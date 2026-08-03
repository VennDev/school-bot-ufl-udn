const messenger = require("./messenger");
const db = require("./db");
const mailer = require("./mailer");

// Normalize semester text to stable format for key comparison.
// Portal dropdown can return "Học kỳ 1", "Kỳ 1", "Kỳ I", etc. between loads.
function _normalizeSemester(text) {
  const str = String(text || "").trim();
  const num = str.match(/(\d+)/);
  if (num) return `Kỳ ${num[1]}`;
  const roman = { i: "1", ii: "2", iii: "3", iv: "4" };
  const lower = str.toLowerCase().replace(/\s+/g, "");
  return roman[lower] ? `Kỳ ${roman[lower]}` : str;
}

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
  const rowKey = row => [row[keyIdx], row[nameIdx], yearIdx >= 0 ? row[yearIdx] : "", semesterIdx >= 0 ? _normalizeSemester(row[semesterIdx]) : ""].join("|");

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
  const examKey = row => [row[1], at(row, yearIdx), _normalizeSemester(at(row, semesterIdx)), at(row, attemptIdx), at(row, roundIdx)].join("|");
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

// Parse a money string like "5.000.000" or "5,000,000" or "5000000" → number.
function _parseMoney(value) {
  const text = String(value || "").trim();
  if (!text || /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(text)) return null;
  if (!/[.,]\d|₫|đ/i.test(text) && !/\d{4,}/.test(text)) return null;
  let number = text.replace(/[^\d.,-]/g, "");
  const comma = number.lastIndexOf(","), dot = number.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    number = comma > dot ? number.replace(/\./g, "").replace(",", ".") : number.replace(/,/g, "");
  } else if (comma >= 0) {
    number = /,\d{1,2}$/.test(number) ? number.replace(",", ".") : number.replace(/,/g, "");
  } else if ((number.match(/\./g) || []).length > 1) {
    number = number.replace(/\./g, "");
  }
  const parsed = Number(number);
  return Number.isFinite(parsed) ? parsed : null;
}

// Extract year + term label from a tuition row.
// Only treat bare digits (1-3) as a term when the table has a term-like column,
// otherwise a credit-count cell ("3") gets misread as "Kỳ 3".
function _parseTuitionTerm(cells, table, headers = []) {
  const year = cells.find(c => /\b\d{4}\s*[-–]\s*\d{4}\b/.test(c)) || table.year || "";
  const termCol = headers.findIndex(h => /hoc ky|học kỳ|ky|kỳ|dot|đợt/.test(h));
  const hasTermColumn = termCol >= 0;
  const term = cells.find(c => /^(?:học\s*kỳ|kỳ|đợt)\s*\d+$/i.test(c)) ||
    (hasTermColumn && cells.find(c => /^[1-3]$/.test(c))) ||
    table.semester || "";
  const termText = String(term).replace(/^học\s*kỳ\s*/i, "Kỳ ").replace(/^kỳ\s*/i, "Kỳ ").replace(/^đợt\s*/i, "Đợt ");
  return {
    year: String(year).replace(/[–—]/g, "-").trim(),
    term: /^[1-3]$/.test(termText) ? `Kỳ ${termText}` : termText,
  };
}

// Parse tuition table array into Map<"year - term", { debt, amount }>.
function _parseTuitionData(data) {
  if (!Array.isArray(data)) return new Map();
  const result = new Map();
  data.forEach((table, idx) => {
    const headers = (table?.headers || []).map(h =>
      String(h).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    );
    const debtCol = headers.findIndex(h => /con no|no\b|chua nop/.test(h));
    let current = { year: table?.year || "", term: table?.semester || "" };
    (table?.rows || []).forEach(row => {
      if (!Array.isArray(row)) return;
      const cells = row.map(c => String(c ?? "").trim()).filter(Boolean);
      if (!cells.length) return;
      const next = _parseTuitionTerm(cells, table, headers);
      if (next.year) current.year = next.year;
      if (next.term) current.term = next.term;

      const label = [current.year, current.term || `Đợt ${idx + 1}`].filter(Boolean).join(" - ");
      const hasDebtText = cells.some(c =>
        /còn nợ|con no|chưa nộp|chua nop/i.test(c) && !/(?:0[,.]0{1,2})\b/.test(c)
      );
      let debtAmount = null;
      if (debtCol >= 0) debtAmount = _parseMoney(row[debtCol]);
      if (debtAmount === null && hasDebtText) {
        const amounts = cells.map(_parseMoney).filter(v => v !== null);
        debtAmount = amounts.length >= 2 ? amounts[amounts.length - 1] : (amounts[0] || null);
      }
      const hasDebt = hasDebtText || (debtAmount !== null && debtAmount > 0);

      if (!result.has(label) || hasDebt) {
        result.set(label, { debt: hasDebt, amount: debtAmount });
      }
    });
  });
  return result;
}

function detectTuition(oldData, newData) {
  if (!newData) return [];

  const oldTerms = _parseTuitionData(oldData);
  const newTerms = _parseTuitionData(newData);
  const alerts = [];

  for (const [label, info] of newTerms) {
    if (!info.debt) continue;
    const prev = oldTerms.get(label);

    if (!prev) {
      const amt = info.amount ? ` ${info.amount.toLocaleString("vi-VN")}đ` : "";
      alerts.push(`[$] Học phí mới: ${label}: Còn nợ${amt}`);
    } else if (!prev.debt) {
      const amt = info.amount ? ` ${info.amount.toLocaleString("vi-VN")}đ` : "";
      alerts.push(`[$] Học phí thay đổi: ${label}: Đã nộp → Còn nợ${amt}`);
    } else if (prev.amount !== info.amount && info.amount !== null) {
      const oldAmt = prev.amount ? prev.amount.toLocaleString("vi-VN") : "?";
      const newAmt = info.amount.toLocaleString("vi-VN");
      alerts.push(`[$] Học phí thay đổi: ${label}: Còn nợ ${oldAmt}đ → ${newAmt}đ`);
    }
    // ponytail: if debt resolved (prev.debt && !info.debt), add alert here.
  }

  return alerts;
}

// Utility Template mapping per notification category.
// Templates bypass 24h window. Created via: npm run setup-templates
const T = messenger.UTILITY_TEMPLATES;

// Jaccard similarity on word tokens (0–1).
function _textSimilarity(a, b) {
  const words = s => {
    const tokens = s.toLowerCase()
      .replace(/[\[\]()|,:.]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 0);
    return new Set(tokens);
  };
  const sa = words(a), sb = words(b);
  if (!sa.size || !sb.size) return 0;
  const intersection = [...sa].filter(w => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return intersection / union;
}

// Extract course name and numeric scores from a grade alert.
function _parseGradeAlert(alert) {
  // New grade: "[=] Điểm mới môn: {name} | ..."
  let m = alert.match(/\[=\]\s*Điểm mới môn:\s*(.+?)\s*\|/);
  if (m) return { name: m[1].trim(), isGrade: true };
  // Changed grade: "(->) Thay đổi điểm môn: {name} | ..."
  m = alert.match(/\(->\)\s*Thay đổi điểm môn:\s*(.+?)\s*\|/);
  if (m) return { name: m[1].trim(), isGrade: true };
  return { isGrade: false };
}

function _numericFingerprint(alert) {
  return [...alert.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => m[1]).sort().join(",");
}

// Check if alert duplicates something already sent (stored in ChangeLog).
// Grades: same course + different scores → not a duplicate (must notify).
// Others: ≥ 75% text similarity → duplicate (suppress).
function _isDuplicateAlert(alert, recentAlerts) {
  if (!alert || !recentAlerts.length) return false;

  const gradeInfo = _parseGradeAlert(alert);

  if (gradeInfo.isGrade) {
    const sameCourseAlerts = recentAlerts.filter(a => {
      const prev = _parseGradeAlert(a);
      return prev.isGrade && prev.name === gradeInfo.name;
    });
    if (!sameCourseAlerts.length) return false; // New course → notify

    // Same course name: check if any numeric score differs.
    const fp = _numericFingerprint(alert);
    const scoreChanged = sameCourseAlerts.some(a => _numericFingerprint(a) !== fp);
    if (scoreChanged) return false; // Score changed → notify

    // Same course, same scores → check text similarity.
    const maxSim = Math.max(...sameCourseAlerts.map(a => _textSimilarity(alert, a)));
    return maxSim >= 0.75;
  }

  // Non-grade alerts: text similarity only.
  const maxSim = Math.max(...recentAlerts.map(a => _textSimilarity(alert, a)));
  return maxSim >= 0.75;
}

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

  // Fetch recent alert history once for cross-run dedup.
  const recentLogs = await db.getChangeLogs(fbId, 50);
  const recentAlerts = recentLogs
    .filter(log => log.type === "alert")
    .map(log => log.content);

  for (const [templateKey, alerts] of grouped) {
    const uniqueAlerts = [...new Set(alerts)];

    const newAlerts = [];
    for (const alert of uniqueAlerts) {
      if (_isDuplicateAlert(alert, recentAlerts)) {
        console.log(`[notifier] Deduped alert for ${fbId}: ${alert.substring(0, 80)}...`);
        continue;
      }
      newAlerts.push(alert);
    }
    if (!newAlerts.length) continue;

    // Log only alerts that pass dedup so they become future dedup references.
    newAlerts.forEach(alert => db.logChange(fbId, "alert", alert));

    const maxAlerts = 8;
    const visible = newAlerts.slice(0, maxAlerts);
    if (newAlerts.length > maxAlerts) {
      visible.push(`... và ${newAlerts.length - maxAlerts} thay đổi khác. Mở mục tra cứu để xem đầy đủ.`);
    }
    const content = visible.join("\n");
    console.log(`[notifier] Sending ${newAlerts.length} alert(s) to ${fbId} [${templateKey}]`);
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
