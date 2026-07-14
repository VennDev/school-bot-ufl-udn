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
