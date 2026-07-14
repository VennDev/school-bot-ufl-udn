const { exec } = require("child_process");
const path = require("path");
const db = require("./db");
const messenger = require("./messenger");
const mailer = require("./mailer");

const scraperPath = path.resolve(__dirname, "./scrape.js");
let schedulerInterval = null;
let reminderInterval = null;

function parseDate(str) {
  if (!str) return null;
  const parts = str.split(/[\/\-]/);
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

function checkExamReminders() {
  const botStatus = db.getSystemSetting("bot_status", "running");
  if (botStatus === "stopped") return;

  const users = db.getAllUsers();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (const u of users) {
    try {
      const data = db.getScrapedData(u.fb_id);
      if (!data || !data.lich_thi) continue;

      const lichThi = JSON.parse(data.lich_thi);
      if (!lichThi || lichThi.length < 2) continue;

      const settings = db.getSettings(u.fb_id);
      if (!settings.notify_exam) continue;

      for (const exam of lichThi.slice(1)) {
        const examDate = parseDate(exam[3]);
        if (!examDate) continue;

        const daysUntil = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));

        if (daysUntil === 0) {
          const msg = `(!) HÔM NAY THI môn: ${exam[2]}\n[@] Giờ: ${exam[5]} | [#] Phòng: ${exam[9]}\n[?] Hình thức: ${exam[10] || "?"}`;
          messenger.sendTextMessage(u.fb_id, msg);
          db.logChange(u.fb_id, "exam_reminder", msg);
          if (settings.email) mailer.sendEmail(settings.email, "[UFL Bot] Nhắc nhở thi hôm nay", msg);
        } else if (daysUntil === 1) {
          const msg = `[@] NGÀY MAI THI môn: ${exam[2]}\n[@] Giờ: ${exam[5]} | [#] Phòng: ${exam[9]}\n[?] Hình thức: ${exam[10] || "?"}`;
          messenger.sendTextMessage(u.fb_id, msg);
          db.logChange(u.fb_id, "exam_reminder", msg);
          if (settings.email) mailer.sendEmail(settings.email, "[UFL Bot] Nhắc nhở thi ngày mai", msg);
        }
      }
    } catch {}
  }
}

function runScraper() {
  const botStatus = db.getSystemSetting("bot_status", "running");
  if (botStatus === "stopped") {
    console.log("[cron] Scraper skipped: Bot is stopped.");
    return;
  }
  console.log(`[cron] Starting scheduled scrape: ${new Date().toISOString()}`);
  
  const mode = db.getSystemSetting("scraper_mode", "parallel");
  const cmd = `node ${scraperPath} ${mode === "parallel" ? "--parallel" : ""}`;

  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error("[cron] Scraper failed:", err.message);
      return;
    }
    console.log("[cron] Scraper completed successfully.");
  });
}

function startScheduler() {
  const intervalHours = parseFloat(db.getSystemSetting("scraper_interval", "4"));
  const intervalMs = intervalHours * 60 * 60 * 1000;

  console.log(`[cron] Scheduler started. Running every ${intervalHours} hours.`);

  runScraper();
  checkExamReminders();

  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(runScraper, intervalMs);

  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(checkExamReminders, 60 * 60 * 1000);
}

module.exports = { startScheduler };
