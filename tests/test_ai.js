require("dotenv").config();
const { askAI } = require("../src/ai");

async function test() {
  console.log("Testing askAI...");
  const systemPrompt = "Bạn là trợ lý AI hữu ích hỗ trợ sinh viên trường Đại học Ngoại ngữ - Đại học Đà Nẵng (UFL).";
  const userPrompt = "Xem điểm học tập của tôi.";
  try {
    const res = await askAI(systemPrompt, userPrompt);
    console.log("Response:", res);
  } catch (e) {
    console.error("Test failed with error:", e);
  }
}

test();