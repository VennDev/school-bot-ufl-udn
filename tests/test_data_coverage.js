const assert = require("assert");
const { hasUsableData } = require("../src/pages");

assert.strictEqual(hasUsableData("lichHoc", []), false);
assert.strictEqual(hasUsableData("lichHoc", [{ headers: ["Môn học"], rows: [["Ngữ âm", "2024-2025", "Kỳ 1"]] }]), true);
assert.strictEqual(hasUsableData("lichThi", [["Môn", "Ngày"], ["Ngữ âm", "01/06/2025"]]), true);
assert.strictEqual(hasUsableData("thongTinSV", { _raw: "" }), false);
assert.strictEqual(hasUsableData("thongTinSV", { "Họ tên": "Nguyễn Văn A" }), true);

console.log("Data coverage test passed OK!");
