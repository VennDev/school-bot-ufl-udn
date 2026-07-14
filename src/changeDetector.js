const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

function detectGrades(oldData, newData) {
  if (!newData) return [];
  const oldTable = oldData?.find((t) => t.headers?.includes("Tên học phần"));
  const newTable = newData.find((t) => t.headers?.includes("Tên học phần"));
  if (!newTable) return [];
  if (!oldTable) return []; // Ignore first sync notify to avoid spam

  const alerts = [];
  const oldRows = new Map(oldTable.rows.map((r) => [r[1], r])); // Ky hieu làm key
  newTable.rows.forEach((r) => {
    const oldRow = oldRows.get(r[1]);
    if (!oldRow) {
      alerts.push(`[=] Điểm mới môn: ${r[2]} - TBCHP: ${r[6]} (${r[8]})`);
    } else if (oldRow[6] !== r[6]) {
      alerts.push(`(->) Thay đổi điểm môn: ${r[2]} -> TBCHP mới: ${r[6]} (${r[8]})`);
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

  const alerts = [];
  const oldRows = new Map((oldTable.rows || []).map((r) => [r[2], r]));
  (newTable.rows || []).forEach((r) => {
    const oldRow = oldRows.get(r[2]);
    if (!oldRow) {
      alerts.push(`[~] Lịch học mới: ${r[2]} - Thứ ${r[0]} tiết ${r[1]} phòng ${r[3]}`);
    } else if (oldRow[0] !== r[0] || oldRow[1] !== r[1] || oldRow[3] !== r[3]) {
      alerts.push(`(->) Thay đổi lịch học môn: ${r[2]} -> Thứ ${r[0]} tiết ${r[1]} phòng ${r[3]}`);
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

async function checkAndNotify(fbId, oldRaw, newRaw, settings) {
  const alerts = [];

  if (settings.notify_gpa) {
    alerts.push(...detectGrades(oldRaw.ketQuaHocTap, newRaw.ketQuaHocTap));
  }
  if (settings.notify_exam) {
    alerts.push(...detectExams(oldRaw.lichThi, newRaw.lichThi));
  }
  if (settings.notify_announcement) {
    alerts.push(...detectAnnouncements(oldRaw.canhBao, newRaw.canhBao));
  }
  if (settings.notify_schedule) {
    alerts.push(...detectSchedule(oldRaw.lichHoc, newRaw.lichHoc));
  }
  if (settings.notify_tuition) {
    alerts.push(...detectTuition(oldRaw.hocPhi, newRaw.hocPhi));
  }

  for (const alert of alerts) {
    console.log(`[notifier] Sending to ${fbId}: ${alert}`);
    await messenger.sendTextMessage(fbId, alert);
    db.logChange(fbId, "alert", alert);

    if (settings.email) {
      await mailer.sendEmail(settings.email, "[UFL Bot] Cập nhật học vụ", alert);
    }
  }
}

module.exports = { checkAndNotify };
