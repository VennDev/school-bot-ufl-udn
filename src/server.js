require("dotenv").config();
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

app.post("/api/admin/toggle-bot", requireAdmin, (req, res) => {
  const current = db.getSystemSetting("bot_status", "running");
  const nextState = current === "running" ? "stopped" : "running";
  db.saveSystemSetting("bot_status", nextState);
  res.json({ success: true, status: nextState });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  const detailedUsers = users.map((u) => {
    const data = db.getScrapedData(u.fb_id) || {};
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
  });

  const completeCount = detailedUsers.filter((u) => u.complete).length;
  
  const hasConfig = db.getSystemSetting("fb_page_token", "") && 
                    db.getSystemSetting("fb_verify_token", "") && 
                    db.getSystemSetting("fb_app_secret", "");
  
  const botStatus = hasConfig ? db.getSystemSetting("bot_status", "running") : "unconfigured";

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

app.post("/api/admin/delete-user", requireAdmin, (req, res) => {
  const { fb_id } = req.query;
  if (!fb_id) return res.status(400).json({ error: "Missing fb_id" });

  db.deleteUser(fb_id);
  res.json({ success: true });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({
    ai_provider: db.getSystemSetting("ai_provider", process.env.AI_PROVIDER || "opencode"),
    opencode_api_key: db.getSystemSetting("opencode_api_key", process.env.OPENCODE_API_KEY || "public"),
    opencode_model: db.getSystemSetting("opencode_model", process.env.OPENCODE_MODEL || "deepseek-v4-flash-free"),
    scraper_interval: db.getSystemSetting("scraper_interval", "4"), // hours
    scraper_mode: db.getSystemSetting("scraper_mode", "parallel"), // parallel / sequential
    fb_page_token: db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || ""),
    fb_verify_token: db.getSystemSetting("fb_verify_token", process.env.FB_VERIFY_TOKEN || ""),
    fb_app_secret: db.getSystemSetting("fb_app_secret", process.env.FB_APP_SECRET || ""),
    smtp_host: db.getSystemSetting("smtp_host", ""),
    smtp_port: db.getSystemSetting("smtp_port", "587"),
    smtp_user: db.getSystemSetting("smtp_user", ""),
    smtp_pass: db.getSystemSetting("smtp_pass", ""),
    smtp_from: db.getSystemSetting("smtp_from", "")
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { ai_provider, opencode_api_key, opencode_model, scraper_interval, scraper_mode, fb_page_token, fb_verify_token, fb_app_secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  
  if (ai_provider) db.saveSystemSetting("ai_provider", ai_provider);
  if (opencode_api_key) db.saveSystemSetting("opencode_api_key", opencode_api_key);
  if (opencode_model) db.saveSystemSetting("opencode_model", opencode_model);
  if (scraper_interval) db.saveSystemSetting("scraper_interval", scraper_interval);
  if (scraper_mode) db.saveSystemSetting("scraper_mode", scraper_mode);
  if (fb_page_token) db.saveSystemSetting("fb_page_token", fb_page_token);
  if (fb_verify_token) db.saveSystemSetting("fb_verify_token", fb_verify_token);
  if (fb_app_secret) db.saveSystemSetting("fb_app_secret", fb_app_secret);
  if (smtp_host !== undefined) db.saveSystemSetting("smtp_host", smtp_host);
  if (smtp_port !== undefined) db.saveSystemSetting("smtp_port", smtp_port);
  if (smtp_user !== undefined) db.saveSystemSetting("smtp_user", smtp_user);
  if (smtp_pass !== undefined) db.saveSystemSetting("smtp_pass", smtp_pass);
  if (smtp_from !== undefined) db.saveSystemSetting("smtp_from", smtp_from);

  res.json({ success: true, message: "Cấu hình hệ thống đã được lưu." });
});

// Messenger Webhook Validation
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    const sysVerifyToken = db.getSystemSetting("fb_verify_token", process.env.FB_VERIFY_TOKEN || "");
    if (mode === "subscribe" && token === sysVerifyToken) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Messenger Message Handlers
app.post("/webhook", (req, res) => {
  const hasConfig = db.getSystemSetting("fb_page_token", "") && 
                    db.getSystemSetting("fb_verify_token", "") && 
                    db.getSystemSetting("fb_app_secret", "");
  const botStatus = hasConfig ? db.getSystemSetting("bot_status", "running") : "unconfigured";

  if (botStatus !== "running") {
    return res.status(200).send("BOT_NOT_RUNNING");
  }

  const body = req.body;
  if (body.object === "page") {
    body.entry.forEach((entry) => {
      const webhook_event = entry.messaging[0];
      const sender_psid = webhook_event.sender.id;

      if (webhook_event.message) {
        handleMessage(sender_psid, webhook_event.message);
      } else if (webhook_event.postback) {
        handlePostback(sender_psid, webhook_event.postback);
      }
    });
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

function handleMessage(sender_psid, received_message) {
  if (received_message.quick_reply && received_message.quick_reply.payload) {
    const payload = received_message.quick_reply.payload;
    if (payload === "TOGGLE_GPA") botRouter.handleMessage(sender_psid, "toggle gpa");
    else if (payload === "TOGGLE_LICH") botRouter.handleMessage(sender_psid, "toggle lich");
    else if (payload === "TOGGLE_THI") botRouter.handleMessage(sender_psid, "toggle thi");
    else if (payload === "TOGGLE_HOCPHI") botRouter.handleMessage(sender_psid, "toggle hocphi");
    else if (payload === "TOGGLE_THONGBAO") botRouter.handleMessage(sender_psid, "toggle thongbao");
  } else if (received_message.text) {
    botRouter.handleMessage(sender_psid, received_message.text);
  }
}

function handlePostback(sender_psid, received_postback) {
  if (received_postback.payload === "GET_STARTED") {
    botRouter.handleMessage(sender_psid, "hello");
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
