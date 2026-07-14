const https = require("https");
const http = require("http");

const PROXY_SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
];

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

async function fetchProxies() {
  const all = new Set();
  for (const src of PROXY_SOURCES) {
    try {
      const txt = await fetchText(src);
      txt.split("\n").forEach((line) => {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+:\d+)/);
        if (m) all.add(m[1]);
      });
    } catch {}
  }
  const list = [...all];
  console.log(`Fetched ${list.length} proxies`);
  return list;
}

async function testProxy(proxy, testUrl = "https://sinhvien.ufl.udn.vn/DangNhap/Login") {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://${proxy}` },
  });
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    const title = await page.title();
    await browser.close();
    return title.length > 0;
  } catch {
    await browser.close();
    return false;
  }
}

async function findWorkingProxies(proxies, count = 5) {
  const working = [];
  const shuffled = proxies.sort(() => Math.random() - 0.5);
  for (const p of shuffled) {
    if (working.length >= count) break;
    process.stdout.write(`  Testing ${p}... `);
    const ok = await testProxy(p);
    console.log(ok ? "OK" : "FAIL");
    if (ok) working.push(p);
  }
  return working;
}

module.exports = { fetchProxies, testProxy, findWorkingProxies };
