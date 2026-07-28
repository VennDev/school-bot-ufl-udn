require("dotenv").config();
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const express = require("express");
const path = require("path");
const { exec } = require("child_process");
const db = require("./db");
const crypto = require("./crypto");
const botRouter = require("./botRouter");
const messenger = require("./messenger");
const { startScheduler } = require("./cron");
const { PAGES, hasUsableData } = require("./pages");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/privacy.html"));
});

const pIndex = process.argv.indexOf('-p');
const PORT = process.env.PORT || (pIndex !== -1 ? process.argv[pIndex + 1] : null) || process.argv[2] || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const MOCK_TOKEN = crypto.encrypt("admin-session");

function requireFbId(value) {
  const fbId = String(value || "").trim();
  return /^\d+$/.test(fbId) ? fbId : null;
}

// Cache to prevent duplicate messages (Facebook retry mitigation)
const processedMessageIds = new Set();
const clearCacheInterval = setInterval(() => processedMessageIds.clear(), 60000); // clear every 1 minute
let globalSyncRunning = false; // prevent overlapping admin sync-all spawns

// Start cron job scheduler for scraping
startScheduler();

// Middleware to resolve app base URL dynamically for webhook
app.use((req, res, next) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers.host;
  botRouter.setBaseUrl(`${protocol}://${host}`);
  next();
});

// Admin Authentication Middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    if (token && crypto.decrypt(token) === "admin-session") {
      return next();
    }
  } catch {}
  res.status(401).json({ error: "Unauthorized" });
}

// Admin API routes
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: MOCK_TOKEN });
  } else {
    res.status(401).json({ success: false, message: "Incorrect password" });
  }
});

app.post("/api/admin/toggle-bot", requireAdmin, async (req, res) => {
  const current = await db.getSystemSetting("bot_status", "running");
  const nextState = current === "running" ? "stopped" : "running";
  await db.saveSystemSetting("bot_status", nextState);
  res.json({ success: true, status: nextState });
});

app.get("/api/admin/user-detail", requireAdmin, async (req, res) => {
  const fb_id = requireFbId(req.query.fb_id);
  if (!fb_id) return res.status(400).json({ error: "A valid numeric fb_id is required" });
  try {
    const user = await db.getUser(fb_id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const rawData = await db.getScrapedData(fb_id) || {};
    const parse = (value) => {
      if (!value) return null;
      try { return JSON.parse(value); } catch { return null; }
    };
    const parsedData = {
      canhBao: parse(rawData.canh_bao),
      thongTinSV: parse(rawData.thong_tin_sv),
      ketQuaHocTap: parse(rawData.ket_qua_hoc_tap),
      diemRenLuyen: parse(rawData.diem_ren_luyen),
      lichThi: parse(rawData.lich_thi),
      hocBongKTKL: parse(rawData.hoc_bong_ktkl),
      lichHoc: parse(rawData.lich_hoc),
      hocPhi: parse(rawData.hoc_phi),
      updatedAt: rawData.updated_at
    };
    const coverage = Object.fromEntries(PAGES.map(page => [page.key, hasUsableData(page.key, parsedData[page.key])]));
    res.json({ username: user.username, fb_id, coverage, data: parsedData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const users = await db.getAllUsers();
  const detailedUsers = await Promise.all(users.map(async (u) => {
    const data = await db.getScrapedData(u.fb_id) || {};
    const completedCount = PAGES.filter((p) => {
      const dbKey = {
        canhBao: "canh_bao", thongTinSV: "thong_tin_sv", ketQuaHocTap: "ket_qua_hoc_tap",
        diemRenLuyen: "diem_ren_luyen", lichThi: "lich_thi", hocBongKTKL: "hoc_bong_ktkl",
        lichHoc: "lich_hoc", hocPhi: "hoc_phi"
      }[p.key];
      try { return hasUsableData(p.key, data[dbKey] ? JSON.parse(data[dbKey]) : null); } catch { return false; }
    }).length;

    return {
      username: u.username,
      fb_id: u.fb_id,
      complete: completedCount === PAGES.length,
      completedCount,
      totalPages: PAGES.length
    };
  }));

  const completeCount = detailedUsers.filter((u) => u.complete).length;
  
  const hasConfig = (await db.getSystemSetting("fb_page_token", "")) && 
                    (await db.getSystemSetting("fb_verify_token", "")) && 
                    (await db.getSystemSetting("fb_app_secret", ""));
  
  const botStatus = hasConfig ? await db.getSystemSetting("bot_status", "running") : "unconfigured";

  res.json({
    totalUsers: users.length,
    completeUsers: completeCount,
    users: detailedUsers,
    botStatus
  });
});

app.post("/api/admin/sync-all", requireAdmin, (req, res) => {
  if (globalSyncRunning) {
    return res.json({ success: false, message: "Một tiến trình đồng bộ toàn cục đang chạy. Vui lòng đợi." });
  }
  globalSyncRunning = true;
  const scraperPath = path.resolve(__dirname, "./scrape.js");
  exec(`node ${scraperPath} --silent --parallel`, (err) => {
    globalSyncRunning = false;
    if (err) console.error("[admin-sync] Global failed:", err.message);
  });
  res.json({ success: true, message: "Bắt đầu chạy scraper ngầm cho toàn bộ users qua Tor." });
});

app.post("/api/admin/sync-user", requireAdmin, async (req, res) => {
  const fbId = requireFbId(req.query.fb_id);
  if (!fbId) return res.status(400).json({ error: "A valid numeric fb_id is required" });

  const users = await db.getAllUsers();
  const targetUsers = users.filter(u => u.fb_id === fbId);
  if (!targetUsers.length) return res.status(404).json({ error: "User not found" });

  const scraperPath = path.resolve(__dirname, "./scrape.js");
  targetUsers.forEach(user => {
    exec(`node ${scraperPath} --silent --fb-id=${fbId}`, (err) => {
      if (err) console.error(`[admin-sync] User ${user.username} (${fbId}) failed:`, err.message);
    });
  });
  res.json({ success: true, message: `Bắt đầu chạy scraper cho ${targetUsers.length} tài khoản.` });
});

// Per-user notify test: tweak one grade in DB, re-sync, verify change-log.
// Admin clicks "Test Notify" → backend tampers old data → scraper detects "change" → notifies.
app.post("/api/admin/test-notify", requireAdmin, async (req, res) => {
  const fbId = requireFbId(req.body.fb_id);
  if (!fbId) return res.status(400).json({ error: "A valid numeric fb_id is required" });

  const users = await db.getAllUsers();
  const targetUsers = users.filter(u => u.fb_id === fbId);

  if (!targetUsers.length) return res.status(404).json({ error: "User not found" });

  let updatedCount = 0;
  let sampleDetail = null;

  for (const user of targetUsers) {
    const curFbId = fbId;
    const data = await db.getScrapedData(curFbId);
    if (!data || !data.ket_qua_hoc_tap) continue;

    let grades;
    try {
      grades = JSON.parse(data.ket_qua_hoc_tap);
    } catch {
      continue;
    }

    const targetTable = grades.find(t => t.headers?.some(h => h.includes("Tên học phần")));
    if (!targetTable || !targetTable.rows || !targetTable.rows.length) continue;

    const row = targetTable.rows[0];
    const originalScore = row[6];
    const tweakedScore = (parseFloat(originalScore) || 5) >= 9 ? "1.0" : "9.9";
    row[6] = tweakedScore;

    await db.saveScrapedData(curFbId, {
      canh_bao: data.canh_bao ? JSON.parse(data.canh_bao) : null,
      thong_tin_sv: data.thong_tin_sv ? JSON.parse(data.thong_tin_sv) : null,
      ket_qua_hoc_tap: grades,
      diem_ren_luyen: data.diem_ren_luyen ? JSON.parse(data.diem_ren_luyen) : null,
      lich_thi: data.lich_thi ? JSON.parse(data.lich_thi) : null,
      hoc_bong_ktkl: data.hoc_bong_ktkl ? JSON.parse(data.hoc_bong_ktkl) : null,
      lich_hoc: data.lich_hoc ? JSON.parse(data.lich_hoc) : null,
      hoc_phi: data.hoc_phi ? JSON.parse(data.hoc_phi) : null,
    });

    const testKey = `test_notify_ts_${user.username}_${curFbId}`;
    const logKey = `test_notify_log_${user.username}_${curFbId}`;
    const beforeTs = Date.now();
    await db.saveSystemSetting(testKey, String(beforeTs));
    await db.saveSystemSetting(logKey, "[process] scraper đang khởi động...\n");

    const scraperPath = path.resolve(__dirname, "./scrape.js");
    exec(`node ${scraperPath} --silent --fb-id=${curFbId}`, {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      const scraperLog = [
        err ? `[process error] ${err.message}` : "[process] exited successfully",
        stdout ? `[stdout]\n${stdout}` : "",
        stderr ? `[stderr]\n${stderr}` : "",
      ].filter(Boolean).join("\n").slice(-12000);
      console.error(`[admin-test-notify][${curFbId}] scraper log:\n${scraperLog}`);
      await db.saveSystemSetting(logKey, scraperLog);

      if (err) {
        await db.saveSystemSetting(testKey, `fail_${Date.now()}`);
        return;
      }
      const logs = await db.getChangeLogs(curFbId, 5);
      const newAlert = logs.find(l => l.type === "alert" && new Date(l.createdAt).getTime() > beforeTs);
      const statusStr = newAlert ? `ok_${Date.now()}` : `fail_${Date.now()}`;
      await db.saveSystemSetting(testKey, statusStr);
    });

    updatedCount++;
    if (!sampleDetail) {
      sampleDetail = { course: row[2], original: originalScore, tweaked: tweakedScore };
    }
  }

  if (updatedCount === 0) {
    return res.status(400).json({ error: "Không thể giả lập điểm (thiếu dữ liệu điểm học tập)." });
  }

  res.json({
    success: true,
    message: `Đã sửa điểm cho ${updatedCount} nick Meta. Đang chạy sync... Kiểm tra ChangeLog sau ~30s.`,
    detail: sampleDetail,
  });
});

// Check latest test-notify result for a user
app.get("/api/admin/test-notify-result", requireAdmin, async (req, res) => {
  const fbId = requireFbId(req.query.fb_id);
  if (!fbId) return res.status(400).json({ error: "A valid numeric fb_id is required" });

  const users = await db.getAllUsers();
  const user = users.find(u => u.fb_id === fbId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const testKey = `test_notify_ts_${user.username}_${fbId}`;
  const logKey = `test_notify_log_${user.username}_${fbId}`;
  const testState = await db.getSystemSetting(testKey, "");
  const scraperLog = await db.getSystemSetting(logKey, "");

  if (!testState) {
    return res.json({ success: true, status: "not_started", lastAlert: null, log: scraperLog });
  }

  if (testState.startsWith("ok_") || testState.startsWith("fail_")) {
    const logs = await db.getChangeLogs(user.fb_id, 3);
    const lastAlert = logs.find(l => l.type === "alert");
    return res.json({
      success: true,
      status: testState.startsWith("ok_") ? "ok" : "fail",
      lastAlert: lastAlert ? {
        content: lastAlert.content,
        time: lastAlert.createdAt,
      } : null,
      log: scraperLog,
    });
  }

  // testState is a numeric timestamp → test still running
  const elapsed = Math.round((Date.now() - parseInt(testState)) / 1000);
  res.json({ success: true, status: "running", elapsed, log: scraperLog });
});

// Simulate test: clear one page from a user's scraped data, then re-sync.
// Used to verify change-detection + notification pipeline from admin UI.
app.post("/api/admin/clear-page", requireAdmin, async (req, res) => {
  const fbId = requireFbId(req.body.fb_id);
  const { page } = req.body;
  if (!fbId || !page) return res.status(400).json({ error: "A valid numeric fb_id and page are required" });

  // Map page key to DB column name (same as /testpage in botRouter)
  const keyMap = {
    "canhbao": "canh_bao", "canh_bao": "canh_bao",
    "thongtinsv": "thong_tin_sv", "thong_tin_sv": "thong_tin_sv",
    "diem": "ket_qua_hoc_tap", "ket_qua_hoc_tap": "ket_qua_hoc_tap",
    "diemrenluyen": "diem_ren_luyen", "diem_ren_luyen": "diem_ren_luyen",
    "lichthi": "lich_thi", "lich_thi": "lich_thi",
    "hocbong": "hoc_bong_ktkl", "hoc_bong_ktkl": "hoc_bong_ktkl",
    "lichhoc": "lich_hoc", "lich_hoc": "lich_hoc",
    "hocphi": "hoc_phi", "hoc_phi": "hoc_phi",
  };
  const dbKey = keyMap[page.toLowerCase()];
  if (!dbKey) {
    return res.status(400).json({ error: `Unknown page: ${page}. Valid: diem, lichthi, canhbao, lichhoc, hocphi, thongtinsv, diemrenluyen, hocbong` });
  }

  const users = await db.getAllUsers();
  const targetUsers = users.filter(u => u.fb_id === fbId);
  if (!targetUsers.length) return res.status(404).json({ error: "User not found" });

  const scraperPath = path.resolve(__dirname, "./scrape.js");
  for (const user of targetUsers) {
    await db.clearScrapedPage(user.fb_id, dbKey);
    exec(`node ${scraperPath} --silent --fb-id=${user.fb_id}`, (err) => {
      if (err) console.error(`[admin-clear-page] Re-sync for ${user.username} (${user.fb_id}) failed:`, err.message);
    });
  }

  res.json({
    success: true,
    message: `Đã xóa dữ liệu mục "${page}" (${dbKey}) của ${targetUsers.length} tài khoản. Đang đồng bộ lại...`,
  });
});

app.post("/api/admin/delete-user", requireAdmin, async (req, res) => {
  const { fb_id } = req.query;
  if (!fb_id) return res.status(400).json({ error: "Missing fb_id" });

  await db.deleteUser(fb_id);
  res.json({ success: true });
});

app.post("/api/admin/delete-record", requireAdmin, async (req, res) => {
  const { model, id } = req.body;
  if (!model || !id) return res.status(400).json({ error: "Missing model or id" });
  try {
    await db.deleteRecord(model, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/delete-all", requireAdmin, async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "Missing model" });
  try {
    await db.deleteAllRecords(model);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/data-view", requireAdmin, async (req, res) => {
  const { model, page, limit } = req.query;
  if (!model) return res.status(400).json({ error: "Missing model name" });
  try {
    const result = await db.getModelsData(model, parseInt(page) || 1, parseInt(limit) || 10);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/data-export", requireAdmin, async (req, res) => {
  const { model } = req.query;
  if (!model) return res.status(400).json({ error: "Missing model name" });
  try {
    const rawData = await db.getAllModelDataForExport(model);
    if (!rawData.length) {
      return res.status(404).json({ error: "No data to export" });
    }

    // Convert rawData to CSV format
    const keys = Object.keys(rawData[0]).filter(k => k !== "__v");
    const csvRows = [keys.join(",")];

    rawData.forEach((item) => {
      const values = keys.map((key) => {
        let val = item[key];
        if (val === null || val === undefined) return "";
        if (typeof val === "object") val = JSON.stringify(val);
        const escaped = String(val).replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(","));
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${model}_export.csv`);
    res.status(200).send("\uFEFF" + csvRows.join("\n")); // BOM for UTF-8
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  res.json({
    ai_provider: await db.getSystemSetting("ai_provider", process.env.AI_PROVIDER || "opencode"),
    opencode_api_key: await db.getSystemSetting("opencode_api_key", process.env.OPENCODE_API_KEY || "public"),
    opencode_model: await db.getSystemSetting("opencode_model", process.env.OPENCODE_MODEL || "deepseek-v4-flash-free"),
    scraper_interval: await db.getSystemSetting("scraper_interval", "4"), // hours
    scraper_mode: await db.getSystemSetting("scraper_mode", "parallel"), // parallel / sequential
    fb_page_token: await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || ""),
    fb_page_id: await db.getSystemSetting("fb_page_id", process.env.FB_PAGE_ID || ""),
    fb_user_token: await db.getSystemSetting("fb_user_token", process.env.FB_USER_TOKEN || ""),
    fb_verify_token: await db.getSystemSetting("fb_verify_token", process.env.FB_VERIFY_TOKEN || ""),
    fb_app_secret: await db.getSystemSetting("fb_app_secret", process.env.FB_APP_SECRET || ""),
    smtp_host: await db.getSystemSetting("smtp_host", ""),
    smtp_port: await db.getSystemSetting("smtp_port", "587"),
    smtp_user: await db.getSystemSetting("smtp_user", ""),
    smtp_pass: await db.getSystemSetting("smtp_pass", ""),
    smtp_from: await db.getSystemSetting("smtp_from", "")
  });
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const { ai_provider, opencode_api_key, opencode_model, scraper_interval, scraper_mode, fb_page_token, fb_page_id, fb_user_token, fb_verify_token, fb_app_secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  
  if (ai_provider) await db.saveSystemSetting("ai_provider", ai_provider);
  if (opencode_api_key) await db.saveSystemSetting("opencode_api_key", opencode_api_key);
  if (opencode_model) await db.saveSystemSetting("opencode_model", opencode_model);
  if (scraper_interval) await db.saveSystemSetting("scraper_interval", scraper_interval);
  if (scraper_mode) await db.saveSystemSetting("scraper_mode", scraper_mode);
  if (fb_page_token) await db.saveSystemSetting("fb_page_token", fb_page_token);
  if (fb_page_id) await db.saveSystemSetting("fb_page_id", fb_page_id);
  if (fb_user_token) await db.saveSystemSetting("fb_user_token", fb_user_token);
  if (fb_verify_token) await db.saveSystemSetting("fb_verify_token", fb_verify_token);
  if (fb_app_secret) await db.saveSystemSetting("fb_app_secret", fb_app_secret);
  if (smtp_host !== undefined) await db.saveSystemSetting("smtp_host", smtp_host);
  if (smtp_port !== undefined) await db.saveSystemSetting("smtp_port", smtp_port);
  if (smtp_user !== undefined) await db.saveSystemSetting("smtp_user", smtp_user);
  if (smtp_pass !== undefined) await db.saveSystemSetting("smtp_pass", smtp_pass);
  if (smtp_from !== undefined) await db.saveSystemSetting("smtp_from", smtp_from);

  res.json({ success: true, message: "Cấu hình hệ thống đã được lưu." });
});

// Messenger Webhook Validation
app.get("/webhook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`[webhook-verify] Received mode: ${mode}, token: ${token}`);

  if (mode && token) {
    const sysVerifyToken = await db.getSystemSetting("fb_verify_token", process.env.FB_VERIFY_TOKEN || "");
    console.log(`[webhook-verify] Configured verify token: "${sysVerifyToken}"`);
    if (mode === "subscribe" && token === sysVerifyToken) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      console.warn("[webhook-verify] Token mismatch!");
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Messenger Message Handlers
app.post("/webhook", async (req, res) => {
  console.log("[webhook-raw]", JSON.stringify(req.body));
  const hasConfig = (await db.getSystemSetting("fb_page_token", "")) && 
                    (await db.getSystemSetting("fb_verify_token", "")) && 
                    (await db.getSystemSetting("fb_app_secret", ""));
  const botStatus = hasConfig ? await db.getSystemSetting("bot_status", "running") : "unconfigured";

  if (botStatus !== "running") {
    return res.status(200).send("BOT_NOT_RUNNING");
  }

  const body = req.body;
  if (body.object === "page") {
    // Send HTTP 200 immediately to Facebook and close HTTP session to prevent retry loops
    res.status(200).send("EVENT_RECEIVED");

    for (const entry of body.entry) {
      if (!entry.messaging) continue;
      for (const webhook_event of entry.messaging) {
        const sender_psid = webhook_event.sender.id;
        
        let dedupKey = null;
        if (webhook_event.message) {
          dedupKey = webhook_event.message.mid || (sender_psid + "_" + (webhook_event.message.text || ""));
          if (webhook_event.message.quick_reply && webhook_event.message.quick_reply.payload) {
            // If it is a quick reply, dedup based on the payload to filter out duplicate text webhook events
            dedupKey = sender_psid + "_" + webhook_event.message.quick_reply.payload;
          }
        } else if (webhook_event.postback) {
          dedupKey = sender_psid + "_" + webhook_event.postback.payload + "_" + (webhook_event.postback.timestamp || Date.now());
        } else if (webhook_event.delivery && webhook_event.delivery.mids) {
          // Delivery receipt webhook event - ignore silently
          continue;
        } else if (webhook_event.read) {
          // Read receipt webhook event - ignore silently
          continue;
        }

        if (dedupKey) {
          if (processedMessageIds.has(dedupKey)) {
            console.log(`[server] Ignored duplicated event/message (retry or dual-event): ${dedupKey}`);
            continue;
          }
          processedMessageIds.add(dedupKey);
        }

        // Fire and forget (asynchronously) without blocking the thread
        if (webhook_event.optin) {
          const token = webhook_event.optin.one_time_notif_token || webhook_event.optin.token;
          const topic = webhook_event.optin.payload || "ACCOUNT_UPDATE";
          if (token) {
            db.saveOtnToken(sender_psid, token, topic).then(async () => {
              console.log(`[webhook] Saved OTN token for ${sender_psid} on topic ${topic}`);
              const count = await db.getOtnTokenCount(sender_psid);
              await messenger.sendTextMessage(sender_psid, `✓ Đăng ký nhận thông báo thành công!\n\n[i] Số tin nhắn tự động dự phòng hiện có: ${count} lượt (mỗi tin nhắn thông báo điểm sẽ tiêu hao 1 lượt).`);
            }).catch(console.error);
          } else {
            console.warn("[webhook] Received optin event but missing token:", JSON.stringify(webhook_event.optin));
          }
        } else if (webhook_event.message) {
          handleMessage(sender_psid, webhook_event.message).catch(console.error);
        } else if (webhook_event.postback) {
          handlePostback(sender_psid, webhook_event.postback).catch(console.error);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

async function handleMessage(sender_psid, received_message) {
  // Ignore echo messages (sent by the bot/page itself)
  if (received_message.is_echo) {
    console.log("[server] Ignored echo message from page itself.");
    return;
  }

  if (received_message.quick_reply && received_message.quick_reply.payload) {
    const payload = received_message.quick_reply.payload;
    if (payload === "TOGGLE_GPA") await botRouter.handleMessage(sender_psid, "toggle gpa");
    else if (payload === "TOGGLE_LICH") await botRouter.handleMessage(sender_psid, "toggle lich");
    else if (payload === "TOGGLE_THI") await botRouter.handleMessage(sender_psid, "toggle thi");
    else if (payload === "TOGGLE_HOCPHI") await botRouter.handleMessage(sender_psid, "toggle hocphi");
    else if (payload === "TOGGLE_THONGBAO") await botRouter.handleMessage(sender_psid, "toggle thongbao");
    else await botRouter.handleMessage(sender_psid, payload);
  } else if (received_message.text) {
    await botRouter.handleMessage(sender_psid, received_message.text);
  }
}

async function handlePostback(sender_psid, received_postback) {
  const payload = received_postback.payload;
  if (payload === "GET_STARTED") {
    await botRouter.handleMessage(sender_psid, "hello");
  } else if (payload === "LOGIN_POSTBACK") {
    await botRouter.handleMessage(sender_psid, "/logout");
    await botRouter.handleMessage(sender_psid, "/login");
  } else {
    await botRouter.handleMessage(sender_psid, payload);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  // Automatically subscribe Page to messaging_optins webhook on startup
  messenger.ensurePageSubscribed().catch(console.error);
});
