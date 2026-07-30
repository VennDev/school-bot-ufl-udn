const assert = require("assert");
const { formatKetQuaHocTap } = require("../src/botRouter");

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
console.log("Credits accumulated regression test passed OK!");
