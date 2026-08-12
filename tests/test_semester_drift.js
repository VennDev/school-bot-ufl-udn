// Regression: portal trả cùng bảng điểm với nhãn học kỳ lệch giữa các lần sync.
// Cùng môn (Triết học, Marketing...) không được báo lại là "Điểm mới".
const assert = require("assert");
const { detectGrades } = require("../src/changeDetector");

const hdr = ["STT","Ký hiệu","Tên học phần","Số tín chỉ","Điểm thành phần","Điểm thi","TBCHP","Điểm số","Điểm chữ","Ghi chú","Năm học","Học kỳ"];
const mk = (year, sem, rows) => [{ headers: hdr, year, semester: sem, rows: rows.map(r => [...r, year, sem]) }];

const rows = [
  ["1","2090180","Triết học Mác - Lênin","3","TP1 : 8 - TP2 : 8","5","6.5","2","C",""],
  ["2","4122213","Marketing căn bản","3","TP1 : 8.1 - TP2 : 8.5","8.8","8.6","4","A",""]
];

// Lần 1: nhãn Kỳ 1. Lần 2: cùng nội dung nhưng nhãn Kỳ 2 (drift).
const oldSnap = mk("2024-2025","Kỳ 1", rows);
const newSnap = mk("2024-2025","Kỳ 2", rows);

const alerts = detectGrades(oldSnap, newSnap);
console.log("alerts:", alerts);
assert.strictEqual(alerts.length, 0, "Không được báo lại điểm cũ khi chỉ đổi nhãn học kỳ");

// Môn mới thật sự vẫn phải báo.
const newRows = [...rows, ["3","9999999","Môn hoàn toàn mới","2","","8","8","4","A",""]];
const alerts2 = detectGrades(oldSnap, mk("2024-2025","Kỳ 2", newRows));
console.log("alerts2:", alerts2);
assert.strictEqual(alerts2.length, 1, "Môn mới thật sự phải được báo");
assert.ok(alerts2[0].includes("Môn hoàn toàn mới"));

console.log("Semester drift regression test passed OK!");
