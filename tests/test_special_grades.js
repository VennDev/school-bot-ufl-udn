const assert = require("assert");
const { calculateGPA, getAcademicEvaluation } = require("../src/gpaHelper");
const { formatKetQuaHocTap, formatTienDo } = require("../src/botRouter");

console.log("=== BẮT ĐẦU TEST ĐIỂM ĐẶC BIỆT I, R, X, P ===");

// 1. Test calculateGPA with R (miễn học và công nhận tín chỉ)
// Course 1: 3 TC, score 8.0 (B = 3)
// Course 2: 4 TC, grade R (exempt, credits count, no GPA weight)
// Course 3: 2 TC, grade I (postponed, no credits, no GPA weight)
// Course 4: 2 TC, grade P (pass, credits count, no GPA weight)
const courses = [
  { name: "Toán cao cấp", credits: "3", score10: "8.0", grade: "B" },
  { name: "Tiếng Anh C1", credits: "4", score10: "", grade: "R" },
  { name: "Triết học", credits: "2", score10: "", grade: "I" },
  { name: "Kỹ năng mềm", credits: "2", score10: "", grade: "P" },
];

const gpaResult = calculateGPA(courses);
// Expected:
// totalCreditsAccumulated = 3 (from Toán) + 4 (from R) + 2 (from P) = 9
// GPA = (3 * 3) / 3 = 3.0
assert.strictEqual(gpaResult.creditsAccumulated, 9, "Credits accumulated phải là 9 (3 + 4 + 2)");
assert.strictEqual(gpaResult.gpaAccumulated, 3.0, "GPA accumulated phải là 3.0");

// 2. Test getAcademicEvaluation with I and R
const evalResult = getAcademicEvaluation(gpaResult.gpaAccumulated, gpaResult.gpaSemester, courses);
assert.deepStrictEqual(evalResult.subjectsPostponed, ["Triết học"], "Phải phát hiện môn điểm I");
assert.deepStrictEqual(evalResult.subjectsExempted, ["Tiếng Anh C1"], "Phải phát hiện môn điểm R");
assert.strictEqual(evalResult.subjectsToRelearn.length, 0, "Không được đánh dấu F cho điểm I hoặc R");

// 3. Test formatKetQuaHocTap includes I and R sections
const gradeTable = {
  headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp", "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ"],
  rows: [
    ["1", "MAT1", "Toán cao cấp", "3", "L01", "8", "8.0", "3", "B"],
    ["2", "ENG1", "Tiếng Anh C1", "4", "L02", "", "", "", "R"],
    ["3", "PHI1", "Triết học", "2", "L03", "", "", "", "I"]
  ]
};

const textKq = formatKetQuaHocTap({
  ket_qua_hoc_tap: JSON.stringify([gradeTable]),
  diem_ren_luyen: "[]"
});

assert.match(textKq, /Môn hoãn thi \/ chưa có điểm \(Điểm I, X\)/, "formatKetQuaHocTap phải hiển thị mục điểm I");
assert.match(textKq, /Triết học/, "Mục hoãn thi phải chứa môn Triết học");
assert.match(textKq, /Môn miễn học \/ công nhận tín chỉ \(Điểm R\)/, "formatKetQuaHocTap phải hiển thị mục điểm R");
assert.match(textKq, /Tiếng Anh C1/, "Mục miễn học phải chứa môn Tiếng Anh C1");
assert.match(textKq, /Tín chỉ tích lũy: 7 TC/, "Tín chỉ tích lũy phải là 3 + 4 = 7 TC");

const textTienDo = formatTienDo({
  ket_qua_hoc_tap: JSON.stringify([gradeTable]),
  diem_ren_luyen: "[]"
});
assert.match(textTienDo, /Tín chỉ đã tích lũy: 7 TC/, "Tiến độ phải ghi nhận 7 TC");

console.log("=== TẤT CẢ TEST ĐIỂM ĐẶC BIỆT THÀNH CÔNG ===");
