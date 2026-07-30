const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

function detectGrades(oldData, newData) {
  if (!Array.isArray(newData)) return [];
  const norm = value => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/\s+/g, " ").trim();
  const isGradeTable = table => {
    const headers = (table?.headers || []).map(norm);
    const hasCourse = headers.some(h => h.includes("ten hoc phan"));
    // Curriculum table also has "Tên học phần". Require grade-specific columns.
    const hasGradeColumns = headers.some(h => /tbchp|diem tk|diem tong ket|diem chu|diem thi/.test(h));
    return hasCourse && hasGradeColumns;
  };

  const oldTables = Array.isArray(oldData) ? oldData.filter(isGradeTable) : [];
  const newTables = newData.filter(isGradeTable);
  if (!newTables.length || !oldTables.length || !oldTables.some(t => t.rows?.length)) return [];

  const hasSemesterMetadata = tables => tables.some(table => {
    const headers = (table.headers || []).map(norm);
    return headers.some(header => header.includes("nam hoc") || header.includes("hoc ky"));
  });
  // First run after multi-semester format migration: old snapshot has one
  // unlabelled table, new snapshot has every year/semester. Do not spam old rows.
  const hasComparableSemesterMetadata = hasSemesterMetadata(newTables) && hasSemesterMetadata(oldTables);
  if (hasSemesterMetadata(newTables) && !hasSemesterMetadata(oldTables)) return [];

  const headers = newTables.find(t => t.headers?.length)?.headers || [];
  const normalizedHeaders = headers.map(norm);
  const findHeader = pattern => normalizedHeaders.findIndex(h => pattern.test(h));
  const keyIdx = findHeader(/ma hoc phan|ma lop hoc phan|ky hieu|ma hp/) !== -1
    ? findHeader(/ma hoc phan|ma lop hoc phan|ky hieu|ma hp/) : 1;
  const nameIdx = findHeader(/ten hoc phan/) !== -1 ? findHeader(/ten hoc phan/) : 2;
  const scoreIdx = findHeader(/tbchp|diem tk|diem tong ket/) !== -1 ? findHeader(/tbchp|diem tk|diem tong ket/) : 6;
  const charIdx = findHeader(/diem chu|diem tk \(ch\)/) !== -1 ? findHeader(/diem chu|diem tk \(ch\)/) : 8;
  const yearIdx = findHeader(/nam hoc/);
  const semesterIdx = findHeader(/hoc ky/);
  const rowKey = row => [row[keyIdx], row[nameIdx], yearIdx >= 0 ? row[yearIdx] : "", semesterIdx >= 0 ? row[semesterIdx] : ""].join("|");

  const oldRows = new Map();
  const oldBaseRows = new Map();
  const baseKey = row => [row[keyIdx], row[nameIdx]].join("|");
  oldTables.flatMap(t => t.rows || []).forEach(row => {
    oldRows.set(rowKey(row), row);
    oldBaseRows.set(baseKey(row), row);
  });
  const alerts = [];
  const seenAlerts = new Set();
  newTables.flatMap(t => t.rows || []).forEach(row => {
    const name = String(row[nameIdx] || "").trim();
    if (!name || /^tên học phần$/i.test(name)) return;
    // Fallback base key prevents one-time migration spam when year/semester
    // metadata was added to existing DB rows.
    const oldRow = oldRows.get(rowKey(row)) || (!hasComparableSemesterMetadata ? oldBaseRows.get(baseKey(row)) : null);
    let alert = null;
    if (!oldRow) {
      alert = `[=] Điểm mới môn: ${name} - TBCHP: ${row[scoreIdx]} (${row[charIdx] || "?"})`;
    } else if (oldRow[scoreIdx] !== row[scoreIdx]) {
      alert = `(->) Thay đổi điểm môn: ${name} -> TBCHP mới: ${row[scoreIdx]} (${row[charIdx] || "?"})`;
    }
    if (alert && !seenAlerts.has(alert)) {
      seenAlerts.add(alert);
      alerts.push(alert);
    }
  });
  return alerts;
}

function detectExams(oldData, newData) {
  if (!newData || newData.length < 2) return [];
  if (!oldData || oldData.length < 2) return []; // Ignore first sync notify to avoid spam
  const hasMeta = rows => rows[0]?.some(cell => /năm học|học kỳ/i.test(String(cell)));
  if (hasMeta(newData) && !hasMeta(oldData)) return []; // Ignore format migration

  const alerts = [];
  const examHeaders = newData[0] || [];
  const headerIdx = pattern => examHeaders.findIndex(cell => pattern.test(String(cell)));
  const yearIdx = headerIdx(/năm học/i);
  const semesterIdx = headerIdx(/học kỳ/i);
  // One subject can be examined twice in a semester (lần thi / đợt thi).
  // Without those columns both rows share a key and every sync reports a
  // phantom reschedule between them.
  const attemptIdx = headerIdx(/lần thi/i);
  const roundIdx = headerIdx(/đợt thi/i);
  const at = (row, idx) => (idx >= 0 ? String(row[idx] ?? "").trim() : "");
  const examKey = row => [row[1], at(row, yearIdx), at(row, semesterIdx), at(row, attemptIdx), at(row, roundIdx)].join("|");
  const slot = row => `${String(row[3] ?? "").trim()}|${String(row[9] ?? "").trim()}`;
  const oldSlots = new Map();
  oldData.slice(1).forEach((r) => {
    const key = examKey(r);
    if (!oldSlots.has(key)) oldSlots.set(key, new Set());
    oldSlots.get(key).add(slot(r));
  });

  // Past exams cannot change in a way the student can act on. Skip them so a
  // historical row never resurfaces as a notification.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isPast = (value) => {
    const parts = String(value || "").trim().split(/[\/\-]/).map(Number);
    if (parts.length !== 3 || parts.some(part => !part)) return false;
    return new Date(parts[2], parts[1] - 1, parts[0]) < today;
  };

  newData.slice(1).forEach((r) => {
    if (isPast(r[3])) return;
    const known = oldSlots.get(examKey(r));
    if (!known) {
      alerts.push(`[~] Lịch thi mới môn: ${r[2]} ngày ${r[3]} phòng ${r[9]}`);
    } else if (!known.has(slot(r))) {
      alerts.push(`(->) Thay đổi lịch thi môn: ${r[2]} -> Ngày: ${r[3]} phòng: ${r[9]}`);
    }
  });
  return [...new Set(alerts)];
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
  // Previous extractor stored whole page as one truncated item. Do not treat
  // parser migration as dozens of new announcements.
  if (oldData.length === 1 && _annItemKey(oldData[0]).length >= 2000 && newData.length > 1) return [];

  const alerts = [];
  const oldTexts = [...new Set(oldData.map(_annItemKey))];
  newData.forEach((item) => {
    const key = _annItemKey(item);
    const known = oldTexts.some(old => old === key || old.includes(key) || (key.length > 20 && key.includes(old)));
    if (!known) {
      alerts.push(`[!] Báo nghỉ/Học vụ mới: ${key.substring(0, 150)}...`);
    }
  });
  return alerts;
}

function detectSchedule(oldData, newData) {
  if (!Array.isArray(newData) || !newData.length) return [];

  const norm = value => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/\s+/g, " ").trim();
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const findColumn = (headers, aliases) => aliases
    .map(alias => headers.indexOf(norm(alias)))
    .find(index => index !== -1);
  const isScheduleTable = table => {
    const headers = (table?.headers || []).map(norm);
    return headers.includes("ten hoc phan") || headers.includes("ten mon hoc") ||
      headers.includes("ten mon") || headers.includes("mon hoc") || headers.includes("hoc phan");
  };
  const tables = data => Array.isArray(data) ? data.filter(isScheduleTable) : [];
  const oldTables = tables(oldData);
  const newTables = tables(newData);
  if (!newTables.length || !oldTables.length) return []; // First sync: no notification.

  const hasMeta = list => list.some(table => (table.headers || []).some(header =>
    /năm học|học kỳ/i.test(String(header))
  ));
  if (hasMeta(newTables) && !hasMeta(oldTables)) return []; // Scraper format migration.

  // Parse every table with its own headers. Merging rows under first table's
  // column map caused false changes when portal returned different layouts.
  const extract = table => {
    const headers = (table.headers || []).map(norm);
    const name = findColumn(headers, ["Tên học phần", "Tên môn học", "Tên môn", "Môn học", "Học phần"]);
    const day = findColumn(headers, ["Thứ", "Ngày"]);
    const period = findColumn(headers, ["Tiết", "Tiết học"]);
    if (name === undefined || day === undefined || period === undefined) return [];
    const room = findColumn(headers, ["Phòng", "Phòng học"]);
    const className = findColumn(headers, ["Tên lớp tín chỉ", "Lớp học phần", "Lớp tín chỉ", "Lớp"]);
    const time = findColumn(headers, ["Thời gian", "Ngày học"]);
    const year = findColumn(headers, ["Năm học"]);
    const semester = findColumn(headers, ["Học kỳ"]);
    return (table.rows || []).map(row => ({
      name: clean(row[name]),
      className: className === undefined ? "" : clean(row[className]),
      day: clean(row[day]),
      period: clean(row[period]),
      room: room === undefined ? "" : clean(row[room]),
      time: time === undefined ? "" : clean(row[time]),
      year: year === undefined ? clean(table.year || table.yearValue) : clean(row[year]),
      semester: semester === undefined ? clean(table.semester || table.semesterValue) : clean(row[semester]),
    })).filter(entry => entry.name && entry.day && entry.period && !/^tên học phần|^tên môn/i.test(entry.name));
  };

  const oldEntries = oldTables.flatMap(extract);
  const newEntries = newTables.flatMap(extract);
  if (!oldEntries.length || !newEntries.length) return []; // Malformed/changed HTML: stay silent.

  const groupPart = (value, type) => {
    const text = norm(value);
    if (type === "year") return text.replace(/\s+/g, "").replace(/[–—]/g, "-");
    const semester = text.match(/(?:ky|hoc ky)\s*(\d+)/);
    return semester ? `ky${semester[1]}` : text;
  };
  const group = entry => `${groupPart(entry.year, "year")}|${groupPart(entry.semester, "semester")}`;
  const oldGroups = new Set(oldEntries.map(group));
  const newGroups = new Set(newEntries.map(group));
  const hasGroupedCoverage = oldGroups.size > 0 && newGroups.size > 0;
  // Old snapshots may contain only portal's default semester while new scraper
  // contains every semester. Compare shared groups only; historical expansion
  // is not a schedule change and must not notify every old course.
  const comparableNewEntries = hasGroupedCoverage
    ? newEntries.filter(entry => oldGroups.has(group(entry)))
    : newEntries;
  if (!comparableNewEntries.length) return [];

  // Same course/class can appear multiple times in one semester. Include
  // schedule date range so Map does not overwrite one session with another.
  const key = entry => [norm(entry.name), norm(entry.className), group(entry), norm(entry.time)].join("|");
  const value = entry => [norm(entry.day), norm(entry.period), norm(entry.room), norm(entry.time)].join("|");
  const oldRows = new Map(oldEntries.map(entry => [key(entry), entry]));
  const alerts = [];
  newEntries.forEach(entry => {
    const oldEntry = oldRows.get(key(entry));
    if (!oldEntry) {
      alerts.push(`[~] Lịch học mới: ${entry.name} - Thứ ${entry.day} tiết ${entry.period} phòng ${entry.room}`);
    } else if (value(oldEntry) !== value(entry)) {
      alerts.push(`(->) Thay đổi lịch học môn: ${entry.name} -> Thứ ${entry.day} tiết ${entry.period} phòng ${entry.room}`);
    }
  });
  return [...new Set(alerts)];
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

  // One sync can produce many row-level changes. Send one message per channel,
  // not one Messenger message per row.
  const grouped = new Map();
  for (const [alert, templateKey] of items) {
    if (!grouped.has(templateKey)) grouped.set(templateKey, []);
    grouped.get(templateKey).push(alert);
  }
  for (const [templateKey, alerts] of grouped) {
    const uniqueAlerts = [...new Set(alerts)];
    grouped.set(templateKey, uniqueAlerts);
    uniqueAlerts.forEach(alert => db.logChange(fbId, "alert", alert));
  }

  for (const [templateKey, alerts] of grouped) {
    const maxAlerts = 8;
    const visible = alerts.slice(0, maxAlerts);
    if (alerts.length > maxAlerts) {
      visible.push(`... và ${alerts.length - maxAlerts} thay đổi khác. Mở mục tra cứu để xem đầy đủ.`);
    }
    const content = visible.join("\n");
    console.log(`[notifier] Sending ${alerts.length} alert(s) to ${fbId} [${templateKey}]`);
    try {
      await messenger.sendUtilityMessage(fbId, templateKey, [content]);
    } catch (error) {
      console.error(`[notifier] Failed ${templateKey} for ${fbId}:`, error.message);
    }

    if (settings.email) {
      await mailer.sendEmail(settings.email, "[UFL Bot] Cập nhật học vụ", content);
    }
  }
}

module.exports = { checkAndNotify, detectGrades, detectExams, detectAnnouncements, detectSchedule, detectTuition };
