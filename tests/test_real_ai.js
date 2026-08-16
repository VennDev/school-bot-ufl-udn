require("dotenv").config();
const { askAI } = require("../src/ai");
const fs = require("fs");
const path = require("path");

async function testReal() {
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules.txt"), "utf8");
  const cleanData = {
    user: { username: process.env.TEST_USERNAME || "test-user" },
    current_time: "2026-07-25",
    gpa_summary: {
      gpaSemester: 3.2,
      gpaAccumulated: 3.44,
      creditsAccumulated: 80,
      rank: "Giỏi",
      subjectsToRelearn: [],
      subjectsToImprove: ["Ngoại ngữ II.1 (Tiếng Trung)"]
    },
    recent_grades: [
      { name: "Triết học Mác - Lênin", credits: 3, score10: 6.5, grade: "C" },
      { name: "Lịch sử Đảng", credits: 2, score10: 7.8, grade: "B" }
    ],
    exams: [],
    tuition: [],
    schedule: []
  };

  const systemPrompt = rules + `\n\nDưới đây là thông tin học vụ của sinh viên để bạn tham khảo. Câu trả lời của bạn PHẢI là văn bản thuần túy tiếng Việt, TUYỆT ĐỐI KHÔNG trả về định dạng JSON hay bất kỳ phân tích cấu trúc nào khác:\n${JSON.stringify(cleanData, null, 2)}`;

  console.log("[test] Calling askAI...");
  const start = Date.now();
  try {
    const res = await askAI(systemPrompt, "Cậu tên là gì?");
    console.log(`[test] Response in ${Date.now() - start}ms:\n`, res);
  } catch (e) {
    console.error("[test] Error:", e);
  }
}

testReal();