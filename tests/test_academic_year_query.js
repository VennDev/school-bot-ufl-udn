const assert = require("assert");
const { extractAcademicYearRequest, filterAcademicYearTables } = require("../src/botRouter");

assert.deepStrictEqual(extractAcademicYearRequest("Lịch học năm 2023-2024"), {
  label: "năm học 2023-2024",
  value: "2023-2024"
});

const data = [
  { title: "Năm học 2023-2024", rows: [["Thứ 2", "1", "Môn cũ"]] },
  { title: "Năm học 2024-2025", rows: [["Thứ 3", "2", "Môn mới"]] }
];

assert.strictEqual(filterAcademicYearTables(data, { value: "2023-2024" }).length, 1);
assert.strictEqual(filterAcademicYearTables(data, { value: "2023-2024" })[0].rows[0][2], "Môn cũ");

const currentSchedule = [{
  headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"],
  rows: [["1", "Biên dịch 2", "3", "Biên dịch 2-15"]]
}];
assert.strictEqual(filterAcademicYearTables(currentSchedule, { ordinal: 2 }).length, 0);

console.log("Academic-year query test passed OK!");
