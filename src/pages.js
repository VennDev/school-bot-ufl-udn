const BASE = "https://sinhvien.ufl.udn.vn";

function _normalizeSemester(text) {
  const str = String(text || "").trim();
  const num = str.match(/(\d+)/);
  if (num) return `Kỳ ${num[1]}`;
  const roman = { i: "1", ii: "2", iii: "3", iv: "4" };
  const lower = str.toLowerCase().replace(/\s+/g, "");
  return roman[lower] ? `Kỳ ${roman[lower]}` : str;
}

function parseAcademicYear(value) {
  const match = String(value || "").match(/\b(\d{4})\s*[-–—]\s*(\d{4})\b/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function inferAcademicYearFromRows(rows, headers = []) {
  const normalizedHeaders = headers.map(value => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
  const timeIndex = normalizedHeaders.findIndex(header => /thoi gian hoc|thoi gian|ngay hoc|ngay thi/.test(header));
  if (timeIndex < 0) return null;
  const dateTexts = (Array.isArray(rows) ? rows : []).map(row => {
    if (!Array.isArray(row)) return "";
    return String(row[timeIndex] || "");
  });
  const starts = dateTexts.flatMap(text => [...text.matchAll(/(?:ngày\s*:\s*)?(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/gi)]
    .map(match => {
      const month = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      return year >= 2000 && year <= new Date().getFullYear() + 2
        ? (month >= 8 ? year : year - 1)
        : null;
    }).filter(Boolean));
  if (!starts.length) return null;
  // One selected portal table can contain old classes plus a newer make-up
  // date. Latest real date identifies academic-year table better than majority.
  const start = Math.max(...starts);
  return { start, end: start + 1, text: `${start}-${start + 1}` };
}

function rowAcademicYearStart(row, headers = []) {
  const normalizedHeaders = headers.map(value => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
  const timeIndex = normalizedHeaders.findIndex(header => /thoi gian hoc|thoi gian|ngay hoc|ngay thi/.test(header));
  const text = Array.isArray(row)
    ? (timeIndex >= 0 ? String(row[timeIndex] || "") : row.join(" "))
    : String(row || "");
  const starts = [...text.matchAll(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/g)]
    .map(match => {
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      if (year < 2000 || year > new Date().getFullYear() + 2) return null;
      return Number(match[2]) >= 8 ? year : year - 1;
    }).filter(year => year !== null);
  return starts.length ? Math.max(...starts) : null;
}

function filterRowsByAcademicYear(rows, headers, wantedStart) {
  const dated = rows.filter(row => rowAcademicYearStart(row, headers) !== null);
  if (!dated.length) return rows;
  return rows.filter(row => {
    const start = rowAcademicYearStart(row, headers);
    return start === null || start === wantedStart;
  });
}

function academicYearTextForRow(row, headers, fallback) {
  const start = rowAcademicYearStart(row, headers);
  return start === null ? fallback : `${start}-${start + 1}`;
}

function normalizeAcademicYearSelection(yearText, rows, headers = []) {
  const parsed = parseAcademicYear(yearText);
  const inferred = inferAcademicYearFromRows(rows, headers);
  // Row dates win. Portal can return a plausible but wrong option label
  // (for example 2027-2028 while rows end in April 2027).
  if (inferred) return { text: inferred.text, value: String(inferred.start) };
  // Always normalize to canonical "YYYY-YYYY" so portal text variations
  // ("2023 - 2024", "2023–2024", "2023-2024") produce a stable key.
  if (parsed && parsed.start <= new Date().getFullYear() + 1) {
    return { text: `${parsed.start}-${parsed.end}`, value: String(parsed.start) };
  }
  return { text: String(yearText || "").trim(), value: String(yearText || "").trim() };
}

// Read every real year/semester option. Keep only combinations whose page returns rows.
async function _collectMultiSemester(page, extractInBrowserFn, mode = "tables") {
  const hasYearSelect = await page.$("#cmbNamHoc");
  if (!hasYearSelect) return false;

  const readOptions = (selector) => page.$eval(selector, select =>
    [...select.options]
      .map(option => ({
        value: option.value,
        text: option.textContent.trim(),
        disabled: option.disabled,
      }))
      .filter(option => !option.disabled && option.value !== "" && option.value !== "-1" && !/(?:chọn|select)/i.test(option.text))
  ).catch(() => []);

  const settleSelection = async (selector, value) => {
    try {
      await page.selectOption(selector, value);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(700);
      return true;
    } catch {
      return false;
    }
  };

  const years = await readOptions("#cmbNamHoc");
  const collectedTables = [];
  const collectedRows = [];
  const seenTables = new Set();
  const seenRows = new Set();
  const isPlaceholderRow = (row) => /không\s+có\s+(?:dữ\s+liệu|lịch)|chưa\s+có\s+dữ\s+liệu|no\s+data/i.test(row.join(" "));

  for (const year of years) {
    if (!await settleSelection("#cmbNamHoc", year.value)) continue;
    // Year change may replace dropdown DOM; read current options each iteration.

    // Semester options can be repopulated after year changes; never hardcode them.
    const semesterSelect = await page.$("#cmbHocKy");
    const semesters = semesterSelect ? await readOptions("#cmbHocKy") : [{ value: "", text: "" }];
    for (const semester of semesters) {
      if (semester.value && !await settleSelection("#cmbHocKy", semester.value)) continue;

      try {
        const extracted = await page.evaluate(extractInBrowserFn, {
          yearText: year.text,
          yearValue: year.value,
          semesterText: semester.text,
          semesterValue: semester.value,
        });

        if (mode === "rows") {
          const rows = Array.isArray(extracted) ? extracted : extracted?.rows || [];
          const headers = extracted?.headers || rows[0] || [];
          const dataRows = extracted?.rows || rows.slice(1);
          const usableRows = dataRows.filter(row => !isPlaceholderRow(row) && row.some(cell => String(cell ?? "").trim()));
          if (!headers.length || !usableRows.length) continue;
          const selection = normalizeAcademicYearSelection(year.text, usableRows, headers);
          if (!collectedRows.length) collectedRows.push([...headers, "Năm học", "Học kỳ"]);
          usableRows.forEach(row => {
            const entry = [...row, academicYearTextForRow(row, headers, selection.text), _normalizeSemester(semester.text)];
            const key = JSON.stringify(entry);
            if (!seenRows.has(key)) { seenRows.add(key); collectedRows.push(entry); }
          });
          continue;
        }

        for (const table of Array.isArray(extracted) ? extracted : []) {
          const isScheduleSummaryRow = row => {
            if (!Array.isArray(row) || row.length > 3) return false;
            const text = row.join(" ");
            return /\b\d{4}\s*[-–]\s*\d{4}\b/.test(text) && /\bkỳ\s*[123]\b/i.test(text);
          };
          const rows = (table?.rows || []).filter(row => !isPlaceholderRow(row) && !isScheduleSummaryRow(row));
          if (!rows.some(row => row.some(cell => String(cell ?? "").trim()))) continue;
          // Same rows can exist in multiple academic years. Keep selection metadata,
          // or a year-specific query can lose an otherwise valid match.
          const headers = table.headers || [];
          const selection = normalizeAcademicYearSelection(year.text, rows, headers);
          const tableKey = JSON.stringify([selection.value, semester.value, headers, rows]);
          if (seenTables.has(tableKey)) continue;
          seenTables.add(tableKey);
          collectedTables.push({
            ...table,
            year: selection.text,
            yearValue: selection.value,
            sourceYear: year.text,
            sourceYearValue: year.value,
            semester: _normalizeSemester(semester.text),
            semesterValue: semester.value,
            headers: [...headers, "Năm học", "Học kỳ"],
            rows: rows.map(row => [...row, academicYearTextForRow(row, headers, selection.text), _normalizeSemester(semester.text)]),
          });
        }
      } catch {
        // One unavailable year/semester must not abort remaining combinations.
      }
    }
  }

  // Mark setup as handled even when no combination has data. Scraper must retry,
  // not fall back to whichever stale dropdown state the portal left selected.
  page._collectedData = mode === "rows" ? collectedRows : collectedTables;
  return true;
}

function _extractTables() {
  const tables = [];
  document.querySelectorAll("table").forEach(table => {
    const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map(th => th.innerText.trim());
    const rows = [];
    table.querySelectorAll("tbody tr, tr:not(:first-child)").forEach(tr => {
      const cells = [...tr.querySelectorAll("td")].map(td => td.innerText.trim());
      if (cells.length) rows.push(cells);
    });
    if (headers.length || rows.length) tables.push({ headers, rows });
  });
  return tables;
}

function _extractRows() {
  const rows = [];
  document.querySelectorAll("table tr").forEach(tr => {
    const cells = [...tr.querySelectorAll("td, th")].map(cell => cell.innerText.trim());
    if (cells.length) rows.push(cells);
  });
  return rows;
}

function _extractScheduleTables() {
  const tables = [];
  document.querySelectorAll("table").forEach(table => {
    const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map(th => th.innerText.trim());
    const rows = [...table.querySelectorAll("tbody tr, tr:not(:first-child)")]
      .map(tr => [...tr.querySelectorAll("td")].map(td => td.innerText.trim()))
      .filter(row => row.length);
    const normalizedHeaders = headers.map(header => String(header || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase());
    // Keep course-registration tables only. Absence/announcement tables also
    // contain subject/time columns, but lack credits and class columns.
    const hasCourse = normalizedHeaders.some(header => /ten hoc phan|ten mon/.test(header));
    const hasRegistrationColumns = normalizedHeaders.some(header => /so tin chi|ten lop tin chi|duong dan/.test(header));
    if (hasCourse && hasRegistrationColumns && rows.some(row => row.some(cell => cell.length > 2 && !/STT/i.test(cell)))) {
      tables.push({ headers, rows });
    }
  });
  return tables;
}

function parseMajorFromClassName(className) {
  // Extract major code from class name like "23CNA13" -> "CNA"
  const text = String(className || "").trim();
  // Match pattern: digits + letters + digits (e.g., 23CNA13, 20SPA01)
  const match = text.match(/^\d{2}([A-Z]+)\d{1,2}$/i);
  if (!match) return null;
  const code = match[1].toUpperCase();
  const majorMap = {
    "CNA": "Cử nhân Anh",
    "SPA": "Sư phạm tiếng Anh",
    "SPP": "Sư phạm tiếng Pháp",
    "SPT": "Sư phạm tiếng Trung Quốc",
    "SPN": "Sư phạm tiếng Nga",
    "SPH": "Sư phạm tiếng Hàn Quốc",
    "SPNH": "Sư phạm tiếng Nhật",
    "CNP": "Cử nhân Pháp",
    "CNT": "Cử nhân Trung Quốc",
    "CNN": "Cử nhân Nga",
    "CNH": "Cử nhân Hàn Quốc",
    "CNNH": "Cử nhân Nhật Bản",
    "CNTL": "Cử nhân Thái Lan",
    "QT": "Quốc tế học",
    "QTH": "Quốc tế học",
    "TV": "Tiếng Việt và Văn hóa Việt Nam",
    "TVVH": "Tiếng Việt và Văn hóa Việt Nam",
  };
  return majorMap[code] || code;
}

function hasUsableData(key, value) {
  if (value == null) return false;
  if (key === "thongTinSV") {
    if (!value || typeof value !== "object") return false;
    const validEntries = Object.entries(value).filter(([f, v]) => !f.startsWith("_") && String(v ?? "").trim().length > 0);
    if (validEntries.length === 0) return false;
    // Check if any key matches student profile fields (flexible matching with/without accents)
    const profileFieldRegex = /nganh|ngành|ma|mã|mssv|ho|họ|ten|tên|lop|lớp|khoa|khóa|trang thai|trạng thái|he|hệ|email|phone|sdt|sđt|dia chi|địa chỉ|cmnd|cccd/i;
    const hasProfileField = validEntries.some(([field]) => {
      const normField = field.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d");
      return profileFieldRegex.test(field) || profileFieldRegex.test(normField);
    });
    return hasProfileField || validEntries.length >= 2;
  }
  if (key === "canhBao") return Array.isArray(value);
  if (key === "hocBongKTKL") return value != null && typeof value === "object";
  if (Array.isArray(value)) {
    return value.some(item => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Array.isArray(item.rows) && item.rows.some(row =>
          Array.isArray(row) && row.some(cell => String(cell ?? "").trim())
        ) || Boolean(String(item.content ?? "").trim());
      }
      return Array.isArray(item) ? item.some(cell => String(cell ?? "").trim()) : Boolean(String(item ?? "").trim());
    });
  }
  return typeof value === "object" && Object.keys(value).length > 0;
}

const PAGES = [
  {
    key: "canhBao",
    url: `${BASE}/CanhBao/Index`,
    label: "Cảnh báo / Thông báo",
    // Announcements are rendered as <label> elements inside #divDataContent, not tables.
    extract: () => {
      const items = [];
      const container = document.querySelector("#divDataContent");
      if (container) {
        const labels = container.querySelectorAll("label");
        labels.forEach(l => {
          const text = l.innerText?.trim();
          if (text && text.length > 10) {
            items.push({ content: text });
          }
        });
      }
      // Fallback: if no labels found, try grabbing all text blocks from the content area
      if (!items.length) {
        const main = document.querySelector("#divDataContent, .news-listing, .col-md-9");
        if (main) {
          items.push({ content: main.innerText.trim() });
        }
      }
      return items;
    },
  },
  {
    key: "thongTinSV",
    url: `${BASE}/SinhVien/ThongTinSinhVien`,
    label: "Thông tin sinh viên",
    extract: () => {
      const info = {};
      const controls = "input:not([type=file]):not([type=password]):not([type=hidden]), select, textarea";
      const cleanKey = value => String(value || "").replace(/[:：]\s*$/, "").replace(/\s+/g, " ").trim();
      const skipKeys = /mật khẩu|password|mã xác nhận|captcha|nhập lại|\bmsbm\b/i;
      const readControl = control => {
        if (!control) return "";
        if (control.matches("select")) {
          return [...control.selectedOptions].map(option => option.textContent.trim()).filter(Boolean).join(", ");
        }
        if (control.matches("input[type=checkbox], input[type=radio]")) return control.checked ? "Có" : "Không";
        return String(control.value || control.innerText || "").trim();
      };
      const findControl = label => {
        let sibling = label.nextElementSibling;
        while (sibling) {
          if (sibling.matches(controls)) return sibling;
          if (sibling.matches(".NoiDungHoSo")) break;
          sibling = sibling.nextElementSibling;
        }
        return label.parentElement?.querySelector(controls);
      };
      const addField = (key, value) => {
        const clean = cleanKey(key);
        const val = String(value ?? "").trim();
        if (!clean || skipKeys.test(clean)) return;
        if (val) info[clean] = val;
      };

      // Strategy 1: .NoiDungHoSo elements may contain "Label: Value" as plain text
      document.querySelectorAll(".NoiDungHoSo").forEach(el => {
        const text = (el.innerText || "").trim();
        if (!text) return;
        // A portal label often ends with ':' while value lives in next input.
        // Only stop after inline value is non-empty; otherwise read sibling control.
        const colonIdx = text.indexOf(":");
        if (colonIdx > 0) {
          const key = text.slice(0, colonIdx);
          const value = text.slice(colonIdx + 1).trim();
          if (value) {
            addField(key, value);
            return;
          }
        }
        const control = findControl(el);
        if (control) {
          addField(text.replace(/[:：]\s*$/, ""), readControl(control));
        } else {
          const parts = text.split(/\s{2,}/);
          if (parts.length >= 2) addField(parts[0], parts.slice(1).join(" "));
        }
      });

      // Strategy 2: form-group with label + control
      document.querySelectorAll(".form-group").forEach(group => {
        const label = group.querySelector("label");
        const key = label?.innerText || "";
        if (skipKeys.test(cleanKey(key))) return;
        const control = group.querySelector(controls);
        if (control) {
          addField(key, readControl(control));
        }
      });

      // Strategy 3: Read tables on the page (portal may show info in <table>)
      if (!Object.keys(info).length || Object.keys(info).filter(k => !skipKeys.test(k)).length <= 2) {
        document.querySelectorAll("table tr").forEach(tr => {
          const cells = [...tr.querySelectorAll("td, th")].map(c => (c.innerText || "").trim()).filter(Boolean);
          if (cells.length >= 2) {
            for (let i = 0; i < cells.length - 1; i += 2) {
              addField(cells[i], cells[i + 1]);
            }
          }
        });
      }

      // Strategy 4: Try reading from any element with class containing "info" or "profile"
      if (!Object.keys(info).length || Object.keys(info).filter(k => !skipKeys.test(k)).length <= 2) {
        document.querySelectorAll("[class*=info], [class*=profile], [class*=detail], [class*=detail]").forEach(section => {
          const rows = section.querySelectorAll("tr, .row, .item");
          rows.forEach(row => {
            const label = row.querySelector("label, .label, .key, th, strong");
            const value = row.querySelector("input, select, textarea, .value, td:last-child, span:last-child");
            if (label && value) {
              addField(label.innerText, value.innerText || value.value || "");
            }
          });
        });
      }

      // Normalize known field names to consistent keys for downstream use
      const keyMap = {
        "ho va ten": "Họ và tên", "ho ten": "Họ và tên", "họ và tên": "Họ và tên", "họ tên": "Họ và tên",
        "ma so sinh vien": "Mã số sinh viên", "ma sinh vien": "Mã số sinh viên", "mssv": "Mã số sinh viên", "mã số sinh viên": "Mã số sinh viên", "mã sinh viên": "Mã số sinh viên",
        "nganh": "Ngành", "nganh hoc": "Ngành", "ngành học": "Ngành", "ngành đào tạo": "Ngành", "nganh dao tao": "Ngành", "chuyen nganh": "Chuyên ngành", "chuyên ngành": "Chuyên ngành",
        "lop": "Lớp", "lop sinh hoat": "Lớp", "lớp": "Lớp", "lớp sinh hoạt": "Lớp",
        "khoa": "Khóa", "khoa hoc": "Khóa", "khóa học": "Khóa", "khoa tuyen sinh": "Khóa", "khóa tuyển sinh": "Khóa",
        "he dao tao": "Hệ đào tạo", "he": "Hệ đào tạo", "hệ đào tạo": "Hệ đào tạo",
        "trang thai": "Trạng thái", "trạng thái": "Trạng thái", "tinh trang": "Trạng thái", "tình trạng": "Trạng thái",
        "ngay sinh": "Ngày sinh", "ngày sinh": "Ngày sinh",
        "gioi tinh": "Giới tính", "giới tính": "Giới tính",
        "email": "Email", "thu dien tu": "Email", "thư điện tử": "Email",
        "so dien thoai": "Số điện thoại", "dien thoai": "Số điện thoại", "số điện thoại": "Số điện thoại", "điện thoại": "Số điện thoại",
        "cmnd": "CMND/CCCD", "cccd": "CMND/CCCD", "so cmnd": "CMND/CCCD", "số cmnd": "CMND/CCCD",
        "dia chi": "Địa chỉ", "địa chỉ": "Địa chỉ",
        "nien khoa": "Niên khóa", "niên khóa": "Niên khóa", "năm học": "Niên khóa",
      };
      const normalized = {};
      for (const [rawKey, value] of Object.entries(info)) {
        const lower = rawKey
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[đĐ]/g, "d").toLowerCase();
        const mapped = keyMap[lower] || rawKey;
        // Keep first occurrence (most specific) or overwrite with non-empty
        if (!normalized[mapped] || (value && !normalized[mapped])) {
          normalized[mapped] = value;
        }
      }

      // Portal shows class code in the page header, not in a labeled field.
      if (!normalized["Lớp"]) {
        const classMatch = (document.body.innerText || "").match(/\b\d{2}[A-Z]{2,}\d{1,2}\b/i);
        if (classMatch) normalized["Lớp"] = classMatch[0].toUpperCase();
      }

      // If major not found, attempt to parse from class name (e.g., 23CNA13 -> CNA)
      if (!normalized["Ngành"]) {
        const className = normalized["Lớp"] || "";
        const m = String(className).trim().match(/^\d{2}([A-Z]+)/i);
        if (m) {
          const code = m[1].toUpperCase();
          const majorMap = {
            CNA: "Cử nhân Anh", SPA: "Sư phạm tiếng Anh",
            CNP: "Cử nhân Pháp", SPP: "Sư phạm tiếng Pháp",
            CNT: "Cử nhân Trung Quốc", SPT: "Sư phạm tiếng Trung Quốc",
            CNN: "Cử nhân Nga", SPN: "Sư phạm tiếng Nga",
            CNH: "Cử nhân Hàn Quốc", SPH: "Sư phạm tiếng Hàn Quốc",
            CNJ: "Cử nhân Nhật Bản", SPJ: "Sư phạm tiếng Nhật",
            QTH: "Quốc tế học", KTD: "Kinh tế đối ngoại",
            VHH: "Tiếng Việt và văn hóa Việt Nam",
          };
          if (majorMap[code]) {
            normalized["Ngành"] = majorMap[code];
            normalized["_nganh_source"] = "parsed_from_class";
          }
        }
      }

      return normalized;
    },
  },
  {
    key: "ketQuaHocTap",
    url: `${BASE}/TraCuuDiemSV/Index`,
    label: "Kết quả học tập",
    // Enumerate every available year/semester; portal default is not relied on.
    setup: async (page) => _collectMultiSemester(page, _extractTables),
    extract: () => {
      const tables = [];
      document.querySelectorAll("table").forEach((table) => {
        const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map((th) => th.innerText.trim());
        const rows = [];
        table.querySelectorAll("tbody tr, tr:not(:first-child)").forEach((tr) => {
          const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
          if (cells.length) rows.push(cells);
        });
        if (headers.length || rows.length) tables.push({ headers, rows });
      });
      return tables;
    },
  },
  {
    key: "diemRenLuyen",
    url: `${BASE}/TraCuuDiemSV/DiemRenLuyen`,
    label: "Điểm rèn luyện",
    // Enumerate every available year/semester; portal default is not relied on.
    setup: async (page) => _collectMultiSemester(page, _extractRows, "rows"),
    extract: () => {
      const rows = [];
      document.querySelectorAll("table tr").forEach((tr) => {
        const cells = [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim());
        if (cells.length) rows.push(cells);
      });
      return rows;
    },
  },
  {
    key: "lichThi",
    url: `${BASE}/TraCuuLichThi/Index`,
    label: "Lịch thi",
    // Exam schedules use same year/semester selectors on portal.
    setup: async (page) => _collectMultiSemester(page, () => {
      const rows = [];
      document.querySelectorAll("table tr").forEach(tr => {
        const cells = [...tr.querySelectorAll("td, th")].map(cell => cell.innerText.trim());
        if (cells.length) rows.push(cells);
      });
      return rows;
    }, "rows"),
    extract: () => {
      const rows = [];
      document.querySelectorAll("table tr").forEach((tr) => {
        const cells = [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim());
        if (cells.length) rows.push(cells);
      });
      return rows;
    },
  },
  {
    key: "hocBongKTKL",
    url: `${BASE}/SinhVien/HocBong_KhenThuong_KyLuat`,
    label: "Học bổng / Khen thưởng / Kỷ luật",
    extract: () => {
      const sections = {};
      document.querySelectorAll("table").forEach((table, idx) => {
        const heading = table.querySelector("thead tr")?.innerText?.trim().split("\n")[1] || `table_${idx}`;
        const rows = [];
        table.querySelectorAll("tr").forEach((tr) => {
          const cells = [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim());
          if (cells.length) rows.push(cells);
        });
        sections[heading] = rows;
      });
      return sections;
    },
  },
  {
    key: "lichHoc",
    url: `${BASE}/TraCuuLichHoc/Index`,
    label: "Lịch học",
    // Iterate all year x semester options to collect full historical + current schedules
    setup: async (page) => _collectMultiSemester(page, _extractScheduleTables),
    extract: () => {
      const tables = [];
      document.querySelectorAll("table").forEach((table) => {
        const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map((th) => th.innerText.trim());
        const rows = [];
        table.querySelectorAll("tbody tr, tr:not(:first-child)").forEach((tr) => {
          const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
          if (cells.length) rows.push(cells);
        });
        if (headers.length || rows.length) tables.push({ headers, rows });
      });
      if (!tables.length) {
        const scheduler = document.querySelector(".scheduler, #scheduler, .calendar");
        if (scheduler?.innerText.trim()) return [{ content: scheduler.innerText.trim() }];
      }
      return tables;
    },
  },
  {
    key: "hocPhi",
    url: `${BASE}/TraCuuHocPhiSV/Index`,
    label: "Học phí và tài chính",
    extract: () => {
      const tables = [];
      document.querySelectorAll("table").forEach((table) => {
        const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map((th) => th.innerText.trim());
        const rows = [];
        table.querySelectorAll("tbody tr, tr:not(:first-child)").forEach((tr) => {
          const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
          if (cells.length) rows.push(cells);
        });
        if (headers.length || rows.length) tables.push({ headers, rows });
      });
      return tables;
    },
  },
];

module.exports = { BASE, PAGES, hasUsableData, parseMajorFromClassName, normalizeAcademicYearSelection, filterRowsByAcademicYear };
