const nodemailer = require("nodemailer");
const db = require("./db");

function getTransporter() {
  const host = db.getSystemSetting("smtp_host", "");
  const port = parseInt(db.getSystemSetting("smtp_port", "587"));
  const user = db.getSystemSetting("smtp_user", "");
  const pass = db.getSystemSetting("smtp_pass", "");

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendEmail(to, subject, body) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log("[mailer] SMTP not configured, skipping email.");
    return false;
  }

  const from = db.getSystemSetting("smtp_from", db.getSystemSetting("smtp_user", ""));

  try {
    await transporter.sendMail({ from, to, subject, text: body });
    console.log(`[mailer] Sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[mailer] Failed to send to ${to}:`, err.message);
    return false;
  }
}

module.exports = { sendEmail };
