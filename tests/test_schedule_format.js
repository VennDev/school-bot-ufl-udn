const assert = require("assert");
const { getScheduleEntries, isScheduleQuery, examDetails } = require("../src/botRouter");
const { normalizeAcademicYearSelection, filterRowsByAcademicYear } = require("../src/pages");
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

// Ignore absence/announcement tables when registration schedule exists.
const registrationOnlyEntries = getScheduleEntries([
  { headers: ["STT", "Tên môn", "Thời gian học", "Cán bộ giảng dạy"], rows: [["1", "Thông báo nghỉ", "Thứ 2;Ngày: 01/08/2026;Tiết: 1", "GV"]] },
  { headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Thời gian", "Thứ", "Tiết"], rows: [["1", "Môn hiện tại", "3", "Môn hiện tại-01", "24/08/2026-06/12/2026", "2", "1-3"]] }
]);
assert.deepStrictEqual(registrationOnlyEntries.map(entry => entry.name), ["Môn hiện tại"]);

const latestEntries = getScheduleEntries([
  { yearValue: "2025", semesterValue: "2", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["1", "Môn cũ", "2", "L01"]] },
  { yearValue: "2026", semesterValue: "1", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["7-8", "Môn hiện tại", "6", "L02"]] }
], { latest: true, now: new Date("2026-08-29T12:00:00Z") });
assert.deepStrictEqual(latestEntries.map(entry => entry.name), ["Môn hiện tại"]);
const mixedYearTables = getScheduleEntries([
  { year: "2027-2028", sourceYear: "2027-2028", semester: "Kỳ 3", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Mới", "Mới", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9"]] },
  { year: "2026-2027", sourceYear: "2026-2027", semester: "Kỳ 1", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Đúng", "Đúng", "Thứ 4;Ngày: 15/10/2026;Tiết: 7 - 9"]] }
], { latest: true, now: new Date("2026-08-29T12:00:00Z") });
assert.deepStrictEqual(mixedYearTables.map(entry => entry.name), ["Đúng"]);
const activeSummer = getScheduleEntries([
  { year: "2025-2026", semester: "Kỳ 3", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Hè", "Hè", "Thứ 2;Ngày: 25/05/2026-31/07/2026;Tiết: 1 - 3"]] },
  { year: "2026-2027", semester: "Kỳ 1", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Tương lai", "Tương lai", "Thứ 2;Ngày: 24/08/2026;Tiết: 1 - 3"]] }
], { latest: true, now: new Date("2026-07-29T12:00:00Z") });
assert.deepStrictEqual(activeSummer.map(entry => entry.name), ["Hè"]);
const upcomingSemester = getScheduleEntries([
  { year: "2025-2026", semester: "Kỳ 3", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Hết hạn", "Hết hạn", "Thứ 2;Ngày: 25/05/2026;Tiết: 1 - 3"]] },
  { year: "2026-2027", semester: "Kỳ 1", headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học"], rows: [["1", "Sắp tới", "Sắp tới", "Thứ 2;Ngày: 24/08/2026;Tiết: 1 - 3"]] }
], { latest: true, now: new Date("2026-07-29T12:00:00Z") });
assert.deepStrictEqual(upcomingSemester.map(entry => entry.name), ["Sắp tới"]);
assert.strictEqual(isScheduleQuery("lịch"), true);
assert.strictEqual(isScheduleQuery("lịch tuần này"), true);
assert.strictEqual(isScheduleQuery("thời khóa biểu"), true);
assert.strictEqual(isScheduleQuery("lịch thi"), false);

const examRows = [
  ["STT", "Mã học phần", "Tên học phần", "Ngày thi", "Ca thi", "Giờ thi", "Lần thi", "Đợt thi", "Số báo danh", "Phòng thi", "Hình thức"],
  ["1", "4131132", "Ngoại ngữ II.2", "08/05/2026", "", "9 giờ 30", "1", "3", "005", "C501(LNH)", "Tự luận"]
];
assert.deepStrictEqual(examDetails(examRows, examRows[1]), {
  subject: "Ngoại ngữ II.2",
  date: "08/05/2026",
  academicYear: 2025,
  session: "",
  time: "9 giờ 30",
  candidate: "005",
  room: "C501(LNH)",
  format: "Tự luận"
});

const portalSchedule = getScheduleEntries([{
  year: "2031-2032", semester: "Kỳ 3",
  headers: ["STT", "TÊN LỚP HỌC PHẦN", "TÊN MÔN", "THỜI GIAN HỌC", "THỜI GIAN DỰ KIẾN DẠY BÙ"],
  rows: [["1", "Biên dịch 1-03", "Biên dịch 1", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9", ""]]
}]);
assert.deepStrictEqual(portalSchedule[0], {
  day: "Thứ 4", period: "7 - 9", name: "Biên dịch 1", room: "", className: "Biên dịch 1-03", date: "15/10/2025", dateStart: "15/10/2025", dateEnd: "15/10/2025"
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
assert.deepStrictEqual(normalizeAcademicYearSelection(
  "2027-2028",
  [["1", "Biên dịch 1", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9"]],
  ["STT", "Tên môn", "Thời gian học"]
), { text: "2025-2026", value: "2025" });
assert.deepStrictEqual(filterRowsByAcademicYear([
  ["1", "Cũ", "Thứ 4;Ngày: 15/10/2025;Tiết: 7 - 9"],
  ["2", "Đúng", "Thứ 4;Ngày: 15/10/2026;Tiết: 7 - 9"],
], ["STT", "Tên môn", "Thời gian học"], 2026), [
  ["2", "Đúng", "Thứ 4;Ngày: 15/10/2026;Tiết: 7 - 9"],
]);

const stableOld = [{
  year: "2026-2027", semester: "Kỳ 1",
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Đường dẫn", "Mô tả", "Thời gian", "Thứ", "Tiết", "Phòng", "Giáo viên"],
  rows: [["1", "Văn học Anh", "2", "Văn học Anh-09", "", "", "24/08/2026-06/12/2026", "6", "7-8", "B503(LNH)", "GV"]]
}];
assert.deepStrictEqual(detectSchedule(stableOld, JSON.parse(JSON.stringify(stableOld))), []);
assert.deepStrictEqual(detectSchedule(stableOld, [{ ...stableOld[0], rows: [["1", "Văn học Anh", "2", "Văn học Anh-09", "", "", "24/08/2026-06/12/2026", "6", "7-8", "B503(LNH)", "GV"]]}]), []);

console.log("Schedule format test passed OK!");

// Portal splits one slot across rooms; cards must merge instead of repeating.
const multiRoom = getScheduleEntries([{
  year: "2026-2027", semester: "Kỳ 1",
  headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học", "Phòng"],
  rows: [
    ["1", "GTLVH-01", "Giao tiếp liên văn hóa", "Thứ 3;Ngày: 24/08/2026-27/09/2026;Tiết: 7 - 9", "A403(LNH)"],
    ["2", "GTLVH-01", "Giao tiếp liên văn hóa", "Thứ 3;Ngày: 24/08/2026-27/09/2026;Tiết: 7 - 9", "Phòng-Dạy Online"],
    ["3", "GTLVH-01", "Giao tiếp liên văn hóa", "Thứ 3;Ngày: 24/08/2026-27/09/2026;Tiết: 7 - 9", "D302(LNH)"]
  ]
}]);
assert.strictEqual(multiRoom.length, 1);
assert.strictEqual(multiRoom[0].room, "A403(LNH), Phòng-Dạy Online, D302(LNH)");
console.log("Multi-room merge test passed OK!");
