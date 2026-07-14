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
const { checkAndNotify } = require("./changeDetector");

const BATCH_SIZE = 2;
const DELAY = 5000;
const MAX_RETRIES = 20;
const BACKOFF_BASE = 30000;
const MAX_PARALLEL = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadResult(account) {
  const row = db.getScrapedData(account.fb_id);
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

async function saveResult(account, result) {
  const oldData = loadResult(account);
  
  db.saveScrapedData(account.fb_id, {
    canh_bao: result.canhBao,
    thong_tin_sv: result.thongTinSV,
    ket_qua_hoc_tap: result.ketQuaHocTap,
    diem_ren_luyen: result.diemRenLuyen,
    lich_thi: result.lichThi,
    hoc_bong_ktkl: result.hocBongKTKL,
    lich_hoc: result.lichHoc,
    hoc_phi: result.hocPhi,
  });

  const settings = db.getSettings(account.fb_id);
  await checkAndNotify(account.fb_id, oldData, result, settings);
}

async function scrapeBatch(account, pages, torProxy) {
  const launchOpts = { headless: true };
  if (torProxy) launchOpts.proxy = { server: torProxy };

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const scraped = {};
  let blocked = false;

  try {
    await page.goto(`${BASE}/DangNhap/Login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.selectOption("#cmbRole", account.role || "0");
    await page.fill("#UserName", account.username);
    await page.fill("#Password", account.password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/SinhVien**", { timeout: 30000 });
    console.log(`  [${account.username}] Login OK`);

    for (const p of pages) {
      await sleep(DELAY);
      try {
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        scraped[p.key] = await page.evaluate(p.extract);
        console.log(`  [${account.username}] ${p.key}: OK`);
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
      try { await page.goto(`${BASE}/DangNhap/Signout`, { timeout: 10000 }); } catch {}
    }
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_EMPTY_RESPONSE")) {
      blocked = true;
    }
    console.log(`  [${account.username}] Session error: ${msg.split("\n")[0]}`);
  }

  await browser.close();
  return { scraped, blocked };
}

async function scrapeAccount(account, torIdx, useTor) {
  let result = loadResult(account);
  let pending = PAGES.filter((p) => !result[p.key]);

  if (!pending.length) {
    console.log(`[${account.username}] All data collected.`);
    return result;
  }

  console.log(`[${account.username}] Need ${pending.length} pages (tor-${torIdx})`);
  let attempt = 0;
  let consecutiveFails = 0;
  const proxy = useTor ? socksUrl(torIdx) : null;

  while (pending.length > 0 && attempt < MAX_RETRIES) {
    const batch = pending.slice(0, BATCH_SIZE);
    attempt++;
    console.log(`\n  [${account.username}] Attempt ${attempt}/${MAX_RETRIES}: ${batch.map((p) => p.key).join(", ")}`);

    const { scraped, blocked } = await scrapeBatch(account, batch, proxy);
    const gotNew = Object.keys(scraped).length > 0;
    Object.assign(result, scraped);
    await saveResult(account, result);

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
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const useTor = !args.includes("--no-tor");
  const parallel = args.includes("--parallel");
  const accountFilter = args.find((a) => a.startsWith("--account="));
  const filterUser = accountFilter ? accountFilter.split("=")[1] : null;

  let rawAccounts = db.getAllUsers();
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
  console.log(`Scraping ${accounts.length} account(s), Tor: ${useTor ? "ON" : "OFF"}, Mode: ${mode}\n`);

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
        return scrapeAccount(account, torIdx, true);
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
      await scrapeAccount(account, 0, false);
    }
  } else {
    for (const account of accounts) {
      console.log(`\n=== ${account.label || account.username} ===`);
      await scrapeAccount(account, 0, useTor);

      if (useTor && accounts.indexOf(account) < accounts.length - 1) {
        await rotateIP(0);
      }
    }
  }

  console.log("\n=== Summary ===");
  let allComplete = true;
  for (const account of accounts) {
    const result = loadResult(account);
    const done = Object.keys(result).length;
    const status = done === PAGES.length ? "COMPLETE" : "INCOMPLETE";
    if (done < PAGES.length) allComplete = false;
    console.log(`${account.username}: ${done}/${PAGES.length} ${status}`);
  }

  if (!allComplete) {
    console.log("\nRe-run to continue incomplete accounts. Progress is saved.");
  }
}

main().catch(console.error);
