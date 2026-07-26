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
const { startScheduler } = require("./cron");
const { PAGES } = require("./pages");

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
  res.sendStatus(401);
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

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const users = await db.getAllUsers();
  const detailedUsers = await Promise.all(users.map(async (u) => {
    const data = await db.getScrapedData(u.fb_id) || {};
    // Check complete: check if all 8 keys in PAGES are parsed
    const completedCount = PAGES.filter((p) => {
      try {
        const val = data[p.key === "canhBao" ? "canh_bao" : 
                         p.key === "thongTinSV" ? "thong_tin_sv" : 
                         p.key === "ketQuaHocTap" ? "ket_qua_hoc_tap" : 
                         p.key === "diemRenLuyen" ? "diem_ren_luyen" : 
                         p.key === "lichThi" ? "lich_thi" : 
                         p.key === "hocBongKTKL" ? "hoc_bong_ktkl" : 
                         p.key === "lichHoc" ? "lich_hoc" : "hoc_phi"];
        return !!val;
      } catch { return false; }
    }).length;

    return {
      username: u.username,
      fb_id: u.fb_id,
      complete: completedCount === PAGES.length
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

app.post("/api/admin/sync-user", requireAdmin, (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const scraperPath = path.resolve(__dirname, "./scrape.js");
  exec(`node ${scraperPath} --silent --account=${username}`, (err) => {
    if (err) console.error(`[admin-sync] User ${username} failed:`, err.message);
  });
  res.json({ success: true, message: `Bắt đầu chạy scraper cho tài khoản ${username}.` });
});

// Per-user notify test: tweak one grade in DB, re-sync, verify change-log.
// Admin clicks "Test Notify" → backend tampers old data → scraper detects "change" → notifies.
app.post("/api/admin/test-notify", requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const users = await db.getAllUsers();
  const user = users.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found" });

  const fbId = user.fb_id;
  const data = await db.getScrapedData(fbId);
  if (!data || !data.ket_qua_hoc_tap) {
    return res.status(400).json({ error: "User chưa có dữ liệu điểm. Hãy sync lần đầu trước." });
  }

  // Parse current grades, tweak one score to simulate "old data"
  let grades;
  try {
    grades = JSON.parse(data.ket_qua_hoc_tap);
  } catch {
    return res.status(400).json({ error: "Dữ liệu điểm bị hỏng, không parse được JSON." });
  }

  const targetTable = grades.find(t => t.headers?.some(h => h.includes("Tên học phần")));
  if (!targetTable || !targetTable.rows || !targetTable.rows.length) {
    return res.status(400).json({ error: "Không tìm thấy bảng điểm có cột 'Tên học phần'." });
  }

  // Tweak: flip the first course's score so change-detector fires
  const row = targetTable.rows[0];
  const originalScore = row[6];
  const tweakedScore = (parseFloat(originalScore) || 5) >= 9 ? "1.0" : "9.9";
  row[6] = tweakedScore;

  // Save tampered data as the new DB baseline
  await db.saveScrapedData(fbId, {
    canh_bao: data.canh_bao,
    thong_tin_sv: data.thong_tin_sv,
    ket_qua_hoc_tap: JSON.stringify(grades),
    diem_ren_luyen: data.diem_ren_luyen,
    lich_thi: data.lich_thi,
    hoc_bong_ktkl: data.hoc_bong_ktkl,
    lich_hoc: data.lich_hoc,
    hoc_phi: data.hoc_phi,
  });

  // Record test timestamp so result endpoint knows which alert is ours
  const testKey = `test_notify_ts_${username}`;
  const beforeTs = Date.now();
  await db.saveSystemSetting(testKey, String(beforeTs));

  // Trigger scraper — it will compare tampered baseline vs real web data → detects "change"
  const scraperPath = path.resolve(__dirname, "./scrape.js");

  const child = exec(`node ${scraperPath} --silent --account=${username}`, { timeout: 120000 }, async (err, stdout, stderr) => {
    if (err) {
      console.error(`[admin-test-notify] Scraper failed for ${username}:`, err.message);
      console.error(`[admin-test-notify] stderr:`, stderr?.slice(-500));
      await db.saveSystemSetting(testKey, `fail_${Date.now()}`);
      return;
    }

    console.log(`[admin-test-notify] Scraper stdout (last 300 chars):`, stdout?.slice(-300));

    // Check ChangeLog for a new alert after the sync
    const logs = await db.getChangeLogs(fbId, 5);
    const newAlert = logs.find(l => l.type === "alert" && new Date(l.createdAt).getTime() > beforeTs);

    if (newAlert) {
      console.log(`[admin-test-notify] SUCCESS for ${username}: alert logged: ${newAlert.content?.substring(0, 100)}`);
      await db.saveSystemSetting(testKey, `ok_${Date.now()}`);
    } else {
      console.log(`[admin-test-notify] WARNING for ${username}: no alert found after sync.`);
      await db.saveSystemSetting(testKey, `fail_${Date.now()}`);
    }
  });

  child.stdout.on('data', (d) => process.stdout.write(`[scraper-test] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[scraper-test-err] ${d}`));

  res.json({
    success: true,
    message: `Đã sửa điểm môn "${row[2]}" từ ${originalScore} → ${tweakedScore}. Đang chạy sync... Kiểm tra ChangeLog sau ~30s.`,
    detail: { course: row[2], original: originalScore, tweaked: tweakedScore },
  });
});

// Check latest test-notify result for a user
app.get("/api/admin/test-notify-result", requireAdmin, async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const users = await db.getAllUsers();
  const user = users.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found" });

  const testKey = `test_notify_ts_${username}`;
  const testState = await db.getSystemSetting(testKey, "");

  if (!testState) {
    return res.json({ success: true, status: "not_started", lastAlert: null });
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
    });
  }

  // testState is a numeric timestamp → test still running
  const elapsed = Math.round((Date.now() - parseInt(testState)) / 1000);
  res.json({ success: true, status: "running", elapsed });
});

// Simulate test: clear one page from a user's scraped data, then re-sync.
// Used to verify change-detection + notification pipeline from admin UI.
app.post("/api/admin/clear-page", requireAdmin, async (req, res) => {
  const { username, page } = req.body;
  if (!username || !page) return res.status(400).json({ error: "Missing username or page" });

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

  // Find user by username
  const users = await db.getAllUsers();
  const user = users.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Clear the page
  await db.clearScrapedPage(user.fb_id, dbKey);
  console.log(`[admin] Cleared page "${page}" (${dbKey}) for user ${username}`);

  // Trigger re-sync
  const scraperPath = path.resolve(__dirname, "./scrape.js");
  exec(`node ${scraperPath} --silent --account=${username}`, (err) => {
    if (err) console.error(`[admin-clear-page] Re-sync for ${username} failed:`, err.message);
  });

  res.json({
    success: true,
    message: `Đã xóa dữ liệu mục "${page}" (${dbKey}) của ${username}. Đang chạy đồng bộ lại...`,
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
  const { ai_provider, opencode_api_key, opencode_model, scraper_interval, scraper_mode, fb_page_token, fb_page_id, fb_verify_token, fb_app_secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  
  if (ai_provider) await db.saveSystemSetting("ai_provider", ai_provider);
  if (opencode_api_key) await db.saveSystemSetting("opencode_api_key", opencode_api_key);
  if (opencode_model) await db.saveSystemSetting("opencode_model", opencode_model);
  if (scraper_interval) await db.saveSystemSetting("scraper_interval", scraper_interval);
  if (scraper_mode) await db.saveSystemSetting("scraper_mode", scraper_mode);
  if (fb_page_token) await db.saveSystemSetting("fb_page_token", fb_page_token);
  if (fb_page_id) await db.saveSystemSetting("fb_page_id", fb_page_id);
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
        }

        if (dedupKey) {
          if (processedMessageIds.has(dedupKey)) {
            console.log(`[server] Ignored duplicated event/message (retry or dual-event): ${dedupKey}`);
            continue;
          }
          processedMessageIds.add(dedupKey);
        }

        // Fire and forget (asynchronously) without blocking the thread
        if (webhook_event.message) {
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
});
