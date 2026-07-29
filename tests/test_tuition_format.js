const assert = require("assert");
const { formatHocPhi } = require("../src/botRouter");

const result = formatHocPhi([
  {
    headers: ["Môn học", "Học phí", "Đã nộp", "Còn nợ"],
    rows: [
      ["Năm học 2025-2026", "Kỳ 1"],
      ["Môn A", "696.000,00 đ", "696.000,00 đ", "0,00 đ"],
      ["Môn B", "696.000,00 đ", "0,00 đ", "696.000,00 đ"]
    ]
  }
]);

assert.match(result, /2025-2026 - Kỳ 1: Còn nợ/);
assert.doesNotMatch(result, /Môn A/);
assert.doesNotMatch(result, /696\.000/);
console.log("Tuition format test passed OK!");
