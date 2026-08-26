const assert = require("assert");
const { hasUsableData } = require("../src/pages");
const { detectSchedule } = require("../src/changeDetector");

const curriculum = [{
  headers: ["Kỳ thứ", "Mã học phần", "Tên học phần", "Môn tự chọn"],
  rows: [["1", "4111000", "Môn thử", ""]],
}];
assert.strictEqual(hasUsableData("chuyenNganhChinh", curriculum), true);
assert.strictEqual(hasUsableData("chuyenNganh2", [{ headers: ["Mã học phần", "Tên học phần"], rows: [] }]), true);

const makeup = (reason, makeupTime = "Thứ 3;Ngày: 02/12/2025;Tiết: 4 - 6") => [{
  headers: ["STT", "Tên lớp học phần", "Tên môn", "Thời gian học", "Thời gian dự kiến dạy bù", "Số phòng", "Lý do", "Cán bộ giảng dạy", "Cán bộ dạy thay"],
  rows: [["1", "Lớp 01", "Môn thử", "Thứ 2;Ngày: 01/12/2025;Tiết: 1 - 3", makeupTime, "A101", reason, "GV cũ", "GV thay"]],
}];
const first = detectSchedule(makeup("Dạy bù"), makeup("Dạy bù"));
assert.deepStrictEqual(first, []);
const changed = detectSchedule(makeup("Dạy bù"), makeup("Dạy thay", "Thứ 4;Ngày: 03/12/2025;Tiết: 7 - 9"));
assert.strictEqual(changed.length, 1);
assert.match(changed[0], /dạy bù\/dạy thay/i);
assert.match(changed[0], /Lý do: Dạy thay/);
assert.match(changed[0], /GV dạy thay: GV thay/);
console.log("Curriculum and makeup schedule test passed OK!");
