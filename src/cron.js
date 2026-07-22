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
              const alertMsg = `⚠️ CẢNH BÁO HỌC PHÍ TRƯỚC KÌ THI!\n\nBạn có lịch thi sắp tới trong vòng 7 ngày:\n- ${upcomingExams.join("\n- ")}\n\nTuy nhiên, hệ thống ghi nhận bạn vẫn chưa hoàn thành học phí:\n- ${debtDetails.slice(0, 3).join("\n- ")}\n\nVui lòng hoàn thành học phí sớm để tránh bị cấm thi hoặc ảnh hưởng kết quả thi.`;
              messenger.sendTextMessage(u.fb_id, alertMsg);
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
  const botStatus = await db.getSystemSetting("bot_status", "running");
  if (botStatus === "stopped") {
    console.log("[cron] Scraper skipped: Bot is stopped.");
    return;
  }
  console.log(`[cron] Starting scheduled scrape: ${new Date().toISOString()}`);
  
  const mode = await db.getSystemSetting("scraper_mode", "parallel");
  const cmd = `node ${scraperPath} ${mode === "parallel" ? "--parallel" : ""}`;

  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error("[cron] Scraper failed:", err.message);
      return;
    }
    console.log("[cron] Scraper completed successfully.");
  });
}

let schedulerTimeout = null;

function scheduleNextRun() {
  // Random delay between 10 and 30 minutes
  const minMins = 10;
  const maxMins = 30;
  const randomMins = Math.floor(Math.random() * (maxMins - minMins + 1)) + minMins;
  const delayMs = randomMins * 60 * 1000;

  console.log(`[cron] Next schedule sync in ${randomMins} minutes.`);

  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  schedulerTimeout = setTimeout(async () => {
    await runScraper();
    scheduleNextRun();
  }, delayMs);
}

async function startScheduler() {
  console.log(`[cron] Scheduler started with random interval (10 - 30 mins).`);

  await runScraper();
  await checkExamReminders();

  scheduleNextRun();

  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(checkExamReminders, 60 * 60 * 1000);
}

module.exports = { startScheduler };
