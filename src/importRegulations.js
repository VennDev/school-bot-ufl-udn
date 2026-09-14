const fs = require("fs");
const path = require("path");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const db = require("./db");

const FILE_PATH = path.resolve(__dirname, "../docs/UFLS.txt");
const QD1221_PATH = path.resolve(__dirname, "../docs/QD-1221.txt");

function detectCategory(pageText) {
  const lower = pageText.toLowerCase();
  if (/quyết định\s*(?:số\s*)?1221|miễn học, miễn thi|quy đổi điểm|chứng chỉ ngoại ngữ quốc tế|hsk|hskk|tocfl|topik|jlpt|nat-test|delf|dalf|tcf/i.test(lower)) {
    if (/miễn học|miễn thi|quy đổi điểm/i.test(lower)) return "certificate_conversion";
  }
  if (/phụ lục ii\.[1-4]|vstep|chuẩn đầu ra ngoại ngữ|cefr|toeic|toefl|jlpt|topik|hsk|nat-test|j-test/i.test(lower)) {
    return "vstep";
  }
  if (/rèn luyện|ý thức công dân|tiêu chí đánh giá rèn luyện/i.test(lower)) {
    return "training_points";
  }
  if (/học bổng|khen thưởng|kỷ luật/i.test(lower)) {
    return "scholarship";
  }
  if (/cảnh báo học tập|buộc thôi học/i.test(lower)) {
    return "warning";
  }
  if (/kế hoạch giảng dạy|chương trình đào tạo|khung chương trình|khoa tiếng/i.test(lower)) {
    return "teaching_plan";
  }
  if (/học phí|chế độ miễn giảm|học bổng chính sách/i.test(lower)) {
    return "tuition";
  }
  if (/quy định tổ chức thi|thi kết thúc học phần|chấm thi|phúc khảo/i.test(lower)) {
    return "exams";
  }
  if (/chuẩn đầu ra tin học|lms|teams/i.test(lower)) {
    return "it_systems";
  }
  return "academic_rules";
}

function extractTitle(pageText) {
  const lines = pageText.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    if (/^(PHỤ LỤC|ĐIỀU|CHƯƠNG|QUY ĐỊNH|QUYẾT ĐỊNH|BẢNG|THÔNG BÁO|KẾ HOẠCH|HƯỚNG DẪN)/i.test(line)) {
      return line.substring(0, 150);
    }
  }
  return lines[0]?.substring(0, 120) || "Sổ tay sinh viên";
}

async function importRegs() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`[import] File not found at: ${FILE_PATH}`);
    process.exit(1);
  }

  console.log(`[import] Reading regulations from: ${FILE_PATH}`);
  const rawContent = fs.readFileSync(FILE_PATH, "utf-8");
  const pages = rawContent.split(/\f+/);
  console.log(`[import] Total pages (detected via form-feed): ${pages.length}`);

  const nodes = [];

  pages.forEach((pageContent, pageIdx) => {
    const pageNum = pageIdx + 1;
    const trimmed = pageContent.trim();
    if (!trimmed) return;

    const title = extractTitle(pageContent);
    const category = detectCategory(pageContent);
    const lines = pageContent.split("\n");

    // For pages under 120 lines (which includes all tables, appendices, and regulations),
    // keep the entire page intact as one coherent node so tables and criteria are never split.
    if (lines.length <= 120) {
      nodes.push({
        title,
        category,
        source_url: `https://hdsd.ufl.udn.vn/so-tay-sinh-vien#trang-${pageNum}`,
        content: trimmed,
        start_page: pageNum,
        end_page: pageNum,
        start_line: 1,
        end_line: lines.length,
      });
    } else {
      // For very long continuous text pages, chunk with generous overlap
      const chunkSize = 80;
      const overlap = 20;
      for (let i = 0; i < lines.length; i += (chunkSize - overlap)) {
        const chunkLines = lines.slice(i, i + chunkSize);
        if (!chunkLines.length) break;

        const cleanContent = chunkLines
          .map(line => line.trim())
          .filter(Boolean)
          .join("\n");

        if (cleanContent.length > 50) {
          nodes.push({
            title,
            category,
            source_url: `https://hdsd.ufl.udn.vn/so-tay-sinh-vien#trang-${pageNum}`,
            content: cleanContent,
            start_page: pageNum,
            end_page: pageNum,
            start_line: i + 1,
            end_line: i + chunkLines.length,
          });
        }
        if (i + chunkSize >= lines.length) break;
      }
    }
  });

  console.log(`[import] Created ${nodes.length} nodes across ${pages.length} pages.`);

  if (fs.existsSync(QD1221_PATH)) {
    console.log(`[import] Reading QD-1221 from: ${QD1221_PATH}`);
    const qdContent = fs.readFileSync(QD1221_PATH, "utf-8");
    const sections = qdContent.split(/\n(?=Điều \d+\.|Khoản \d+\.|Khoản \d+\.)/);
    const qdNodes = [];
    sections.forEach((section, idx) => {
      const trimmed = section.trim();
      if (trimmed.length < 40) return;
      const firstLine = trimmed.split("\n")[0].substring(0, 120);
      qdNodes.push({
        title: `Quyết định 1221/QĐ-ĐHNN: ${firstLine}`,
        category: /miễn học|miễn thi|quy đổi điểm|hsk|topik|jlpt|delf|tcf|ielts/i.test(trimmed)
          ? "certificate_conversion"
          : "academic_rules",
        source_url: "https://nnvhhanquoc.ufl.udn.vn/wp-content/uploads/2023/12/QD-1221-quy-doi-diem-chung-chi-quoc-te-Truong-DHNN.pdf",
        content: trimmed,
        start_page: 1,
        end_page: 16,
        start_line: idx + 1,
        end_line: idx + 1,
      });
    });
    console.log(`[import] Created ${qdNodes.length} nodes from QD-1221.`);
    nodes.push(...qdNodes);
  } else {
    console.warn(`[import] QD-1221 file not found at ${QD1221_PATH}, skipping.`);
  }

  console.log(`[import] Saving ${nodes.length} nodes to database...`);
  await db.saveRegNodes(nodes);
  console.log("[import] Regulations imported successfully!");
  process.exit(0);
}

importRegs().catch((err) => {
  console.error("[import] Error importing regulations:", err);
  process.exit(1);
});
