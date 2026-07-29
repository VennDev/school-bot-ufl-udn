const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 6000;
const OCR_TIMEOUT_MS = 30000;

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") ||
      host === "fbsbx.com" || host.endsWith(".fbsbx.com") ||
      host === "fbcdn.net" || host.endsWith(".fbcdn.net") ||
      host === "lookaside.fbsbx.com";
  } catch {
    return false;
  }
}

function isImageContentType(value) {
  return /^image\//i.test(String(value || "").split(";", 1)[0].trim());
}

function sanitizeOcrText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n").map(line => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n")
    .trim()
    .slice(0, maxLength);
}

async function verifyTesseract() {
  await execFileAsync("tesseract", ["--version"], { timeout: 5000, windowsHide: true });
  const languages = await execFileAsync("tesseract", ["--list-langs"], { timeout: 5000, windowsHide: true });
  const list = `${languages.stdout || ""}\n${languages.stderr || ""}`
    .split(/\r?\n/).map(value => value.trim());
  if (!list.includes("vie")) throw new Error("Tesseract language vie unavailable");
}

async function readImageResponse(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8MB limit");
  const chunks = [];
  let total = 0;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8MB limit");
    return buffer;
  }
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8MB limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function ocrImageUrl(imageUrl, options = {}) {
  if (!isAllowedImageUrl(imageUrl)) throw new Error("Unsupported image URL");
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch unavailable");
  const timeoutMs = options.timeoutMs || OCR_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let tempDir;
  try {
    const response = await fetchImpl(imageUrl, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    if (!isImageContentType(response.headers.get("content-type"))) throw new Error("Attachment is not an image");
    const image = await readImageResponse(response);
    await (options.verify || verifyTesseract)();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "school-bot-ocr-"));
    const inputPath = path.join(tempDir, "input");
    await fs.promises.writeFile(inputPath, image, { mode: 0o600 });
    const result = await execFileAsync("tesseract", [inputPath, "stdout", "-l", "vie", "--psm", "6"], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return sanitizeOcrText(result.stdout);
  } finally {
    clearTimeout(timeout);
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  isAllowedImageUrl,
  isImageContentType,
  sanitizeOcrText,
  verifyTesseract,
  ocrImageUrl,
};
