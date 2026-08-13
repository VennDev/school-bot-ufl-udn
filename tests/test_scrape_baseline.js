const assert = require("assert");
const {
  mergeGradeSnapshots,
  isLikelyGradeBaselineExpansion,
  isLikelyGradeSnapshotShrink,
} = require("../src/scrapeMerge");

const headers = [
  "STT", "Ký hiệu", "Tên học phần", "Số tín chỉ", "Điểm thành phần",
  "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ", "Ghi chú", "Năm học", "Học kỳ",
];
const row = (no, code, name, score) => [String(no), code, name, "3", "TP1 : 8", "8", score, "4", "A", "", "2024-2025", "Kỳ 1"];
const table = (semester, rows) => ({ headers, year: "2024-2025", semester, rows });

const oldData = [
  table("Kỳ 1", [row(1, "A", "Môn cũ 1", "8"), row(2, "B", "Môn cũ 2", "7")]),
];
const partialNewData = [
  table("Kỳ 2", [row(1, "A", "Môn cũ 1", "8")]),
];
const merged = mergeGradeSnapshots(oldData, partialNewData);
const mergedRows = merged.flatMap(t => t.rows || []);
assert.strictEqual(mergedRows.length, 2, "Partial scrape must not erase old grade rows");
assert.ok(mergedRows.some(r => r[2] === "Môn cũ 2"), "Missing old subject must be preserved");

const expandedNewData = [
  table("Kỳ 1", [
    row(1, "A", "Môn cũ 1", "8"), row(2, "B", "Môn cũ 2", "7"),
    row(3, "C", "Môn cũ 3", "6"), row(4, "D", "Môn cũ 4", "6"),
  ]),
  table("Kỳ 2", [
    row(5, "E", "Môn cũ 5", "6"), row(6, "F", "Môn cũ 6", "6"),
    row(7, "G", "Môn cũ 7", "6"), row(8, "H", "Môn cũ 8", "6"),
  ]),
];
assert.strictEqual(
  isLikelyGradeBaselineExpansion(oldData, expandedNewData),
  true,
  "Material recovery of missing semesters must suppress one grade notification"
);
assert.strictEqual(
  isLikelyGradeBaselineExpansion(oldData, partialNewData),
  false,
  "Small/partial scrape must not trigger expansion suppression"
);
assert.strictEqual(
  isLikelyGradeSnapshotShrink(oldData, partialNewData),
  true,
  "A snapshot losing a semester must be rejected for retry"
);
assert.strictEqual(
  isLikelyGradeSnapshotShrink(oldData, oldData),
  false,
  "An unchanged snapshot must not be rejected"
);

console.log("Scrape baseline regression tests passed OK!");
