const fs = require("fs");
const path = require("path");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}
const db = require("./db");

const FILE_PATH = path.resolve(__dirname, "../docs/UFLS.txt");

async function importRegs() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`[import] File not found at: ${FILE_PATH}`);
    process.exit(1);
  }

  console.log(`[import] Reading regulations from: ${FILE_PATH}`);
  const content = fs.readFileSync(FILE_PATH, "utf-8");
  const lines = content.split("\n");
  console.log(`[import] Total lines: ${lines.length}`);

  const nodes = [];
  const chunkSize = 40;
  const overlap = 5;

  for (let i = 0; i < lines.length; i += (chunkSize - overlap)) {
    const chunkLines = lines.slice(i, i + chunkSize);
    if (!chunkLines.length) break;

    const cleanContent = chunkLines
      .map(line => line.trim())
      .filter(Boolean)
      .join("\n");

    if (cleanContent.length > 50) {
      nodes.push({
        content: cleanContent,
        start_line: i + 1,
        end_line: i + chunkLines.length,
      });
    }

    if (i + chunkSize >= lines.length) break;
  }

  console.log(`[import] Created ${nodes.length} nodes. Saving to database...`);
  await db.saveRegNodes(nodes);
  console.log("[import] Regulations imported successfully!");
  process.exit(0);
}

importRegs().catch((err) => {
  console.error("[import] Error importing regulations:", err);
  process.exit(1);
});
