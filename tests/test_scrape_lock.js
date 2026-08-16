const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "school-scrape-lock-"));
process.env.SCHOOL_SCRAPE_LOCK_DIR = lockDir;
process.env.SCHOOL_SCRAPE_LOCK_WAIT_MS = "2000";
process.env.SCHOOL_SCRAPE_LOCK_STALE_MS = "2000";

const { acquireSchoolScrapeLock, lockKey } = require("../src/scrapeLock");

(async () => {
  const username = "test-student";
  assert.strictEqual(lockKey(` ${username} `), lockKey(username));
  assert.notStrictEqual(lockKey(username), lockKey("test-student-2"));

  const release = await acquireSchoolScrapeLock(username);
  assert.ok(release, "first process must acquire lock");
  const blocked = await acquireSchoolScrapeLock(username);
  assert.strictEqual(blocked, null, "second process must not acquire active lock");

  release();
  const next = await acquireSchoolScrapeLock(username);
  assert.ok(next, "lock must be reusable after release");
  next();
  fs.rmSync(lockDir, { recursive: true, force: true });
  console.log("Scrape lock regression tests passed OK!");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
