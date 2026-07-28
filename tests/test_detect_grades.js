const assert = require("assert");
const { detectGrades } = require("../src/changeDetector");

console.log("=== BẮT ĐẦU CHẠY TEST CASE DETECT GRADES ===");

// 1. Mock dữ liệu cũ
const mockOldData = [
  {
    headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp học phần", "Điểm thi", "Điểm TK (10)", "Điểm TK (CH)", "Điểm chữ"],
    rows: [
      ["1", "ENG101", "Tiếng Anh Cơ Bản", "3", "L01", "8.0", "8.2", "B+", "B+"],
      ["2", "MAT101", "Toán Cao Cấp", "3", "L02", "5.0", "5.5", "C", "C"]
    ]
  }
];

// Case A: Không có điểm mới/thay đổi
const mockNewDataNoChange = [
  {
    headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp học phần", "Điểm thi", "Điểm TK (10)", "Điểm TK (CH)", "Điểm chữ"],
    rows: [
      ["1", "ENG101", "Tiếng Anh Cơ Bản", "3", "L01", "8.0", "8.2", "B+", "B+"],
      ["2", "MAT101", "Toán Cao Cấp", "3", "L02", "5.0", "5.5", "C", "C"]
    ]
  }
];

// Case B: Có môn học mới (Thêm dòng)
const mockNewDataNewSubject = [
  {
    headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp học phần", "Điểm thi", "Điểm TK (10)", "Điểm TK (CH)", "Điểm chữ"],
    rows: [
      ["1", "ENG101", "Tiếng Anh Cơ Bản", "3", "L01", "8.0", "8.2", "B+", "B+"],
      ["2", "MAT101", "Toán Cao Cấp", "3", "L02", "5.0", "5.5", "C", "C"],
      ["3", "PHY101", "Vật Lý Đại Cương", "3", "L03", "9.0", "9.0", "A", "A"]
    ]
  }
];

// Case C: Thay đổi điểm của môn đã có
const mockNewDataChangedGrade = [
  {
    headers: ["STT", "Mã học phần", "Tên học phần", "Số tín chỉ", "Lớp học phần", "Điểm thi", "Điểm TK (10)", "Điểm TK (CH)", "Điểm chữ"],
    rows: [
      ["1", "ENG101", "Tiếng Anh Cơ Bản", "3", "L01", "8.0", "8.2", "B+", "B+"],
      ["2", "MAT101", "Toán Cao Cấp", "3", "L02", "7.0", "7.2", "B", "B"] // Đã đổi điểm 5.5 -> 7.2
    ]
  }
];

// Case D: Không tìm thấy bảng điểm do sai Header
const mockNewDataBadHeader = [
  {
    headers: ["STT", "Mã HP", "Tên môn học", "Số TC", "Lớp HP", "Điểm"], // Tên học phần -> Tên môn học
    rows: [
      ["1", "ENG101", "Tiếng Anh Cơ Bản", "3", "L01", "8.2"]
    ]
  }
];

try {
  // Test Case A
  const alertsA = detectGrades(mockOldData, mockNewDataNoChange);
  console.log("Test Case A (Không đổi):", alertsA);
  assert.strictEqual(alertsA.length, 0, "Không đổi phải trả về 0 alerts");

  // Test Case B
  const alertsB = detectGrades(mockOldData, mockNewDataNewSubject);
  console.log("Test Case B (Có môn mới):", alertsB);
  assert.strictEqual(alertsB.length, 1, "Thêm môn mới phải trả về 1 alert");
  assert.ok(alertsB[0].includes("Vật Lý Đại Cương"), "Alert phải chứa tên môn Vật Lý Đại Cương");

  // Test Case C
  const alertsC = detectGrades(mockOldData, mockNewDataChangedGrade);
  console.log("Test Case C (Thay đổi điểm):", alertsC);
  assert.strictEqual(alertsC.length, 1, "Thay đổi điểm phải trả về 1 alert");
  assert.ok(alertsC[0].includes("Toán Cao Cấp"), "Alert phải chứa tên môn Toán Cao Cấp");
  assert.ok(alertsC[0].includes("7.2"), "Alert phải báo điểm mới 7.2");

  // Test Case D
  const alertsD = detectGrades(mockOldData, mockNewDataBadHeader);
  console.log("Test Case D (Sai Header):", alertsD);
  assert.strictEqual(alertsD.length, 0, "Sai header trả về 0 alert (Lỗi silent fail)");

  // Test Case E: Multi-semester snapshot must not alert during format migration.
  const migratedOld = [mockOldData[0]];
  const migratedNew = [{
    headers: [...mockOldData[0].headers, "Năm học", "Học kỳ"],
    rows: mockOldData[0].rows.map(row => [...row, "2024-2025", "Kỳ 1"])
  }];
  assert.strictEqual(detectGrades(migratedOld, migratedNew).length, 0, "Migration không được spam alert");

  console.log("\n=> KẾT LUẬN: Code logic detectGrades chạy tốt cho trường hợp chuẩn.");
  console.log("=> LƯU Ý: Bảng chương trình đào tạo không được xem như bảng điểm.");
  
} catch (error) {
  console.error("Test thất bại:", error);
}
