const assert = require("assert");
const db = require("../src/db");

console.log("=== BẮT ĐẦU TEST RAG QUY ĐỔI CHỨNG CHỈ (QĐ 1221) ===");

async function run() {
  const cases = [
    { q: "HSK 5 quy đổi điểm bao nhiêu", expect: /tiếng Trung|Trung Quốc/i },
    { q: "IELTS 5.5 quy đổi điểm", expect: /tiếng Anh|Anh chuyên ngành|Quốc tế học/i },
    { q: "IELTS 7.0 quy đổi điểm", expect: /Kỹ năng tiếng B1\.4/i },
    { q: "JLPT N3 miễn học phần nào", expect: /Nhật Bản|Nhật/i },
    { q: "TOPIK II quy đổi điểm", expect: /Hàn Quốc|Hàn/i },
    { q: "NAT-Test quy đổi", expect: /Nhật Bản|Nhật/i },
    { q: "quy đổi điểm chứng chỉ tiếng Pháp DELF", expect: /Pháp/i },
  ];

  for (const c of cases) {
    const res = await db.searchRegNodes(c.q, 3, null);
    assert.ok(res.length > 0, `Phải có kết quả cho "${c.q}"`);
    const joined = res.map(r => `${r.title} ${r.content}`).join("\n");
    assert.match(joined, c.expect, `Kết quả cho "${c.q}" phải chứa ${c.expect}`);
    console.log(`✓ ${c.q} -> ${res[0].title.substring(0, 70)}`);
  }

  // Node QĐ 1221 phải tồn tại trong dữ liệu đã import
  const qd = await db.searchRegNodes("quyết định 1221 quy đổi điểm", 5, "certificate_conversion");
  assert.ok(qd.length > 0, "Phải tìm thấy node QĐ 1221");
  assert.ok(qd.some(r => (r.content || "").includes("1221") || (r.title || "").includes("1221")),
    "Phải có node nhắc tới QĐ 1221");

  console.log("=== TẤT CẢ TEST RAG CHỨNG CHỈ THÀNH CÔNG ===");
  process.exit(0);
}

run().catch(err => {
  console.error("Test thất bại:", err.message);
  process.exit(1);
});
