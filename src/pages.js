const BASE = "https://sinhvien.ufl.udn.vn";

// Shared helper: determine current academic year + semester for dropdown selection.
// Returns { namHoc, hocKy } where namHoc is the cmbNamHoc value (e.g. "2025" for "2025-2026").
// ponytail: if school changes semester calendar, adjust month ranges here.
function _currentSemester() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();
  // Kỳ 1: Aug-Dec, Kỳ 2: Jan-May, Kỳ 3 (hè): Jun-Jul
  if (month >= 8) return { namHoc: String(year), hocKy: "1" };
  if (month >= 1 && month <= 5) return { namHoc: String(year - 1), hocKy: "2" };
  return { namHoc: String(year - 1), hocKy: "3" };
}

// Shared setup: select học kỳ + năm học + chuyên ngành chính on pages that have these dropdowns.
// Waits for page reload after each selection (portal uses JS onChange submit).
async function _setupSemester(page) {
  const { namHoc, hocKy } = _currentSemester();

  const namHocSelect = await page.$("#cmbNamHoc");
  if (namHocSelect) {
    const opts = await namHocSelect.$$eval("option", els => els.map(e => e.value));
    if (opts.includes(namHoc)) {
      await page.selectOption("#cmbNamHoc", namHoc);
      await page.waitForTimeout(2000);
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }

  const hocKySelect = await page.$("#cmbHocKy");
  if (hocKySelect) {
    await page.selectOption("#cmbHocKy", hocKy);
    await page.waitForTimeout(2000);
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  const cnSelect = await page.$("#cmbChuyenNganh");
  if (cnSelect) {
    await page.selectOption("#cmbChuyenNganh", "0");
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
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
          items.push({ content: main.innerText.trim().substring(0, 3000) });
        } else {
          items.push({ content: document.body.innerText.substring(0, 3000) });
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
      document.querySelectorAll("table tr").forEach((tr) => {
        const tds = tr.querySelectorAll("td");
        for (let i = 0; i < tds.length - 1; i += 2) {
          const key = tds[i]?.innerText?.trim();
          const val = tds[i + 1]?.innerText?.trim();
          if (key) info[key] = val || "";
        }
      });
      document.querySelectorAll(".form-group").forEach((g) => {
        const label = g.querySelector("label");
        const input = g.querySelector("input, select, span, p");
        if (label && input) info[label.innerText.trim()] = (input.value || input.innerText || "").trim();
      });
      if (!Object.keys(info).length) info._raw = document.body.innerText.substring(0, 3000);
      return info;
    },
  },
  {
    key: "ketQuaHocTap",
    url: `${BASE}/TraCuuDiemSV/Index`,
    label: "Kết quả học tập",
    // Portal has cmbHocKy, cmbNamHoc, cmbChuyenNganh — default unselected shows all semesters.
    // Select current semester to get consistent, focused data for change detection.
    setup: _setupSemester,
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
    // Portal has cmbHocKy, cmbNamHoc — default unselected shows all semesters.
    setup: _setupSemester,
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
        const heading = table.closest(".panel, .box, div")?.querySelector("h3, h4, .box-header, .panel-heading")?.innerText?.trim() || `table_${idx}`;
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
    // Select correct học kỳ + năm học before extracting.
    // Portal has dropdowns: cmbHocKy (1/2/3), cmbNamHoc (2018..2026), cmbChuyenNganh (0/1).
    // Default loads with "--- Chọn ... ---" which may show stale or no data.
    setup: _setupSemester,
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
        if (scheduler) return [{ content: scheduler.innerText.substring(0, 3000) }];
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

module.exports = { BASE, PAGES };
