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
console.log("Grade dedup test passed OK!");
