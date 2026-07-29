const assert = require("assert");
const { getScheduleEntries, isScheduleQuery } = require("../src/botRouter");
const { normalizeAcademicYearSelection } = require("../src/pages");
const { detectSchedule } = require("../src/changeDetector");

const entries = getScheduleEntries([{
  headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"],
  rows: [
    ["1", "Biên dịch 2", "3", "Biên dịch 2-15"],
    ["2", "Kỹ năng tiếng C1.3", "3", "Kỹ năng tiếng C1.3-12"]
  ]
}]);

assert.deepStrictEqual(entries, [
  { day: "3", period: "1", name: "Biên dịch 2", room: "", className: "Biên dịch 2-15" },
  { day: "3", period: "2", name: "Kỹ năng tiếng C1.3", room: "", className: "Kỹ năng tiếng C1.3-12" }
]);

const multiSemesterEntries = getScheduleEntries([
  { headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["1", "Môn cũ", "2", "L01"]] },
  { headers: ["Môn học", "Phòng", "Thứ", "Tiết", "Lớp"], rows: [["Môn mới", "B204", "4", "2", "L02"]] }
]);
assert.strictEqual(multiSemesterEntries.length, 2);
assert.ok(multiSemesterEntries.some(entry => entry.name === "Môn mới" && entry.room === "B204" && entry.period === "2"));

const latestEntries = getScheduleEntries([
  { yearValue: "2025", semesterValue: "2", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["1", "Môn cũ", "2", "L01"]] },
  { yearValue: "2026", semesterValue: "1", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["7-8", "Môn hiện tại", "6", "L02"]] }
], { latest: true });
assert.deepStrictEqual(latestEntries.map(entry => entry.name), ["Môn hiện tại"]);
assert.strictEqual(isScheduleQuery("lịch"), true);
assert.strictEqual(isScheduleQuery("lịch tuần này"), true);
assert.strictEqual(isScheduleQuery("thời khóa biểu"), true);
assert.strictEqual(isScheduleQuery("lịch thi"), false);

const portalSchedule = getScheduleEntries([{
  year: "2031-2032", semester: "Kỳ 3",
  headers: ["STT", "TÊN LỚP HỌC PHẦN", "TÊN MÔN", "THỜI GIAN HỌC", "THỜI GIAN DỰ KIẾN DẠY BÙ"],
  rows: [["1", "Biên dịch 1-03", "Biên dịch 1", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9", ""]]
}]);
assert.deepStrictEqual(portalSchedule[0], {
  day: "Thứ 4", period: "7 - 9", name: "Biên dịch 1", room: "", className: "Biên dịch 1-03", date: "15/10/2025"
});

assert.deepStrictEqual(normalizeAcademicYearSelection(
  "2031-2032",
  [["1", "Biên dịch 1-03", "Biên dịch 1", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9"]],
  ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"]
), { text: "2025-2026", value: "2025" });
assert.deepStrictEqual(normalizeAcademicYearSelection(
  "2031-2032",
  [
    ["1", "Môn cũ", "Môn cũ", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9"],
    ["2", "Môn mới", "Môn mới", "Thứ 7;Ngày: 03/04/2027;Tiết: 9 - 11"]
  ],
  ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"]
), { text: "2026-2027", value: "2026" });

const stableOld = [{
  year: "2026-2027", semester: "Kỳ 1",
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Đường dẫn", "Mô tả", "Thời gian", "Thứ", "Tiết", "Phòng", "Giáo viên"],
  rows: [["1", "Văn học Anh", "2", "Văn học Anh-09", "", "", "24/08/2026-06/12/2026", "6", "7-8", "B503(LNH)", "GV"]]
}];
assert.deepStrictEqual(detectSchedule(stableOld, JSON.parse(JSON.stringify(stableOld))), []);
assert.deepStrictEqual(detectSchedule(stableOld, [{ ...stableOld[0], rows: [["1", "Văn học Anh", "2", "Văn học Anh-09", "", "", "24/08/2026-06/12/2026", "6", "7-8", "B503(LNH)", "GV"]]}]), []);

console.log("Schedule format test passed OK!");
