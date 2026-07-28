const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { askAI } = require("./ai");
const { calculateGPA, extractGPA, extractDRL, getAcademicEvaluation, getScholarshipAndActivityAdvice } = require("./gpaHelper");
const { PAGES, hasUsableData } = require("./pages");
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

function formatKetQuaHocTap(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm học tập.";

  let gpa = extractGPA(rawKq);
  const gradeTables = rawKq.filter((t) => t.headers && t.headers.includes("Tên học phần"));
  const targetTable = gradeTables[0];

  let courses = [];
  if (gradeTables.length) {
    courses = gradeTables.flatMap(table => table.rows || []).map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
  }

  if (!gpa) {
    if (!targetTable) return "Chưa cập nhật bảng điểm chính.";
    gpa = calculateGPA(courses);
  }

  if (!gpa) return "Không thể đọc dữ liệu điểm học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester, courses);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  let txt = `📊 KẾT QUẢ HỌC TẬP (Dữ liệu từ UFLS):\n`;
  txt += `- GPA Học kỳ: ${gpa.gpaSemester}/4.0\n`;
  txt += `- GPA Tích lũy: ${gpa.gpaAccumulated}/4.0\n`;
  txt += `- Tín chỉ tích lũy: ${gpa.creditsAccumulated} TC\n`;
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
    txt += `\n📝 Chi tiết điểm môn gần đây:`;
    gradeTables.flatMap(table => table.rows || []).slice(0, 5).forEach((r) => {
      txt += `\n- ${r[2]}: ${r[6]} (${r[8]})`;
    });
  }

  txt += `\n\n(Thông tin tham khảo từ Sổ tay sinh viên)`;
  return txt;
}

function formatLichThi(data, showAll = false) {
  if (!data || !data.length || data.length < 2) return "Không có lịch thi sắp tới.";
  let txt = "[~] LỊCH THI:\n";
  const currentYear = new Date().getFullYear().toString();
  
  let rows = data.slice(1);
  if (!showAll) {
    rows = rows.filter(r => {
      const dateStr = r[3] || "";
      return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
    });
  }

  if (!rows.length) return showAll ? "Không có lịch thi." : "Không có lịch thi trong năm nay.";

  rows.slice(0, 5).forEach((r) => {
    txt += `\n- Môn: ${r[2]}\n  Ngày: ${r[3]} (${r[5]})\n  Phòng: ${r[9]} - HT: ${r[10]}\n`;
  });
  return txt;
}

function formatHocPhi(data) {
  if (!data || !data.length) return "Chưa có dữ liệu học phí.";
  let txt = "[$] TÀI CHÍNH & HỌC PHÍ THEO KÌ:\n";
  let hasDebt = false;
  
  data.forEach((t, idx) => {
    let termTitle = `Học kỳ / Đợt ${idx + 1}`;
    if (t.headers) {
      // Try to detect headers or look for text in headers
    }
    
    let tableTxt = "";
    if (t.rows) {
      t.rows.forEach((r) => {
        const cleaned = r.map(cell => cell.trim().replace(/\s+/g, " ")).filter(Boolean);
        // Display rows related to course fees or summary status
        if (cleaned.some(cell => cell.includes("Học phí") || cell.includes("Số tiền") || cell.includes("Nợ") || cell.includes("Tổng") || cell.includes("Còn nợ"))) {
          tableTxt += `  + ${cleaned.join(" | ")}\n`;
        }
        if (cleaned.some(cell => cell.toLowerCase().includes("còn nợ") || cell.toLowerCase().includes("nợ"))) {
          // Check if there is actual remaining debt > 0
          const debtCell = cleaned.find(cell => cell.toLowerCase().includes("còn nợ") || cell.toLowerCase().includes("nợ"));
          if (debtCell && !debtCell.includes(": 0") && !debtCell.match(/:\s*0\b/)) {
            hasDebt = true;
          }
        }
      });
    }
    if (tableTxt) {
      txt += `\n* ${termTitle}:\n${tableTxt}`;
    }
  });

  return txt.length > 30 ? txt : "Không có công nợ học phí.";
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
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scheduleColumn(headers, aliases) {
  const normalized = headers.map(normalizeScheduleHeader);
  return aliases
    .map((alias) => normalized.indexOf(normalizeScheduleHeader(alias)))
    .find((index) => index !== -1);
}

function getScheduleEntries(data, options = {}) {
  if (!Array.isArray(data)) return [];
  const isPeriod = (value) => /^\d+(?:\s*[-–]\s*\d+)?$/.test(String(value || "").trim());
  const isDay = (value) => /^(?:thứ\s*)?[2-7]$|^chủ nhật$/i.test(String(value || "").trim());
  const isLegacyRow = (row) => isPeriod(row?.[0]) && isDay(row?.[2]) && String(row?.[1] || "").trim();
  const isScheduleHeader = (h) => {
    const n = normalizeScheduleHeader(h);
    return n.includes("ten hoc phan") || n.includes("ten mon") || n === "mon hoc" || n === "hoc phan";
  };
  const tables = data.filter((t) => {
    const headers = (t.headers || []).map(normalizeScheduleHeader);
    return headers.some(isScheduleHeader) || (t.rows || []).some(isLegacyRow);
  });
  if (!tables.length) return [];

  if (options.latest && tables.length > 1) {
    const scheduleValue = table => {
      const year = Number(table.yearValue || String(table.year || "").match(/\d{4}/)?.[0] || 0);
      const semester = Number(table.semesterValue || String(table.semester || "").match(/\d+/)?.[0] || 0);
      return year * 10 + semester;
    };
    const latestValue = Math.max(...tables.map(scheduleValue));
    const latest = tables.filter(table => scheduleValue(table) === latestValue);
    tables.splice(0, tables.length, latest[latest.length - 1] || tables[tables.length - 1]);
  }

  // Multi-semester scraper stores one table per year/semester. Merge selected rows.
  const table = {
    headers: tables.find(t => t.headers?.length)?.headers || [],
    rows: tables.flatMap(t => t.rows || [])
  };

  const headers = table.headers || [];
  const columns = {
    day: scheduleColumn(headers, ["Thứ", "Ngày"]),
    period: scheduleColumn(headers, ["Tiết", "Tiết học"]),
    name: scheduleColumn(headers, ["Tên học phần", "Tên môn học", "Môn học", "Học phần", "Tên môn"]),
    room: scheduleColumn(headers, ["Phòng", "Phòng học"]),
    className: scheduleColumn(headers, ["Tên lớp tín chỉ", "Lớp học phần", "Lớp", "Lớp tín chỉ"]),
  };

  // Only use legacy fallback if header resolution failed completely
  const hasDetectedHeaders = columns.day !== -1 && columns.period !== -1 && columns.name !== -1;
  const legacy = !hasDetectedHeaders && (table.rows || []).some(isLegacyRow);
  const fallback = { day: 2, period: 0, name: 1, room: 4, className: 3 };
  const col = legacy
    ? fallback
    : Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, value !== -1 ? value : (fallback[key] ?? -1)]));

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const entries = [];

  (table.rows || []).forEach((row) => {
    const name = col.name !== -1 ? clean(row[col.name]).replace(/^tiết\s+/i, "") : "";
    if (!name || ["stt", "môn học", "tên học phần", "học phần"].includes(name.toLowerCase())) return;

    const rawDay = col.day !== -1 ? String(row[col.day] || "") : "";
    const rawPeriod = col.period !== -1 ? String(row[col.period] || "") : "";
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
          className
        });
      }
    } else {
      entries.push({
        day: days.join(", ") || clean(rawDay),
        period: periods.join(", ") || clean(rawPeriod),
        name,
        room: rooms.join(", ") || clean(rawRoom),
        className
      });
    }
  });

  return entries.filter((entry) => entry.name && (isDay(entry.day) || entry.day.toLowerCase().startsWith("thứ") || /^\d+$/.test(entry.day)));
}

function formatScheduleDay(day) {
  const value = String(day || "").trim();
  if (!value) return "";
  return /^thứ\s|^chủ nhật/i.test(value) ? value : `Thứ ${value}`;
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

  filtered.slice(0, 7).forEach((entry) => {
    const details = [entry.day && `Thứ ${entry.day.replace(/^thứ\s*/i, "")}`, entry.period && `Tiết ${entry.period}`];
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

function filterAcademicYearTables(data, request) {
  if (!Array.isArray(data) || !request) return [];
  const serialized = (item) => JSON.stringify(item);
  const pattern = request.value
    ? new RegExp(`${request.value.split("-")[0]}\\s*[-–]\\s*${request.value.split("-")[1]}`, "i")
    : new RegExp(`năm\\s*(?:học\\s*)?(?:đào tạo\\s*)?(?:thứ\\s*)?${request.ordinal}\\b`, "i");
  return data.filter((item) => pattern.test(serialized(item)));
}

function isStudentProfileQuery(text) {
  return /\b(?:thông tin\s+(?:cá nhân|sinh viên)|hồ sơ(?:\s+sinh viên|\s+cá nhân)?|lý lịch|profile)\b/i.test(text);
}

function formatTienDo(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm để tính tiến độ.";

  let gpa = extractGPA(rawKq);
  const gradeTables = rawKq.filter((t) => t.headers && t.headers.includes("Tên học phần"));
  const targetTable = gradeTables[0];

  let courses = [];
  if (gradeTables.length) {
    courses = gradeTables.flatMap(table => table.rows || []).map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
  }

  if (!gpa && targetTable) {
    gpa = calculateGPA(courses);
  }

  if (!gpa) return "Không thể đọc thông tin tiến độ học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester, courses);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  const rows = gradeTables.flatMap(table => table.rows || []);
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
  else if (actionText === "sync_postback") actionText = "/sync";
  else if (actionText === "logout_postback") actionText = "/logout";
  else if (actionText === "login_postback") actionText = "/login";
  else if (actionText === "menu_postback") actionText = "xem menu hoc vu"; // map Tra cứu học vụ to xem menu hoc vu view
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
    const scraperPath = path.resolve(__dirname, "./scrape.js");
    const execCmd = `node "${scraperPath}" --fb-id="${user.fb_id.replace(/"/g, '\\"')}" --silent`;
    exec(execCmd, async (err) => {
      scrapingInProgress.delete(senderPsid);
      if (err) {
        return messenger.sendTextMessage(senderPsid, "[X] Quá trình đồng bộ thất bại.");
      }
      const complete = await isSyncComplete(senderPsid);
      return messenger.sendTextMessage(senderPsid, complete
        ? `[✓] Đã đồng bộ xong mục "${arg}". Gõ /pages để kiểm tra.`
        : "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
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
    const scraperPath = path.resolve(__dirname, "./scrape.js");
    const execCmd = `node "${scraperPath}" --fb-id="${user.fb_id.replace(/"/g, '\\"')}" --silent`;
    exec(execCmd, async (err) => {
      scrapingInProgress.delete(senderPsid);
      if (err) {
        const complete = await isSyncComplete(senderPsid);
        return messenger.sendTextMessage(senderPsid, complete
          ? "[X] Quá trình đồng bộ dữ liệu tức thời thất bại hoặc bị nghẽn mạng."
          : "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
      }
      const complete = await isSyncComplete(senderPsid);
      if (!complete) {
        return messenger.sendTextMessage(senderPsid, "[!] Đồng bộ chưa hoàn tất. Một số mục chưa có dữ liệu; thử /sync lại sau.");
      }
      return sendSyncConfirmation(senderPsid, user.username);
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
      { title: "Lịch thi (năm nay)", payload: "LICH_THI" },
      { title: "Tất cả Lịch thi", payload: "ALL_LICH_THI" },
      { title: "Điểm số", payload: "DIEM_SO" },
      { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
      { title: "Tiến độ", payload: "TIEN_DO" },
      { title: "Học phí", payload: "HOC_PHI" },
      { title: "Cài đặt", payload: "MENU_POSTBACK" }
    ]);
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
    return messenger.sendTextMessage(senderPsid, "Vui lòng nhập Mã sinh viên của bạn để kết nối UFL Productivity Hub:");
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
            await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang suy nghĩ...");
            const reply = await askAI(fallbackPrompt, text);
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
          await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang suy nghĩ...");
          const reply = await askAI(fallbackPrompt, text);
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
        const scraperPath = path.resolve(__dirname, "./scrape.js");
        const execCmd = `node "${scraperPath}" --fb-id="${senderPsid.replace(/"/g, '\\"')}" --silent --notify-login-failure`;
        console.log(`[botRouter] Executing scrape command: ${execCmd}`);
        const child = exec(execCmd, async (err, stdout, stderr) => {
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
  
  if (normalizedLowerText === "lịch thi" || normalizedLowerText === "lich thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const currentYear = new Date().getFullYear().toString();
    const filtered = raw.slice(1).filter(r => {
      const dateStr = r[3] || "";
      return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
    });

    if (!filtered.length) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi trong năm nay. Gõ 'tất cả lịch thi' để xem toàn bộ.");
    }

    const elements = filtered.slice(0, 5).map((r) => ({
      title: `Thi: ${r[2] || "Môn học"}`,
      subtitle: `Ngày: ${r[3]} (${r[5]})\nPhòng: ${r[9]} | SBD: ${r[8]} | HT: ${r[10]}`,
      buttons: [
        {
          type: "postback",
          title: "Xem Điểm",
          payload: "DIEM_SO"
        }
      ]
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (normalizedLowerText === "tất cả lịch thi" || normalizedLowerText === "tat ca lich thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const elements = raw.slice(1, 6).map((r) => ({
      title: `Thi: ${r[2] || "Môn học"}`,
      subtitle: `Ngày: ${r[3]} (${r[5]})\nPhòng: ${r[9]} | SBD: ${r[8]} | HT: ${r[10]}`,
      buttons: [
        {
          type: "postback",
          title: "Xem Điểm",
          payload: "DIEM_SO"
        }
      ]
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  const requestedScheduleYear = extractAcademicYearRequest(text);
  if (requestedScheduleYear && isSchedulePrefix(normalizedLowerText)) {
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const matchingTables = filterAcademicYearTables(raw, requestedScheduleYear);
    if (matchingTables.length) return messenger.sendTextMessage(senderPsid, formatLichHoc(matchingTables));

    const scheduleForAI = raw && raw.length ? raw : null;
    const gradesForAI = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : [];
    const academicTables = gradesForAI.filter((table) => {
      const headers = (table.headers || []).join(" ").toLowerCase();
      return headers.includes("kỳ thứ") || headers.includes("học kỳ") || headers.includes("tên học phần");
    });
    if (!scheduleForAI && !academicTables.length) {
      const label = requestedScheduleYear.value ? requestedScheduleYear.label : `năm ${requestedScheduleYear.ordinal}`;
      return messenger.sendTextMessage(senderPsid, `Không có dữ liệu lịch học cho ${label} trong dữ liệu đã đồng bộ.`);
    }

    const schedulePrompt = `${systemPrompt}\n\nDỮ LIỆU HỌC VỤ GỐC CỦA SINH VIÊN:\n${JSON.stringify({ lịch_học: scheduleForAI, bảng_học_phần: academicTables }, null, 2)}\n\nQuy tắc truy vấn năm học:\n- Chỉ trả lời năm được hỏi nếu dữ liệu có nhãn năm tương ứng hoặc có cột Kỳ thứ/Học kỳ để xác định rõ.\n- Với chương trình 4 năm, năm N chỉ gồm kỳ thứ ${requestedScheduleYear.ordinal ? `${requestedScheduleYear.ordinal * 2 - 1} và ${requestedScheduleYear.ordinal * 2}` : "được ghi rõ trong dữ liệu"}; không dùng lịch của kỳ khác.\n- Nếu dữ liệu chỉ có lịch hiện tại và không xác định được năm, nói rõ không có dữ liệu cho năm đó. Tuyệt đối không suy đoán hoặc lấy lịch hiện tại gán cho năm cũ.\n`;
    await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang kiểm tra lịch học...");
    const reply = await askAI(schedulePrompt, text);
    await db.saveConversation(senderPsid, "user", text);
    await db.saveConversation(senderPsid, "assistant", reply);
    return messenger.sendTextMessage(senderPsid, reply);
  }

  if (isScheduleQuery(normalizedLowerText)) {
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const entries = getScheduleEntries(raw, { latest: true });
    if (!entries.length) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch học trong kỳ hiện tại.");
    }
    return messenger.sendTextMessage(senderPsid, formatLichHoc(raw, null, { latest: true }));
  }

  if (normalizedLowerText.startsWith("lịch học thứ") || normalizedLowerText.startsWith("lịch học t") || normalizedLowerText.startsWith("lịch học cn") || normalizedLowerText.startsWith("lịch học chủ nhật") || normalizedLowerText.startsWith("lich hoc thu") || normalizedLowerText.startsWith("lich hoc t") || normalizedLowerText.startsWith("lich hoc cn") || normalizedLowerText.startsWith("lich hoc chu nhat")) {
    const dayPart = text.replace(/lịch học /i, "").replace(/lich hoc /i, "").trim();
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const entries = getScheduleEntries(raw);
    const dayMap = {
      "2": "thứ 2", "3": "thứ 3", "4": "thứ 4", "5": "thứ 5", "6": "thứ 6", "7": "thứ 7", "cn": "chủ nhật",
      "thu2": "thứ 2", "thu3": "thứ 3", "thu4": "thứ 4", "thu5": "thứ 5", "thu6": "thứ 6", "thu7": "thứ 7",
    };
    const targetDay = (dayMap[dayPart.toLowerCase()] || dayPart).toLowerCase();
    const filtered = entries.filter((entry) => entry.day.toLowerCase().includes(targetDay));

    if (!filtered.length) {
      return messenger.sendTextMessage(senderPsid, `Không có lịch học nào vào ${dayPart}.`);
    }

    const elements = filtered.slice(0, 5).map((entry) => ({
      title: entry.name,
      subtitle: [entry.period && `Tiết ${entry.period}`, entry.room && `Phòng ${entry.room}`, entry.className && `Lớp ${entry.className}`]
        .filter(Boolean).join(" | "),
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
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

    await messenger.sendTextMessage(senderPsid, "AI đang phân tích dữ liệu học tập của bạn...");
    const statsResult = await askAI(statsPrompt, "Hãy thống kê và phân tích tiến độ học tập của tôi.");
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

    await messenger.sendTextMessage(senderPsid, "AI đang tổng hợp và tóm tắt tuần của bạn...");
    const summaryResult = await askAI(summaryPrompt, "Hãy tóm tắt tuần học tập của tôi.");
    await db.saveConversation(senderPsid, "user", messageText);
    await db.saveConversation(senderPsid, "assistant", summaryResult);
    return messenger.sendTextMessage(senderPsid, summaryResult);
  }

  // Ask AI (Free text)
  const rawGrades = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : null;
  const targetGradeTable = rawGrades ? rawGrades.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
  const gradesRows = targetGradeTable ? (targetGradeTable.rows || []) : [];

  // Compact grade data to reduce token load and prevent AI timeout/refusal
  let gpaSummary = null;
  let recentGradesFiltered = [];
  if (gradesRows && gradesRows.length > 0) {
    const courses = gradesRows.map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
    const calculated = calculateGPA(courses);
    const evalResult = getAcademicEvaluation(calculated.gpaAccumulated, calculated.gpaSemester, courses);
    
    gpaSummary = {
      gpaSemester: calculated.gpaSemester,
      gpaAccumulated: calculated.gpaAccumulated,
      creditsAccumulated: calculated.creditsAccumulated,
      rank: evalResult.rank,
      subjectsToRelearn: evalResult.subjectsToRelearn,
      subjectsToImprove: evalResult.subjectsToImprove
    };
    // Only send the 8 most recent courses to prevent system overload
    recentGradesFiltered = gradesRows.slice(0, 8).map(r => ({
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
    : filteredSchedule.slice(0, 4);

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
      ? filteredExams.slice(0, 5)
      : filteredExams.slice(1).filter(r => {
          const examDate = parseDate(r[3]);
          if (examDate) {
            return examDate >= todayReset;
          }
          const dateStr = r[3] || "";
          return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
        }).slice(0, 3),
    tuition: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
    schedule: requestedSchedule
  };

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
  }

  // RAG: Query matching regulation nodes from DB and hdsd crawl file
  const regs = await db.searchRegNodes(messageText, 4, detectedCategory);
  let regContextText = "";
  if (regs && regs.length > 0) {
    regContextText = "\n[!] QUY CHẾ ĐÀO TẠO & HƯỚNG DẪN THAM KHẢO (Được trích xuất từ tài liệu UFLS):\n";
    regs.forEach((r, idx) => {
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

  await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang suy nghĩ...");
  const reply = await askAI(systemPrompt, messageText);

  // Persist conversation turn
  await db.saveConversation(senderPsid, "user", messageText);
  await db.saveConversation(senderPsid, "assistant", reply);

  return messenger.sendTextMessage(senderPsid, reply);
}

const MESSAGE_BATCH_DELAY = 1200;

function createMessageBatcher(processBatch, delayMs = MESSAGE_BATCH_DELAY) {
  const pending = new Map();

  return (senderPsid, messageText) => new Promise((resolve, reject) => {
    const batch = pending.get(senderPsid) || { messages: [], waiters: [], timer: null };
    batch.messages.push(String(messageText).trim());
    batch.waiters.push({ resolve, reject });
    clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      pending.delete(senderPsid);
      try {
        const result = await processBatch(senderPsid, batch.messages.join("\n"));
        batch.waiters.forEach(({ resolve: done }) => done(result));
      } catch (error) {
        batch.waiters.forEach(({ reject: fail }) => fail(error));
      }
    }, delayMs);
    pending.set(senderPsid, batch);
  });
}

const batchMessage = createMessageBatcher(processMessage);

function isBatchableMessage(senderPsid, messageText) {
  if (loginSessions.has(senderPsid)) return false;
  const text = String(messageText || "").trim();
  return text.includes(" ") && !text.startsWith("/") && isNaturalLanguageQuestion(text);
}

function handleMessage(senderPsid, messageText) {
  return isBatchableMessage(senderPsid, messageText)
    ? batchMessage(senderPsid, messageText)
    : processMessage(senderPsid, messageText);
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
};
