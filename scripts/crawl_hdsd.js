require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const db = require("../src/db");

const BASE_URL = "https://hdsd.ufl.udn.vn";
const INDEX_URL = `${BASE_URL}/~gitbook/site-index`;

// Map breadcrumbs to categories to structure RAG scoping
function getCategoryFromBreadcrumbs(breadcrumbs) {
  if (!breadcrumbs || !breadcrumbs.length) return "general";
  const text = breadcrumbs.map(b => b.label.toLowerCase()).join(" ");
  if (text.includes("học bổng") || text.includes("khen thưởng")) return "scholarship";
  if (text.includes("cảnh báo") || text.includes("buộc thôi học") || text.includes("kỷ luật")) return "warning";
  if (text.includes("quy chế học vụ") || text.includes("tín chỉ") || text.includes("đào tạo")) return "academic_rules";
  if (text.includes("thi kết thúc") || text.includes("chấm thi") || text.includes("phúc khảo") || text.includes("exams")) return "exams";
  if (text.includes("lms3") || text.includes("teams") || text.includes("email")) return "it_systems";
  if (text.includes("học phí") || text.includes("tài chính") || text.includes("công nợ")) return "tuition";
  if (text.includes("vstep") || text.includes("nlnn")) return "vstep";
  if (text.includes("sổ tay sinh viên")) return "student_handbook";
  return "general";
}

// Extract PDF urls from Markdown content
function extractPdfUrls(markdownText) {
  const urls = [];
  const matches = markdownText.matchAll(/\]\((.*?\.pdf)\)/g);
  for (const match of matches) {
    let u = match[1];
    if (u.startsWith("/")) u = BASE_URL + u;
    urls.push(u);
  }
  return urls;
}

// Download PDF helper
async function downloadPdf(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error(`[PDF Downloader] Failed: ${url}`, e.message);
    return null;
  }
}

// Chunking helper
function chunkText(text, limitWords = 350) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += (limitWords - 30)) {
    const chunk = words.slice(i, i + limitWords).join(" ");
    if (chunk.trim().length > 50) {
      chunks.push(chunk.trim());
    }
  }
  return chunks;
}

async function run() {
  console.log("[crawler] Loading site-index...");
  const res = await fetch(INDEX_URL);
  if (!res.ok) {
    console.error(`Failed to fetch site-index: ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const items = data.pages || [];
  console.log(`[crawler] Found ${items.length} pages. Crawling content...`);

  const allNodes = [];
  const processedPdfs = new Set();

  for (const item of items) {
    if (!item.pathname || item.pathname === "/") continue;

    const mdUrl = `${BASE_URL}${item.pathname}.md`;
    const pageTitle = item.title;
    const category = getCategoryFromBreadcrumbs(item.breadcrumbs);
    const sourceUrl = `${BASE_URL}${item.pathname}`;

    console.log(`[crawler] Fetching ${mdUrl} (Category: ${category})`);
    try {
      const response = await fetch(mdUrl);
      if (!response.ok) {
        console.warn(`[crawler] Page not found: ${mdUrl}`);
        continue;
      }

      const mdText = await response.text();
      
      // Save direct chunks of md text
      const mdChunks = chunkText(mdText);
      mdChunks.forEach((c) => {
        allNodes.push({
          title: pageTitle,
          category: category,
          source_url: sourceUrl,
          content: c
        });
      });

      // Detect and process PDF links inside the page
      const pdfs = extractPdfUrls(mdText);
      for (const pdfUrl of pdfs) {
        if (processedPdfs.has(pdfUrl)) continue;
        processedPdfs.add(pdfUrl);

        console.log(`[crawler] Found PDF: ${pdfUrl}. Downloading...`);
        const pdfBuf = await downloadPdf(pdfUrl);
        if (pdfBuf) {
          try {
            const data = await pdfParse(pdfBuf);
            console.log(`[crawler] Parsed PDF successfully. Length: ${data.text.length} chars.`);
            const pdfChunks = chunkText(data.text);
            pdfChunks.forEach((c) => {
              allNodes.push({
                title: `${pageTitle} (PDF Attachment)`,
                category: category,
                source_url: pdfUrl,
                content: c
              });
            });
          } catch (pdfErr) {
            console.error(`[crawler] Failed to parse PDF: ${pdfUrl}`, pdfErr.message);
          }
        }
      }
    } catch (err) {
      console.error(`[crawler] Error processing ${item.pathname}`, err.message);
    }
  }

  console.log(`[crawler] Total parsed chunks: ${allNodes.length}. Saving to data/rag_nodes.json...`);
  const dataDir = path.resolve(__dirname, "../data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, "rag_nodes.json"), JSON.stringify(allNodes, null, 2), "utf8");
  console.log("[crawler] Crawl and RAG import finished successfully!");
  process.exit(0);
}

run().catch((err) => {
  console.error("[crawler] Fatal error:", err);
  process.exit(1);
});