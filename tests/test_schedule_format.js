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
console.log("Schedule format test passed OK!");
