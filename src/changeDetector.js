const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

function detectGrades(oldData, newData) {
  if (!newData) return [];
  const oldTable = oldData?.find((t) => t.headers?.includes("Tên học phần"));
  const newTable = newData.find((t) => t.headers?.includes("Tên học phần"));
  if (!newTable) return [];
  if (!oldTable) return []; // Ignore first sync notify to avoid spam

  const headers = newTable.headers || [];
  const keyIdx = headers.indexOf("Mã học phần") !== -1 ? headers.indexOf("Mã học phần") : (headers.indexOf("Mã lớp học phần") !== -1 ? headers.indexOf("Mã lớp học phần") : 1);
  const nameIdx = headers.indexOf("Tên học phần") !== -1 ? headers.indexOf("Tên học phần") : 2;
  const scoreIdx = headers.indexOf("Điểm TBCHP") !== -1 ? headers.indexOf("Điểm TBCHP") : (headers.indexOf("Điểm tổng kết (10)") !== -1 ? headers.indexOf("Điểm tổng kết (10)") : 6);
  const charIdx = headers.indexOf("Điểm chữ") !== -1 ? headers.indexOf("Điểm chữ") : 8;

  const alerts = [];
  const oldRows = new Map(oldTable.rows.map((r) => [r[keyIdx], r])); // Ky hieu làm key
  newTable.rows.forEach((r) => {
    const oldRow = oldRows.get(r[keyIdx]);
    if (!oldRow) {
      alerts.push(`[=] Điểm mới môn: ${r[nameIdx]} - TBCHP: ${r[scoreIdx]} (${r[charIdx] || "?"})`);
    } else if (oldRow[scoreIdx] !== r[scoreIdx]) {
      alerts.push(`(->) Thay đổi điểm môn: ${r[nameIdx]} -> TBCHP mới: ${r[scoreIdx]} (${r[charIdx] || "?"})`);
    }
  });
  return alerts;
}

function detectExams(oldData, newData) {
  if (!newData || newData.length < 2) return [];
  if (!oldData || oldData.length < 2) return []; // Ignore first sync notify to avoid spam

  const alerts = [];
  const oldExams = new Map(oldData.slice(1).map((r) => [r[1], r])); // Ma hoc phan
  newData.slice(1).forEach((r) => {
    const oldExam = oldExams.get(r[1]);
    if (!oldExam) {
      alerts.push(`[~] Lịch thi mới môn: ${r[2]} ngày ${r[3]} phòng ${r[9]}`);
    } else if (oldExam[3] !== r[3] || oldExam[9] !== r[9]) {
      alerts.push(`(->) Thay đổi lịch thi môn: ${r[2]} -> Ngày: ${r[3]} phòng: ${r[9]}`);
    }
  });
  return alerts;
}

function detectAnnouncements(oldData, newData) {
  if (!newData || !newData.length) return [];
  if (!oldData || !oldData.length) return []; // Ignore first sync notify to avoid spam

  const alerts = [];
  const oldTexts = new Set(oldData.map((item) => item.content || JSON.stringify(item)));
  newData.forEach((item) => {
    const txt = item.content || JSON.stringify(item);
    if (!oldTexts.has(txt)) {
      alerts.push(`[!] Báo nghỉ/Học vụ mới: ${txt.substring(0, 150)}...`);
    }
  });
  return alerts;
}

function detectSchedule(oldData, newData) {
  if (!newData || !newData.length) return [];
  const oldTable = oldData?.find((t) => t.headers?.includes("Tên học phần"));
  const newTable = newData.find((t) => t.headers?.includes("Tên học phần"));
  if (!newTable) return [];
  if (!oldTable) return []; // Ignore first sync notify to avoid spam

  // Dynamically find header indices to prevent column shift bugs
  const headers = newTable.headers || [];
  const nameIdx = headers.indexOf("Tên học phần");
  const thuIdx = headers.indexOf("Thứ");
  const tietIdx = headers.indexOf("Tiết");
  const phongIdx = headers.indexOf("Phòng");

  const nameK = nameIdx !== -1 ? nameIdx : 2;
  const thuK = thuIdx !== -1 ? thuIdx : 0;
  const tietK = tietIdx !== -1 ? tietIdx : 1;
  const phongK = phongIdx !== -1 ? phongIdx : 3;

  const alerts = [];
  const oldRows = new Map((oldTable.rows || []).map((r) => [r[nameK], r]));
  (newTable.rows || []).forEach((r) => {
    const oldRow = oldRows.get(r[nameK]);
    if (!oldRow) {
      alerts.push(`[~] Lịch học mới: ${r[nameK]} - Thứ ${r[thuK]} tiết ${r[tietK]} phòng ${r[phongK]}`);
    } else if (oldRow[thuK] !== r[thuK] || oldRow[tietK] !== r[tietK] || oldRow[phongK] !== r[phongK]) {
      alerts.push(`(->) Thay đổi lịch học môn: ${r[nameK]} -> Thứ ${r[thuK]} tiết ${r[tietK]} phòng ${r[phongK]}`);
    }
  });
  return alerts;
}

function detectTuition(oldData, newData) {
  if (!newData) return [];
  // basic string diff for tuition table rows
  const oldStr = JSON.stringify(oldData);
  const newStr = JSON.stringify(newData);
  if (oldStr !== newStr && newStr.includes("Nợ")) {
    return ["[$] Có thay đổi hoặc công nợ mới về học phí. Vui lòng kiểm tra."];
  }
  return [];
}

// Utility Template mapping per notification category.
// Templates bypass 24h window. Created via: npm run setup-templates
const T = messenger.UTILITY_TEMPLATES;

async function checkAndNotify(fbId, oldRaw, newRaw, settings) {
  // Collect (alert, templateKey) pairs
  const items = [];

  if (settings.notify_gpa) {
    for (const a of detectGrades(oldRaw.ketQuaHocTap, newRaw.ketQuaHocTap)) {
      items.push([a, "ACCOUNT_UPDATE"]);
    }
  }
  if (settings.notify_exam) {
    for (const a of detectExams(oldRaw.lichThi, newRaw.lichThi)) {
      items.push([a, "ANNOUNCEMENT"]);
    }
  }
  if (settings.notify_announcement) {
    for (const a of detectAnnouncements(oldRaw.canhBao, newRaw.canhBao)) {
      items.push([a, "ANNOUNCEMENT"]);
    }
  }
  if (settings.notify_schedule) {
    for (const a of detectSchedule(oldRaw.lichHoc, newRaw.lichHoc)) {
      items.push([a, "ANNOUNCEMENT"]);
    }
  }
  if (settings.notify_tuition) {
    for (const a of detectTuition(oldRaw.hocPhi, newRaw.hocPhi)) {
      items.push([a, "TUITION_ALERT"]);
    }
  }

  for (const [alert, templateKey] of items) {
    console.log(`[notifier] Sending to ${fbId} [${templateKey}]: ${alert}`);
    await messenger.sendUtilityMessage(fbId, templateKey, [alert]);
    db.logChange(fbId, "alert", alert);

    if (settings.email) {
      await mailer.sendEmail(settings.email, "[UFL Bot] Cập nhật học vụ", alert);
    }
  }
}

module.exports = { checkAndNotify, detectGrades, detectExams, detectAnnouncements, detectSchedule, detectTuition };
