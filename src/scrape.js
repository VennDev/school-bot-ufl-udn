const { chromium } = require("playwright");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const fs = require("fs");
const path = require("path");
const { BASE, PAGES } = require("./pages");
const { socksUrl, rotateIP, startMultipleTor, stopAllTor } = require("./tor");
const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { checkAndNotify } = require("./changeDetector");

const BATCH_SIZE = 8; // Scrape all 8 pages in one login session to prevent duplicate logins
const DELAY = 2000; // Reduce delay to speed up scraping
const MAX_RETRIES = 20;
const BACKOFF_BASE = 30000;
const MAX_PARALLEL = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function scrapeBatch(account, pages, torProxy, silent = false) {
  // Race Direct IP vs Tor — first to login wins. Loser gets closed.
  // ponytail: if >2 proxy types needed, refactor to generic raceWithCleanup helper.
  let fastBrowser = null;
  let fastPage = null;
  let fastProxyUsed = null;

  const activeBrowsers = [];
  let raceSettled = false; // guard against late-arriving loser leaking browser

  const tryLogin = async (proxyServer, label) => {
    const launchOpts = { headless: true };
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
      await page.waitForURL("**/SinhVien**", { timeout: 25000 });

      return { browser, page, label };
    } catch (e) {
      console.error(`  [${account.username}] Error inside ${label}:`, e.message);
      await browser.close().catch(() => {});
      const idx = activeBrowsers.indexOf(browser);
      if (idx !== -1) activeBrowsers.splice(idx, 1);
      throw e;
    }
  };

  try {
    const loginPromises = [
      tryLogin(null, "Direct IP"),
    ];
    if (torProxy) {
      loginPromises.push(tryLogin(torProxy, "Tor Proxy"));
    }

    const winner = await Promise.any(loginPromises);
    raceSettled = true;
    fastBrowser = winner.browser;
    fastPage = winner.page;
    fastProxyUsed = winner.label;
    console.log(`  [${account.username}] Winner connection: ${fastProxyUsed}`);

    // Close losing browsers immediately (those that made it into activeBrowsers before race settled)
    await Promise.all(
      activeBrowsers
        .filter((b) => b !== fastBrowser)
        .map((b) => b.close().catch(() => {}))
    );
  } catch (e) {
    raceSettled = true;
    console.error(`  [${account.username}] Both connections failed to login:`, e.message);
    // Close any remaining browser instances on total failure
    await Promise.all(activeBrowsers.map((b) => b.close().catch(() => {})));
    
    // Background sync (silent) should NEVER delete users or send failure buttons.
    // That prevents school server downtime from deleting active accounts.
    if (!silent) {
      await db.deleteUser(account.fb_id);
      await messenger.sendButtons(account.fb_id, "[X] Đăng nhập thất bại. Mã sinh viên hoặc mật khẩu cổng sinh viên không chính xác. Nhấn nút bên dưới để thử đăng nhập lại:", [
        {
          type: "postback",
          title: "Đăng nhập lại",
          payload: "LOGIN_POSTBACK"
        }
      ]);
    }
    return { scraped: {}, blocked: true };
  }

  const scraped = {};
  let blocked = false;

  try {
    if (!silent) {
      await messenger.sendTextMessage(account.fb_id, `[✓] Đăng nhập thành công qua kết nối [${fastProxyUsed}]! Đang tiến hành tải dữ liệu học tập...`);
    }
 
    for (const p of pages) {
      await sleep(DELAY);
      try {
        await fastPage.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await fastPage.waitForLoadState("networkidle").catch(() => {});
        scraped[p.key] = await fastPage.evaluate(p.extract);
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
        if (msg.includes("HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_EMPTY_RESPONSE")) {
          blocked = true;
          console.log(`  [${account.username}] ${p.key}: BLOCKED`);
          break;
        }
        console.log(`  [${account.username}] ${p.key}: FAIL`);
      }
    }

    if (!blocked) {
      try { await fastPage.goto(`${BASE}/DangNhap/Signout`, { timeout: 10000 }); } catch {}
    }
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_EMPTY_RESPONSE")) {
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

async function scrapeAccount(account, torIdx, useTor, silent = false) {
  let result = await loadResult(account);
  // Snapshot original DB state ONCE before any scraping.
  // All change-detection calls compare against this baseline,
  // so multi-batch retries don't suppress notifications via
  // intermediate null fields ("first sync" guard false-positive).
  const baselineOldData = await loadResult(account);
  let pending = PAGES.filter((p) => !result[p.key]);

  // Always re-scrape all pages so change-detection works on every cron run.
  // Previously skipped when pending.length === 0, meaning completed accounts
  // never got grade/exam/tuition updates after initial sync.
  pending = PAGES;

  console.log(`[${account.username}] Refreshing all ${pending.length} pages (tor-${torIdx})`);
  let attempt = 0;
  let consecutiveFails = 0;
  const proxy = useTor ? socksUrl(torIdx) : null;

  while (pending.length > 0 && attempt < MAX_RETRIES) {
    const batch = pending.slice(0, BATCH_SIZE);
    attempt++;
    console.log(`\n  [${account.username}] Attempt ${attempt}/${MAX_RETRIES}: ${batch.map((p) => p.key).join(", ")}`);

    const { scraped, blocked } = await scrapeBatch(account, batch, proxy, silent);
    
    // Check if user still exists in database. If not (e.g. login failed and user was deleted), exit retry loop immediately.
    const userExists = await db.getUser(account.fb_id);
    if (!userExists) {
      console.log(`  [${account.username}] User deleted due to invalid credentials. Aborting scrape loop.`);
      return result;
    }

    const gotNew = Object.keys(scraped).length > 0;
    Object.assign(result, scraped);
    await saveResult(account, result, baselineOldData, false);

    pending = PAGES.filter((p) => !result[p.key]);
    console.log(`  [${account.username}] Progress: ${Object.keys(result).length}/${PAGES.length}`);

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
  } else {
    if (!silent) {
      // When successfully synced, show a welcome message with a chat list (Quick Replies) as in the image, containing a logout option.
      const successMsg = `Chúc mừng ${account.username} đã kết nối tài khoản sinh viên thành công! Tôi có thể giúp gì cho bạn?`;
      await messenger.sendQuickReplies(account.fb_id, successMsg, [
        { title: "Lịch học", payload: "LICH_HOC" },
        { title: "Lịch thi", payload: "LICH_THI" },
        { title: "Điểm số", payload: "DIEM_SO" },
        { title: "Học phí", payload: "HOC_PHI" },
        { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
        { title: "Đăng xuất", payload: "LOGOUT_POSTBACK" }
      ]);

      // Prompt user to grant first OTN Token for 24h bypass
      setTimeout(async () => {
        try {
          await messenger.sendOtnRequest(account.fb_id, "Đăng ký nhận thông báo GPA & Điểm mới tự động", "ACCOUNT_UPDATE");
        } catch (e) {
          console.error("[scrape] Failed to send OTN request:", e.message);
        }
      }, 2000);
    }
  }

  // Trigger change detection and notify EXACTLY ONCE at the end of the scraper session.
  // Prevents duplicate spamming when scraper saves multiple batches.
  await saveResult(account, result, baselineOldData, true);

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const useTor = !args.includes("--no-tor");
  const parallel = args.includes("--parallel");
  const silent = args.includes("--silent");
  const accountFilter = args.find((a) => a.startsWith("--account="));
  const filterUser = accountFilter ? accountFilter.split("=")[1] : null;

  let rawAccounts = await db.getAllUsers();
  if (filterUser) {
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
        return scrapeAccount(account, torIdx, true, silent);
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
      await scrapeAccount(account, 0, false, silent);
    }
  } else {
    for (const account of accounts) {
      console.log(`\n=== ${account.label || account.username} ===`);
      await scrapeAccount(account, 0, useTor, silent);

      if (useTor && accounts.indexOf(account) < accounts.length - 1) {
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

  if (!allComplete) {
    console.log("\nRe-run to continue incomplete accounts. Progress is saved.");
  }
}

main()
  .catch((err) => {
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
