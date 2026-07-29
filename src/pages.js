const BASE = "https://sinhvien.ufl.udn.vn";

function parseAcademicYear(value) {
  const match = String(value || "").match(/\b(\d{4})\s*[-–]\s*(\d{4})\b/);
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

function normalizeAcademicYearSelection(yearText, rows, headers = []) {
  const parsed = parseAcademicYear(yearText);
  const inferred = inferAcademicYearFromRows(rows, headers);
  // Trust valid dropdown selection. Only replace corrupt future labels
  // (for example 2031-2032) with row-date inference.
  if (parsed && parsed.start <= new Date().getFullYear() + 1) {
    return { text: String(yearText).trim(), value: String(parsed.start) };
  }
  if (inferred) return { text: inferred.text, value: String(inferred.start) };
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
            const entry = [...row, selection.text, semester.text];
            const key = JSON.stringify(entry);
            if (!seenRows.has(key)) { seenRows.add(key); collectedRows.push(entry); }
          });
          continue;
        }

        for (const table of Array.isArray(extracted) ? extracted : []) {
          const rows = (table?.rows || []).filter(row => !isPlaceholderRow(row));
          if (!rows.some(row => row.some(cell => String(cell ?? "").trim()))) continue;
          // Same rows can exist in multiple academic years. Keep selection metadata,
          // or a year-specific query can lose an otherwise valid match.
          const selection = normalizeAcademicYearSelection(year.text, rows, table.headers || []);
          const tableKey = JSON.stringify([selection.value, semester.value, table.headers || [], rows]);
          if (seenTables.has(tableKey)) continue;
          seenTables.add(tableKey);
          collectedTables.push({
            ...table,
            year: selection.text,
            yearValue: selection.value,
            sourceYear: year.text,
            sourceYearValue: year.value,
            semester: semester.text,
            semesterValue: semester.value,
            headers: [...(table.headers || []), "Năm học", "Học kỳ"],
            rows: rows.map(row => [...row, year.text, semester.text]),
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
    if (headers.some(h => /học phần|môn/i.test(h)) && rows.some(row => row.some(cell => cell.length > 2 && !/STT/i.test(cell)))) {
      tables.push({ headers, rows });
    }
  });
  return tables;
}

function hasUsableData(key, value) {
  if (value == null) return false;
  if (key === "thongTinSV") return typeof value === "object" && Object.entries(value).some(([field, fieldValue]) =>
    !field.startsWith("_") && String(fieldValue ?? "").trim()
  );
  if (key === "canhBao") return Array.isArray(value) && value.length > 0;
  if (key === "lichThi" || key === "diemRenLuyen") {
    return Array.isArray(value) && value.length > 1 && value.slice(1).some(row =>
      Array.isArray(row) && row.some(cell => String(cell ?? "").trim())
    );
  }
  if (key === "hocBongKTKL") {
    // Header-only tables mean portal responded successfully with no records.
    return value && typeof value === "object" && Object.values(value).some(rows =>
      Array.isArray(rows) && rows.length > 0
    );
  }
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
      const addField = (key, control) => {
        const clean = cleanKey(key);
        const value = readControl(control);
        if (clean && value) info[clean] = value;
      };

      // Portal uses span.NoiDungHoSo + sibling control, not label/form-group.
      document.querySelectorAll(".NoiDungHoSo").forEach(label => {
        addField(label.innerText, findControl(label));
      });

      // Keep support for older portal markup.
      document.querySelectorAll(".form-group").forEach(group => {
        const label = group.querySelector("label");
        addField(label?.innerText, group.querySelector(controls));
      });
      return info;
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

module.exports = { BASE, PAGES, hasUsableData, normalizeAcademicYearSelection };
