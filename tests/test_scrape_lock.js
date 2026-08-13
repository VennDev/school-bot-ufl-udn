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
  assert.strictEqual(lockKey(" 411230510 "), lockKey("411230510"));
  assert.notStrictEqual(lockKey("411230510"), lockKey("411230511"));

  const release = await acquireSchoolScrapeLock("411230510");
  assert.ok(release, "first process must acquire lock");
  const blocked = await acquireSchoolScrapeLock("411230510");
  assert.strictEqual(blocked, null, "second process must not acquire active lock");

  release();
  const next = await acquireSchoolScrapeLock("411230510");
  assert.ok(next, "lock must be reusable after release");
  next();
  fs.rmSync(lockDir, { recursive: true, force: true });
  console.log("Scrape lock regression tests passed OK!");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
