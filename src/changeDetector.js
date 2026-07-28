const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

function detectGrades(oldData, newData) {
  if (!newData) return [];
  const oldTable = oldData?.find((t) => t.headers?.includes("Tên học phần"));
  const newTable = newData.find((t) => t.headers?.includes("Tên học phần"));
  if (!newTable || !newTable.rows) return [];
  if (!oldTable || !oldTable.rows || oldTable.rows.length === 0) return []; // Ignore first sync / empty snapshot notify to avoid spam

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
      // Only treat as single new grade alert if old table was not a partial snapshot (expansion across semesters)
      if (oldTable.rows.length >= newTable.rows.length - 3) {
        alerts.push(`[=] Điểm mới môn: ${r[nameIdx]} - TBCHP: ${r[scoreIdx]} (${r[charIdx] || "?"})`);
      }
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

// Normalize an announcement item to a stable string for comparison.
// Arrays (table rows) get cells joined; objects use .content; strings used as-is.
function _annItemKey(item) {
  if (Array.isArray(item)) {
    return item.map(c => String(c || "").trim().replace(/\s+/g, " ")).join(" | ");
  }
  if (item && typeof item.content === "string") return item.content.trim().replace(/\s+/g, " ");
  return JSON.stringify(item);
}

function detectAnnouncements(oldData, newData) {
  if (!newData || !newData.length) return [];
  if (!oldData || !oldData.length) return []; // Ignore first sync notify to avoid spam

  const alerts = [];
  const oldTexts = new Set(oldData.map(_annItemKey));
  newData.forEach((item) => {
    const key = _annItemKey(item);
    if (!oldTexts.has(key)) {
      alerts.push(`[!] Báo nghỉ/Học vụ mới: ${key.substring(0, 150)}...`);
    }
  });
  return alerts;
}

function detectSchedule(oldData, newData) {
  if (!newData || !newData.length) return [];

  // Match schedule table by header — same logic as getScheduleEntries in botRouter.js.
  // Portal may use "Tên học phần", "Tên môn", or "Học phần".
  const norm = (h) => String(h || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const isScheduleTable = (t) => {
    const headers = (t.headers || []).map(norm);
    return headers.some(h => h.includes("ten hoc phan") || h.includes("ten mon") || h === "mon hoc" || h === "hoc phan");
  };

  const oldTable = oldData?.find(isScheduleTable);
  const newTable = newData.find(isScheduleTable);
  if (!newTable) return [];
  if (!oldTable) return []; // Ignore first sync notify to avoid spam

  // Dynamically find header indices to prevent column shift bugs
  const headers = (newTable.headers || []).map(norm);
  const nameIdx = headers.findIndex(h => h.includes("ten hoc phan") || h.includes("ten mon") || h === "mon hoc" || h === "hoc phan");
  const thuIdx = headers.findIndex(h => h === "thu" || h.includes("thu"));
  const tietIdx = headers.findIndex(h => h === "tiet" || h.includes("tiet"));
  const phongIdx = headers.findIndex(h => h === "phong" || h.includes("phong"));

  const nameK = nameIdx !== -1 ? nameIdx : 2;
  const thuK = thuIdx !== -1 ? thuIdx : 0;
  const tietK = tietIdx !== -1 ? tietIdx : 1;
  const phongK = phongIdx !== -1 ? phongIdx : 3;

  const alerts = [];
  const oldRows = new Map((oldTable.rows || []).map((r) => [r[nameK], r]));
  (newTable.rows || []).forEach((r) => {
    const name = r[nameK];
    // Skip section-header rows (single cell spanning columns, no course name)
    if (!name || String(name).length < 2) return;

    const oldRow = oldRows.get(name);
    if (!oldRow) {
      alerts.push(`[~] Lịch học mới: ${name} - Thứ ${r[thuK]} tiết ${r[tietK]} phòng ${r[phongK]}`);
    } else if (oldRow[thuK] !== r[thuK] || oldRow[tietK] !== r[tietK] || oldRow[phongK] !== r[phongK]) {
      alerts.push(`(->) Thay đổi lịch học môn: ${name} -> Thứ ${r[thuK]} tiết ${r[tietK]} phòng ${r[phongK]}`);
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
