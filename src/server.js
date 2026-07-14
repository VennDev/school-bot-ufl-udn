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

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const MOCK_TOKEN = crypto.encrypt("admin-session");

// Cache to prevent duplicate messages (Facebook retry mitigation)
const processedMessageIds = new Set();
const clearCacheInterval = setInterval(() => processedMessageIds.clear(), 60000); // clear every 1 minute

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
  const scraperPath = path.resolve(__dirname, "./scrape.js");
  exec(`node ${scraperPath} --parallel`, (err) => {
    if (err) console.error("[admin-sync] Global failed:", err.message);
  });
  res.json({ success: true, message: "Bắt đầu chạy scraper ngầm cho toàn bộ users qua Tor." });
});

app.post("/api/admin/sync-user", requireAdmin, (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const scraperPath = path.resolve(__dirname, "./scrape.js");
  exec(`node ${scraperPath} --account=${username}`, (err) => {
    if (err) console.error(`[admin-sync] User ${username} failed:`, err.message);
  });
  res.json({ success: true, message: `Bắt đầu chạy scraper cho tài khoản ${username}.` });
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
  const { ai_provider, opencode_api_key, opencode_model, scraper_interval, scraper_mode, fb_page_token, fb_verify_token, fb_app_secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  
  if (ai_provider) await db.saveSystemSetting("ai_provider", ai_provider);
  if (opencode_api_key) await db.saveSystemSetting("opencode_api_key", opencode_api_key);
  if (opencode_model) await db.saveSystemSetting("opencode_model", opencode_model);
  if (scraper_interval) await db.saveSystemSetting("scraper_interval", scraper_interval);
  if (scraper_mode) await db.saveSystemSetting("scraper_mode", scraper_mode);
  if (fb_page_token) await db.saveSystemSetting("fb_page_token", fb_page_token);
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
      const webhook_event = entry.messaging[0];
      const sender_psid = webhook_event.sender.id;
      const message_id = webhook_event.message ? webhook_event.message.mid : null;

      if (message_id) {
        if (processedMessageIds.has(message_id)) {
          console.log(`[server] Ignored duplicated message ID (retry): ${message_id}`);
          continue;
        }
        processedMessageIds.add(message_id);
      }

      // Fire and forget (asynchronously) without blocking the thread
      if (webhook_event.message) {
        handleMessage(sender_psid, webhook_event.message).catch(console.error);
      } else if (webhook_event.postback) {
        handlePostback(sender_psid, webhook_event.postback).catch(console.error);
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
  } else if (received_message.text) {
    await botRouter.handleMessage(sender_psid, received_message.text);
  }
}

async function handlePostback(sender_psid, received_postback) {
  if (received_postback.payload === "GET_STARTED") {
    await botRouter.handleMessage(sender_psid, "hello");
  } else if (received_postback.payload === "LOGIN_POSTBACK") {
    await botRouter.handleMessage(sender_psid, "/login");
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
