const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const net = require("net");

const BASE = "https://sinhvien.ufl.udn.vn";
const CREDS = { UserName: "411230510", Password: "kimhoang@54" };
const TOR_PROXY = "socks5://127.0.0.1:9050";
const DELAY = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendTorSignal(signal) {
  return new Promise((resolve) => {
    const client = net.createConnection(9051, "127.0.0.1", () => {
      client.write(`AUTHENTICATE ""\r\n`);
    });
    let buf = "";
    client.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("250") && !buf.includes(signal)) {
        client.write(`SIGNAL ${signal}\r\n`);
      }
      if (buf.split("250").length > 2) {
        client.end();
        resolve(true);
      }
    });
    client.on("error", () => resolve(false));
    setTimeout(() => { client.destroy(); resolve(false); }, 5000);
  });
}

async function newTorIdentity() {
  const ok = await sendTorSignal("NEWNYM");
  if (ok) {
    console.log("Tor: new identity requested, waiting 10s...");
    await sleep(10000);
  } else {
    console.log("Tor: ControlPort not available, reusing same circuit");
  }
}

const PAGES = [
  {
    key: "canhBao",
    url: `${BASE}/CanhBao/Index`,
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
];

const BATCH_SIZE = 2;
const outPath = path.join(__dirname, "data.json");

async function scrapeBatch(pages) {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: TOR_PROXY },
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const scraped = {};

  try {
    await page.goto(`${BASE}/DangNhap/Login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.selectOption("#cmbRole", "0");
    await page.fill("#UserName", CREDS.UserName);
    await page.fill("#Password", CREDS.Password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/SinhVien**", { timeout: 30000 });
    console.log("  Login OK via Tor");

    for (const p of pages) {
      await sleep(DELAY);
      try {
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        scraped[p.key] = await page.evaluate(p.extract);
        console.log(`  ${p.key}: OK`);
      } catch (e) {
        console.log(`  ${p.key}: FAIL (${e.message.split("\n")[0]})`);
      }
    }

    try { await page.goto(`${BASE}/DangNhap/Signout`, { timeout: 10000 }); } catch {}
  } catch (e) {
    console.log(`  Session error: ${e.message.split("\n")[0]}`);
  }

  await browser.close();
  return scraped;
}

(async () => {
  let result = {};
  if (fs.existsSync(outPath)) {
    try { result = JSON.parse(fs.readFileSync(outPath, "utf-8")); } catch {}
  }

  let pending = PAGES.filter((p) => !result[p.key]);
  if (!pending.length) {
    console.log("All data already collected.");
    return;
  }

  console.log(`Need ${pending.length} pages via Tor\n`);
  let attempt = 0;
  const MAX_ATTEMPTS = 6;

  while (pending.length > 0 && attempt < MAX_ATTEMPTS) {
    const batch = pending.slice(0, BATCH_SIZE);
    attempt++;
    console.log(`--- Attempt ${attempt}: ${batch.map((p) => p.key).join(", ")} ---`);

    const scraped = await scrapeBatch(batch);
    Object.assign(result, scraped);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

    pending = PAGES.filter((p) => !result[p.key]);
    console.log(`Progress: ${Object.keys(result).length}/${PAGES.length}\n`);

    if (pending.length > 0) {
      await newTorIdentity();
    }
  }

  if (pending.length > 0) {
    console.log(`WARNING: ${pending.length} pages missing: ${pending.map((p) => p.key).join(", ")}`);
  } else {
    console.log(`Done! All 6 pages saved: ${outPath}`);
  }
})();
