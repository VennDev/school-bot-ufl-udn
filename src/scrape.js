const { chromium } = require("playwright");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const fs = require("fs");
const path = require("path");
const { BASE, PAGES, hasUsableData } = require("./pages");
const { socksUrl, rotateIP, startMultipleTor, stopAllTor } = require("./tor");
const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { checkAndNotify } = require("./changeDetector");
const syncProgress = require("./syncProgress");

let progressRunId = null;
const BATCH_SIZE = 8; // Scrape all 8 pages in one login session to prevent duplicate logins
const DELAY = 2000; // Reduce delay to speed up scraping
const MAX_RETRIES = 20;
const BACKOFF_BASE = 30000;
const MAX_PARALLEL = Math.max(1, Math.min(3, Number.parseInt(process.env.SCRAPER_MAX_PARALLEL || "2", 10) || 2));
const PAGE_TIMEOUT_MS = Math.max(30000, Number.parseInt(process.env.SCRAPER_PAGE_TIMEOUT_MS || "120000", 10) || 120000);
const BROWSER_CLOSED_RE = /(?:Target page|context or browser has been closed|Browser has been closed|Target closed|Browser closed)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

function isLoginSuccessUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return /\/SinhVien(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function isLoginFailureUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return /\/DangNhap\/Login$/i.test(url.pathname) && url.searchParams.has("Message");
  } catch {
    return false;
  }
}

function isLoginOutcomeUrl(value) {
  return isLoginSuccessUrl(value) || isLoginFailureUrl(value);
}

async function loadResult(account) {
  const row = await db.getScrapedData(account.fb_id);
  if (!row) return {};
  return {
    canhBao: row.canh_bao ? JSON.parse(row.canh_bao) : null,
    thongTinSV: row.thong_tin_sv ? JSON.parse(row.thong_tin_sv) : null,
    ketQuaHocTap: row.ket_qua_hoc_tap ? JSON.parse(row.ket_qua_hoc_tap) : null,
    diemRenLuyen: row.diem_ren_luyen ? JSON.parse(row.diem_ren_luyen) : null,
    lichThi: row.lich_thi ? JSON.parse(row.lich_thi) : null,
    hocBongKTKL: row.hoc_bong_ktkl ? JSON.parse(row.hoc_bong_ktkl) : null,
    lichHoc: row.lich_hoc ? JSON.parse(row.lich_hoc) : null,
    hocPhi: row.hoc_phi ? JSON.parse(row.hoc_phi) : null,
  };
}

async function saveResult(account, result, baselineOldData, runNotify = false) {
  // baselineOldData: original snapshot before any scraping this session.
  // Prevents partial-save pollution: if scrape runs multiple batches,
  // every checkAndNotify compares against the same original baseline,
  // not against the intermediate DB state (which may have nulls for
  // not-yet-scraped categories, suppressing notifications as "first sync").
  const oldData = baselineOldData !== undefined ? baselineOldData : await loadResult(account);
  
  await db.saveScrapedData(account.fb_id, {
    canh_bao: result.canhBao,
    thong_tin_sv: result.thongTinSV,
    ket_qua_hoc_tap: result.ketQuaHocTap,
    diem_ren_luyen: result.diemRenLuyen,
    lich_thi: result.lichThi,
    hoc_bong_ktkl: result.hocBongKTKL,
    lich_hoc: result.lichHoc,
    hoc_phi: result.hocPhi,
  });

  if (runNotify) {
    const settings = await db.getSettings(account.fb_id);
    await checkAndNotify(account.fb_id, oldData, result, settings);
  }
}

async function scrapeBatch(account, pages, torProxy, silent = false, notifyLoginFailure = false) {
  // Race Direct IP vs Tor — first to login wins. Loser gets closed.
  // ponytail: if >2 proxy types needed, refactor to generic raceWithCleanup helper.
  let fastBrowser = null;
  let fastPage = null;
  let fastProxyUsed = null;

  const activeBrowsers = [];
  let raceSettled = false; // guard against late-arriving loser leaking browser

  const tryLogin = async (proxyServer, label) => {
    const launchOpts = {
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--js-flags=--max-old-space-size=512",
        "--renderer-process-limit=2",
      ],
    };
    if (proxyServer) launchOpts.proxy = { server: proxyServer };

    let browser;
    try {
      browser = await chromium.launch(launchOpts);
      // If race already settled, close immediately — don't leak
      if (raceSettled) {
        await browser.close().catch(() => {});
        throw new Error(`RACE_SETTLED: ${label} arrived after winner`);
      }
      activeBrowsers.push(browser);
    } catch (e) {
      if (e.message.startsWith("RACE_SETTLED")) throw e;
      console.error(`  [${account.username}] Failed to launch browser for ${label}:`, e.message);
      throw e;
    }

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      console.log(`  [${account.username}] Attempting login via ${label}...`);
      await page.goto(`${BASE}/DangNhap/Login`, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.selectOption("#cmbRole", account.role || "0");
      await page.fill("#UserName", account.username);
      await page.fill("#Password", account.password);
      await page.click('button[type="submit"]');
      // Portal redirects invalid credentials to /DangNhap/Login?Message=...;
      // waiting only for /SinhVien makes each bad login consume full timeout.
      await page.waitForURL(url => isLoginOutcomeUrl(url), { timeout: 25000 });
      if (!isLoginSuccessUrl(page.url())) throw new Error("INVALID_CREDENTIALS");

      return { browser, page, label };
    } catch (e) {
      // Losing login race gets ERR_ABORTED when winner cleanup closes its browser.
      // Not a school-server failure; keep logs quiet and let Promise.any ignore loser.
      if (!raceSettled && !e.message.includes("ERR_ABORTED")) {
        console.error(`  [${account.username}] Error inside ${label}:`, e.message);
      }
      await browser.close().catch(() => {});
      const idx = activeBrowsers.indexOf(browser);
      if (idx !== -1) activeBrowsers.splice(idx, 1);
      throw e;
    }
  };

  try {
    if (progressRunId) syncProgress.loginStarted(progressRunId, account.fb_id);
    let rejectCredentialFailure;
    const credentialFailure = new Promise((_, reject) => {
      rejectCredentialFailure = reject;
    });
    const loginPromises = [
      tryLogin(null, "Direct IP").catch((error) => {
        if (error.message === "INVALID_CREDENTIALS") rejectCredentialFailure(error);
        throw error;
      }),
    ];
    if (torProxy) {
      loginPromises.push(tryLogin(torProxy, "Tor Proxy").catch((error) => {
        if (error.message === "INVALID_CREDENTIALS") rejectCredentialFailure(error);
        throw error;
      }));
    }

    // Invalid credentials are definitive. Do not wait for a dead Tor race
    // connection to hit its 25s timeout before telling user.
    const winner = await Promise.race([Promise.any(loginPromises), credentialFailure]);
    raceSettled = true;
    fastBrowser = winner.browser;
    fastPage = winner.page;
    fastProxyUsed = winner.label;
    console.log(`  [${account.username}] Winner connection: ${fastProxyUsed}`);
    if (progressRunId) syncProgress.loginSucceeded(progressRunId, account.fb_id, fastProxyUsed);

    // Close losing browsers immediately (those that made it into activeBrowsers before race settled)
    await Promise.all(
      activeBrowsers
        .filter((b) => b !== fastBrowser)
        .map((b) => b.close().catch(() => {}))
    );
  } catch (e) {
    raceSettled = true;
    const loginDetails = e.errors?.map((error) => error.message).join(" | ") || e.message;
    console.error(`  [${account.username}] Both connections failed to login:`, loginDetails);
    // Close any remaining browser instances on total failure
    await Promise.all(activeBrowsers.map((b) => b.close().catch(() => {})));
    
    const invalidCredentials = e.message === "INVALID_CREDENTIALS" || e.errors?.some(error => error.message === "INVALID_CREDENTIALS");
    if (progressRunId) syncProgress.accountAttempt(progressRunId, account.fb_id, 0, `Đăng nhập thất bại: ${loginDetails.split(" | ")[0]}`);
    // Background sync should never delete users for transient network failures.
    if (!silent || (notifyLoginFailure && invalidCredentials)) {
      await db.deleteUser(account.fb_id);
      await messenger.sendButtons(account.fb_id, "[X] Đăng nhập thất bại. Mã sinh viên hoặc mật khẩu cổng sinh viên không chính xác. Nhấn nút bên dưới để thử đăng nhập lại:", [
        {
          type: "postback",
          title: "Đăng nhập lại",
          payload: "LOGIN_POSTBACK"
        }
      ]);
    }
    return { scraped: {}, blocked: true, invalidCredentials };
  }

  const scraped = {};
  let blocked = false;

  try {
    if (!silent) {
      await messenger.sendTextMessage(account.fb_id, `[✓] Đăng nhập thành công qua kết nối [${fastProxyUsed}]! Đang tiến hành tải dữ liệu học tập...`);
    }
 
    for (const p of pages) {
      if (progressRunId) syncProgress.pageStarted(progressRunId, account.fb_id, p.key);
      await sleep(DELAY);
      try {
        await fastPage.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await fastPage.waitForLoadState("networkidle").catch(() => {});

        // Run page-specific setup (e.g. iterate semester/year dropdowns) before extracting
        if (typeof p.setup === "function") {
          await withTimeout(p.setup(fastPage), PAGE_TIMEOUT_MS, `${p.key} setup`);
        }

        const pageData = fastPage._collectedData !== undefined
          ? fastPage._collectedData
          : await withTimeout(fastPage.evaluate(p.extract), PAGE_TIMEOUT_MS, `${p.key} evaluate`);
        delete fastPage._collectedData;
        if (!hasUsableData(p.key, pageData)) {
          console.warn(`  [${account.username}] ${p.key}: EMPTY_DATA validation failed. Extracted raw:`, JSON.stringify(pageData));
          throw new Error("EMPTY_DATA");
        }
        scraped[p.key] = pageData;
        if (progressRunId) syncProgress.pageFinished(progressRunId, account.fb_id, p.key);
        console.log(`  [${account.username}] ${p.key}: OK`);
        if (!silent) {
          await messenger.sendTextMessage(account.fb_id, `[+] Tải thành công danh mục: ${p.key === "canhBao" ? "Cảnh báo học vụ" : 
                           p.key === "thongTinSV" ? "Hồ sơ sinh viên" : 
                           p.key === "ketQuaHocTap" ? "Điểm học tập" : 
                           p.key === "diemRenLuyen" ? "Điểm rèn luyện" : 
                           p.key === "lichThi" ? "Lịch thi" : 
                           p.key === "hocBongKTKL" ? "Học bổng & Khen thưởng" : 
                           p.key === "lichHoc" ? "Lịch học" : "Học phí"}`);
        }
      } catch (e) {
        const msg = e.message || "";
        if (progressRunId) syncProgress.pageFailed(progressRunId, account.fb_id, p.key, msg.split("\n")[0] || e.name || "Unknown error");
        if (BROWSER_CLOSED_RE.test(msg) || msg.includes("timed out after") || msg.includes("HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_EMPTY_RESPONSE")) {
          blocked = true;
          console.log(`  [${account.username}] ${p.key}: BLOCKED (${BROWSER_CLOSED_RE.test(msg) ? "browser closed" : msg.includes("timed out after") ? "timeout" : msg.split("\n")[0]})`);
          break;
        }
        console.error(`  [${account.username}] ${p.key}: FAIL: ${msg.split("\n")[0] || e.name || "Unknown error"}`);
      }
    }

    if (!blocked) {
      try { await fastPage.goto(`${BASE}/DangNhap/Signout`, { timeout: 10000 }); } catch {}
    }
  } catch (e) {
    const msg = e.message || "";
    if (BROWSER_CLOSED_RE.test(msg) || msg.includes("timed out after") || msg.includes("HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_EMPTY_RESPONSE")) {
      blocked = true;
    }
    console.log(`  [${account.username}] Session error: ${msg.split("\n")[0]}`);
    if (!silent) {
      await messenger.sendTextMessage(account.fb_id, `[X] Lỗi kết nối khi lấy dữ liệu: ${msg.split("\n")[0]}`);
    }
  } finally {
    if (fastBrowser) await fastBrowser.close().catch(() => {});
  }

  return { scraped, blocked };
}

async function scrapeAccount(account, torIdx, useTor, silent = false, notifyLoginFailure = false) {
  if (progressRunId) syncProgress.accountStart(progressRunId, account.fb_id);
  let result = await loadResult(account);
  // Snapshot original DB state ONCE before any scraping.
  // All change-detection calls compare against this baseline,
  // so multi-batch retries don't suppress notifications via
  // intermediate null fields ("first sync" guard false-positive).
  const baselineOldData = await loadResult(account);
  // Always re-scrape all pages so change-detection works on every cron run.
  // Previously skipped when pending.length === 0, meaning completed accounts
  // never got grade/exam/tuition updates after initial sync.
  let pending = PAGES;

  console.log(`[${account.username}] Refreshing all ${pending.length} pages (tor-${torIdx})`);
  let attempt = 0;
  let consecutiveFails = 0;
  const syncedThisRun = new Set();
  const proxy = useTor ? socksUrl(torIdx) : null;
  const deadline = Date.now() + (Number.parseInt(process.env.SCRAPER_ACCOUNT_TIMEOUT_MS || "0", 10) || 0);

  while (pending.length > 0 && attempt < MAX_RETRIES && (deadline === 0 || Date.now() < deadline)) {
    const batch = pending.slice(0, BATCH_SIZE);
    attempt++;
    if (progressRunId) syncProgress.accountAttempt(progressRunId, account.fb_id, attempt, `Lần thử ${attempt}/${MAX_RETRIES}`);
    console.log(`\n  [${account.username}] Attempt ${attempt}/${MAX_RETRIES}: ${batch.map((p) => p.key).join(", ")}`);

    const { scraped, blocked, invalidCredentials } = await scrapeBatch(account, batch, proxy, silent, notifyLoginFailure);
    
    // Invalid credentials are definitive: do not retry 20 times or spam logs.
    if (invalidCredentials) {
      console.log(`  [${account.username}] INVALID_CREDENTIALS — aborting, no retry.`);
      if (progressRunId) syncProgress.accountFinished(progressRunId, account.fb_id, "failed", "Sai mã sinh viên hoặc mật khẩu");
      return result;
    }

    // Check if user still exists in database. If not (e.g. login failed and user was deleted), exit retry loop immediately.
    const userExists = await db.getUser(account.fb_id);
    if (!userExists) {
      console.log(`  [${account.username}] User deleted due to invalid credentials. Aborting scrape loop.`);
      if (progressRunId) syncProgress.accountFinished(progressRunId, account.fb_id, "failed", "Tài khoản đã bị xóa sau khi đăng nhập thất bại");
      return result;
    }

    const gotNew = Object.keys(scraped).length > 0;
    Object.assign(result, scraped);
    Object.keys(scraped).forEach(key => syncedThisRun.add(key));
    await saveResult(account, result, baselineOldData, false);

    // Old DB values do not count as a successful scrape this run.
    pending = PAGES.filter((p) => !syncedThisRun.has(p.key));
    console.log(`  [${account.username}] Progress: ${syncedThisRun.size}/${PAGES.length}`);

    if (!pending.length) break;

    if (blocked || !gotNew) {
      consecutiveFails++;
      const wait = BACKOFF_BASE * Math.min(consecutiveFails, 4);

      if (useTor) {
        console.log(`  [${account.username}] Blocked — rotating tor-${torIdx}...`);
        const rotated = await rotateIP(torIdx);
        if (!rotated) {
          console.log(`  [${account.username}] Waiting ${wait / 1000}s...`);
          await sleep(wait);
        }
      } else {
        console.log(`  [${account.username}] Blocked — waiting ${wait / 1000}s...`);
        await sleep(wait);
      }
    } else {
      consecutiveFails = 0;
      if (useTor) {
        await rotateIP(torIdx);
      } else {
        await sleep(30000);
      }
    }
  }

  if (pending.length > 0) {
    console.log(`  [${account.username}] INCOMPLETE after ${attempt} attempts`);
    console.log(`  Missing: ${pending.map((p) => p.key).join(", ")}`);
    if (!silent) {
      await messenger.sendTextMessage(account.fb_id, "[!] Quá trình đồng bộ dữ liệu chưa hoàn tất. Một số mục có thể đã thất bại do lỗi kết nối mạng. Bạn có thể gõ /login để thử đồng bộ lại phần còn thiếu.");
    }
  }

  // Trigger change detection only after complete sync. Incomplete snapshots
  // must not produce false alerts from partial semester data.
  if (!pending.length) {
    await saveResult(account, result, baselineOldData, true);
  }

  if (progressRunId) {
    syncProgress.accountFinished(
      progressRunId,
      account.fb_id,
      pending.length ? "incomplete" : "complete",
      pending.length ? `Thiếu: ${pending.map(p => p.label).join(", ")}` : null,
    );
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const useTor = !args.includes("--no-tor");
  const parallel = args.includes("--parallel");
  const silent = args.includes("--silent");
  const notifyLoginFailure = args.includes("--notify-login-failure");
  const accountFilter = args.find((a) => a.startsWith("--account="));
  const filterUser = accountFilter ? accountFilter.split("=")[1] : null;
  const fbIdFilter = args.find((a) => a.startsWith("--fb-id="));
  const filterFbId = fbIdFilter ? fbIdFilter.split("=")[1] : null;

  let rawAccounts = await db.getAllUsers();
  if (filterFbId) {
    rawAccounts = rawAccounts.filter((a) => a.fb_id === filterFbId);
  } else if (filterUser) {
    rawAccounts = rawAccounts.filter((a) => a.username === filterUser);
  }

  const accounts = rawAccounts.map((a) => ({
    fb_id: a.fb_id,
    username: a.username,
    password: crypto.decrypt(a.password_enc),
    role: a.role,
    label: a.username,
  }));

  if (!accounts.length) {
    console.log("No accounts found in database.");
    return;
  }

  const mode = parallel ? "PARALLEL" : "SEQUENTIAL";
  progressRunId = syncProgress.startRun(accounts, { mode, useTor });
  console.log(`Scraping ${accounts.length} account(s), Tor: ${useTor ? "ON" : "OFF"}, Mode: ${mode}, Silent: ${silent}\n`);

  if (parallel && useTor) {
    const needed = Math.min(accounts.length, MAX_PARALLEL);
    console.log(`Starting ${needed} Tor instances...\n`);
    const instances = await startMultipleTor(needed);
    if (!instances.length) {
      console.log("Failed to start Tor instances. Run: sudo pacman -S tor");
      return;
    }

    const chunks = [];
    for (let i = 0; i < accounts.length; i += instances.length) {
      chunks.push(accounts.slice(i, i + instances.length));
    }

    for (const chunk of chunks) {
      const promises = chunk.map((account, i) => {
        const torIdx = instances[i % instances.length].idx;
        return scrapeAccount(account, torIdx, true, silent, notifyLoginFailure);
      });
      await Promise.all(promises);

      for (const inst of instances) {
        await rotateIP(inst.idx);
      }
    }

    stopAllTor();
  } else if (parallel && !useTor) {
    console.log("Parallel without Tor: running sequentially (same IP = instant block)\n");
    for (const account of accounts) {
      await scrapeAccount(account, 0, false, silent, notifyLoginFailure);
    }
  } else {
    const timeoutMs = Number.parseInt(process.env.SCRAPER_ACCOUNT_TIMEOUT_MS || "0", 10) || 0;
    const queue = accounts.slice();
    let index = 0;
    let processed = 0;
    const pushed = new Set();
    // Round-robin: nick nào fail quá lâu sẽ bị đẩy về cuối hàng đợi,
    // xử các nick khác trước, rồi quay lại sau.
    while (queue.length > 0 && processed < accounts.length * 2) {
      const account = queue[index % queue.length];
      console.log(`\n=== ${account.label || account.username} ===`);
      await scrapeAccount(account, 0, useTor, silent, notifyLoginFailure);
      processed++;
      const result = await loadResult(account);
      const done = Object.keys(result).length;
      const complete = done === PAGES.length;
      if (complete) {
        // Remove completed accounts from the queue so they aren't retried again.
        queue.splice(index % queue.length, 1);
      } else if (timeoutMs > 0 && !pushed.has(account.fb_id)) {
        // Nick fail quá lâu: đẩy về cuối hàng đợi, xử nick khác trước.
        console.log(`  [${account.username}] Incomplete after timeout — deferring to end of queue.`);
        queue.splice(index % queue.length, 1);
        queue.push(account);
        pushed.add(account.fb_id);
        // Không tăng index: nick vừa đẩy về cuối sẽ được xử lại sau vòng này.
      } else {
        index++;
      }
      if (useTor && queue.length > 0) {
        await rotateIP(0);
      }
    }
  }

  console.log("\n=== Summary ===");
  let allComplete = true;
  for (const account of accounts) {
    const result = await loadResult(account);
    const done = Object.keys(result).length;
    const status = done === PAGES.length ? "COMPLETE" : "INCOMPLETE";
    if (done < PAGES.length) allComplete = false;
    console.log(`${account.username}: ${done}/${PAGES.length} ${status}`);
  }

  syncProgress.finishRun(progressRunId, allComplete ? "complete" : "incomplete");
  if (!allComplete) {
    console.log("\nRe-run to continue incomplete accounts. Progress is saved.");
    process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    if (progressRunId) syncProgress.finishRun(progressRunId, "failed", err.message);
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    // Disconnect MongoDB to prevent connection pool leak in child processes
    try {
      const mongoose = require("mongoose");
      await mongoose.disconnect();
      console.log("[scrape] MongoDB disconnected.");
    } catch {}
  });
