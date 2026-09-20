const assert = require("assert");
const { formatKetQuaHocTap } = require("../src/botRouter");

const raw = {
  ket_qua_hoc_tap: JSON.stringify([{
    headers: ["STT", "Mã", "Tên học phần", "Số tín chỉ", "TP", "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ"],
    rows: [
      ["1", "A", "Ngoại ngữ II.1 (Tiếng Trung)", "3", "", "2.2", "4.8", "1", "D"],
      ["2", "B", "Môn tốt", "3", "", "8", "8", "3", "B"]
    ]
  }]),
  diem_ren_luyen: "[]"
};
const result = formatKetQuaHocTap(raw);
const improvement = result.match(/Môn cần cải thiện[\s\S]*?(?=\n💡|\n📝|$)/)?.[0] || "";
assert.strictEqual((improvement.match(/Ngoại ngữ II\.1/g) || []).length, 1);

// Test case: student took Trung (D) but passed Phap (B) -> Trung is excluded from improvement
const rawWithAlternative = {
  ket_qua_hoc_tap: JSON.stringify([{
    headers: ["STT", "Mã", "Tên học phần", "Số tín chỉ", "TP", "Điểm thi", "TBCHP", "Điểm số", "Điểm chữ"],
    rows: [
      ["1", "A", "Ngoại ngữ II.1 (Tiếng Trung)", "3", "", "2.2", "4.8", "1", "D"],
      ["2", "B", "Môn tốt", "3", "", "8", "8", "3", "B"],
      ["3", "C", "Ngoại ngữ II.1 (Tiếng Pháp)", "3", "", "7.5", "8.0", "3", "B"]
    ]
  }]),
  diem_ren_luyen: "[]"
};
const resultAlt = formatKetQuaHocTap(rawWithAlternative);
const improvementAlt = resultAlt.match(/Môn cần cải thiện[\s\S]*?(?=\n💡|\n📝|$)/)?.[0] || "";
assert.strictEqual((improvementAlt.match(/Ngoại ngữ II\.1/g) || []).length, 0);

console.log("Grade dedup test passed OK!");
