const fs = require("fs");
const path = require("path");

const LOG_DIR = path.resolve(__dirname, "../logs/notifications");

// Map notification template → scraped-data fields that feed it.
// Used to slice the old/new snapshot down to the relevant category.
const FIELDS_BY_TEMPLATE = {
  ACCOUNT_UPDATE: ["ketQuaHocTap"],
  ANNOUNCEMENT: ["lichThi", "canhBao", "lichHoc"],
  TUITION_ALERT: ["hocPhi"],
};

// Write a detailed debug log every time a notification is about to be sent.
// Captures the exact alerts plus the old/new data slices so future
// "why did it notify / why didn't it" questions can be answered offline.
function logNotificationDiff({ fbId, templateKey, alerts = [], deduped = [], oldRaw = {}, newRaw = {} }) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const fields = FIELDS_BY_TEMPLATE[templateKey] || Object.keys(oldRaw);
    const slice = raw => Object.fromEntries(fields.map(f => [f, raw[f] ?? null]));
    const timestamp = new Date().toISOString();
    const file = path.join(LOG_DIR, `${fbId}-${templateKey}-${timestamp.replace(/[:.]/g, "-")}.json`);
    const payload = {
      timestamp,
      fbId,
      templateKey,
      alerts,
      deduped,
      oldData: slice(oldRaw),
      newData: slice(newRaw),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    console.log(`[notifLog] ${file} (${alerts.length} alerts)`);
    return file;
  } catch (error) {
    console.error("[notifLog] Write failed:", error.message);
    return null;
  }
}

module.exports = { logNotificationDiff };
