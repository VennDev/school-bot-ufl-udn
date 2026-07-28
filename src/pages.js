const BASE = "https://sinhvien.ufl.udn.vn";

// Helper to iterate relevant year x semester dropdown options (lichHoc, lichThi).
// Aggregates full multi-semester data across available semesters.
async function _collectMultiSemester(page, extractInBrowserFn) {
  const namHocSelect = await page.$("#cmbNamHoc");
  if (!namHocSelect) return;

  const namHocOpts = await namHocSelect.$$eval("option", els =>
    els.map(e => ({ value: e.value, text: e.textContent.trim() }))
       .filter(o => o.value !== "-1")
  );
  const hocKyOpts = ["1", "2", "3"];

  const currentYear = new Date().getFullYear();
  const relevantNamHocOpts = namHocOpts.filter(o => {
    const val = parseInt(o.value, 10);
    return val >= currentYear - 3 && val <= currentYear + 2;
  });

  const optsToIterate = relevantNamHocOpts.length > 0 ? relevantNamHocOpts : namHocOpts.slice(-5);
  const collectedTables = [];

  for (const nh of optsToIterate) {
    for (const hk of hocKyOpts) {
      try {
        await page.selectOption("#cmbNamHoc", nh.value);
        await page.waitForTimeout(400);
        await page.selectOption("#cmbHocKy", hk);
        await page.waitForTimeout(400);
        await page.waitForLoadState("networkidle").catch(() => {});

        const tables = await page.evaluate(extractInBrowserFn, { yearText: nh.text, hkValue: hk });
        if (tables && tables.length > 0) {
          collectedTables.push(...tables);
        }
      } catch (e) {
        // ignore option errors
      }
    }
  }

  if (collectedTables.length > 0) {
    page._collectedData = collectedTables;
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
    // Unselected default view returns full history of grades across all semesters.
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
    // Unselected default view returns full history of training points across all semesters.
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
    // Iterate all year x semester options to collect full historical + current schedules
    setup: async (page) => {
      await _collectMultiSemester(page, ({ yearText, hkValue }) => {
        const res = [];
        document.querySelectorAll("table").forEach((table) => {
          const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map((th) => th.innerText.trim());
          const rows = [];
          table.querySelectorAll("tbody tr, tr:not(:first-child)").forEach((tr) => {
            const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
            if (cells.length) rows.push(cells);
          });
          const isSchedule = headers.some(h => h.includes("học phần") || h.includes("môn"));
          const hasData = rows.some(r => r.length >= 4 && r.some(c => c.length > 2 && !c.includes("STT")));
          if (isSchedule && hasData) {
            res.push({
              headers: [...headers, "Năm học", "Học kỳ"],
              rows: rows.map(r => [...r, yearText, `Kỳ ${hkValue}`])
            });
          }
        });
        return res;
      });
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
