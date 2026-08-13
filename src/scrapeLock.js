const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOCK_ROOT = process.env.SCHOOL_SCRAPE_LOCK_DIR || path.resolve(__dirname, "../data/school-scrape-locks");
const STALE_MS = Math.max(1000, Number.parseInt(process.env.SCHOOL_SCRAPE_LOCK_STALE_MS || "3600000", 10) || 3600000);
const WAIT_MS = Math.max(STALE_MS, Number.parseInt(process.env.SCHOOL_SCRAPE_LOCK_WAIT_MS || "2700000", 10) || 2700000);
const POLL_MS = 2000;

function lockKey(username) {
  const normalized = String(username || "").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex") : null;
}

function heartbeatPath(lockPath) {
  return path.join(lockPath, "heartbeat");
}

function isStale(lockPath) {
  try {
    return Date.now() - fs.statSync(heartbeatPath(lockPath)).mtimeMs > STALE_MS;
  } catch {
    try { return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS; } catch { return false; }
  }
}

async function acquireSchoolScrapeLock(username) {
  const key = lockKey(username);
  if (!key) return null;
  const lockPath = path.join(LOCK_ROOT, key);
  fs.mkdirSync(LOCK_ROOT, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    try {
      // mkdir is atomic across Node processes and hosts sharing this filesystem.
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        username: String(username).trim(),
        startedAt: new Date().toISOString(),
      }), { mode: 0o600 });
      const touch = () => {
        try { fs.utimesSync(heartbeatPath(lockPath), new Date(), new Date()); } catch {
          try { fs.closeSync(fs.openSync(heartbeatPath(lockPath), "a", 0o600)); } catch {}
        }
      };
      touch();
      const heartbeat = setInterval(touch, Math.min(30000, Math.max(5000, Math.floor(STALE_MS / 3))));
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (isStale(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
  return null;
}

async function withSchoolScrapeLock(username, task) {
  const release = await acquireSchoolScrapeLock(username);
  if (!release) {
    console.warn(`[scrape-lock] Timed out waiting for school account ${String(username || "?")}; skip this run.`);
    return { skippedByLock: true };
  }
  try {
    return await task();
  } finally {
    release();
  }
}

module.exports = { acquireSchoolScrapeLock, withSchoolScrapeLock, lockKey };
