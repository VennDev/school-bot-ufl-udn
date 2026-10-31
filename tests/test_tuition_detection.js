const assert = require("assert");
const { detectTuition, parseTuitionData } = require("../src/changeDetector");
const { formatHocPhi } = require("../src/botRouter");

// 1. Real UFL Portal Table 0 (summary table) and Table 2 (course receipts)
const realTablesOld = [
  {
    headers: ["Học kỳ", "Năm học", "Mức học phí", "Miễn giảm", "Số tiền phải nộp", "Số tiền đã nộp", "Thừa thiếu"],
    rows: [
      ["1", "2023-2024", "5.916.000,00 ₫", "0,00 ₫", "5.916.000,00 ₫", "5.916.000,00 ₫", "0,00 ₫"],
      ["2", "2023-2024", "6.264.000,00 ₫", "0,00 ₫", "6.264.000,00 ₫", "6.264.000,00 ₫", "0,00 ₫"]
    ]
  },
  {
    headers: ["Học kỳ", "Năm học", "Khoản thu khác", "Số tiền phải nộp", "Số tiền đã nộp", "Thừa thiếu"],
    rows: []
  },
  {
    headers: ["Năm học", "Học kỳ", "Loại thu", "Số tiền nộp", "Số tiền miễn giảm", "Số tiền phải nộp", "Số tiền đã nộp", "Ngày nộp"],
    rows: [
      ["2023-2024", "1", "Học phí : Triết học", "696.000,00 ₫", "0,00 ₫", "696.000,00 ₫", "0,00 ₫", ""]
    ]
  }
];

const parsedOld = parseTuitionData(realTablesOld);
assert.strictEqual(parsedOld.size, 2);
assert.strictEqual(parsedOld.get("2023-2024 - Kỳ 1").debt, false);
assert.strictEqual(parsedOld.get("2023-2024 - Kỳ 1").paid, true);
assert.strictEqual(parsedOld.get("2023-2024 - Kỳ 2").debt, false);
assert.strictEqual(parsedOld.get("2023-2024 - Kỳ 2").paid, true);

// Table 2 (individual receipt rows) must not create phantom debt or override Table 0
const formattedOld = formatHocPhi(realTablesOld);
assert.match(formattedOld, /2023-2024 - Kỳ 1: Đã nộp/);
assert.match(formattedOld, /2023-2024 - Kỳ 2: Đã nộp/);
assert.doesNotMatch(formattedOld, /Còn nợ/);

// 2. New semester updated with unpaid tuition
const realTablesNew = [
  {
    headers: ["Học kỳ", "Năm học", "Mức học phí", "Miễn giảm", "Số tiền phải nộp", "Số tiền đã nộp", "Thừa thiếu"],
    rows: [
      ["1", "2023-2024", "5.916.000,00 ₫", "0,00 ₫", "5.916.000,00 ₫", "5.916.000,00 ₫", "0,00 ₫"],
      ["2", "2023-2024", "6.264.000,00 ₫", "0,00 ₫", "6.264.000,00 ₫", "6.264.000,00 ₫", "0,00 ₫"],
      ["1", "2026-2027", "8.955.000,00 ₫", "0,00 ₫", "8.955.000,00 ₫", "0,00 ₫", "8.955.000,00 ₫"]
    ]
  }
];

const alertsNewTerm = detectTuition(realTablesOld, realTablesNew);
assert.strictEqual(alertsNewTerm.length, 1);
assert.match(alertsNewTerm[0], /\[\$\] Học phí mới: 2026-2027 - Kỳ 1: Còn nợ 8\.955\.000đ/);

// 3. Tuition debt paid off
const realTablesPaid = [
  {
    headers: ["Học kỳ", "Năm học", "Mức học phí", "Miễn giảm", "Số tiền phải nộp", "Số tiền đã nộp", "Thừa thiếu"],
    rows: [
      ["1", "2023-2024", "5.916.000,00 ₫", "0,00 ₫", "5.916.000,00 ₫", "5.916.000,00 ₫", "0,00 ₫"],
      ["2", "2023-2024", "6.264.000,00 ₫", "0,00 ₫", "6.264.000,00 ₫", "6.264.000,00 ₫", "0,00 ₫"],
      ["1", "2026-2027", "8.955.000,00 ₫", "0,00 ₫", "8.955.000,00 ₫", "8.955.000,00 ₫", "0,00 ₫"]
    ]
  }
];

const alertsPaid = detectTuition(realTablesNew, realTablesPaid);
assert.strictEqual(alertsPaid.length, 1);
assert.match(alertsPaid[0], /\[\$\] Học phí thay đổi: 2026-2027 - Kỳ 1: Đã hoàn thành \(Hết nợ\)/);

// 4. First sync baseline: empty oldData must produce 0 alerts
assert.deepStrictEqual(detectTuition(null, realTablesNew), []);
assert.deepStrictEqual(detectTuition([], realTablesNew), []);

console.log("All tuition detection & parsing tests passed successfully!");
