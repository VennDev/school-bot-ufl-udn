const assert = require("assert");
const { detectExams } = require("../src/changeDetector");

const headers = ["STT", "Mã học phần", "Tên học phần", "Ngày thi", "Ca thi", "Giờ thi", "Lần thi", "Đợt thi", "Số báo danh", "Phòng thi", "Hình thức", "Năm học", "Học kỳ"];
const future = `13/05/${new Date().getFullYear() + 2}`;
const row = (over = {}) => {
  const base = ["1", "4111981", "Kỹ năng tiếng C1.4", future, "", "7 giờ 30", "1", "3", "135", "B102(LNH)", "Vấn đáp", "2025-2026", "Kỳ 3"];
  Object.entries(over).forEach(([idx, value]) => { base[idx] = value; });
  return base;
};

// Same subject examined twice in one semester must not look like a reschedule.
const twoAttempts = [
  headers,
  row({ 3: future, 6: "1", 9: "A502(LNH)" }),
  row({ 3: `20/05/${new Date().getFullYear() + 2}`, 6: "2", 9: "B303(LNH)" }),
];
assert.deepStrictEqual(detectExams(twoAttempts, JSON.parse(JSON.stringify(twoAttempts))), []);

// Past exams never notify, even when room or date differs.
const pastOld = [headers, row({ 3: "27/06/2024", 9: "A302(LNH)" })];
const pastNew = [headers, row({ 3: "27/06/2024", 9: "C101(LNH)" })];
assert.deepStrictEqual(detectExams(pastOld, pastNew), []);

// Real future reschedule still notifies.
const movedOld = [headers, row({ 9: "B102(LNH)" })];
const movedNew = [headers, row({ 9: "D404(LNH)" })];
assert.deepStrictEqual(detectExams(movedOld, movedNew), [
  `(->) Thay đổi lịch thi môn: Kỹ năng tiếng C1.4 -> Ngày: ${future} phòng: D404(LNH)`
]);

// Genuinely new future exam still notifies.
const addedNew = [headers, row(), row({ 1: "4110783", 2: "Biên dịch 2", 3: `15/05/${new Date().getFullYear() + 2}` })];
assert.deepStrictEqual(detectExams([headers, row()], addedNew), [
  `[~] Lịch thi mới môn: Biên dịch 2 ngày 15/05/${new Date().getFullYear() + 2} phòng B102(LNH)`
]);

console.log("Exam detect test passed OK!");
