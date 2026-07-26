const assert = require("assert");

console.log("=== CHỨNG MINH LỖI: SCRAPER KHÔNG CÀO LẠI TRANG ĐÃ CÓ DỮ LIỆU ===\n");

// Mô phỏng logic của scrapeAccount
const PAGES_MOCK = [
  { key: "ketQuaHocTap" },
  { key: "lichThi" },
  { key: "canhBao" },
  { key: "thongTinSV" },
  { key: "diemRenLuyen" },
  { key: "hocBongKTKL" },
  { key: "lichHoc" },
  { key: "hocPhi" },
];

function simulateScrapeAccount(existingData) {
  // loadResult() trả về dữ liệu đã có trong DB
  const result = { ...existingData };
  
  // Chỉ cào các trang CHƯA có dữ liệu
  const pending = PAGES_MOCK.filter((p) => !result[p.key]);
  
  if (!pending.length) {
    return { action: "SKIP", reason: "All data collected - KHÔNG CÀO LẠI" };
  }
  return { action: "SCRAPE", pages: pending.map(p => p.key) };
}

// TEST 1: Lần đầu, DB trống → Cào tất cả
console.log("TEST 1: DB trống (lần đầu sync)");
const r1 = simulateScrapeAccount({});
console.log("  ->", r1.action, "| Pages:", r1.pages);
assert.strictEqual(r1.action, "SCRAPE");
assert.strictEqual(r1.pages.length, 8);

// TEST 2: Đã có đủ 8/8 trang → KHÔNG cào lại
console.log("\nTEST 2: DB đã đủ 8/8 trang (sau lần đầu thành công)");
const r2 = simulateScrapeAccount({
  ketQuaHocTap: "[...]",
  lichThi: "[...]",
  canhBao: "[...]",
  thongTinSV: "[...]",
  diemRenLuyen: "[...]",
  hocBongKTKL: "[...]",
  lichHoc: "[...]",
  hocPhi: "[...]",
});
console.log("  ->", r2.action, "|", r2.reason);
assert.strictEqual(r2.action, "SKIP");

// TEST 3: Web trường vừa cập nhật điểm mới → Bot vẫn SKIP vì DB đã có ketQuaHocTap
console.log("\nTEST 3: Web trường có điểm mới, nhưng DB đã có ketQuaHocTap cũ");
const r3 = simulateScrapeAccount({
  ketQuaHocTap: "[dữ liệu cũ]",  // ← DB có dữ liệu cũ
  lichThi: "[...]",
  canhBao: "[...]",
  thongTinSV: "[...]",
  diemRenLuyen: "[...]",
  hocBongKTKL: "[...]",
  lichHoc: "[...]",
  hocPhi: "[...]",
});
console.log("  ->", r3.action, "|", r3.reason);
assert.strictEqual(r3.action, "SKIP");
console.log("  ⚠️  BOT KHÔNG BAO GIỜ PHÁT HIỆN ĐIỂM MỚI!");

console.log("\n======================================================");
console.log("KẾT LUẬN:");
console.log("Scraper thiết kế theo kiểu 'điền vào chỗ trống' (fill-missing).");
console.log("Sau lần đầu sync thành công, mọi lần cron sau đều SKIP.");
console.log("Điểm mới trên web không bao giờ được phát hiện.");
console.log("======================================================");
