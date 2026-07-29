const assert = require("assert");
const { extractAcademicYearRequest, filterAcademicYearTables, getExamRows } = require("../src/botRouter");

assert.deepStrictEqual(extractAcademicYearRequest("Lịch học năm 2023-2024"), {
  label: "năm học 2023-2024",
  value: "2023-2024"
});

const data = [
  { title: "Năm học 2023-2024", rows: [["Thứ 2", "1", "Môn cũ"]] },
  { title: "Năm học 2024-2025", rows: [["Thứ 3", "2", "Môn mới"]] },
  { title: "Môn 2023-2024", rows: [["Thứ 4", "3", "Không có nhãn năm"]] },
  { rows: [["Thứ 5", "4", "2023-2024"]] },
];

assert.strictEqual(filterAcademicYearTables(data, { value: "2023-2024" }).length, 1);
assert.strictEqual(filterAcademicYearTables(data, { value: "2023-2024" })[0].rows[0][2], "Môn cũ");
assert.strictEqual(filterAcademicYearTables([{ title: "Lịch hiện tại", rows: [["2023-2024"]] }], { value: "2023-2024" }).length, 0);
assert.strictEqual(filterAcademicYearTables([{ academicYear: "Năm thứ 2" }], { ordinal: 2 }).length, 1);
assert.strictEqual(filterAcademicYearTables([{ academicYear: "Kỳ 3" }], { ordinal: 2 }).length, 0);

const currentSchedule = [{
  headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"],
  rows: [["1", "Biên dịch 2", "3", "Biên dịch 2-15"]]
}];
assert.strictEqual(filterAcademicYearTables(currentSchedule, { ordinal: 2 }).length, 0);

const examData = [
  ["STT", "Tên học phần", "Ngày thi", "Năm học"],
  ["1", "Môn cũ", "10/12/2025", "2025-2026"],
  ["2", "Môn mới", "08/05/2027", "2026-2027"]
];
assert.deepStrictEqual(getExamRows(examData).map(row => row[1]), ["Môn mới"]);
assert.deepStrictEqual(getExamRows([
  ["STT", "Tên học phần", "Ngày thi", "Năm học"],
  ["1", "Môn cũ", "", "2024-2025"],
  ["2", "Môn mới", "08/05/2027", "2026-2027"]
]).map(row => row[1]), ["Môn mới"]);
assert.deepStrictEqual(getExamRows([
  ["STT", "Tên học phần", "Ngày thi", "Năm học"],
  ["1", "Môn cũ", "", "2024-2025"]
]).map(row => row[1]), []);

console.log("Academic-year query test passed OK!");
