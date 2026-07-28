const BASE = "https://sinhvien.ufl.udn.vn";

const PAGES = [
  {
    key: "canhBao",
    url: `${BASE}/CanhBao/Index`,
    label: "Cảnh báo / Thông báo",
    extract: () => {
      const rows = [];
      document.querySelectorAll("table tr").forEach((tr, i) => {
        if (i === 0) return;
        const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
        if (cells.length) rows.push(cells);
      });
      if (!rows.length) return [{ content: document.body.innerText.substring(0, 3000) }];
      return rows;
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
    setup: async (page) => {
      const now = new Date();
      const month = now.getMonth() + 1; // 1-12
      const year = now.getFullYear();

      // Determine academic year and semester
      // Kỳ 1: Aug-Dec, Kỳ 2: Jan-May, Kỳ 3 (hè): Jun-Jul
      let namHoc, hocKy;
      if (month >= 8) {
        namHoc = String(year);        // e.g. 2025 -> "2025-2026"
        hocKy = "1";
      } else if (month >= 1 && month <= 5) {
        namHoc = String(year - 1);    // e.g. 2025 -> "2024-2025"
        hocKy = "2";
      } else {
        namHoc = String(year - 1);    // Jun-Jul: hè của năm học trước
        hocKy = "3";
      }

      // Select năm học first (triggers page reload via JS)
      const namHocSelect = await page.$("#cmbNamHoc");
      if (namHocSelect) {
        const opts = await namHocSelect.$$eval("option", els => els.map(e => e.value));
        if (opts.includes(namHoc)) {
          await page.selectOption("#cmbNamHoc", namHoc);
          await page.waitForTimeout(2000);
          await page.waitForLoadState("networkidle").catch(() => {});
        }
      }

      // Select học kỳ
      const hocKySelect = await page.$("#cmbHocKy");
      if (hocKySelect) {
        await page.selectOption("#cmbHocKy", hocKy);
        await page.waitForTimeout(2000);
        await page.waitForLoadState("networkidle").catch(() => {});
      }

      // Select chuyên ngành chính (0)
      const cnSelect = await page.$("#cmbChuyenNganh");
      if (cnSelect) {
        await page.selectOption("#cmbChuyenNganh", "0");
        await page.waitForTimeout(1500);
        await page.waitForLoadState("networkidle").catch(() => {});
      }
    },
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
