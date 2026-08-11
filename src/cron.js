const { exec } = require("child_process");
const path = require("path");
const db = require("./db");
const messenger = require("./messenger");
const mailer = require("./mailer");

const scraperPath = path.resolve(__dirname, "./scrape.js");
let schedulerInterval = null;
let reminderInterval = null;
let scraperRunning = false; // prevent overlapping scheduled runs

// Dedup: track sent reminders so hourly checkExamReminders doesn't spam.
// Keys: "exam:${fbId}:${subject}:${dateStr}:${daysUntil}" and "tuition:${fbId}:${todayStr}"
const sentReminders = new Set();
// Purge stale keys every 24h to prevent unbounded growth
setInterval(() => {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  for (const key of sentReminders) {
    // Keep only keys containing today's date
    if (!key.includes(todayStr)) sentReminders.delete(key);
  }
}, 24 * 60 * 60 * 1000);

function parseDate(str) {
  if (!str) return null;
  const parts = str.split(/[\/\-]/);
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

async function checkExamReminders() {
  const botStatus = await db.getSystemSetting("bot_status", "running");
  if (botStatus === "stopped") return;

  const users = await db.getAllUsers();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (const u of users) {
    try {
      const data = await db.getScrapedData(u.fb_id);
      if (!data) continue;

      const settings = await db.getSettings(u.fb_id);

      // Check exam reminders if enabled
      if (settings.notify_exam && data.lich_thi) {
        const lichThi = JSON.parse(data.lich_thi);
        if (lichThi && lichThi.length >= 2) {
          for (const exam of lichThi.slice(1)) {
            const examDate = parseDate(exam[3]);
            if (!examDate) continue;

            const daysUntil = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));

            if (daysUntil === 0 || daysUntil === 1) {
              const reminderKey = `exam:${u.fb_id}:${exam[2]}:${exam[3]}:${daysUntil}`;
              if (sentReminders.has(reminderKey)) continue;
              sentReminders.add(reminderKey);

              const label = daysUntil === 0 ? "HÔM NAY THI" : "NGÀY MAI THI";
              // Utility Template: ufl_exam_reminder (5 params: subject, date, time, room, format)
              messenger.sendUtilityMessage(u.fb_id, "EVENT_REMINDER", [
                exam[2] || "?",
                exam[3] || "?",
                exam[5] || "?",
                exam[9] || "?",
                exam[10] || "?"
              ]);
              const msg = `(!) ${label} môn: ${exam[2]}\n[@] Giờ: ${exam[5]} | [#] Phòng: ${exam[9]}\n[?] Hình thức: ${exam[10] || "?"}`;
              db.logChange(u.fb_id, "exam_reminder", msg);
              const emailSubject = daysUntil === 0 ? "[UFL Bot] Nhắc nhở thi hôm nay" : "[UFL Bot] Nhắc nhở thi ngày mai";
              if (settings.email) mailer.sendEmail(settings.email, emailSubject, msg);
            }
          }
        }
      }

      // Tuition alert: check if there is an exam in the next 7 days and any unpaid tuition exists
      if (settings.notify_tuition && data.lich_thi && data.hoc_phi) {
        const lichThi = JSON.parse(data.lich_thi);
        const hocPhi = JSON.parse(data.hoc_phi);

        if (lichThi && lichThi.length >= 2 && hocPhi && hocPhi.length > 0) {
          // Check if any tuition is still unpaid/has debt
          let hasTuitionDebt = false;
          let debtDetails = [];
          
          hocPhi.forEach((t, idx) => {
            if (t.rows) {
              t.rows.forEach((r) => {
                const cleaned = r.map(cell => cell.trim().replace(/\s+/g, " ")).filter(Boolean);
                // Check for debt rows
                const isDebtRow = cleaned.some(cell => cell.toLowerCase().includes("còn nợ") || cell.toLowerCase().includes("nợ"));
                if (isDebtRow) {
                  const valStr = cleaned.join(" | ");
                  // Exclude debt rows that clearly specify 0 debt
                  const zeroDebt = cleaned.some(cell => cell.includes(": 0") || cell.match(/:\s*0\b/));
                  if (!zeroDebt) {
                    hasTuitionDebt = true;
                    debtDetails.push(`Đợt ${idx + 1}: ${valStr}`);
                  }
                }
              });
            }
          });

          if (hasTuitionDebt) {
            // Find exams within 7 days
            const upcomingExams = [];
            for (const exam of lichThi.slice(1)) {
              const examDate = parseDate(exam[3]);
              if (!examDate) continue;

              const daysUntil = (examDate - now) / (1000 * 60 * 60 * 24);
              if (daysUntil >= 0 && daysUntil <= 7) {
                upcomingExams.push(`${exam[2]} (Thi ngày ${exam[3]})`);
              }
            }

            if (upcomingExams.length > 0) {
              const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
              const tuitionKey = `tuition:${u.fb_id}:${todayStr}`;
              if (sentReminders.has(tuitionKey)) continue;
              sentReminders.add(tuitionKey);

              const alertMsg = `⚠️ CẢNH BÁO HỌC PHÍ TRƯỚC KÌ THI!\n\nBạn có lịch thi sắp tới trong vòng 7 ngày:\n- ${upcomingExams.join("\n- ")}\n\nTuy nhiên, hệ thống ghi nhận bạn vẫn chưa hoàn thành học phí:\n- ${debtDetails.slice(0, 3).join("\n- ")}\n\nVui lòng hoàn thành học phí sớm để tránh bị cấm thi hoặc ảnh hưởng kết quả thi.`;
              // Utility Template: ufl_tuition_alert (1 param: full alert text)
              messenger.sendUtilityMessage(u.fb_id, "TUITION_ALERT", [alertMsg]);
              db.logChange(u.fb_id, "tuition_exam_warning", alertMsg);
              if (settings.email) mailer.sendEmail(settings.email, "[UFL Bot] Cảnh báo học phí trước kì thi", alertMsg);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[cron] Error processing user ${u.fb_id} in checkExamReminders:`, e.message);
    }
  }
}

async function runScraper() {
  if (scraperRunning) {
    console.log("[cron] Scraper skipped: previous run still in progress.");
    return;
  }
  const botStatus = await db.getSystemSetting("bot_status", "running");
  if (botStatus === "stopped") {
    console.log("[cron] Scraper skipped: Bot is stopped.");
    return;
  }
  scraperRunning = true;
  console.log(`[cron] Starting scheduled scrape: ${new Date().toISOString()}`);
  
  const mode = await db.getSystemSetting("scraper_mode", "parallel");
  const cmd = `node ${scraperPath} --silent ${mode === "parallel" ? "--parallel" : ""}`;
  const maxParallel = process.env.SCRAPER_MAX_PARALLEL || "2";

  exec(cmd, {
    env: { ...process.env, SCRAPER_MAX_PARALLEL: maxParallel },
  }, (err, stdout, stderr) => {
    scraperRunning = false;
    if (err) {
      console.error("[cron] Scraper failed:", err.message);
      if (stderr) console.error("[cron] Scraper stderr:", stderr.slice(-500));
      return;
    }
    console.log("[cron] Scraper completed successfully.");
    if (stdout) console.log("[cron] Scraper stdout (last 300):", stdout.slice(-300));
  });
}

let schedulerTimeout = null;

function scheduleNextRun() {
  // Use configured scraper_interval (hours), default 4h.
  // With full-page refresh, 1-5min is too aggressive — school server will rate-limit.
  const intervalHours = parseInt(process.env.SCRAPER_INTERVAL_HOURS || "4", 10);
  const minMs = Math.max(intervalHours * 60 * 60 * 1000, 30 * 60 * 1000); // min 30min
  // Add 0-15min random jitter to avoid all users hitting at same second
  const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000);
  const delayMs = minMs + jitterMs;

  const delayMins = Math.round(delayMs / 60000);
  console.log(`[cron] Next full refresh in ~${delayMins} minutes.`);

  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  schedulerTimeout = setTimeout(async () => {
    await runScraper();
    scheduleNextRun();
  }, delayMs);
}

async function startScheduler() {
  const intervalHours = parseInt(process.env.SCRAPER_INTERVAL_HOURS || "4", 10);
  console.log(`[cron] Scheduler started (full-page refresh every ~${intervalHours}h + 0-15min jitter).`);

  await runScraper();
  await checkExamReminders();

  scheduleNextRun();

  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(checkExamReminders, 60 * 60 * 1000);
}

module.exports = { startScheduler };
