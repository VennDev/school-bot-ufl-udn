const db = require("./db");

// Hardcoded fallback: total credits for known UFL programs (from Sổ tay sinh viên 2025)
// Keys are stored in normalized form (no diacritics, lowercase)
// ponytail: when new programs added, update this map and re-import handbook
const KNOWN_PROGRAMS = {
  "su pham tieng anh": { totalCredits: 144, durationYears: 4 },
  "su pham tieng trung quoc": { totalCredits: 140, durationYears: 4 },
  "su pham tieng phap": { totalCredits: 140, durationYears: 4 },
  "su pham tieng nga": { totalCredits: 140, durationYears: 4 },
  "su pham tieng han quoc": { totalCredits: 140, durationYears: 4 },
  "su pham tieng nhat": { totalCredits: 140, durationYears: 4 },
  "cu nhan anh": { totalCredits: 131, durationYears: 4 },
  "ngon ngu anh": { totalCredits: 131, durationYears: 4 },
  "ngon ngu anh - bien phien dich": { totalCredits: 131, durationYears: 4 },
  "bien phien dich tieng anh": { totalCredits: 131, durationYears: 4 },
  "bien phien dich": { totalCredits: 131, durationYears: 4 },
  "tieng anh thuong mai": { totalCredits: 131, durationYears: 4 },
  "tieng anh du lich": { totalCredits: 131, durationYears: 4 },
  "tieng anh thuong mai dien tu": { totalCredits: 135, durationYears: 4 },
  "tieng anh cong nghe thong tin": { totalCredits: 131, durationYears: 4 },
  "tieng anh cntt": { totalCredits: 131, durationYears: 4 },
  "cu nhan phap": { totalCredits: 131, durationYears: 4 },
  "ngon ngu phap": { totalCredits: 131, durationYears: 4 },
  "cu nhan trung quoc": { totalCredits: 131, durationYears: 4 },
  "ngon ngu trung quoc": { totalCredits: 131, durationYears: 4 },
  "cu nhan nga": { totalCredits: 131, durationYears: 4 },
  "ngon ngu nga": { totalCredits: 131, durationYears: 4 },
  "cu nhan han quoc": { totalCredits: 131, durationYears: 4 },
  "ngon ngu han quoc": { totalCredits: 131, durationYears: 4 },
  "cu nhan nhat ban": { totalCredits: 131, durationYears: 4 },
  "ngon ngu nhat ban": { totalCredits: 131, durationYears: 4 },
  "cu nhan thai lan": { totalCredits: 131, durationYears: 4 },
  "ngon ngu thai lan": { totalCredits: 131, durationYears: 4 },
  "quoc te hoc": { totalCredits: 135, durationYears: 4 },
  "tieng viet va van hoa viet nam": { totalCredits: 135, durationYears: 4 },
};

function normalizeMajorName(name) {
  return String(name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findKnownProgram(majorName) {
  const normalized = normalizeMajorName(majorName);
  // Exact match first
  if (KNOWN_PROGRAMS[normalized]) return KNOWN_PROGRAMS[normalized];
  // Substring match (e.g., "Cử nhân Anh" matches "cử nhân anh")
  for (const [key, value] of Object.entries(KNOWN_PROGRAMS)) {
    if (normalized.includes(key) || key.includes(normalized)) return value;
  }
  return null;
}

/**
 * Search handbook RegNode for the teaching plan matching the student's major.
 * Returns { totalCredits, durationYears, planTitle, source } or null.
 */
async function lookupProgramFramework(majorName) {
  if (!majorName) return null;

  // 1. Try hardcoded known programs first (fast, reliable)
  const known = findKnownProgram(majorName);
  if (known) {
    return { ...known, planTitle: majorName, source: "known_programs" };
  }

  // 2. Search RegNode database for teaching plan section
  const normalized = normalizeMajorName(majorName);
  const searchTerms = [majorName, normalized];
  // Add partial terms (split by space, take significant words)
  const words = normalized.split(" ").filter(w => w.length > 2 && !/^(tiếng|ngữ|học|và|của|các)$/i.test(w));
  searchTerms.push(...words);

  let bestResult = null;
  for (const term of searchTerms) {
    const results = await db.searchRegNodes(`KẾ HOẠCH GIẢNG DẠY ${term}`, 3);
    if (results && results.length > 0) {
      for (const r of results) {
        const content = r.content || "";
        // Look for "Tổng số tín chỉ toàn khóa" line
        const totalMatch = content.match(/tổng\s+số\s+tín\s+chỉ\s+toàn\s+kh[oó]a\s*:?\s*(\d{2,3})/i);
        if (totalMatch) {
          bestResult = {
            totalCredits: parseInt(totalMatch[1], 10),
            durationYears: 4,
            planTitle: r.title || majorName,
            source: "handbook_search",
          };
          break;
        }
        // Also try "Tổng" at end of teaching plan (last number before next section)
        const lines = content.split("\n");
        for (const line of lines) {
          const m = line.match(/^tổng\s*(?:số\s*tín\s*chỉ\s*)?:?\s*(\d{2,3})\s*$/i);
          if (m) {
            bestResult = {
              totalCredits: parseInt(m[1], 10),
              durationYears: 4,
              planTitle: r.title || majorName,
              source: "handbook_search",
            };
            break;
          }
        }
        if (bestResult) break;
      }
    }
    if (bestResult) break;
  }

  return bestResult;
}

/**
 * Get the full teaching plan (course list by semester) for a given major.
 */
async function getTeachingPlan(majorName) {
  if (!majorName) return null;
  const results = await db.searchRegNodes(`KẾ HOẠCH GIẢNG DẠY ${majorName}`, 10);
  if (!results || !results.length) return null;

  // Concatenate all chunks that belong to the same teaching plan
  const planChunks = results
    .filter(r => {
      const content = (r.content || "").toLowerCase();
      const title = (r.title || "").toLowerCase();
      return content.includes("kế hoạch giảng dạy") || title.includes("kế hoạch giảng dạy");
    })
    .map(r => r.content)
    .join("\n");

  return planChunks || null;
}

module.exports = { lookupProgramFramework, getTeachingPlan, findKnownProgram, KNOWN_PROGRAMS };
