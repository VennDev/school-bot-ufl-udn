const assert = require("assert");
const fs = require("fs");
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

// Regression: the complete test account has grade rows across the full
// history. Do not report only the first semester/table (52 TC).
const testAccountFixture = JSON.parse(fs.readFileSync(require.resolve("./data.json"), "utf8"));
const completeHistory = formatKetQuaHocTap({
  ket_qua_hoc_tap: JSON.stringify(testAccountFixture.ketQuaHocTap),
  diem_ren_luyen: "[]"
});
assert.match(completeHistory, /Tín chỉ tích lũy: 114 TC/);


// Regression: partial scrape (only current semester collected) must NOT
// under-report the profile's accumulated total when the portal summary has it.
const partialRows = [
  ["1", "Giao thoa văn hóa", "2", "TP1 : 8.6 - TP2 : 8.8", "", "7.9", "3", "B"],
  ["2", "Biên dịch 2", "3", "TP1 : 9 - TP2 : 8.5", "8", "8.4", "3", "B"],
  ["3", "Kỹ năng tiếng C1.3", "3", "TP1 : 8.6 - TP2 : 7.7", "9.2", "8.6", "4", "A"],
  ["4", "Kỹ năng tiếng C1.4", "3", "TP1 : 8.2 - TP2 : 8.5", "9.3", "8.8", "4", "A"],
  ["5", "Dẫn nhập ngữ dụng học tiếng Anh", "2", "TP2 : 8.7 - TP1 : 8", "7.7", "8.1", "3", "B"]
];
const partialTable = {
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Điểm thành phần", "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ"],
  rows: partialRows
};
const summary114 = {
  headers: ["ĐTBHK hệ 4", "ĐTBCTL hệ 4", "Tín chỉ tích lũy"],
  rows: [["3.56", "3.56", "114"]]
};
const partialResult = formatKetQuaHocTap({
  ket_qua_hoc_tap: JSON.stringify([summary114, partialTable]),
  diem_ren_luyen: "[]"
});
assert.match(partialResult, /Tín chỉ tích lũy: 114 TC/);
assert.doesNotMatch(partialResult, /Tín chỉ tích lũy: 13 TC/);

// Regression: hệ 10 text summary ("Tín chỉ tích lũy: 114") must surface credits.
assert.strictEqual(extractGPA([{
  headers: [],
  rows: [["Điểm TBCTL hệ 10: 8.9"], ["Tín chỉ tích lũy: 114"], ["Xếp loại: Giỏi"]]
}]).creditsAccumulated, 114);


// Regression: portal summary "Số tín chỉ tích lũy: A / B" — A is the earned
// accumulated credits. Parse the numeric A row even without a GPA column.
assert.strictEqual(extractGPA([{
  headers: [],
  rows: [["Số tín chỉ tích lũy: A / B"], ["A: 114"], ["B: 116"]]
}]).creditsAccumulated, 114);
assert.strictEqual(extractGPA([{
  headers: [],
  rows: [["A = 114", "B = 116"]]
}]).creditsAccumulated, 114);
// Legend-only rows (no numbers) must not become credits.
assert.strictEqual(extractGPA([{
  headers: [],
  rows: [["Số tín chỉ tích lũy: A / B", "A: Tổng số tín chỉ...", "B: Tổng số tín chỉ..."]]
}]), null);

console.log("Credits accumulated regression test passed OK!");
