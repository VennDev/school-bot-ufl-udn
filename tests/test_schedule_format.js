const assert = require("assert");
const { getScheduleEntries } = require("../src/botRouter");

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
  { headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["2", "Môn mới", "4", "L02"]] }
]);
assert.strictEqual(multiSemesterEntries.length, 2);
assert.ok(multiSemesterEntries.some(entry => entry.name === "Môn mới"));

const latestEntries = getScheduleEntries([
  { yearValue: "2025", semesterValue: "2", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["1", "Môn cũ", "2", "L01"]] },
  { yearValue: "2026", semesterValue: "1", headers: ["Tiết", "Môn học", "Thứ", "Lớp học phần"], rows: [["7-8", "Môn hiện tại", "6", "L02"]] }
], { latest: true });
assert.deepStrictEqual(latestEntries.map(entry => entry.name), ["Môn hiện tại"]);

console.log("Schedule format test passed OK!");
