const assert = require("assert");
const {
  MAX_IMAGE_BYTES,
  isAllowedImageUrl,
  isImageContentType,
  sanitizeOcrText,
} = require("../src/ocr");

assert.strictEqual(MAX_IMAGE_BYTES, 8 * 1024 * 1024);
assert.strictEqual(isAllowedImageUrl("https://lookaside.fbsbx.com/file/image"), true);
assert.strictEqual(isAllowedImageUrl("https://sub.fbcdn.net/image"), true);
assert.strictEqual(isAllowedImageUrl("https://example.com/image"), false);
assert.strictEqual(isAllowedImageUrl("http://www.facebook.com/image"), false);
assert.strictEqual(isAllowedImageUrl("https://facebook.com.evil.test/image"), false);
assert.strictEqual(isImageContentType("image/jpeg; charset=binary"), true);
assert.strictEqual(isImageContentType("application/octet-stream"), false);
assert.strictEqual(sanitizeOcrText("  Xin  chào\r\n\r\nSinh viên\u0000  "), "Xin chào\n\nSinh viên");
assert.ok(sanitizeOcrText("x".repeat(7000)).length <= 6000);

console.log("OCR boundary test passed OK!");
