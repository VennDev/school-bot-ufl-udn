const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

// Parse component score text like "TP1 : 8 - TP2 : 8" or "CC:8, GK:7.5"
// into a stable, comparable key-sorted string: "TP1:8|TP2:8"
function _normComponentScores(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  // Split on common delimiters: - ; / (NOT comma — it's a decimal separator in Vietnamese)
  const parts = text.split(/\s*[-–;\/]\s*/).filter(Boolean);
  const pairs = [];
  parts.forEach(part => {
    const match = part.match(/^([^:]+)\s*:\s*(.+)$/);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "");
      const score = parseFloat(String(match[2]).trim().replace(/,/g, "."));
      pairs.push([key, Number.isFinite(score) ? score : match[2].trim()]);
    }
  });
  if (!pairs.length) return text.toLowerCase().replace(/\s+/g, "");
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return pairs.map(([k, v]) => `${k}:${v}`).join("|");
}

function _normComponentScoreForDisplay(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parts = text.split(/\s*[-–]\s*/).filter(Boolean);
  return parts.map(p => p.trim()).join(" | ");
}

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
  // Component scores: "Điểm thành phần", "Điểm chuyên cần", "Điểm giữa kỳ", etc.
  const componentIdx = findHeader(/diem thanh phan|diem chuyen can|diem giua ky|diem thuc hanh|diem bai tap|diem thuong xuyen|diem tieu luan/);
  // Final exam score: "Điểm thi" (separate from TBCHP)
  const examIdx = findHeader(/^diem thi$|diem thi(?!.*tk)|diem cuoi ky/);
  const yearIdx = findHeader(/nam hoc/);
  const semesterIdx = findHeader(/hoc ky/);
  const rowKey = row => [row[keyIdx], row[nameIdx], yearIdx >= 0 ? row[yearIdx] : "", semesterIdx >= 0 ? row[semesterIdx] : ""].join("|");

  const oldRows = new Map();
  const oldBaseRows = new Map();
  const baseKey = row => [row[keyIdx], row[nameIdx]].join("|");
  // Portal renders the same numeric grade with varying string forms between
  // page loads ("6.5" vs "6.50", trailing spaces, comma decimals). Compare
  // numerically so formatting churn never looks like a new/changed grade.
  const normScore = value => {
    const text = String(value ?? "").trim().replace(/,/g, ".");
    const numeric = parseFloat(text);
    return Number.isFinite(numeric) ? numeric : text;
  };
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
      const parts = [`[=] Điểm mới môn: ${name}`];
      if (componentIdx >= 0 && row[componentIdx]) parts.push(`TP: ${_normComponentScoreForDisplay(row[componentIdx])}`);
      if (examIdx >= 0 && row[examIdx]) parts.push(`Thi: ${row[examIdx]}`);
      parts.push(`TBCHP: ${row[scoreIdx]} (${row[charIdx] || "?"})`);
      alert = parts.join(" | ");
    } else {
      const changes = [];
      // Detect TBCHP change
      if (normScore(oldRow[scoreIdx]) !== normScore(row[scoreIdx])) {
        const oldVal = String(oldRow[scoreIdx] || "").trim() || "(trống)";
        const newVal = String(row[scoreIdx] || "").trim() || "(trống)";
        changes.push(`TBCHP: ${oldVal} -> ${newVal}`);
      }
      // Detect component score change
      if (componentIdx >= 0) {
        const oldComp = _normComponentScores(oldRow[componentIdx]);
        const newComp = _normComponentScores(row[componentIdx]);
        if (oldComp !== newComp) {
          const oldDisplay = _normComponentScoreForDisplay(oldRow[componentIdx]);
          const newDisplay = _normComponentScoreForDisplay(row[componentIdx]);
          if (!oldComp && newComp) {
            changes.push(`Điểm TP mới: ${newDisplay}`);
          } else if (oldComp && !newComp) {
            changes.push(`Điểm TP đã bị xóa (trước: ${oldDisplay})`);
          } else {
            changes.push(`Điểm TP: ${oldDisplay || "(trống)"} -> ${newDisplay}`);
          }
        }
      }
      // Detect exam score change
      if (examIdx >= 0) {
        const oldExam = normScore(oldRow[examIdx]);
        const newExam = normScore(row[examIdx]);
        if (oldExam !== newExam) {
          const oldVal = String(oldRow[examIdx] || "").trim() || "(trống)";
          const newVal = String(row[examIdx] || "").trim();
          if (!String(oldRow[examIdx] || "").trim() && newVal) {
            changes.push(`Điểm thi mới: ${newVal}`);
          } else if (newVal) {
            changes.push(`Điểm thi: ${oldVal} -> ${newVal}`);
          }
        }
      }
      if (changes.length) {
        alert = `(->) Thay đổi điểm môn: ${name} | ${changes.join(" | ")}`;
      }
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
    const hasSubject = headers.includes("ten hoc phan") || headers.includes("ten mon hoc") ||
      headers.includes("ten mon") || headers.includes("mon hoc") || headers.includes("hoc phan");
    const hasRegistrationColumns = headers.some(header =>
      /so tin chi|ten lop tin chi|duong dan/.test(header)
    );
    return hasSubject && hasRegistrationColumns;
  };
  const tableDates = table => {
    const headers = (table?.headers || []).map(norm);
    const timeIndex = ["thoi gian", "thoi gian hoc", "ngay hoc"].map(alias => headers.indexOf(alias)).find(index => index !== -1);
    const text = (table?.rows || []).map(row => {
      if (!Array.isArray(row)) return "";
      return timeIndex === undefined ? row.join(" ") : String(row[timeIndex] || "");
    }).join(" ");
    return [...text.matchAll(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/g)].map(match => {
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
      return Number.isNaN(date.getTime()) ? null : date;
    }).filter(Boolean);
  };
  const tableYear = table => {
    const value = table?.year || table?.sourceYear || table?.yearValue || "";
    const match = String(value).match(/\d{4}/);
    return match ? Number(match[0]) : null;
  };
  const tableSemester = table => {
    const value = table?.semester || table?.semesterValue || "";
    const match = String(value).match(/\d+/);
    return match ? Number(match[0]) : null;
  };
  const relevantTables = data => {
    const source = Array.isArray(data) ? data.filter(isScheduleTable) : [];
    if (!source.length) return [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentYear = now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const windows = source.map(table => {
      const dates = tableDates(table);
      return {
        table,
        dates,
        year: tableYear(table) || (dates[0] && (dates[0].getMonth() + 1 >= 8 ? dates[0].getFullYear() : dates[0].getFullYear() - 1)),
        semester: tableSemester(table),
        start: dates.length ? new Date(Math.min(...dates.map(date => date.getTime()))) : null,
        end: dates.length ? new Date(Math.max(...dates.map(date => date.getTime()))) : null,
      };
    });
    const active = windows.filter(item => item.start && item.end && item.start <= today && item.end >= today);
    if (active.length) {
      const latestEnd = Math.max(...active.map(item => item.end.getTime()));
      return active.filter(item => item.end.getTime() === latestEnd).map(item => item.table);
    }
    const upcoming = windows
      .filter(item => item.start && item.start > today && item.year === currentYear)
      .sort((a, b) => a.start - b.start);
    if (upcoming.length) {
      const earliestStart = upcoming[0].start.getTime();
      return upcoming.filter(item => item.start.getTime() === earliestStart).map(item => item.table);
    }
    // Historical-only fixtures and old snapshots: compare latest stored term,
    // never every historical table. This prevents old courses being announced.
    const datedOrMeta = windows.filter(item => item.year !== null);
    if (!datedOrMeta.length) return source;
    const latestYear = Math.max(...datedOrMeta.map(item => item.year));
    const latestYearItems = datedOrMeta.filter(item => item.year === latestYear);
    const semesters = latestYearItems.map(item => item.semester).filter(Number.isFinite);
    if (!semesters.length) return latestYearItems.map(item => item.table);
    const latestSemester = Math.max(...semesters);
    return latestYearItems.filter(item => item.semester === latestSemester).map(item => item.table);
  };
  const oldTables = relevantTables(oldData);
  const newTables = relevantTables(newData);
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
  // The portal renders date ranges with inconsistent dash/space formatting
  // ("18/09/2023- 31/12/2023" vs "18/09/2023 - 31/12/2023") between loads;
  // normalize before using as identity/value so formatting churn never
  // looks like a new or changed schedule.
  const normTime = value => norm(value).replace(/\s*-\s*/g, "-").replace(/\s*[/.,;|]\s*/g, " ").replace(/\s+/g, " ");
  const key = entry => [norm(entry.name), norm(entry.className), group(entry), normTime(entry.time)].join("|");
  const value = entry => [norm(entry.day), norm(entry.period), norm(entry.room), normTime(entry.time)].join("|");
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
