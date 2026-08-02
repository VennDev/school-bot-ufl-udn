const assert = require("assert");
const { detectSchedule, detectGrades } = require("../src/changeDetector");

// Regression tests for false-positive alerts caused by portal formatting churn.
// The UFL portal renders the same data with varying whitespace/dash/number
// formats between page loads. Change detection must not treat pure formatting
// differences as new grades or new schedules.

// ---- detectSchedule: Thời gian (time) column whitespace ----
// Real portal format (table with separate Thứ/Tiết/Phòng columns):
const scheduleTable = () => [{
  year: "2023-2024", semester: "Kỳ 1",
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Đường dẫn", "Mô tả", "Thời gian", "Thứ", "Tiết", "Phòng", "Giáo viên", "Năm học", "Học kỳ"],
  rows: [
    ["1", "Cơ sở văn hóa Việt Nam", "2", "Cơ sở văn hóa Việt Nam-21", "", "", "18/09/2023- 31/12/2023", "7", "6-7", "F303(LD)", "GV", "2023-2024", "Kỳ 1"],
    ["2", "Ngữ pháp tiếng Anh căn bản 1", "2", "Ngữ pháp tiếng Anh căn bản 1-02", "", "", "18/09/2023- 31/12/2023", "6", "9-10", "E101(LD)", "GV", "2023-2024", "Kỳ 1"],
  ]
}];

// Same schedule, but portal renders time with a space before the dash.
const scheduleWithSpacedDash = () => {
  const clone = scheduleTable();
  clone[0].rows = clone[0].rows.map(r => {
    const copy = [...r];
    copy[6] = copy[6].replace("-", " - ");
    return copy;
  });
  return clone;
};

// Same schedule, portal renders time without any spaces around dash.
const scheduleWithTightDash = () => {
  const clone = scheduleTable();
  clone[0].rows = clone[0].rows.map(r => {
    const copy = [...r];
    copy[6] = copy[6].replace(/\s*-\s*/g, "-");
    return copy;
  });
  return clone;
};

assert.strictEqual(detectSchedule(scheduleTable(), scheduleWithSpacedDash()).length, 0,
  "Schedule time dash spacing must not fire false alerts");
assert.strictEqual(detectSchedule(scheduleTable(), scheduleWithTightDash()).length, 0,
  "Schedule time tight dash must not fire false alerts");

// Multi-line time ranges with newline vs semicolon separators.
const multiLineTable = () => [{
  year: "2023-2024", semester: "Kỳ 2",
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Đường dẫn", "Mô tả", "Thời gian", "Thứ", "Tiết", "Phòng", "Giáo viên", "Năm học", "Học kỳ"],
  rows: [
    ["1", "Kỹ năng tiếng B1.3", "4", "Kỹ năng tiếng B1.3-13", "", "", "22/01/2024- 04/02/2024\n19/02/2024- 25/02/2024", "2", "1-4", "C203(LD)", "GV", "2023-2024", "Kỳ 2"],
  ]
}];
const multiLineWithSemicolons = () => {
  const clone = multiLineTable();
  clone[0].rows[0][6] = clone[0].rows[0][6].replace(/\n/g, "; ").replace("-", " - ");
  return clone;
};
assert.strictEqual(detectSchedule(multiLineTable(), multiLineWithSemicolons()).length, 0,
  "Schedule multi-line time separator must not fire false alerts");

// A REAL schedule change (room moved) must still be detected.
const movedRoom = scheduleTable();
movedRoom[0].rows[0][9] = "X999(LD)";
const realAlerts = detectSchedule(scheduleTable(), movedRoom);
assert.strictEqual(realAlerts.length, 1, "Real room change must still alert");
assert.ok(realAlerts[0].includes("X999(LD)"), "Alert must mention the new room");

// Historical schedules must not notify as newly added when current term exists.
const historicalOld = scheduleTable();
const currentTerm = {
  year: "2026-2027", semester: "Kỳ 1",
  headers: ["STT", "Tên học phần", "Số tín chỉ", "Tên lớp tín chỉ", "Thời gian", "Thứ", "Tiết", "Phòng"],
  rows: [["1", "Văn học Anh", "2", "Văn học Anh-09", "24/08/2026-06/12/2026", "6", "7-8", "B503(LNH)"]]
};
assert.deepStrictEqual(detectSchedule(historicalOld, [currentTerm]), [],
  "Historical courses must not be announced as new when only current term is relevant");

// ---- detectGrades: score numeric formatting ----
const gradeTable = () => [{
  headers: ["STT", "Ký hiệu", "Tên học phần", "Số tín chỉ", "Điểm thành phần", "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ", "Ghi chú", "Năm học", "Học kỳ"],
  rows: [
    ["1", "2090180", "Triết học Mác - Lênin", "3", "TP1 : 8 - TP2 : 8", "5", "6.5", "2", "C", "", "2018-2019", "Kỳ 1"],
    ["2", "2090181", "Tiếng Anh A1", "3", "TP1 : 9", "8", "8.5", "4", "A", "", "2018-2019", "Kỳ 1"],
  ]
}];

// Same grades, but portal renders score with trailing zero / trailing space.
const scoreWithZero = gradeTable();
scoreWithZero[0].rows[0][6] = "6.50";
const scoreWithSpace = gradeTable();
scoreWithSpace[0].rows[0][6] = "6.5 ";
assert.strictEqual(detectGrades(gradeTable(), scoreWithZero).length, 0,
  "Score 6.5 vs 6.50 must not fire false grade alert");
assert.strictEqual(detectGrades(gradeTable(), scoreWithSpace).length, 0,
  "Score trailing space must not fire false grade alert");

// A REAL grade change must still be detected.
const realGradeChange = gradeTable();
realGradeChange[0].rows[0][6] = "7.0";
const gradeAlerts = detectGrades(gradeTable(), realGradeChange);
assert.strictEqual(gradeAlerts.length, 1, "Real grade change must still alert");
assert.ok(gradeAlerts[0].includes("7.0"), "Alert must mention the new score");

console.log("Schedule/grades false-positive regression tests passed OK!");
