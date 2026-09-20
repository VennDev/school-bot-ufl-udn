const fs = require("fs");
const path = require("path");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const db = require("./db");

const FILE_PATH = path.resolve(__dirname, "../docs/UFLS.txt");
const QD1221_PATH = path.resolve(__dirname, "../docs/QD-1221.txt");

function detectDocumentCategory(pageNum, pageText) {
  const lower = pageText.toLowerCase();

  // Explicit decision 1221 / certificate conversion
  if (/quyết định\s*(?:số\s*)?1221|miễn học, miễn thi|quy đổi điểm/i.test(lower) &&
      /chứng chỉ ngoại ngữ quốc tế|hsk|tocfl|topik|jlpt|nat-test|delf|dalf|tcf/i.test(lower)) {
    return "certificate_conversion";
  }

  // Document hierarchy from Sổ tay sinh viên 2025:
  if (pageNum >= 9 && pageNum <= 33) {
    // 2.1. Quy chế đào tạo trình độ đại học theo tín chỉ
    return "academic_rules";
  }
  if (pageNum >= 34 && pageNum <= 62) {
    // 2.2. Quy định việc tổ chức thi kết thúc học phần
    return "exams";
  }
  if (pageNum >= 63 && pageNum <= 83) {
    // 2.3. Quy định chuẩn đầu ra ngoại ngữ và công nhận chứng chỉ
    return "vstep";
  }
  if (pageNum >= 84 && pageNum <= 86) {
    // 2.4. Chuẩn đầu ra tin học
    return "it_systems";
  }
  if (pageNum >= 87 && pageNum <= 104) {
    // 3.1. Quy chế công tác sinh viên
    return "academic_rules";
  }
  if (pageNum >= 105 && pageNum <= 113) {
    // 3.2. Quy chế đánh giá kết quả rèn luyện
    return "training_points";
  }
  if (pageNum >= 114 && pageNum <= 134) {
    // 3.3. Học bổng khuyến khích học tập & học bổng chính sách
    return "scholarship";
  }
  if (pageNum >= 135 && pageNum <= 229) {
    // 3.4 - 3.8: Học phí, miễn giảm, hỗ trợ chi phí sinh hoạt, sinh viên sư phạm, tín dụng
    return "tuition";
  }
  if (pageNum >= 230 && pageNum <= 235) {
    // 3.9: Ngoại trú
    return "academic_rules";
  }
  if (pageNum >= 236 && pageNum <= 248) {
    // 3.10: Hoạt động cộng đồng
    return "training_points";
  }
  if (pageNum >= 249 && pageNum <= 284) {
    // 3.11 - 3.12: Quy tắc ứng xử & NCKH
    return "academic_rules";
  }
  if (pageNum >= 285 && pageNum <= 289) {
    // Phần 4: Thông tin liên hệ
    return "academic_rules";
  }
  if (pageNum >= 290) {
    // Phần 5: Kế hoạch giảng dạy
    return "teaching_plan";
  }
  return "academic_rules";
}

function getSectionName(pageNum) {
  if (pageNum >= 9 && pageNum <= 33) return "Quy chế đào tạo theo tín chỉ";
  if (pageNum >= 34 && pageNum <= 62) return "Quy định tổ chức thi KTHP";
  if (pageNum >= 63 && pageNum <= 83) return "Quy định chuẩn đầu ra ngoại ngữ";
  if (pageNum >= 84 && pageNum <= 86) return "Chuẩn đầu ra tin học";
  if (pageNum >= 87 && pageNum <= 104) return "Quy chế công tác sinh viên";
  if (pageNum >= 105 && pageNum <= 113) return "Quy chế đánh giá kết quả rèn luyện";
  if (pageNum >= 114 && pageNum <= 134) return "Quy định học bổng KKHT";
  if (pageNum >= 135 && pageNum <= 229) return "Chính sách học phí, miễn giảm, hỗ trợ";
  if (pageNum >= 230 && pageNum <= 235) return "Quy chế ngoại trú";
  if (pageNum >= 236 && pageNum <= 248) return "Quy định hoạt động cộng đồng";
  if (pageNum >= 249 && pageNum <= 284) return "Quy tắc ứng xử và NCKH";
  if (pageNum >= 285 && pageNum <= 289) return "Thông tin liên hệ";
  if (pageNum >= 290) return "Kế hoạch giảng dạy CTĐT";
  return "Sổ tay sinh viên";
}

function extractTitle(pageText, pageNum) {
  const section = getSectionName(pageNum);
  const lines = pageText.split("\n").map(l => l.trim()).filter(Boolean);

  const articles = [];
  for (const line of lines) {
    const artMatch = line.match(/^(Điều\s+\d+[:.]?\s*[^\n]{0,80})/i);
    if (artMatch) articles.push(artMatch[1].trim());
    const appMatch = line.match(/^(Phụ\s+lục\s+[IVX0-9.]+[:.]?\s*[^\n]{0,80})/i);
    if (appMatch) articles.push(appMatch[1].trim());
    const chMatch = line.match(/^(Chương\s+[IVX0-9]+[:.]?\s*[^\n]{0,80})/i);
    if (chMatch) articles.push(chMatch[1].trim());
  }
  if (articles.length > 0) {
    return `[${section}] ${articles.slice(0, 3).join("; ")}`.substring(0, 150);
  }

  const firstLine = lines.find(l => l.length > 5 && !/^\d+$/.test(l)) || "Sổ tay sinh viên";
  return `[${section}] ${firstLine}`.substring(0, 150);
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
  let chunkCounter = 1;

  pages.forEach((pageContent, pageIdx) => {
    const pageNum = pageIdx + 1;
    const trimmed = pageContent.trim();
    if (!trimmed) return;

    const title = extractTitle(pageContent, pageNum);
    const category = detectDocumentCategory(pageNum, pageContent);
    const lines = pageContent.split("\n");

    // For pages under 120 lines, keep intact as single coherent node
    if (lines.length <= 120) {
      nodes.push({
        chunk_id: `chunk_${String(chunkCounter++).padStart(3, "0")}`,
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
            chunk_id: `chunk_${String(chunkCounter++).padStart(3, "0")}`,
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
        chunk_id: `chunk_${String(chunkCounter++).padStart(3, "0")}`,
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

  // Export full chunk list to CSV for research documentation
  try {
    const csvHeader = "chunk_id,start_page,category,title,content_preview\n";
    const csvRows = nodes.map(n => {
      const cleanTitle = `"${(n.title || "").replace(/"/g, '""')}"`;
      const preview = `"${(n.content || "").slice(0, 120).replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
      return `${n.chunk_id},${n.start_page},${n.category},${cleanTitle},${preview}`;
    }).join("\n");
    const exportPath = path.resolve(__dirname, "../docs/handbook_chunks.csv");
    fs.writeFileSync(exportPath, csvHeader + csvRows, "utf8");
    console.log(`[import] Exported chunk registry to: ${exportPath}`);
  } catch (exportErr) {
    console.warn(`[import] Failed to export chunk registry: ${exportErr.message}`);
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
