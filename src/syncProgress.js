const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PAGES } = require("./pages");

const PROGRESS_DIR = process.env.SYNC_PROGRESS_DIR || path.resolve(__dirname, "../data/sync-progress");
const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const RUN_HEARTBEAT_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.SYNC_PROGRESS_TIMEOUT_MS || "600000", 10) || 600000);

const now = () => new Date().toISOString();
const createRunId = () => `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const validRunId = runId => /^[A-Za-z0-9_-]+$/.test(String(runId || ""));
const runDir = runId => path.join(PROGRESS_DIR, String(runId));
const metaPath = runId => path.join(runDir(runId), "run.json");
const accountPath = (runId, fbId) => path.join(runDir(runId), `account-${fbId}.json`);

function writeJSON(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readMeta(runId) {
  return validRunId(runId) ? readJSON(metaPath(runId)) : null;
}

function readAccount(runId, fbId) {
  return validRunId(runId) ? readJSON(accountPath(runId, fbId)) : null;
}

function pageState(page) {
  return { key: page.key, label: page.label, status: "pending", error: null };
}

function accountState(account) {
  return {
    fbId: account.fb_id,
    username: account.username,
    status: "queued",
    stage: "Đang chờ",
    percent: 0,
    attempt: 0,
    maxAttempts: 20,
    syncedPages: 0,
    totalPages: PAGES.length,
    currentPage: null,
    error: null,
    startedAt: null,
    updatedAt: now(),
    pages: PAGES.map(pageState),
  };
}

function calculatePercent(account) {
  if (account.status === "complete") return 100;
  const done = account.pages.filter(page => page.status === "done").length;
  if (account.status === "incomplete" || account.status === "failed") {
    return account.totalPages ? Math.round(done * 100 / account.totalPages) : 0;
  }
  if (account.status === "queued") return 0;
  // Login contributes a small visible amount before first page completes.
  return Math.min(99, Math.max(2, Math.round(5 + done * 90 / (account.totalPages || 1))));
}

function updateAccount(runId, fbId, mutate) {
  const account = readAccount(runId, fbId);
  if (!account) return null;
  mutate(account);
  account.syncedPages = account.pages.filter(page => page.status === "done").length;
  account.percent = calculatePercent(account);
  account.updatedAt = now();
  writeJSON(accountPath(runId, fbId), account);
  touchRun(runId);
  return account;
}

function startRun(accounts, options = {}) {
  const runId = options.runId || process.env.SYNC_RUN_ID || createRunId();
  if (!validRunId(runId)) throw new Error("Invalid sync progress run ID");
  if (readMeta(runId)) return runId;

  fs.mkdirSync(runDir(runId), { recursive: true, mode: 0o700 });
  const timestamp = now();
  writeJSON(metaPath(runId), {
    runId,
    status: "running",
    mode: options.mode || "unknown",
    useTor: Boolean(options.useTor),
    startedAt: timestamp,
    updatedAt: timestamp,
    totalAccounts: accounts.length,
    error: null,
  });
  accounts.forEach(account => writeJSON(accountPath(runId, account.fb_id), accountState(account)));
  return runId;
}

function accountUpdate(runId, fbId, patch = {}) {
  return updateAccount(runId, fbId, account => Object.assign(account, patch));
}

function accountStart(runId, fbId) {
  return accountUpdate(runId, fbId, {
    status: "running",
    stage: "Đang chuẩn bị đăng nhập",
    percent: 1,
    startedAt: now(),
    error: null,
  });
}

function accountAttempt(runId, fbId, attempt, stage = "Đang đăng nhập") {
  return accountUpdate(runId, fbId, { status: "running", stage, attempt, currentPage: null });
}

function loginStarted(runId, fbId) {
  return accountUpdate(runId, fbId, { status: "running", stage: "Đang đăng nhập" });
}

function loginSucceeded(runId, fbId, label) {
  return accountUpdate(runId, fbId, {
    status: "running",
    stage: `Đã đăng nhập qua ${label}`,
    currentPage: null,
  });
}

function pageStarted(runId, fbId, pageKey) {
  return updateAccount(runId, fbId, account => {
    const page = account.pages.find(item => item.key === pageKey);
    if (!page) return;
    page.status = "running";
    page.error = null;
    account.status = "running";
    account.currentPage = pageKey;
    account.stage = `Đang tải ${page.label}`;
  });
}

function pageFinished(runId, fbId, pageKey) {
  return updateAccount(runId, fbId, account => {
    const page = account.pages.find(item => item.key === pageKey);
    if (!page) return;
    page.status = "done";
    page.error = null;
    account.currentPage = null;
    account.stage = `Đã tải ${account.pages.filter(item => item.status === "done").length}/${account.totalPages} mục`;
  });
}

function pageFailed(runId, fbId, pageKey, error) {
  return updateAccount(runId, fbId, account => {
    const page = account.pages.find(item => item.key === pageKey);
    if (!page) return;
    page.status = "failed";
    page.error = String(error || "Lỗi không xác định").slice(0, 240);
    account.currentPage = pageKey;
    account.stage = `Lỗi ${page.label}`;
    account.error = page.error;
  });
}

function accountFinished(runId, fbId, status, error = null) {
  return accountUpdate(runId, fbId, {
    status,
    stage: status === "complete" ? "Hoàn tất" : status === "incomplete" ? "Chưa hoàn tất" : "Thất bại",
    currentPage: null,
    error: error ? String(error).slice(0, 240) : null,
  });
}

function readRun(runId) {
  const meta = readMeta(runId);
  if (!meta) return null;
  let files = [];
  try { files = fs.readdirSync(runDir(runId)).filter(file => file.startsWith("account-") && file.endsWith(".json")); } catch { return null; }
  const accounts = files.map(file => readJSON(path.join(runDir(runId), file))).filter(Boolean);
  const updatedAt = accounts.reduce((latest, account) =>
    Date.parse(account.updatedAt || 0) > Date.parse(latest || 0) ? account.updatedAt : latest,
    meta.updatedAt
  );
  const finishedAccounts = accounts.filter(account => ["complete", "incomplete", "failed"].includes(account.status)).length;
  const overallPercent = accounts.length
    ? Math.round(accounts.reduce((sum, account) => sum + (account.percent || 0), 0) / accounts.length)
    : meta.status === "complete" ? 100 : 0;
  return { ...meta, updatedAt, totalAccounts: meta.totalAccounts ?? accounts.length, finishedAccounts, overallPercent, accounts };
}

function finishRun(runId, status = "complete", error = null) {
  const meta = readMeta(runId);
  if (!meta) return;
  meta.status = status;
  meta.error = error ? String(error).slice(0, 240) : null;
  meta.updatedAt = now();
  writeJSON(metaPath(runId), meta);
}

function touchRun(runId) {
  const meta = readMeta(runId);
  if (!meta || meta.status !== "running") return;
  meta.updatedAt = now();
  writeJSON(metaPath(runId), meta);
}

function listRuns() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROGRESS_DIR); } catch { return []; }
  const nowMs = Date.now();
  const cutoff = nowMs - STALE_AFTER_MS;
  return dirs.map(readRun).filter(Boolean).filter(run => {
    const updatedMs = Date.parse(run.updatedAt || 0);
    if (updatedMs < cutoff) {
      try { fs.rmSync(runDir(run.runId), { recursive: true, force: true }); } catch {}
      return false;
    }
    const hasActiveAccount = (run.accounts || []).some(acc => acc.status === "running");
    if (run.status === "running" && !hasActiveAccount && nowMs - updatedMs > RUN_HEARTBEAT_TIMEOUT_MS) {
      run.status = "failed";
      run.error = "Scraper process stopped unexpectedly or timed out";
      run.updatedAt = new Date().toISOString();
      writeJSON(metaPath(run.runId), {
        runId: run.runId,
        status: run.status,
        mode: run.mode,
        useTor: run.useTor,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        totalAccounts: run.totalAccounts,
        error: run.error,
      });
    }
    return true;
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

module.exports = {
  createRunId,
  startRun,
  readRun,
  listRuns,
  accountStart,
  accountAttempt,
  loginStarted,
  loginSucceeded,
  pageStarted,
  pageFinished,
  pageFailed,
  accountFinished,
  finishRun,
  touchRun,
};
