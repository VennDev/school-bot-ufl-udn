const net = require("net");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOR_BASE_SOCKS = 9050;
const TOR_BASE_CONTROL = 9051;
const TOR_DATA_DIR = path.join(__dirname, "../.tor-instances");

function socksPort(idx) { return TOR_BASE_SOCKS + idx * 2; }
function controlPort(idx) { return TOR_BASE_CONTROL + idx * 2; }
function socksUrl(idx) { return `socks5://127.0.0.1:${socksPort(idx)}`; }

function newIdentity(ctrlPort) {
  return new Promise((resolve) => {
    const client = net.createConnection(ctrlPort, "127.0.0.1", () => {
      client.write('AUTHENTICATE ""\r\n');
    });
    let buf = "";
    let authenticated = false;
    client.on("data", (d) => {
      buf += d.toString();
      if (!authenticated && buf.includes("250")) {
        authenticated = true;
        client.write("SIGNAL NEWNYM\r\n");
      } else if (authenticated && buf.includes("250 OK")) {
        client.end();
        resolve(true);
      }
    });
    client.on("error", () => resolve(false));
    setTimeout(() => { client.destroy(); resolve(false); }, 5000);
  });
}

async function rotateIP(idx = 0, waitMs = 10000) {
  const port = controlPort(idx);
  const ok = await newIdentity(port);
  if (ok) {
    console.log(`[tor-${idx}] New identity, waiting ${waitMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return true;
  }
  console.log(`[tor-${idx}] ControlPort ${port} unavailable`);
  return false;
}

function startTorInstance(idx) {
  const socks = socksPort(idx);
  const ctrl = controlPort(idx);
  const dataDir = path.join(TOR_DATA_DIR, `tor-${idx}`);

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  try {
    const check = execSync(`ss -tlnp | grep ":${socks} " 2>/dev/null || true`).toString();
    if (check.includes(`:${socks}`)) {
      console.log(`[tor-${idx}] Already running on SOCKS:${socks} CTRL:${ctrl}`);
      return { socks, ctrl, socksUrl: socksUrl(idx) };
    }
  } catch {}

  console.log(`[tor-${idx}] Starting on SOCKS:${socks} CTRL:${ctrl}...`);
  let proc;
  try {
    proc = spawn("tor", [
      "--SocksPort", String(socks),
      "--ControlPort", String(ctrl),
      "--DataDirectory", dataDir,
      "--CookieAuthentication", "0",
      "--RunAsDaemon", "1",
    ], { stdio: "inherit", detached: true });
    
    proc.on("error", (err) => {
      console.error(`[tor-${idx}] Failed to start Tor process: ${err.message}. Please install Tor using: sudo apt install -y tor`);
    });
    
    proc.unref();
  } catch (e) {
    console.error(`[tor-${idx}] Spawn error:`, e.message);
    return null;
  }

  return new Promise((resolve) => {
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      const client = net.createConnection(socks, "127.0.0.1", () => {
        client.end();
        clearInterval(interval);
        console.log(`[tor-${idx}] Ready`);
        resolve({ socks, ctrl, socksUrl: socksUrl(idx) });
      });
      client.on("error", () => {
        if (tries > 30) {
          clearInterval(interval);
          console.log(`[tor-${idx}] Failed to start`);
          resolve(null);
        }
      });
    }, 2000);
  });
}

async function startMultipleTor(count) {
  const instances = [];
  for (let i = 0; i < count; i++) {
    const inst = await startTorInstance(i);
    if (inst) instances.push({ idx: i, ...inst });
  }
  return instances;
}

function stopAllTor() {
  try {
    execSync("pkill -f 'tor --SocksPort' 2>/dev/null || true");
    console.log("[tor] All instances stopped");
  } catch {}
}

async function checkTor(idx = 0) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: socksUrl(idx) },
  });
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto("https://check.torproject.org", { timeout: 20000 });
    const text = await page.textContent("body");
    const ok = text.includes("Congratulations");
    console.log(`[tor-${idx}] ${ok ? "Connected via Tor" : "NOT using Tor"}`);
    await browser.close();
    return ok;
  } catch (e) {
    await browser.close();
    console.log(`[tor-${idx}] Check failed: ${e.message.split("\n")[0]}`);
    return false;
  }
}

module.exports = {
  socksUrl,
  rotateIP,
  checkTor,
  startTorInstance,
  startMultipleTor,
  stopAllTor,
};
