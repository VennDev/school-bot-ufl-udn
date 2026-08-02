const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { askAI } = require("./ai");
const { calculateGPA, extractGPA, extractDRL, getAcademicEvaluation, getScholarshipAndActivityAdvice } = require("./gpaHelper");
const { lookupProgramFramework, findKnownProgram } = require("./programFramework");
const { PAGES, hasUsableData, parseMajorFromClassName } = require("./pages");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

// Load static response nodes
let staticNodes = [];
try {
  staticNodes = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../static_nodes.json"), "utf8"));
} catch (e) {
  console.error("Failed to load static_nodes.json:", e.message);
}

// Memory map for login sessions
const loginSessions = new Map();

// Mutex to prevent concurrent scrape spawns per user
const scrapingInProgress = new Set();

const SCRAPED_DB_KEYS = {
  canhBao: "canh_bao", thongTinSV: "thong_tin_sv", ketQuaHocTap: "ket_qua_hoc_tap",
  diemRenLuyen: "diem_ren_luyen", lichThi: "lich_thi", hocBongKTKL: "hoc_bong_ktkl",
  lichHoc: "lich_hoc", hocPhi: "hoc_phi"
};

async function isSyncComplete(fbId) {
  const raw = await db.getScrapedData(fbId);
  if (!raw) return false;
  return PAGES.every(page => {
    const value = raw[SCRAPED_DB_KEYS[page.key]];
    try { return hasUsableData(page.key, value ? JSON.parse(value) : null); } catch { return false; }
  });
}

async function sendSyncConfirmation(fbId, username) {
  return messenger.sendQuickReplies(fbId, `[✓] Đồng bộ dữ liệu hoàn tất cho ${username}. Lịch học, lịch thi, điểm số và học vụ đã được cập nhật.`, [
    { title: "Lịch học", payload: "LICH_HOC" },
    { title: "Lịch thi", payload: "LICH_THI" },
    { title: "Điểm số", payload: "DIEM_SO" },
    { title: "Học phí", payload: "HOC_PHI" },
    { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
    { title: "Đăng xuất", payload: "LOGOUT_POSTBACK" }
  ]);
}

// Get base URL for Webview
let appBaseUrl = "http://localhost:3000";

function setBaseUrl(url) {
  appBaseUrl = url;
}

async function askAIWithTyping(senderPsid, systemPrompt, userPrompt) {
  await messenger.sendTypingAction(senderPsid, "typing_on");
  try {
    return { reply: await askAI(systemPrompt, userPrompt) };
  } catch (error) {
    console.error("[botRouter] AI request failed:", error.message);
    return { reply: "Trợ lý AI không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau." };
  } finally {
    await messenger.sendTypingAction(senderPsid, "typing_off");
  }
}

function formatCanhBao(data, showAll = false) {
  if (!data || !data.length) return "Không có cảnh báo học vụ mới nào.";
  let txt = "[!] THÔNG BÁO HỌC VỤ MỚI NHẤT:\n";
  const currentYear = new Date().getFullYear().toString();
  
  let filtered = data;
  if (!showAll) {
    // Only keep items matching current year (e.g. content contains "/2026" or "2026")
    filtered = data.filter(item => {
      const content = item.content || JSON.stringify(item);
      return content.includes(currentYear) || content.includes("/" + currentYear.slice(2));
    });
  }
  
  if (!filtered.length) {
    return showAll ? "Không có cảnh báo học vụ nào." : "Không có cảnh báo học vụ mới của năm nay.";
  }

  filtered.slice(0, 3).forEach((item, idx) => {
    txt += `\n${idx + 1}. ${item.content || JSON.stringify(item)}`;
  });
  return txt;
}

function isGradeTable(table) {
  const headers = Array.isArray(table?.headers) ? table.headers.map(normalizeScheduleHeader) : [];
  return headers.includes("ten hoc phan") && headers.some(header => /tbchp|diem tk|diem thi|diem chu|diem so/.test(header));
}

function useGradeTableCredits(gpa, courses) {
  if (!gpa || !courses.length) return gpa;
  const calculated = calculateGPA(courses);
  return { ...gpa, creditsAccumulated: calculated.creditsAccumulated };
}

// Portal trả cùng bảng điểm tích lũy cho mọi năm/kỳ, nên một học phần lặp nhiều
// lần. Giữ một bản ghi mỗi học phần, ưu tiên điểm cao nhất (trường hợp học lại).
function gradeRows(gradeTables) {
  const best = new Map();
  gradeTables.flatMap(table => table.rows || []).forEach((row) => {
    const key = `${String(row[1] || "").trim()}|${String(row[2] || "").trim()}`.toLowerCase();
    const current = best.get(key);
    if (!current) return void best.set(key, row);
    const score = parseFloat(row[6]);
    const currentScore = parseFloat(current[6]);
    if (!isNaN(score) && (isNaN(currentScore) || score > currentScore)) best.set(key, row);
  });
  return [...best.values()];
}

function formatKetQuaHocTap(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm học tập.";

  let gpa = extractGPA(rawKq);
  const gradeTables = rawKq.filter(isGradeTable);
  const targetTable = gradeTables[0];

  let courses = [];
  if (gradeTables.length) {
    courses = gradeRows(gradeTables).map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
  }

  if (!gpa) {
    if (!targetTable) return "Chưa cập nhật bảng điểm chính.";
    gpa = calculateGPA(courses);
  }

  // Tín chỉ tích lũy phải lấy từ bảng môn học; parser tóm tắt có thể đọc nhầm số.
  gpa = useGradeTableCredits(gpa, courses);
  if (!gpa) return "Không thể đọc dữ liệu điểm học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester, courses);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  let txt = `📊 KẾT QUẢ HỌC TẬP (Dữ liệu từ UFLS):\n`;
  txt += `- GPA Học kỳ: ${gpa.gpaSemester}/4.0\n`;
  txt += `- GPA Tích lũy: ${gpa.gpaAccumulated}/4.0\n`;
  txt += `- Tín chỉ tích lũy: ${gpa.creditsAccumulated} TC\n`;

  // Look up program total credits from student profile
  const rawProfile = scrapedData.thong_tin_sv ? JSON.parse(scrapedData.thong_tin_sv) : null;
  const profile = rawProfile || {};
  let majorName = profile["Ngành"] || profile["ngành"] || profile["nganh"] || "";
  if (!majorName && profile["Lớp"]) {
    majorName = parseMajorFromClassName(profile["Lớp"]) || "";
  }
  const program = majorName ? findKnownProgram(majorName) : null;
  if (program) {
    const creditsRemaining = Math.max(0, program.totalCredits - gpa.creditsAccumulated);
    const progressPercent = program.totalCredits > 0
      ? Math.round((gpa.creditsAccumulated / program.totalCredits) * 100)
      : 0;
    txt += `- Ngành: ${majorName} (${program.totalCredits} TC toàn khóa, còn ${creditsRemaining} TC = ${progressPercent}%)\n`;
  }

  txt += `- Xếp loại học lực: ${evalResult.rank}\n`;
  if (drl) {
    txt += `- Điểm rèn luyện: ${drl.score}/100 (${drl.rank})\n`;
  }
  txt += `\n💬 Nhận xét: ${evalResult.comment}\n`;

  if (evalResult.subjectsToRelearn.length > 0) {
    txt += `\n❌ Môn cần học lại (Điểm F):\n`;
    evalResult.subjectsToRelearn.forEach(m => {
      txt += `  + ${m}\n`;
    });
  }

  if (evalResult.subjectsToImprove.length > 0) {
    txt += `\n⚠️ Môn cần cải thiện (Điểm thấp):\n`;
    evalResult.subjectsToImprove.forEach(m => {
      txt += `  + ${m}\n`;
    });
  }

  if (evalResult.warning) {
    txt += `\n${evalResult.warning}\n`;
  }

  if (advice) {
    txt += `\n💡 TƯ VẤN & KHUYẾN NGHỊ (Quy chế UFLS):\n${advice}`;
  }

  if (gradeTables.length) {
    // Detect component score and exam score columns from headers
    const norm = value => String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
      .toLowerCase().replace(/\s+/g, " ").trim();
    const sampleHeaders = gradeTables.find(t => t.headers?.length)?.headers || [];
    const normalizedHeaders = sampleHeaders.map(norm);
    const findHeader = pattern => normalizedHeaders.findIndex(h => pattern.test(h));
    const componentIdx = findHeader(/diem thanh phan|diem chuyen can|diem giua ky|diem thuc hanh|diem bai tap|diem thuong xuyen|diem tieu luan/);
    const examIdx = findHeader(/^diem thi$|diem thi(?!.*tk)|diem cuoi ky/);

    txt += `\n📝 Chi tiết điểm môn gần đây:`;
    gradeRows(gradeTables).slice(0, 5).forEach((r) => {
      const parts = [`${r[2]}: TBCHP ${r[6]} (${r[8] || "?"})`];
      if (componentIdx >= 0 && r[componentIdx]) {
        const tp = String(r[componentIdx]).trim().split(/\s*[-–]\s*/).filter(Boolean).join(" | ");
        parts.push(`TP: ${tp}`);
      }
      if (examIdx >= 0 && r[examIdx]) {
        parts.push(`Thi: ${String(r[examIdx]).trim()}`);
      }
      txt += `\n- ${parts.join(" | ")}`;
    });
  }

  txt += `\n\n(Thông tin tham khảo từ Sổ tay sinh viên)`;
  return txt;
}

function normalizeExamHeaders(data) {
  const headers = Array.isArray(data?.[0]) ? data[0].map(normalizeScheduleHeader) : [];
  const find = aliases => aliases.map(alias => headers.indexOf(normalizeScheduleHeader(alias))).find(index => index !== -1);
  return {
    subject: find(["Tên học phần", "Tên môn học", "Tên môn", "Môn học"]) ?? 2,
    date: find(["Ngày thi", "Ngày"]) ?? 3,
    session: find(["Ca thi", "Ca"]) ?? 4,
    time: find(["Giờ thi", "Giờ", "Thời gian thi"]) ?? 5,
    candidate: find(["Số báo danh", "SBD"]) ?? 8,
    room: find(["Phòng thi", "Phòng"]) ?? 9,
    format: find(["Hình thức", "Hình thức thi"]) ?? 10,
    year: find(["Năm học", "Nien khoa", "Academic year"]) ?? -1,
  };
}

function examDetails(data, row) {
  const columns = normalizeExamHeaders(data);
  const cells = row.map(value => String(value || "").trim());
  const findDate = () => cells.find(value => /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(value)) || "";
  const findTime = () => cells.find(value => /\b\d{1,2}\s*(?:giờ|h)\b/i.test(value)) || "";
  const findRoom = () => cells.find(value => /\b[A-Z]\d{2,4}(?:\([^)]*\))?\b/i.test(value)) || "";
  const findFormat = () => cells.find(value => /tự luận|trắc nghiệm|vấn đáp|thực hành/i.test(value)) || "";
  const findCandidate = () => cells.slice(Math.max(0, columns.date + 1)).find(value => /^\d{3,12}$/.test(value)) || "";
  const date = cells[columns.date] || findDate();
  return {
    subject: cells[columns.subject] || cells[2] || "Môn học",
    date,
    academicYear: academicYearStartFromDateText(date),
    session: cells[columns.session] || "",
    time: cells[columns.time] || findTime(),
    candidate: cells[columns.candidate] || "",
    room: cells[columns.room] || findRoom(),
    format: cells[columns.format] || findFormat(),
  };
}

function formatLichThi(data, showAll = false, selectedRows = null) {
  if (!data || !data.length || data.length < 2) return "Không có lịch thi sắp tới.";
  let txt = "[~] LỊCH THI:\n";
  let rows = Array.isArray(selectedRows) ? selectedRows : data.slice(1);
  if (!showAll && !selectedRows) rows = getExamRows(data);
  if (!rows.length) return showAll ? "Không có lịch thi." : "Không có lịch thi trong năm học hiện tại.";

  rows.slice(0, showAll ? rows.length : 5).forEach((row) => {
    const exam = examDetails(data, row);
    const time = [exam.session && `Ca ${exam.session}`, exam.time].filter(Boolean).join(" - ");
    const details = [
      exam.academicYear && `Năm học ${exam.academicYear}-${exam.academicYear + 1}`,
      exam.date && `Ngày ${exam.date}`,
      time,
      exam.room && `Phòng ${exam.room}`,
      exam.candidate && `SBD ${exam.candidate}`,
      exam.format && `HT ${exam.format}`,
    ].filter(Boolean);
    txt += `\n- Môn: ${exam.subject}\n  ${details.join(" | ") || "Chưa có ngày thi/phòng thi trong dữ liệu."}\n`;
  });
  return txt;
}

function tuitionMoney(value) {
  const text = String(value || "").trim();
  if (!text || /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(text) || !/[.,]\d{2}|₫|đ/i.test(text)) return null;
  let number = text.replace(/[^\d.,-]/g, "");
  const comma = number.lastIndexOf(",");
  const dot = number.lastIndexOf(".");
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

function tuitionRowStatus(row, headers = []) {
  const cells = row.map(cell => String(cell ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const normalizedHeaders = headers.map(normalizeScheduleHeader);
  const debtIndex = normalizedHeaders.findIndex(header => /còn nợ|con no|nợ|no phai nop|chua nop/.test(header));
  const paidIndex = normalizedHeaders.findIndex(header => /đã nộp|da nop|đã đóng|da dong|đã thanh toán|da thanh toan/.test(header));
  const debtValues = debtIndex >= 0 ? [tuitionMoney(row[debtIndex])] : [];
  const paidValues = paidIndex >= 0 ? [tuitionMoney(row[paidIndex])] : [];
  const amounts = cells.map(tuitionMoney).filter(value => value !== null);
  const explicitDebt = cells.some(cell => /còn nợ|con no|chưa nộp|chua nop/i.test(cell) && !/(?:0[,.]0{1,2})\b/.test(cell));
  const debt = debtValues.some(value => value !== null && value > 0) || explicitDebt || (debtIndex < 0 && amounts.length >= 2 && amounts.at(-1) > 0);
  const paid = paidValues.some(value => value !== null && value > 0) || (!debt && amounts.length >= 2 && amounts.slice(0, -1).some(value => value > 0));
  return { debt, paid };
}

function tuitionTerm(row, table, current) {
  const cells = row.map(cell => String(cell ?? "").trim());
  const year = cells.find(cell => /\b\d{4}\s*[-–]\s*\d{4}\b/.test(cell)) || current.year || table.year || "";
  const term = cells.find(cell => /^(?:học\s*kỳ|ky|kỳ|đợt)\s*\d+$/i.test(cell)) ||
    cells.find(cell => /^[1-3]$/.test(cell)) || current.term || table.semester || table.semesterValue || "";
  const termText = String(term).replace(/^học\s*kỳ\s*/i, "Kỳ ").replace(/^kỳ\s*/i, "Kỳ ").replace(/^đợt\s*/i, "Đợt ");
  return { year: year.replace(/[–—]/g, "-"), term: /^[1-3]$/.test(termText) ? `Kỳ ${termText}` : termText };
}

function formatHocPhi(data) {
  if (!Array.isArray(data) || !data.length) return "Chưa có dữ liệu học phí.";
  const terms = new Map();
  data.forEach((table, tableIndex) => {
    const headers = Array.isArray(table?.headers) ? table.headers : [];
    let current = { year: table?.year || table?.yearValue || "", term: table?.semester || table?.semesterValue || "" };
    (table?.rows || []).forEach(row => {
      if (!Array.isArray(row)) return;
      const cells = row.map(cell => String(cell ?? "").trim()).filter(Boolean);
      if (!cells.length) return;
      const next = tuitionTerm(row, table, current);
      if (next.year) current.year = next.year;
      if (next.term) current.term = next.term;
      if (!cells.some(cell => /học phí|hoc phi/i.test(cell)) && cells.map(tuitionMoney).filter(value => value !== null).length < 2) return;
      const label = [current.year, current.term || `Kỳ/đợt ${tableIndex + 1}`].filter(Boolean).join(" - ") || `Kỳ/đợt ${tableIndex + 1}`;
      const summary = terms.get(label) || { debt: false, paid: false };
      const status = tuitionRowStatus(row, headers);
      summary.debt ||= status.debt;
      summary.paid ||= status.paid;
      terms.set(label, summary);
    });
  });
  if (!terms.size) return "Chưa có dữ liệu học phí.";
  const lines = [...terms].map(([label, status]) => `- ${label}: ${status.debt ? "Còn nợ" : status.paid ? "Đã nộp" : "Chưa xác định"}`);
  return `[$] TÌNH TRẠNG HỌC PHÍ:\n\n${lines.join("\n")}`;
}

function formatTietHoc() {
  return `⏰ THỜI GIAN CÁC TIẾT HỌC:

BUỔI SÁNG
- Tiết 1: 7h00 - 7h50
- Tiết 2: 7h50 - 8h40 (Giải lao 10 phút)
- Tiết 3: 8h50 - 9h40 (Giải lao 05 phút)
- Tiết 4: 9h45 - 10h35
- Tiết 5: 10h35 - 11h25 (Giải lao 05 phút)
- Tiết 6: 11h30 - 12h20

BUỔI CHIỀU
- Tiết 7: 13h00 - 13h50
- Tiết 8: 13h50 - 14h40 (Giải lao 10 phút)
- Tiết 9: 14h50 - 15h40 (Giải lao 05 phút)
- Tiết 10: 15h45 - 16h35
- Tiết 11: 16h35 - 17h25

BUỔI TỐI
- Tiết 12: 17h30 - 18h20
- Tiết 13: 18h20 - 19h10 (Giải lao 10 phút)
- Tiết 14: 19h20 - 20h10
- Tiết 15: 20h10 - 21h00`;
}

function formatThongTinSV(data) {
  if (!data) return "Chưa có dữ liệu hồ sơ sinh viên.";
  let txt = "[i] THÔNG TIN HỒ SƠ SINH VIÊN:\n";
  // data is parsed object from thong_tin_sv JSON (typically key-value details)
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "string") {
      txt += `\n- ${k}: ${v}`;
    }
  }
  return txt;
}

function normalizeScheduleHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scheduleColumn(headers, aliases) {
  const normalized = headers.map(normalizeScheduleHeader);
  const index = aliases
    .map((alias) => normalized.indexOf(normalizeScheduleHeader(alias)))
    .find((value) => value !== -1);
  return index === undefined ? -1 : index;
}

function scheduleTableYear(table) {
  const value = table?.year || table?.sourceYear || table?.academicYear || table?.yearValue || table?.sourceYearValue;
  const metadata = Number(String(value || "").match(/\d{4}/)?.[0] || 0);
  const currentStart = currentAcademicYearStart();
  if (metadata >= 2000 && metadata <= currentStart + 1) return metadata;
  return academicYearStartFromTable(table) || metadata;
}

function scheduleRowDates(row, expectedYear = null) {
  const text = Array.isArray(row) ? row.join(" ") : String(row || "");
  return [...text.matchAll(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/g)].flatMap(match => {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    return !Number.isNaN(date.getTime()) && (expectedYear === null || academicYearStartFromDateText(match[0]) === expectedYear) ? [date] : [];
  });
}

function scheduleTableDates(table, expectedYear = null) {
  return (table?.rows || []).flatMap(row => scheduleRowDates(row, expectedYear));
}

function selectLatestScheduleTables(tables, now) {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  const windows = tables.map(table => {
    const year = scheduleTableYear(table);
    const dates = scheduleTableDates(table, year >= 2000 ? year : null);
    const semester = Number(String(table.semester || "").match(/\d+/)?.[0] || table.semesterValue || 0);
    return { table, year, semester, start: dates.length ? new Date(Math.min(...dates)) : null, end: dates.length ? new Date(Math.max(...dates)) : null };
  });

  // Active semester wins. If none active, choose nearest upcoming semester.
  const currentStart = currentAcademicYearStart(now);
  const active = windows.filter(item => item.start && item.start <= dayEnd && item.end >= dayStart);
  if (active.length) {
    const latestEnd = Math.max(...active.map(item => item.end.getTime()));
    return active.filter(item => item.end.getTime() === latestEnd).map(item => item.table);
  }
  const upcoming = windows.filter(item => item.start && item.start > dayEnd && item.year === currentStart).sort((a, b) => a.start - b.start);
  if (upcoming.length) {
    const earliestStart = upcoming[0].start.getTime();
    return upcoming.filter(item => item.start.getTime() === earliestStart).map(item => item.table);
  }

  // Expired tables are never returned. Date-less legacy data gets metadata-only
  // fallback because no expiry can be proven from its payload.
  const undated = windows.filter(item => !item.start && item.year === currentAcademicYearStart(now));
  if (undated.length) {
    const maxSemester = Math.max(...undated.map(item => item.semester));
    return undated.filter(item => item.semester === maxSemester).map(item => item.table);
  }
  return [];
}

function getScheduleEntries(data, options = {}) {
  if (!Array.isArray(data)) return [];
  const isPeriod = (value) => /^\d+(?:\s*[-–]\s*\d+)?$/.test(String(value || "").trim());
  const isDay = (value) => /^(?:thứ\s*)?[2-7]$|^chủ nhật$/i.test(String(value || "").trim());
  const hasScheduleTime = (value) => /(?:thứ\s*(?:[2-7])|chủ nhật)|ngày\s*:|tiết\s*:/i.test(String(value || ""));
  const isLegacyRow = (row) => isPeriod(row?.[0]) && isDay(row?.[2]) && String(row?.[1] || "").trim();
  const isPortalScheduleRow = (row) => hasScheduleTime(row?.[3]) && String(row?.[2] || "").trim();
  const isScheduleHeader = (h) => {
    const n = normalizeScheduleHeader(h);
    return n.includes("ten hoc phan") || n.includes("ten mon") || n === "mon hoc" || n === "hoc phan";
  };
  let tables = data.filter((t) => {
    const headers = (t.headers || []).map(normalizeScheduleHeader);
    return headers.some(isScheduleHeader) || (t.rows || []).some(isLegacyRow) || (t.rows || []).some(isPortalScheduleRow);
  });
  if (!tables.length) return [];

  if (options.latest) {
    tables = selectLatestScheduleTables(tables, options.now || new Date())
      .map(table => ({ ...table, rows: filterScheduleRowsByAcademicYear(table, scheduleTableYear(table)) }));
  }

  const fallback = { day: 2, period: 0, name: 1, room: 4, className: 3 };
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const entries = [];

  // Resolve each table independently. Different semesters can change column order.
  tables.forEach((table) => {
    const headers = table.headers || [];
    const columns = {
      day: scheduleColumn(headers, ["Thứ", "Ngày"]),
      period: scheduleColumn(headers, ["Tiết", "Tiết học"]),
      time: scheduleColumn(headers, ["Thời gian học", "Thời gian" ]),
      name: scheduleColumn(headers, ["Tên học phần", "Tên môn học", "Môn học", "Học phần", "Tên môn"]),
      room: scheduleColumn(headers, ["Phòng", "Phòng học"]),
      className: scheduleColumn(headers, ["Tên lớp tín chỉ", "Tên lớp học phần", "Lớp học phần", "Lớp", "Lớp tín chỉ"]),
    };
    const hasDetectedHeaders = columns.name !== -1 && (columns.time !== -1 || (columns.day !== -1 && columns.period !== -1));
    const legacy = !hasDetectedHeaders && (table.rows || []).some(isLegacyRow);
    const col = legacy
      ? fallback
      : Object.fromEntries(Object.entries(columns).map(([key, value]) => [
          key,
          value !== -1 ? value : (key === "room" && columns.time === -1 ? fallback[key] : (key === "className" && columns.time === -1 ? fallback[key] : -1))
        ]));

    (table.rows || []).forEach((row) => {
    const name = col.name !== -1 ? clean(row[col.name]).replace(/^tiết\s+/i, "") : "";
    if (!name || ["stt", "môn học", "tên học phần", "học phần", "tên môn"].includes(name.toLowerCase())) return;

    const rawTime = col.time !== -1 ? clean(row[col.time]) : "";
    const parsedDay = rawTime.match(/(?:^|[;|])\s*(thứ\s*[2-7]|chủ nhật)\b/i)?.[1] || "";
    const dateMatches = [...rawTime.matchAll(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g)].map(match => match[0]);
    const parsedDate = rawTime.match(/ngày\s*:\s*([^;|]+)/i)?.[1]?.trim().replace(/\s+00:00:00$/, "") ||
      (dateMatches.length > 1 ? `${dateMatches[0]} - ${dateMatches[1]}` : dateMatches[0] || "");
    const parsedDateStart = dateMatches[0] || "";
    const parsedDateEnd = dateMatches[1] || dateMatches[0] || "";
    const parsedPeriod = rawTime.match(/tiết\s*:\s*([^;|]+)/i)?.[1]?.trim() || "";
    const rawDay = col.day !== -1 ? String(row[col.day] || "") : parsedDay;
    const rawPeriod = col.period !== -1 ? String(row[col.period] || "") : parsedPeriod;
    const rawRoom = col.room !== -1 ? String(row[col.room] || "") : "";
    const className = col.className !== -1 ? clean(row[col.className]) : "";

    const days = rawDay.split(/[\r\n]+/).map(clean).filter(Boolean);
    const periods = rawPeriod.split(/[\r\n]+/).map(clean).filter(Boolean);
    const rooms = rawRoom.split(/[\r\n]+/).map(clean).filter(Boolean);

    if (days.length > 0 && (days.length === periods.length || days.length === rooms.length)) {
      for (let i = 0; i < days.length; i++) {
        entries.push({
          day: days[i],
          period: periods[i] || periods[0] || "",
          name,
          room: rooms[i] || rooms[0] || "",
          className,
          ...(parsedDate ? { date: parsedDate, dateStart: parsedDateStart, dateEnd: parsedDateEnd } : {})
        });
      }
    } else {
      entries.push({
        day: days.join(", ") || clean(rawDay),
        period: periods.join(", ") || clean(rawPeriod),
        name,
        room: rooms.join(", ") || clean(rawRoom),
        className,
        ...(parsedDate ? { date: parsedDate, dateStart: parsedDateStart, dateEnd: parsedDateEnd } : {})
      });
    }
    });
  });

  // Portal emits one row per room for the same slot. Room is kept out of the
  // identity key and merged instead, so one slot renders as one card.
  const seen = new Map();
  const merged = [];
  entries.forEach((entry) => {
    if (!entry.name || !(isDay(entry.day) || entry.day.toLowerCase().startsWith("thứ") || /^\d+$/.test(entry.day) || entry.period || entry.date)) return;
    const date = String(entry.date || "").replace(/\s+00:00:00$/, "");
    const key = JSON.stringify([entry.day, date, entry.period, entry.name, entry.className]);
    const existing = seen.get(key);
    if (!existing) { seen.set(key, entry); merged.push(entry); return; }
    const rooms = String(existing.room || "").split(", ").filter(Boolean);
    if (entry.room && !rooms.includes(entry.room)) existing.room = [...rooms, entry.room].join(", ");
  });
  return merged;
}

function formatScheduleDay(day) {
  const value = String(day || "").trim();
  if (!value) return "";
  return /^thứ\s|^chủ nhật/i.test(value) ? value : `Thứ ${value}`;
}

function clipCardText(value, maxLength = 80) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function prepareCards(elements) {
  return Array.isArray(elements)
    ? elements.filter(card => card && String(card.title || card.subtitle || "").trim()).map(card => ({
        ...card,
        title: clipCardText(card.title),
        subtitle: clipCardText(card.subtitle),
      }))
    : [];
}

function splitCardBatches(elements, size = 5) {
  const cards = prepareCards(elements);
  const batches = [];
  for (let i = 0; i < cards.length; i += size) batches.push(cards.slice(i, i + size));
  return batches;
}

async function sendCardsOrText(senderPsid, elements, fallbackText) {
  const cards = splitCardBatches(elements)[0] || [];
  if (!cards.length) return messenger.sendTextMessage(senderPsid, fallbackText);
  try {
    const result = await messenger.sendGenericTemplate(senderPsid, cards);
    return result?.error ? messenger.sendTextMessage(senderPsid, fallbackText) : result;
  } catch {
    return messenger.sendTextMessage(senderPsid, fallbackText);
  }
}

async function sendCardBatchesOrText(senderPsid, elements, fallbackText) {
  const batches = splitCardBatches(elements);
  if (!batches.length) return messenger.sendTextMessage(senderPsid, fallbackText);
  for (const cards of batches) {
    try {
      const result = await messenger.sendGenericTemplate(senderPsid, cards);
      if (result?.error) return messenger.sendTextMessage(senderPsid, fallbackText);
    } catch {
      return messenger.sendTextMessage(senderPsid, fallbackText);
    }
  }
  return { ok: true, batches: batches.length };
}

function formatLichHoc(data, dayFilter, options = {}) {
  const entries = getScheduleEntries(data, options);
  if (!entries.length) return "Không có lịch học nào sắp tới.";

  const dayMap = {
    "2": "thứ 2", "3": "thứ 3", "4": "thứ 4", "5": "thứ 5", "6": "thứ 6", "7": "thứ 7", "cn": "chủ nhật",
    "thu2": "thứ 2", "thu3": "thứ 3", "thu4": "thứ 4", "thu5": "thứ 5", "thu6": "thứ 6", "thu7": "thứ 7",
  };
  const targetDay = dayFilter ? (dayMap[dayFilter] || dayFilter).toLowerCase() : null;
  const filtered = targetDay
    ? entries.filter((entry) => entry.day.toLowerCase().includes(targetDay))
    : entries;

  let txt = dayFilter
    ? `[~] LỊCH HỌC ${dayFilter.toUpperCase()}:\n`
    : "[~] LỊCH HỌC TUẦN NÀY:\n";
  if (!filtered.length) return txt + "Không có tiết học nào.";

  filtered.slice(0, 30).forEach((entry) => {
    const details = [entry.day && `Thứ ${entry.day.replace(/^thứ\s*/i, "")}`, entry.dateStart && `Từ ${entry.dateStart}`, entry.dateEnd && `Đến ${entry.dateEnd}`, entry.period && `Tiết ${entry.period}`];
    if (entry.room) details.push(`Phòng ${entry.room}`);
    if (entry.className) details.push(`Lớp ${entry.className}`);
    txt += `\n- ${entry.name} | ${details.filter(Boolean).join(" | ")}`;
  });
  return txt;
}

function isSchedulePrefix(text) {
  return /^(?:(?:lịch|lich)(?!\s*thi\b)(?:\s+(?:học|hoc))?|(?:thời khóa biểu|thoi khoa bieu))(?:\s|$)/i.test(String(text || "").trim());
}

function isScheduleQuery(text) {
  return /^(?:(?:lịch|lich)(?!\s*thi\b)(?:\s+(?:học|hoc))?|(?:thời khóa biểu|thoi khoa bieu))(?:\s+(?:tuần này|tuần hiện tại|tuan nay|tuan hien tai))?$/i.test(String(text || "").trim());
}

function extractAcademicYearRequest(text) {
  const explicit = text.match(/\b(?:năm\s*học\s*)?(\d{4})\s*[-–]\s*(\d{4})\b/i);
  if (explicit) {
    return { label: `năm học ${explicit[1]}-${explicit[2]}`, value: `${explicit[1]}-${explicit[2]}` };
  }

  const ordinal = text.match(/\bnăm(?:\s+học)?\s+(?:thứ\s+)?(\d+)\b/i);
  return ordinal ? { label: `năm ${ordinal[1]}`, ordinal: Number(ordinal[1]) } : null;
}

function normalizeAcademicLabel(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function academicYearFromValue(value) {
  const match = normalizeAcademicLabel(value).match(/\b(\d{4})\s*-\s*(\d{4})\b/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function academicYearStartFromDateText(value) {
  const starts = [...String(value || "").matchAll(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/g)]
    .map(match => {
      const month = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      if (year < 2000 || year > new Date().getFullYear() + 1) return null;
      return month >= 8 ? year : year - 1;
    }).filter(year => year !== null);
  if (!starts.length) return null;
  const counts = new Map();
  starts.forEach(year => counts.set(year, (counts.get(year) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

function currentAcademicYearStart(now = new Date()) {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

function parseExamDate(value) {
  const match = String(value || "").match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function academicYearStartFromTable(table) {
  const rowDates = (table?.rows || []).flatMap(row => {
    const text = Array.isArray(row) ? row.join(" ") : String(row || "");
    const start = academicYearStartFromDateText(text);
    return start === null ? [] : [start];
  });
  if (rowDates.length) return Math.max(...rowDates);
  const label = table?.year || table?.academicYear || table?.yearText;
  const match = String(label || "").match(/\b(\d{4})\s*[-–]\s*\d{4}\b/);
  if (match) {
    const start = Number(match[1]);
    if (start <= new Date().getFullYear() + 1) return start;
  }
  const value = Number(table?.yearValue);
  return value >= 2000 && value <= new Date().getFullYear() + 1 ? value : null;
}

function filterScheduleRowsByAcademicYear(table, wantedStart) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const dated = rows.filter(row => academicYearStartFromDateText(Array.isArray(row) ? row.join(" ") : row) !== null);
  if (!dated.length) return rows;
  return rows.filter(row => academicYearStartFromDateText(Array.isArray(row) ? row.join(" ") : row) === wantedStart);
}

function getExamRows(data, request = null, showAll = false) {
  if (!Array.isArray(data) || data.length < 2) return [];
  const headers = Array.isArray(data[0]) ? data[0] : [];
  const columns = normalizeExamHeaders(data);
  const yearIndex = columns.year;
  const rows = data.slice(1).filter(Array.isArray);
  const dated = rows.filter(row => academicYearStartFromDateText(row[columns.date]) !== null);
  const rowsForYear = (wantedStart, allowMetadata = true) => {
    const matchingDates = dated.filter(row => academicYearStartFromDateText(row[columns.date]) === wantedStart);
    const wanted = `${wantedStart}-${wantedStart + 1}`;
    const matchingLabels = yearIndex >= 0
      ? rows.filter(row => academicYearFromValue(row[yearIndex]) === wanted)
      : [];
    if (matchingDates.length) {
      const datedSet = new Set(matchingDates);
      return matchingDates.concat(allowMetadata
        ? matchingLabels.filter(row => !datedSet.has(row) && !String(row[columns.date] || "").trim())
        : []);
    }
    return dated.length && allowMetadata ? matchingLabels : [];
  };

  if (request?.value) {
    const wanted = academicYearFromValue(request.value);
    if (!wanted) return [];
    const wantedStart = Number(wanted.slice(0, 4));
    const matching = rowsForYear(wantedStart);
    return matching;
  }
  if (request?.ordinal || showAll) return request?.ordinal ? [] : rows;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = rows.filter(row => {
    const value = row[columns.date];
    const date = parseExamDate(value);
    return date ? date >= today : false;
  });
  if (!upcoming.length) return [];
  const availableStarts = [...new Set(upcoming.map(row => academicYearStartFromDateText(row[columns.date])))].sort((a, b) => a - b);
  const nearest = availableStarts[0];
  return upcoming.filter(row => academicYearStartFromDateText(row[columns.date]) === nearest);
}

function academicYearLabels(table) {
  if (!table || typeof table !== "object") return [];
  const labels = [];
  ["year", "yearValue", "academicYear", "academic_year", "yearText"].forEach((key) => {
    if (table[key] !== undefined && table[key] !== null) labels.push(String(table[key]));
  });
  const title = normalizeAcademicLabel(table.title);
  if (title && (/nam\s+hoc|nam\s+thu|academic\s+year|nien\s+khoa/.test(title) || /^\d{4}\s*-\s*\d{4}$/.test(title))) {
    labels.push(title);
  }
  // Scraper appends selected year/semester labels to rows. Read cells only
  // when header explicitly identifies year; never inspect arbitrary course text.
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const yearColumns = headers.map(normalizeAcademicLabel).reduce((indexes, header, index) => {
    if (/^nam\s+hoc$|academic\s+year|nien\s+khoa/.test(header)) indexes.push(index);
    return indexes;
  }, []);
  for (const row of Array.isArray(table.rows) ? table.rows : []) {
    if (!Array.isArray(row)) continue;
    yearColumns.forEach(index => labels.push(String(row[index] ?? "")));
    row.forEach(cell => {
      const value = normalizeAcademicLabel(cell);
      if (/nam\s+hoc|nam\s+thu|academic\s+year|nien\s+khoa/.test(value)) labels.push(value);
    });
  }
  return labels.map(normalizeAcademicLabel);
}

function filterAcademicYearTables(data, request) {
  if (!Array.isArray(data) || !request) return [];
  if (request.value) {
    const parts = String(request.value).replace(/[–—]/g, "-").split("-").map(v => v.trim());
    if (parts.length !== 2 || !/^\d{4}$/.test(parts[0]) || !/^\d{4}$/.test(parts[1])) return [];
    const wanted = `${parts[0]}-${parts[1]}`;
    const wantedStart = Number(parts[0]);
    return data.filter((item) => academicYearLabels(item).some((label) => {
      const matches = label.match(/\b(\d{4})\s*-\s*(\d{4})\b/g) || [];
      return matches.some(pair => pair.replace(/\s+/g, "") === wanted);
    })).map(item => ({ ...item, rows: filterScheduleRowsByAcademicYear(item, wantedStart) }));
  }
  if (!Number.isInteger(request.ordinal) || request.ordinal < 1) return [];
  const ordinal = String(request.ordinal);
  return data.filter((item) => academicYearLabels(item).some((label) =>
    new RegExp(`\\bnam(?: hoc)?\\s+(?:thu\\s+)?${ordinal}\\b`, "i").test(label)
  ));
}

function isStudentProfileQuery(text) {
  return /\b(?:thông tin\s+(?:cá nhân|sinh viên)|hồ sơ(?:\s+sinh viên|\s+cá nhân)?|lý lịch|profile)\b/i.test(text);
}

function formatTienDo(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm để tính tiến độ.";

  let gpa = extractGPA(rawKq);
  const gradeTables = rawKq.filter(isGradeTable);
  const targetTable = gradeTables[0];

  let courses = [];
  if (gradeTables.length) {
    courses = gradeRows(gradeTables).map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
  }

  if (!gpa && targetTable) {
    gpa = calculateGPA(courses);
  }

  // Tín chỉ tích lũy phải lấy từ bảng môn học; parser tóm tắt có thể đọc nhầm số.
  gpa = useGradeTableCredits(gpa, courses);
  if (!gpa) return "Không thể đọc thông tin tiến độ học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester, courses);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  const rows = gradeRows(gradeTables);
  const earned = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return grade && !["f", "chưa đạt"].includes(grade) && r[6] !== "0";
  });
  const remaining = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return !grade || grade === "f" || grade === "chưa đạt" || r[6] === "0";
  });
  const remainingCredits = remaining.reduce((sum, r) => sum + (parseFloat(r[3]) || 0), 0);

  let txt = `📈 TIẾN ĐỘ HỌC TẬP (Quy chế UFLS):\n`;
  txt += `- GPA Tích lũy: ${gpa.gpaAccumulated}/4.0 (${evalResult.rank})\n`;
  txt += `- Tín chỉ đã tích lũy: ${gpa.creditsAccumulated} TC\n`;

  // Look up program total credits from student profile
  const rawProfile = scrapedData.thong_tin_sv ? JSON.parse(scrapedData.thong_tin_sv) : null;
  const profile = rawProfile || {};
  let majorName = profile["Ngành"] || profile["ngành"] || profile["nganh"] || "";
  if (!majorName && profile["Lớp"]) {
    majorName = parseMajorFromClassName(profile["Lớp"]) || "";
  }
  const program = majorName ? findKnownProgram(majorName) : null;
  if (program) {
    const creditsRemaining = Math.max(0, program.totalCredits - gpa.creditsAccumulated);
    const progressPercent = program.totalCredits > 0
      ? Math.round((gpa.creditsAccumulated / program.totalCredits) * 100)
      : 0;
    txt += `- Ngành: ${majorName} (Tổng ${program.totalCredits} TC toàn khóa)\n`;
    txt += `- Tín chỉ còn lại: ${creditsRemaining} TC (Đã hoàn thành ${progressPercent}%)\n`;
    // Estimate remaining semesters (avg 15-18 TC/semester)
    const estSemesters = Math.ceil(creditsRemaining / 16);
    txt += `- Dự kiến: ~${estSemesters} học kỳ còn lại (nếu học ~16 TC/kỳ)\n`;
  }

  txt += `- Số môn hoàn thành: ${earned.length} môn\n`;
  txt += `- Số tín chỉ nợ/chưa hoàn thành: ${remainingCredits} TC\n`;
  if (drl) {
    txt += `- Điểm rèn luyện: ${drl.score}/100 (${drl.rank})\n`;
  }
  txt += `\n💬 Nhận xét: ${evalResult.comment}\n`;

  if (evalResult.subjectsToRelearn.length > 0) {
    txt += `\n❌ Môn cần học lại (Điểm F):\n`;
    evalResult.subjectsToRelearn.forEach(m => {
      txt += `  + ${m}\n`;
    });
  }

  if (evalResult.subjectsToImprove.length > 0) {
    txt += `\n⚠️ Môn cần cải thiện (Điểm thấp):\n`;
    evalResult.subjectsToImprove.forEach(m => {
      txt += `  + ${m}\n`;
    });
  }

  if (evalResult.warning) {
    txt += `\n${evalResult.warning}\n`;
  }

  if (advice) {
    txt += `\n💡 TƯ VẤN & KHUYẾN NGHỊ (Quy chế UFLS):\n${advice}`;
  }

  if (remaining.length > 0) {
    txt += "\n📝 Các môn chưa hoàn thành gần đây:\n";
    remaining.slice(0, 5).forEach((r) => {
      txt += `- ${r[2]} (${r[3]} TC): ${r[6] || "Chưa học/Chưa có điểm"}\n`;
    });
  }
  
  txt += `\n\n(Thông tin tham khảo từ Sổ tay sinh viên)`;
  return txt;
}

// Detect if input looks like a natural language chat question (not a credential)
function isNaturalLanguageQuestion(text) {
  const t = text.trim();
  // Must have spaces — student IDs and passwords typically don't
  if (!t.includes(" ")) return false;
  const words = t.split(/\s+/).filter(w => w.length >= 2);
  if (words.length < 2) return false;
  // Vietnamese question/sentence markers
  const questionMarkers = /[?？]|gì|nào|sao|không|bao nhiêu|làm sao|như thế nào|ở đâu|khi nào|ai\b|hỏi|cho\b|tôi|mình|bạn|em|anh|chị|giúp|hướng dẫn|cách|muốn|học\b|thi\b|điểm|học phí|lịch|quy chế|\blà\b/i;
  const hasDiacritics = /[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  // Long text with spaces is likely chat
  if (t.length > 30) return true;
  // Has question markers or Vietnamese diacritics with multiple words
  if ((questionMarkers.test(t) || hasDiacritics.test(t)) && words.length >= 2) return true;
  return false;
}

async function processMessage(senderPsid, messageText) {
  const text = messageText.trim();

  // Normalize payloads from FB buttons/quick replies to avoid string match failures
  let actionText = text.toLowerCase().trim();
  if (actionText === "lich_hoc") actionText = "lịch học";
  else if (actionText === "lich_thi") actionText = "lịch thi";
  else if (actionText === "all_lich_thi") actionText = "tất cả lịch thi";
  else if (actionText === "diem_so") actionText = "điểm số";
  else if (actionText === "tien_do") actionText = "tiến độ";
  else if (actionText === "hoc_phi") actionText = "học phí";
  else if (actionText === "tiet_hoc") actionText = "thời gian tiết học";
  else if (actionText === "sync_postback") actionText = "/sync";
  else if (actionText === "logout_postback" || actionText === "đăng xuất" || actionText === "đăng xuất tài khoản" || actionText === "logout") actionText = "/logout";
  else if (actionText === "login_postback") actionText = "/login";
  else if (actionText === "menu_postback") actionText = "xem menu hoc vu"; // map Tra cứu học vụ to xem menu hoc vu view
  else if (actionText === "settings_postback") actionText = "/settings";
  else if (actionText === "faq_postback") actionText = "xem menu cau hoi";
  else if (actionText === "qc_hocbong") actionText = "qc_hocbong";
  else if (actionText === "qc_canhbao") actionText = "qc_canhbao";
  else if (actionText === "qc_xeploai") actionText = "qc_xeploai";
  else if (actionText === "qc_caithien") actionText = "qc_caithien";
  
  // Normalize text labels from Toggle Quick Replies to toggle commands
  else if (actionText === "togglegpa" || actionText === "toggle gpa") actionText = "toggle gpa";
  else if (actionText === "togglelịch" || actionText === "toggle lịch" || actionText === "toggle lich" || actionText === "toggle lịh") actionText = "toggle lich";
  else if (actionText === "togglelichthi" || actionText === "toggle lịch thi" || actionText === "toggle lichthi" || actionText === "toggle_lichthi") actionText = "toggle thi";
  else if (actionText === "toggle học phí" || actionText === "toggle hocphi" || actionText === "toggle họcphí") actionText = "toggle hocphi";
  else if (actionText === "toggle thông báo" || actionText === "toggle thongbao" || actionText === "toggle thôngbáo") actionText = "toggle thongbao";

  // Use the mapped text for logic
  const normalizedLowerText = actionText;

  await db.logInteraction(senderPsid, "message", text);
  const user = await db.getUser(senderPsid);

  console.log(`[botRouter] Received message from "${senderPsid}": "${text}" (Normalized: "${normalizedLowerText}")`);
  console.log(`[botRouter] Database user check: ${user ? `Found user "${user.username}"` : "User not found"}`);

  // Handle Pages status command
  if (normalizedLowerText === "/pages" || normalizedLowerText === "pages" || normalizedLowerText === "trang") {
    if (!user) {
      return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản. Vui lòng gõ /login để đăng nhập.");
    }
    const data = await db.getScrapedData(senderPsid) || {};
    const keyMap = {
      canh_bao: "Cảnh báo", thong_tin_sv: "Hồ sơ SV", ket_qua_hoc_tap: "Điểm số",
      diem_ren_luyen: "Điểm rèn luyện", lich_thi: "Lịch thi", hoc_bong_ktkl: "HB/KT/KL",
      lich_hoc: "Lịch học", hoc_phi: "Học phí"
    };
    let txt = `📋 TRẠNG THÁI DỮ LIỆU (${Object.values(keyMap).length} mục):\n`;
    let done = 0;
    for (const [dbKey, label] of Object.entries(keyMap)) {
      const has = !!data[dbKey];
      if (has) done++;
      txt += `\n${has ? "✅" : "❌"} ${label}`;
    }
    txt += `\n\nHoàn thành: ${done}/${Object.keys(keyMap).length}`;
    if (done < Object.keys(keyMap).length) {
      txt += `\nGõ /sync để đồng bộ các mục còn thiếu.`;
      txt += `\nGõ /testpage <tên> để kiểm tra lại một mục.`;
    }
    return messenger.sendTextMessage(senderPsid, txt);
  }

  // Handle Test single page command
  if (normalizedLowerText.startsWith("/testpage") || normalizedLowerText.startsWith("testpage")) {
    if (!user) {
      return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản. Vui lòng gõ /login để đăng nhập.");
    }
    const keyMap = {
      "canhbao": "canh_bao", "cảnh báo": "canh_bao", "canh bao": "canh_bao",
      "thongtinsv": "thong_tin_sv", "hồ sơ": "thong_tin_sv", "ho so": "thong_tin_sv", "thông tin": "thong_tin_sv",
      "diem": "ket_qua_hoc_tap", "điểm": "ket_qua_hoc_tap", "ketqua": "ket_qua_hoc_tap", "kết quả": "ket_qua_hoc_tap",
      "diemrenluyen": "diem_ren_luyen", "điểm rèn luyện": "diem_ren_luyen", "drl": "diem_ren_luyen",
      "lichthi": "lich_thi", "lịch thi": "lich_thi", "thi": "lich_thi",
      "hocbong": "hoc_bong_ktkl", "học bổng": "hoc_bong_ktkl", "khen thưởng": "hoc_bong_ktkl",
      "lichhoc": "lich_hoc", "lịch học": "lich_hoc", "thời khóa biểu": "lich_hoc",
      "hocphi": "hoc_phi", "học phí": "hoc_phi", "tài chính": "hoc_phi"
    };
    const arg = text.replace(/\/testpage\s*/i, "").replace(/testpage\s*/i, "").trim().toLowerCase();
    const dbKey = keyMap[arg];
    if (!dbKey) {
      const validKeys = [...new Set(Object.values(keyMap))].join(", ");
      return messenger.sendTextMessage(senderPsid, `Không rõ mục cần kiểm tra. Dùng: /testpage <tên>\nCác mục: ${validKeys}\nVí dụ: /testpage điểm, /testpage lịch học`);
    }
    // Clear just that page's data, then trigger sync
    await db.clearScrapedPage(senderPsid, dbKey);
    await messenger.sendTextMessage(senderPsid, `Đã xóa dữ liệu cũ của mục "${arg}". Đang chạy đồng bộ lại...`);
    if (scrapingInProgress.has(senderPsid)) {
      return messenger.sendTextMessage(senderPsid, "Đang có quá trình đồng bộ khác chạy. Vui lòng đợi...");
    }
    scrapingInProgress.add(senderPsid);
    await messenger.sendTypingAction(senderPsid, "typing_on");
    const scraperPath = path.resolve(__dirname, "./scrape.js");
    const execCmd = `node "${scraperPath}" --fb-id="${user.fb_id.replace(/"/g, '\\"')}" --silent`;
    exec(execCmd, async (err) => {
      try {
        scrapingInProgress.delete(senderPsid);
        if (err) {
          await messenger.sendTextMessage(senderPsid, "[X] Quá trình đồng bộ thất bại.");
          return;
        }
        const complete = await isSyncComplete(senderPsid);
        await messenger.sendTextMessage(senderPsid, complete
          ? `[✓] Đã đồng bộ xong mục "${arg}". Gõ /pages để kiểm tra.`
          : "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
      } finally {
        await messenger.sendTypingAction(senderPsid, "typing_off");
      }
    });
    return;
  }

  // Handle Test Utility Messaging API call
  if (normalizedLowerText === "/testutility" || normalizedLowerText === "test utility" || normalizedLowerText === "test utility messaging") {
    await messenger.sendTextMessage(senderPsid, "Đang kiểm tra/khởi tạo Utility Template trên Facebook Page...");
    const setupRes = await messenger.ensureUtilityTemplateCreated();
    if (setupRes.success) {
      await messenger.sendTextMessage(senderPsid, `[✓] Trạng thái template: ${setupRes.message}. Đang gửi tin nhắn...`);
    } else {
      await messenger.sendTextMessage(senderPsid, `[⚠️] Lưu ý template: ${setupRes.error}. Đang thử gửi...`);
    }

    try {
      const resData = await messenger.sendUtilityMessage(
        senderPsid,
        "ACCOUNT_UPDATE",
        ["[UFL Bot] Thông báo thử nghiệm: Đây là tin nhắn Utility Template gửi qua Facebook Messenger API."]
      );
      await messenger.sendTextMessage(
        senderPsid,
        `[✓] Gửi thành công! Meta Message ID: ${resData.message_id || "N/A"}.\nMeta App Dashboard sẽ ghi nhận 1/1 lệnh gọi API cho pages_utility_messaging.`
      );
    } catch (e) {
      await messenger.sendTextMessage(senderPsid, `[X] Gửi Utility Message thất bại: ${e.message}`);
    }
    return;
  }

  // Handle Sync command
  if (normalizedLowerText === "/sync" || normalizedLowerText === "đồng bộ" || normalizedLowerText === "sync") {
    if (!user) {
      return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản. Vui lòng gõ /login để đăng nhập.");
    }
    if (scrapingInProgress.has(senderPsid)) {
      return messenger.sendTextMessage(senderPsid, "Quá trình đồng bộ trước đó vẫn đang chạy. Vui lòng đợi...");
    }
    scrapingInProgress.add(senderPsid);
    await messenger.sendTextMessage(senderPsid, "Đang khởi động đồng bộ dữ liệu tức thời từ cổng sinh viên. Quá trình có thể mất 1-2 phút...");
    await messenger.sendTypingAction(senderPsid, "typing_on");
    const scraperPath = path.resolve(__dirname, "./scrape.js");
    const execCmd = `node "${scraperPath}" --fb-id="${user.fb_id.replace(/"/g, '\\"')}" --silent`;
    exec(execCmd, async (err) => {
      try {
        scrapingInProgress.delete(senderPsid);
        if (err) {
          const complete = await isSyncComplete(senderPsid);
          await messenger.sendTextMessage(senderPsid, complete
            ? "[X] Quá trình đồng bộ dữ liệu tức thời thất bại hoặc bị nghẽn mạng."
            : "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
          return;
        }
        const complete = await isSyncComplete(senderPsid);
        if (!complete) {
          await messenger.sendTextMessage(senderPsid, "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
          return;
        }
        await sendSyncConfirmation(senderPsid, user.username);
      } finally {
        await messenger.sendTypingAction(senderPsid, "typing_off");
      }
    });
    return;
  }

  // Handle Menu command
  if (normalizedLowerText === "/menu" || normalizedLowerText === "menu" || normalizedLowerText === "xem menu" || normalizedLowerText === "cho xem menu") {
    const s = await db.getSettings(senderPsid);
    const menuText = "📚 MENU CHỨC NĂNG UFL BOT\nChọn phím tắt bên dưới để tra cứu nhanh thông tin học vụ của bạn hoặc hỏi các câu hỏi mẫu:";
    
    // Check OTN token count and prompt user to replenish if count is 0
    db.getOtnTokenCount(senderPsid).then((count) => {
      if (count === 0) {
        setTimeout(() => {
          messenger.sendOtnRequest(senderPsid, "Đăng ký nhận thông báo GPA & Điểm mới tự động (Ngoài 24h)", "ACCOUNT_UPDATE").catch(() => {});
        }, 1500);
      }
    }).catch(() => {});

    return messenger.sendButtons(senderPsid, menuText, [
      {
        type: "postback",
        title: "Tra cứu học vụ",
        payload: "MENU_POSTBACK"
      },
      {
        type: "postback",
        title: "Câu hỏi thường gặp",
        payload: "FAQ_POSTBACK"
      },
      {
        type: "postback",
        title: "Hủy đăng nhập",
        payload: "LOGOUT_POSTBACK"
      }
    ]);
  }

  if (normalizedLowerText === "xem menu hoc vu") {
    const menuText = "📚 MENU TRA CỨU HỌC VỤ\nChọn thông tin bạn muốn kiểm tra:";
    return messenger.sendQuickReplies(senderPsid, menuText, [
      { title: "Lịch học", payload: "LICH_HOC" },
      { title: "Lịch thi", payload: "LICH_THI" },
      { title: "Điểm số", payload: "DIEM_SO" },
      { title: "Học phí", payload: "HOC_PHI" },
      { title: "Thời gian & tiết học", payload: "TIET_HOC" },
      { title: "Cài đặt", payload: "SETTINGS_POSTBACK" }
    ]);
  }

  if (normalizedLowerText === "thời gian tiết học" || normalizedLowerText === "thời gian & tiết học" || normalizedLowerText === "thời gian & các tiết học" || normalizedLowerText === "thời gian cac tiet hoc" || normalizedLowerText === "tiết học" || normalizedLowerText === "tiet hoc") {
    return messenger.sendTextMessage(senderPsid, formatTietHoc());
  }

  if (normalizedLowerText === "xem menu cau hoi" || normalizedLowerText === "câu hỏi thường gặp") {
    const menuText = "💡 CÂU HỎI THƯỜNG GẶP\nChọn câu hỏi mẫu bên dưới để xem trả lời nhanh từ quy chế:";
    return messenger.sendQuickReplies(senderPsid, menuText, [
      { title: "Quy chế học bổng", payload: "QC_HOCBONG" },
      { title: "Cảnh báo học vụ", payload: "QC_CANHBAO" },
      { title: "Xếp loại học lực", payload: "QC_XEPLOAI" },
      { title: "Học & Thi cải thiện", payload: "QC_CAITHIEN" }
    ]);
  }

  if (normalizedLowerText === "qc_hocbong" || normalizedLowerText === "quy chế học bổng") {
    const node = staticNodes.find(n => n.keywords.includes("quy chế học bổng"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (normalizedLowerText === "qc_canhbao" || normalizedLowerText === "cảnh báo học vụ") {
    const node = staticNodes.find(n => n.keywords.includes("cảnh báo học vụ"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (normalizedLowerText === "qc_xeploai" || normalizedLowerText === "xếp loại học lực") {
    const node = staticNodes.find(n => n.keywords.includes("xếp loại học lực"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (normalizedLowerText === "qc_caithien" || normalizedLowerText === "thi cải thiện") {
    const node = staticNodes.find(n => n.keywords.includes("thi cải thiện"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (normalizedLowerText === "thông tin về dịch vụ" || normalizedLowerText === "thông tin dịch vụ" || normalizedLowerText === "dịch vụ") {
    const node = staticNodes.find(n => n.keywords.includes("thông tin về dịch vụ"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }

  // Handle Logout command
  if (normalizedLowerText === "/logout") {
    console.log(`[botRouter] Processing /logout command for "${senderPsid}"`);
    if (user) {
      await db.deleteUser(senderPsid);
      loginSessions.delete(senderPsid);
      return messenger.sendTextMessage(senderPsid, "Đã ngắt kết nối tài khoản sinh viên thành công.");
    }
    return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản nào.");
  }

  // Handle Login command
  if (normalizedLowerText === "/login") {
    console.log(`[botRouter] Processing /login command for "${senderPsid}"`);
    if (user) {
      const dataExist = await db.getScrapedData(senderPsid);
      if (dataExist) {
        // Return standard menu options including logout button if already logged in
        return messenger.sendQuickReplies(senderPsid, `Bạn hiện đã đăng nhập với tài khoản sinh viên *${user.username}* và dữ liệu đã được đồng bộ.`, [
          { title: "Lịch học", payload: "LICH_HOC" },
          { title: "Lịch thi", payload: "LICH_THI" },
          { title: "Điểm số", payload: "DIEM_SO" },
          { title: "Học phí", payload: "HOC_PHI" },
          { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
          { title: "Đăng xuất", payload: "LOGOUT_POSTBACK" }
        ]);
      }
      return messenger.sendTextMessage(senderPsid, `Bạn hiện đã đăng nhập với tài khoản *${user.username}*. Đang chờ đồng bộ dữ liệu hoặc bạn có thể gõ "cài đặt" để cấu hình.`);
    }
    loginSessions.set(senderPsid, { step: "AWAITING_USERNAME" });
    return messenger.sendTextMessage(senderPsid, "Để lấy dữ liệu học tập (điểm số, lịch thi, học phí...) từ cổng thông tin nhà trường, bot cần đăng nhập vào tài khoản sinh viên của bạn. Vui lòng nhập Mã sinh viên (MSSV) trước nhé:");
  }

  // Handle User Settings
  if (normalizedLowerText === "/settings" || normalizedLowerText === "cài đặt") {
    console.log(`[botRouter] Processing settings view for "${senderPsid}"`);
    const s = await db.getSettings(senderPsid);
    const tokenCount = await db.getOtnTokenCount(senderPsid);
    const textStatus = `[*] CÀI ĐẶT THÔNG BÁO CỦA BẠN:
~ GPA: ${s.notify_gpa ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle gpa)
~ Lịch học: ${s.notify_schedule ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle lich)
~ Lịch thi: ${s.notify_exam ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle thi)
~ Học phí: ${s.notify_tuition ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle hocphi)
~ Thông báo học vụ: ${s.notify_announcement ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle thongbao)
~ Email: ${s.email || "Chưa có"} (Gõ: email <địa chỉ email>)
~ Tin nhắn tự động dự phòng: ${tokenCount} lượt (Gõ /menu để lấy thêm)`;
    
    return messenger.sendQuickReplies(senderPsid, textStatus, [
      { title: "Toggle GPA", payload: "TOGGLE_GPA" },
      { title: "Toggle Lịch", payload: "TOGGLE_LICH" },
      { title: "Toggle Lịch Thi", payload: "TOGGLE_THI" },
      { title: "Toggle Học Phí", payload: "TOGGLE_HOCPHI" },
      { title: "Toggle Thông báo", payload: "TOGGLE_THONGBAO" },
      { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
    ]);
  }

  // Handle toggle interactions
  if (normalizedLowerText.startsWith("toggle ") || normalizedLowerText.startsWith("toggle_")) {
    console.log(`[botRouter] Processing toggle setting command for "${senderPsid}"`);
    let key = normalizedLowerText.replace("toggle ", "").replace("toggle_", "").trim();
    // Normalize typos/differences in Vietnamese characters
    if (key === "lịh" || key === "lịch") key = "lich";
    if (key === "thí" || key === "thỉ") key = "thi";
    
    const s = await db.getSettings(senderPsid);
    
    if (key === "gpa") s.notify_gpa = s.notify_gpa ? 0 : 1;
    else if (key === "lich") s.notify_schedule = s.notify_schedule ? 0 : 1;
    else if (key === "thi") s.notify_exam = s.notify_exam ? 0 : 1;
    else if (key === "hocphi" || key === "hoc_phi" || key === "học phí") s.notify_tuition = s.notify_tuition ? 0 : 1;
    else if (key === "thongbao" || key === "thông báo") s.notify_announcement = s.notify_announcement ? 0 : 1;
    else return messenger.sendTextMessage(senderPsid, "Lệnh toggle không hợp lệ.");

    await db.saveSettings(senderPsid, s);
    return processMessage(senderPsid, "/settings");
  }

  // Handle email save
  if (normalizedLowerText.startsWith("email ")) {
    console.log(`[botRouter] Processing email save for "${senderPsid}"`);
    const email = text.replace(/email /i, "").trim();
    const s = await db.getSettings(senderPsid);
    s.email = email;
    await db.saveSettings(senderPsid, s);
    return messenger.sendTextMessage(senderPsid, `Đã cập nhật email nhận thông báo: ${email}`);
  }

  // Handle Login State Machine
  if (!user) {
    const session = loginSessions.get(senderPsid);
    console.log(`[botRouter] Login State Machine. Current session for "${senderPsid}":`, session);
    
    if (session) {
      if (session.step === "AWAITING_USERNAME") {
        console.log(`[botRouter] Login State Machine: AWAITING_USERNAME -> username "${text}" received.`);
        // If input looks like a natural language question, fallback to AI
        if (!/^\d+$/.test(text)) {
          if (isNaturalLanguageQuestion(text)) {
            loginSessions.delete(senderPsid);
            // Fall through to AI below — load system prompt and ask
            let fallbackPrompt = "";
            try {
              fallbackPrompt = fs.readFileSync(path.resolve(__dirname, "../rules.txt"), "utf8");
            } catch (e) { /* use empty */ }
            const { reply } = await askAIWithTyping(senderPsid, fallbackPrompt, text);
            return messenger.sendTextMessage(senderPsid, reply);
          }
          return messenger.sendTextMessage(senderPsid, "Mã sinh viên không hợp lệ. Vui lòng nhập lại (chỉ gồm các chữ số):");
        }
        session.username = text;
        session.step = "AWAITING_PASSWORD";
        loginSessions.set(senderPsid, session);
        return messenger.sendTextMessage(senderPsid, "Nhận mã sinh viên thành công. Vui lòng nhập Mật khẩu cổng sinh viên của bạn (thông tin được mã hóa bảo mật):");
      }

      if (session.step === "AWAITING_PASSWORD") {
        // If input looks like a natural language question, fallback to AI
        if (isNaturalLanguageQuestion(text)) {
          loginSessions.delete(senderPsid);
          let fallbackPrompt = "";
          try {
            fallbackPrompt = fs.readFileSync(path.resolve(__dirname, "../rules.txt"), "utf8");
          } catch (e) { /* use empty */ }
          const { reply } = await askAIWithTyping(senderPsid, fallbackPrompt, text);
          return messenger.sendTextMessage(senderPsid, reply);
        }
        // Allow user to cancel login flow
        const cancelKeywords = ["không", "hủy", "cancel", "thoát", "dừng", "/logout", "ko", "k", "no"];
        if (cancelKeywords.includes(text.toLowerCase().trim())) {
          loginSessions.delete(senderPsid);
          return messenger.sendTextMessage(senderPsid, "Đã hủy đăng nhập. Gõ /login để thử lại khi cần.");
        }
        // Reject empty or obviously invalid passwords
        if (!text.trim() || text.trim().length < 2) {
          return messenger.sendTextMessage(senderPsid, "Mật khẩu không được để trống. Vui lòng nhập mật khẩu cổng sinh viên, hoặc gõ 'hủy' để thoát:");
        }
        if (text.trim().length > 128) {
          return messenger.sendTextMessage(senderPsid, "Mật khẩu quá dài (tối đa 128 ký tự). Vui lòng nhập lại, hoặc gõ 'hủy' để thoát:");
        }
        console.log(`[botRouter] Login State Machine: AWAITING_PASSWORD -> password received, starting scrape process.`);
        const username = session.username;
        const passwordEnc = crypto.encrypt(text);
        
        // Save user
        await db.saveUser(senderPsid, username, passwordEnc, "0");
        loginSessions.delete(senderPsid);

        await messenger.sendTextMessage(senderPsid, "Đang kết nối & tiến hành đồng bộ dữ liệu lần đầu. Quá trình này có thể mất 1-2 phút, vui lòng đợi...");

        // OTN request goes out only after complete sync succeeds.
        // Trigger async scrape immediately for this user
        if (scrapingInProgress.has(senderPsid)) {
          return messenger.sendTextMessage(senderPsid, "Đang có quá trình đồng bộ khác chạy. Vui lòng đợi...");
        }
        scrapingInProgress.add(senderPsid);
        await messenger.sendTypingAction(senderPsid, "typing_on");
        const scraperPath = path.resolve(__dirname, "./scrape.js");
        const execCmd = `node "${scraperPath}" --fb-id="${senderPsid.replace(/"/g, '\\"')}" --silent --notify-login-failure`;
        console.log(`[botRouter] Executing scrape command: ${execCmd}`);
        const child = exec(execCmd, async (err, stdout, stderr) => {
          try {
            scrapingInProgress.delete(senderPsid);
            if (err) {
            console.error(`[async-sync] Scrape process exited with error for ${username}:`, err.message);
            // Check if user still exists — scraper deletes user on login failure
            const stillExists = await db.getUser(senderPsid);
            if (stillExists) {
              const complete = await isSyncComplete(senderPsid);
              await messenger.sendTextMessage(senderPsid, complete
                ? "[X] Quá trình đồng bộ gặp lỗi sau khi lấy dữ liệu. Vui lòng thử /sync lại sau."
                : "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
            }
            // If user was deleted, scraper already sent the failure message — do nothing
          } else {
            console.log(`[async-sync] Scrape for ${username} succeeded.`);
            // Check if user still exists — scraper deletes user on login failure even when process exits cleanly
            const stillExists = await db.getUser(senderPsid);
            if (!stillExists) {
              // Login failed, scraper already sent "[X] Đăng nhập thất bại..." — do not send conflicting success message
              return;
            }
            if (!await isSyncComplete(senderPsid)) {
              await messenger.sendTextMessage(senderPsid, "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
              return;
            }
            await sendSyncConfirmation(senderPsid, username);
            setTimeout(() => {
              messenger.sendOtnRequest(senderPsid, "Đăng ký nhận thông báo GPA & Điểm mới tự động", "ACCOUNT_UPDATE").catch(() => {});
            }, 1500);
          }
          } finally {
            await messenger.sendTypingAction(senderPsid, "typing_off");
          }
        });
        child.stdout.on("data", (data) => {
          console.log(`[async-sync-process-stdout] ${data.trim()}`);
        });
        child.stderr.on("data", (data) => {
          console.error(`[async-sync-process-stderr] ${data.trim()}`);
        });
        return;
      }
    }

    // If not in login session and doesn't trigger explicit /login, do not proceed with login state machine
    if (!session && normalizedLowerText !== "/login") {
      return messenger.sendButtons(senderPsid, "Xin chào! Mình có thể giúp gì cho bạn?\nĐể bắt đầu sử dụng, vui lòng đăng nhập tài khoản sinh viên UFL.", [
        {
          type: "postback",
          title: "Đăng nhập ngay",
          payload: "LOGIN_POSTBACK"
        }
      ]);
    }
  }

  // Quick keywords
  const data = await db.getScrapedData(senderPsid) || {};
  console.log(`[botRouter] Querying data for keywords. Message: "${text}"`);

  // Load system rules early so all AI-calling paths can use them
  let systemPrompt = "";
  try {
    systemPrompt = fs.readFileSync(path.resolve(__dirname, "../rules.txt"), "utf8");
  } catch (e) {
    console.error("Failed to load rules.txt:", e.message);
  }
  if (!systemPrompt) {
    systemPrompt = `Bạn là trợ lý AI hữu ích hỗ trợ sinh viên trường Đại học Ngoại ngữ - Đại học Đà Nẵng (UFL).`;
  }
  
  if (/^(?:lịch|lich)\s+thi(?:\s|$)/i.test(normalizedLowerText)) {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const requestedExamYear = extractAcademicYearRequest(text);
    const filtered = getExamRows(raw, requestedExamYear);
    if (!filtered.length) {
      const label = requestedExamYear?.value ? requestedExamYear.label : `năm học ${currentAcademicYearStart()}-${currentAcademicYearStart() + 1}`;
      return messenger.sendTextMessage(senderPsid, `Không có lịch thi cho ${label}. Gõ 'tất cả lịch thi' để xem toàn bộ.`);
    }

    const elements = filtered.slice(0, 5).map((row) => {
      const exam = examDetails(raw, row);
      return {
        title: `Thi: ${exam.subject}`,
        subtitle: [exam.academicYear && `Năm học ${exam.academicYear}-${exam.academicYear + 1}`, exam.date && `Ngày: ${exam.date}`, exam.session && `Ca: ${exam.session}`, exam.time && `Giờ: ${exam.time}`, exam.room && `Phòng: ${exam.room}`, exam.candidate && `SBD: ${exam.candidate}`, exam.format && `HT: ${exam.format}`].filter(Boolean).join(" | ") || "Chưa có ngày thi/phòng thi trong dữ liệu."
      };
    });
    return sendCardsOrText(senderPsid, elements, formatLichThi(raw, false, filtered));
  }

  if (normalizedLowerText === "tất cả lịch thi" || normalizedLowerText === "tat ca lich thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const filtered = getExamRows(raw, null, true);
    if (!filtered.length) return messenger.sendTextMessage(senderPsid, "Không có lịch thi.");
    const elements = filtered.map((row) => {
      const exam = examDetails(raw, row);
      return {
        title: `Thi: ${exam.subject}`,
        subtitle: [exam.academicYear && `Năm học ${exam.academicYear}-${exam.academicYear + 1}`, exam.date && `Ngày: ${exam.date}`, exam.session && `Ca: ${exam.session}`, exam.time && `Giờ: ${exam.time}`, exam.room && `Phòng: ${exam.room}`, exam.candidate && `SBD: ${exam.candidate}`, exam.format && `HT: ${exam.format}`].filter(Boolean).join(" | ") || "Chưa có ngày thi/phòng thi trong dữ liệu."
      };
    });
    return sendCardBatchesOrText(senderPsid, elements, formatLichThi(raw, true, filtered));
  }

  const requestedScheduleYear = extractAcademicYearRequest(text);
  if (requestedScheduleYear && isSchedulePrefix(normalizedLowerText)) {
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const matchingTables = filterAcademicYearTables(raw, requestedScheduleYear);
    const label = requestedScheduleYear.value ? requestedScheduleYear.label : `năm ${requestedScheduleYear.ordinal}`;
    if (!matchingTables.length) {
      return messenger.sendTextMessage(senderPsid, `Không có dữ liệu lịch học cho ${label} trong dữ liệu đã đồng bộ.`);
    }
    const scheduleEntries = getScheduleEntries(matchingTables);
    const elements = scheduleEntries.map((entry) => ({
      title: entry.name,
      subtitle: [formatScheduleDay(entry.day), entry.dateStart && `Từ: ${entry.dateStart}`, entry.dateEnd && `Đến: ${entry.dateEnd}`, entry.period && `Tiết ${entry.period}`, entry.room && `Phòng ${entry.room}`, entry.className && `Lớp ${entry.className}`]
        .filter(Boolean).join(" | ")
    }));
    return sendCardBatchesOrText(senderPsid, elements, formatLichHoc(matchingTables));
  }

  if (isScheduleQuery(normalizedLowerText)) {
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const entries = getScheduleEntries(raw, { latest: true });
    if (!entries.length) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch học trong kỳ hiện tại.");
    }
    const scheduleEntries = getScheduleEntries(raw, { latest: true });
    const elements = scheduleEntries.map((entry) => ({
      title: entry.name,
      subtitle: [formatScheduleDay(entry.day), entry.dateStart && `Từ: ${entry.dateStart}`, entry.dateEnd && `Đến: ${entry.dateEnd}`, entry.period && `Tiết ${entry.period}`, entry.room && `Phòng ${entry.room}`, entry.className && `Lớp ${entry.className}`]
        .filter(Boolean).join(" | ")
    }));
    return sendCardBatchesOrText(senderPsid, elements, formatLichHoc(raw, null, { latest: true }));
  }

  if (normalizedLowerText.startsWith("lịch học thứ") || normalizedLowerText.startsWith("lịch học t") || normalizedLowerText.startsWith("lịch học cn") || normalizedLowerText.startsWith("lịch học chủ nhật") || normalizedLowerText.startsWith("lich hoc thu") || normalizedLowerText.startsWith("lich hoc t") || normalizedLowerText.startsWith("lich hoc cn") || normalizedLowerText.startsWith("lich hoc chu nhat")) {
    const dayPart = text.replace(/lịch học /i, "").replace(/lich hoc /i, "").trim();
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const entries = getScheduleEntries(raw, { latest: true });
    const dayMap = {
      "2": "thứ 2", "3": "thứ 3", "4": "thứ 4", "5": "thứ 5", "6": "thứ 6", "7": "thứ 7", "cn": "chủ nhật",
      "thu2": "thứ 2", "thu3": "thứ 3", "thu4": "thứ 4", "thu5": "thứ 5", "thu6": "thứ 6", "thu7": "thứ 7",
    };
    const targetDay = (dayMap[dayPart.toLowerCase()] || dayPart).toLowerCase();
    const filtered = entries.filter((entry) => entry.day.toLowerCase().includes(targetDay));

    if (!filtered.length) {
      return messenger.sendTextMessage(senderPsid, `Không có lịch học nào vào ${dayPart}.`);
    }

    const elements = filtered.map((entry) => ({
      title: entry.name,
      subtitle: [formatScheduleDay(entry.day), entry.dateStart && `Từ: ${entry.dateStart}`, entry.dateEnd && `Đến: ${entry.dateEnd}`, entry.period && `Tiết ${entry.period}`, entry.room && `Phòng ${entry.room}`, entry.className && `Lớp ${entry.className}`]
        .filter(Boolean).join(" | "),
    }));
    return sendCardBatchesOrText(senderPsid, elements, formatLichHoc(raw, dayPart, { latest: true }));
  }

  if (normalizedLowerText === "điểm số" || normalizedLowerText === "gpa" || normalizedLowerText === "diem so" || normalizedLowerText === "diem") {
    return messenger.sendTextMessage(senderPsid, formatKetQuaHocTap(data));
  }

  if (normalizedLowerText === "tiến độ" || normalizedLowerText === "tín chỉ" || normalizedLowerText === "tien do" || normalizedLowerText === "tin chi") {
    return messenger.sendTextMessage(senderPsid, formatTienDo(data));
  }

  if (normalizedLowerText === "học vụ" || normalizedLowerText === "thông báo" || normalizedLowerText === "hoc vu" || normalizedLowerText === "thong bao") {
    const raw = data.canh_bao ? JSON.parse(data.canh_bao) : null;
    return messenger.sendTextMessage(senderPsid, formatCanhBao(raw, false));
  }

  if (normalizedLowerText === "tất cả thông báo" || normalizedLowerText === "tat ca thong bao" || normalizedLowerText === "tất cả học vụ" || normalizedLowerText === "tat ca hoc vu") {
    const raw = data.canh_bao ? JSON.parse(data.canh_bao) : null;
    return messenger.sendTextMessage(senderPsid, formatCanhBao(raw, true));
  }

  if (normalizedLowerText === "học phí" || normalizedLowerText === "tiền" || normalizedLowerText === "hoc phi" || normalizedLowerText === "tien") {
    const raw = data.hoc_phi ? JSON.parse(data.hoc_phi) : null;
    return messenger.sendTextMessage(senderPsid, formatHocPhi(raw));
  }

  if (normalizedLowerText === "hồ sơ" || normalizedLowerText === "hồ sơ sinh viên" || normalizedLowerText === "ho so" || normalizedLowerText === "lý lịch" || normalizedLowerText === "ly lich" || isStudentProfileQuery(text)) {
    const raw = data.thong_tin_sv ? JSON.parse(data.thong_tin_sv) : null;
    return messenger.sendTextMessage(senderPsid, formatThongTinSV(raw));
  }

  if (normalizedLowerText === "thống kê" || normalizedLowerText === "thong ke" || normalizedLowerText === "phân tích" || normalizedLowerText === "phan tich") {
    const cleanDataForStats = {
      user: { username: user.username },
      diem: data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap).slice(0, 10) : [],
      lich_thi: data.lich_thi ? JSON.parse(data.lich_thi).slice(0, 5) : [],
      hoc_phi: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
      canh_bao: data.canh_bao ? JSON.parse(data.canh_bao).slice(0, 3) : []
    };

    const statsPrompt = `${systemPrompt}\n\nDữ liệu sinh viên cần phân tích:\n${JSON.stringify(cleanDataForStats, null, 2)}\n\nYêu cầu định dạng phản hồi:\n[+] Tóm tắt: (1-2 câu nhận xét chung)\n[+] Phân tích chi tiết:\n- Tiến độ học tập & GPA: (Mô tả ngắn)\n- Lịch thi & Học phí: (Mô tả ngắn)\n[+] Lời khuyên: (1 câu khuyên học tập)`;

    const { reply: statsResult } = await askAIWithTyping(senderPsid, statsPrompt, "Hãy thống kê và phân tích tiến độ học tập của tôi.");
    await db.saveConversation(senderPsid, "user", messageText);
    await db.saveConversation(senderPsid, "assistant", statsResult);
    return messenger.sendTextMessage(senderPsid, statsResult);
  }

  // AI Weekly Summary
  if (normalizedLowerText === "tóm tắt tuần" || normalizedLowerText === "tóm tắt" || normalizedLowerText === "tom tat") {
    const cleanDataForSummary = {
      user: { username: user.username },
      lich_hoc: data.lich_hoc ? JSON.parse(data.lich_hoc).slice(0, 5) : [],
      lich_thi: data.lich_thi ? JSON.parse(data.lich_thi).slice(0, 3) : [],
      hoc_phi: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
      canh_bao: data.canh_bao ? JSON.parse(data.canh_bao).slice(0, 2) : []
    };

    const summaryPrompt = `${systemPrompt}\n\nDữ liệu tuần của sinh viên:\n${JSON.stringify(cleanDataForSummary, null, 2)}\n\nYêu cầu định dạng:\n[+] Tóm tắt tuần học: (Nhận xét tổng quan tuần tới ngắn trong 1 câu)\n[+] Lịch trình:\n- Lịch học chính: (Các môn cần học tuần tới)\n- Lịch thi & Học phí: (Các môn thi sắp tới, tình trạng học phí/nợ nếu có)\n[+] Nhiệm vụ ưu tiên: (Bullet point ngắn gọn các việc cần làm)`;

    const { reply: summaryResult } = await askAIWithTyping(senderPsid, summaryPrompt, "Hãy tóm tắt tuần học tập của tôi.");
    await db.saveConversation(senderPsid, "user", messageText);
    await db.saveConversation(senderPsid, "assistant", summaryResult);
    return messenger.sendTextMessage(senderPsid, summaryResult);
  }

  // Ask AI (Free text)
  const rawGrades = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : null;
  const targetGradeTable = rawGrades ? rawGrades.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
  const gradesRows = targetGradeTable ? (targetGradeTable.rows || []) : [];

  // Build GPA summary and grade list for AI context.
  // Use extractGPA first (summary tables) like formatKetQuaHocTap does;
  // fall back to calculating from grade-table rows only when no summary row exists.
  let gpaSummary = null;
  let recentGradesFiltered = [];
  if (gradesRows && gradesRows.length > 0) {
    const courses = gradesRows.map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));

    let gpa = extractGPA(rawGrades);
    if (!gpa) {
      gpa = calculateGPA(courses);
    } else {
      // Merge credits accumulated from actual course rows (more reliable than summary parser)
      const calculated = calculateGPA(courses);
      gpa = { ...gpa, creditsAccumulated: calculated.creditsAccumulated };
    }

    const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester, courses);

    gpaSummary = {
      gpaSemester: gpa.gpaSemester,
      gpaAccumulated: gpa.gpaAccumulated,
      creditsAccumulated: gpa.creditsAccumulated,
      rank: evalResult.rank,
      subjectsToRelearn: evalResult.subjectsToRelearn,
      subjectsToImprove: evalResult.subjectsToImprove
    };
    // Send all courses so AI has full context; gradeRows already deduplicates.
    // ponytail: if token limit becomes issue, compact to {name,grade} only for older courses.
    recentGradesFiltered = gradesRows.map(r => ({
      name: r[2],
      credits: r[3],
      score10: r[6],
      grade: r[8]
    }));
  }

  // Filter cleanData sent to AI based on current date to prevent AI from seeing past announcements/exams
  const today = new Date();
  const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentYear = today.getFullYear().toString();
  const isRequestingAll = normalizedLowerText.includes("tất cả") || normalizedLowerText.includes("tat ca") || normalizedLowerText.includes("toàn bộ") || normalizedLowerText.includes("toan bo");

  const filteredAnnouncements = data.canh_bao ? JSON.parse(data.canh_bao) : [];
  const filteredExams = data.lich_thi ? JSON.parse(data.lich_thi) : [];
  const filteredSchedule = data.lich_hoc ? JSON.parse(data.lich_hoc) : [];

  // Parse DD/MM/YYYY dates
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      const year = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
      return new Date(year, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
    return null;
  };

  // Helper to extract future or recent dates (up to 7 days ago) from announcement content strings
  const oneWeekAgo = new Date(todayReset);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const isRecentOrFutureAnnouncement = (item) => {
    const content = typeof item === "string" ? item : (item.content || JSON.stringify(item));
    const dates = content.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g);
    if (dates && dates.length > 0) {
      const parsedDates = dates.map(parseDate).filter(Boolean);
      if (parsedDates.length > 0) {
        return parsedDates.some(d => d >= oneWeekAgo);
      }
    }
    return content.includes(currentYear) || content.includes("/" + currentYear.slice(2));
  };

  const requestedAcademicYear = extractAcademicYearRequest(messageText);
  const requestedSchedule = requestedAcademicYear
    ? filterAcademicYearTables(filteredSchedule, requestedAcademicYear)
    : getScheduleEntries(filteredSchedule, { latest: true });

  const aiExamRows = isRequestingAll ? filteredExams.slice(1) : getExamRows(filteredExams);

  const cleanData = {
    user: { username: user.username },
    student_profile: data.thong_tin_sv ? JSON.parse(data.thong_tin_sv) : null,
    current_time: today.toISOString().split("T")[0] + " (Today is " + today.toLocaleDateString("vi-VN") + ")",
    announcements: isRequestingAll 
      ? filteredAnnouncements.slice(0, 5) 
      : filteredAnnouncements.filter(isRecentOrFutureAnnouncement).slice(0, 3),
    gpa_summary: gpaSummary,
    recent_grades: recentGradesFiltered,
    exams: isRequestingAll 
      ? aiExamRows.slice(0, 5)
      : aiExamRows.filter(r => {
          const examDate = parseExamDate(r[normalizeExamHeaders(filteredExams).date]);
          if (examDate) {
            return examDate >= todayReset;
          }
          const dateStr = r[normalizeExamHeaders(filteredExams).date] || "";
          return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
        }).slice(0, 3),
    tuition: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
    schedule: requestedSchedule
  };

  // Look up program framework from student's major
  const studentProfile = cleanData.student_profile || {};
  let majorName = studentProfile["Ngành"] || studentProfile["ngành"] || studentProfile["nganh"] || "";
  // Fallback: parse major from class name if not in profile
  if (!majorName && studentProfile["Lớp"]) {
    majorName = parseMajorFromClassName(studentProfile["Lớp"]) || "";
  }
  if (majorName) {
    const framework = await lookupProgramFramework(majorName);
    if (framework) {
      const creditsAccumulated = gpaSummary?.creditsAccumulated || 0;
      cleanData.program = {
        name: majorName,
        total_credits: framework.totalCredits,
        duration_years: framework.durationYears,
        credits_accumulated: creditsAccumulated,
        credits_remaining: Math.max(0, framework.totalCredits - creditsAccumulated),
        progress_percent: framework.totalCredits > 0
          ? Math.round((creditsAccumulated / framework.totalCredits) * 100)
          : 0,
        source: framework.source,
      };
      // Also update gpa_summary with program context
      if (gpaSummary) {
        gpaSummary.program_total_credits = framework.totalCredits;
        gpaSummary.credits_remaining = cleanData.program.credits_remaining;
      }
    }
  }

  // Classify query intent to scope RAG search to correct category in hdsd site content
  let detectedCategory = null;
  const lowerQuery = messageText.toLowerCase();
  if (lowerQuery.includes("học bổng") || lowerQuery.includes("khen thưởng") || lowerQuery.includes("tiêu chuẩn xét")) {
    detectedCategory = "scholarship";
  } else if (lowerQuery.includes("cảnh báo") || lowerQuery.includes("buộc thôi học") || lowerQuery.includes("kỷ luật")) {
    detectedCategory = "warning";
  } else if (lowerQuery.includes("quy chế") || lowerQuery.includes("tín chỉ") || lowerQuery.includes("điểm số") || lowerQuery.includes("đào tạo")) {
    detectedCategory = "academic_rules";
  } else if (lowerQuery.includes("thi kết thúc") || lowerQuery.includes("chấm thi") || lowerQuery.includes("phúc khảo") || lowerQuery.includes("exams")) {
    detectedCategory = "exams";
  } else if (lowerQuery.includes("lms3") || lowerQuery.includes("teams") || lowerQuery.includes("email") || lowerQuery.includes("tài khoản")) {
    detectedCategory = "it_systems";
  } else if (lowerQuery.includes("học phí") || lowerQuery.includes("tiền học") || lowerQuery.includes("công nợ")) {
    detectedCategory = "tuition";
  } else if (lowerQuery.includes("vstep") || lowerQuery.includes("nlnn") || lowerQuery.includes("chuẩn đầu ra")) {
    detectedCategory = "vstep";
  } else if (lowerQuery.includes("kế hoạch giảng dạy") || lowerQuery.includes("khung chương trình") || lowerQuery.includes("chương trình đào tạo") || lowerQuery.includes("môn học") || lowerQuery.includes("học phần")) {
    detectedCategory = "teaching_plan";
  }

  // RAG: Query matching regulation nodes from DB and hdsd crawl file.
  // When student's major is known, also search for program-specific teaching plan.
  const regs = await db.searchRegNodes(messageText, 4, detectedCategory);
  let majorRegs = [];
  if (majorName) {
    majorRegs = await db.searchRegNodes(`${majorName} kế hoạch giảng dạy`, 3, "teaching_plan");
    // Also try without category filter if nothing found
    if (!majorRegs.length) {
      majorRegs = await db.searchRegNodes(`${majorName} tổng số tín chỉ`, 2);
    }
  }
  // Merge: program-specific results first, then general results (deduplicated by content)
  const seenContents = new Set();
  const allRegs = [];
  for (const r of [...majorRegs, ...regs]) {
    const key = (r.content || "").slice(0, 100);
    if (!seenContents.has(key)) {
      seenContents.add(key);
      allRegs.push(r);
    }
  }
  const finalRegs = allRegs.slice(0, 6);
  let regContextText = "";
  if (finalRegs && finalRegs.length > 0) {
    regContextText = "\n[!] QUY CHẾ ĐÀO TẠO & HƯỚNG DẪN THAM KHẢO (Được trích xuất từ tài liệu UFLS):\n";
    finalRegs.forEach((r, idx) => {
      regContextText += `\nĐoạn ${idx + 1} (Nguồn: ${r.title || "Sổ tay sinh viên"} - ${r.source_url || "UFLS"}):\n${r.content}\n`;
    });
  }

  // Append student context data to existing system prompt
  systemPrompt += `\n\n===== DỮ LIỆU HỌC VỤ THỰC TẾ CỦA SINH VIÊN (NGUỒN DUY NHẤT) =====\nQUAN TRỌNG: Đây là dữ liệu THỰC TẾ của sinh viên. Bạn CHỈ được sử dụng thông tin trong này để trả lời. Nếu thông tin không có trong này, hãy nói "Thông tin này không có trong dữ liệu của bạn" thay vì bịa ra. Tuyệt đối không tự ý thêm URL, số điện thoại, địa chỉ, quy trình hay bất kỳ chi tiết nào không có trong dữ liệu dưới đây. Khi dữ liệu không có năm học được hỏi, không được suy ra từ năm học khác; phải nói rõ không có dữ liệu cho năm đó.\n${JSON.stringify(cleanData, null, 2)}\n${regContextText}`;

  // Append conversation history (last 3-5 exchanges) so AI can continue the chat
  const history = await db.getConversationHistory(senderPsid, 6);
  if (history && history.length > 0) {
    const formatted = history.reverse().map((h) => `${h.role === "user" ? "Sinh viên" : "Trợ lý"}: ${h.content}`).join("\n");
    systemPrompt += `\n\n===== LỊCH SỬ HỘI THOẠI GẦN ĐÂY =====\n${formatted}`;
  }

  const { reply } = await askAIWithTyping(senderPsid, systemPrompt, messageText);

  // Persist conversation turn
  await db.saveConversation(senderPsid, "user", messageText);
  await db.saveConversation(senderPsid, "assistant", reply);

  return messenger.sendTextMessage(senderPsid, reply);
}

// Short fragments need wider quiet window: users often send next Messenger bubble after >1.2s.
const MESSAGE_BATCH_DELAY = 3000;

function createMessageBatcher(processBatch, delayMs = MESSAGE_BATCH_DELAY) {
  const states = new Map();

  const drain = async (senderPsid, state) => {
    if (state.running) return;
    state.running = true;
    try {
      while (state.queue.length) {
        const batch = state.queue.shift();
        try {
          const result = await processBatch(senderPsid, batch.messages.join("\n"));
          batch.waiters.forEach(({ resolve }) => resolve(result));
        } catch (error) {
          batch.waiters.forEach(({ reject }) => reject(error));
        }
      }
    } finally {
      state.running = false;
      if (!state.pending && !state.queue.length) states.delete(senderPsid);
    }
  };

  const enqueue = (senderPsid, messageText) => new Promise((resolve, reject) => {
    const state = states.get(senderPsid) || { pending: null, queue: [], running: false };
    const pending = state.pending || { messages: [], waiters: [], timer: null };
    pending.messages.push(String(messageText).trim());
    pending.waiters.push({ resolve, reject });
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (state.pending !== pending) return;
      state.pending = null;
      state.queue.push(pending);
      void drain(senderPsid, state);
    }, delayMs);
    state.pending = pending;
    states.set(senderPsid, state);
  });

  // Immediate commands cancel unsent chat fragments, then wait behind active AI work.
  enqueue.enqueueNow = (senderPsid, messageText) => new Promise((resolve, reject) => {
    const state = states.get(senderPsid) || { pending: null, queue: [], running: false };
    if (state.pending) {
      clearTimeout(state.pending.timer);
      state.pending.waiters.forEach(({ resolve: done }) => done(undefined));
      state.pending = null;
    }
    state.queue.push({ messages: [String(messageText).trim()], waiters: [{ resolve, reject }] });
    states.set(senderPsid, state);
    void drain(senderPsid, state);
  });

  return enqueue;
}

const batchMessage = createMessageBatcher(processMessage);

const IMMEDIATE_MESSAGES = new Set([
  "pages", "trang", "sync", "đồng bộ", "menu", "xem menu", "cho xem menu",
  "xem menu hoc vu", "xem menu cau hoi", "câu hỏi thường gặp", "đăng xuất", "đăng xuất tài khoản", "logout", "qc_hocbong",
  "qc_canhbao", "qc_xeploai", "qc_caithien", "thông tin về dịch vụ", "dịch vụ",
  "lịch học", "lịch thi", "tất cả lịch thi", "điểm số", "gpa", "diem so", "diem",
  "tiến độ", "tín chỉ", "tien do", "tin chi", "học vụ", "thông báo", "hoc vu",
  "thong bao", "tất cả thông báo", "tat ca thong bao", "tất cả học vụ", "tat ca hoc vu",
  "học phí", "tiền", "hoc phi", "tien", "thời gian tiết học", "thời gian & tiết học", "thời gian & các tiết học", "tiết học", "tiet hoc", "hồ sơ", "hồ sơ sinh viên", "ho so",
  "lý lịch", "ly lich", "thống kê", "thong ke", "phân tích", "phan tich",
  "tóm tắt tuần", "tóm tắt", "tom tat", "test utility", "test utility messaging"
]);

function isImmediateMessage(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.startsWith("/") ||
    IMMEDIATE_MESSAGES.has(normalized) ||
    normalized.startsWith("testpage") ||
    normalized.startsWith("toggle ") ||
    normalized.startsWith("toggle_") ||
    normalized.startsWith("email ") ||
    normalized.startsWith("lịch học thứ") ||
    normalized.startsWith("lịch học t") ||
    normalized.startsWith("lịch học cn") ||
    normalized.startsWith("lịch học chủ nhật") ||
    normalized.startsWith("lich hoc ") ||
    /^\d+$/.test(normalized) ||
    /^[a-z0-9]+_[a-z0-9_]+$/i.test(normalized);
}

function isBatchableMessage(senderPsid, messageText) {
  if (loginSessions.has(senderPsid)) return false;
  const text = String(messageText || "").trim();
  return Boolean(text) && !isImmediateMessage(text);
}

function handleMessage(senderPsid, messageText) {
  return isBatchableMessage(senderPsid, messageText)
    ? batchMessage(senderPsid, messageText)
    : batchMessage.enqueueNow(senderPsid, messageText);
}

module.exports = {
  handleMessage,
  createMessageBatcher,
  setBaseUrl,
  extractAcademicYearRequest,
  filterAcademicYearTables,
  getScheduleEntries,
  isScheduleQuery,
  isSchedulePrefix,
  normalizeExamHeaders,
  examDetails,
  getExamRows,
  formatHocPhi,
  formatKetQuaHocTap,
  formatTietHoc,
};
