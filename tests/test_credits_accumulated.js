const assert = require("assert");
const { formatKetQuaHocTap } = require("../src/botRouter");
const { extractGPA } = require("../src/gpaHelper");

const gradeTable = {
  headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp", "Điểm thi", "Điểm TK (10)", "Điểm chữ"],
  rows: [
    ["1", "A", "Môn đạt 1", "3", "L01", "8", "8", "B"],
    ["2", "B", "Môn đạt 2", "2", "L02", "7", "7", "B"],
    ["3", "C", "Môn trượt", "3", "L03", "2", "3", "F"]
  ]
};

const summaryTable = {
  headers: ["ĐTBHK hệ 4", "ĐTBCTL hệ 4", "Tín chỉ tích lũy"],
  rows: [["3.45", "3.45", "812"]]
};

const result = formatKetQuaHocTap({
  ket_qua_hoc_tap: JSON.stringify([summaryTable, gradeTable]),
  diem_ren_luyen: "[]"
});

assert.match(result, /Tín chỉ tích lũy: 5 TC/);
assert.doesNotMatch(result, /Tín chỉ tích lũy: 812 TC/);

// Parser không được nhận số vô lý từ bảng tóm tắt hoặc ô text mô tả.
assert.strictEqual(extractGPA([summaryTable]).creditsAccumulated, 0);
assert.strictEqual(extractGPA([{
  headers: [],
  rows: [["ĐTBCTL hệ 4: 3.2"], ["Số tín chỉ tích lũy: 812"]]
}]).creditsAccumulated, 0);
assert.strictEqual(extractGPA([{
  headers: ["ĐTBCTL hệ 4", "Tín chỉ tích lũy"],
  rows: [["3.2", "114"]]
}]).creditsAccumulated, 114);

// Portal trả lại cùng bảng tích lũy cho mỗi năm/kỳ. Không được cộng tín chỉ nhiều lần.
const duplicated = formatKetQuaHocTap({
  ket_qua_hoc_tap: JSON.stringify([
    { ...gradeTable, year: "2023-2024", semester: "Kỳ 1" },
    { ...gradeTable, year: "2024-2025", semester: "Kỳ 1" },
    { ...gradeTable, year: "2025-2026", semester: "Kỳ 2" }
  ]),
  diem_ren_luyen: "[]"
});
assert.match(duplicated, /Tín chỉ tích lũy: 5 TC/);

console.log("Credits accumulated regression test passed OK!");
