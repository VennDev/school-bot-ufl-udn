const db = require("./db");
const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function callOpenCode(systemPrompt, userPrompt) {
  const apiKey = await db.getSystemSetting("opencode_api_key", process.env.OPENCODE_API_KEY || "public");
  const model = await db.getSystemSetting("opencode_model", process.env.OPENCODE_MODEL || "deepseek-v4-flash-free");

  const res = await fetchWithTimeout(OPENCODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "x-opencode-client": "desktop",
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.0
    }),
  }, 25000);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content.trim();
  }
  throw new Error("Invalid response structure");
}

async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = await db.getSystemSetting("openai_api_key", process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("No OpenAI API key");

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.0
    })
  }, 15000);

  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content.trim();
  }
  throw new Error("Invalid OpenAI response");
}

async function callGemini(systemPrompt, userPrompt) {
  const apiKey = await db.getSystemSetting("gemini_api_key", process.env.GEMINI_API_KEY);
  if (!apiKey) throw new Error("No Gemini API key");

  const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\nUser request: ${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.0
      }
    })
  }, 15000);

  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
    return data.candidates[0].content.parts[0].text.trim();
  }
  throw new Error("Invalid Gemini response");
}

function stripMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$2")
    .replace(/`{1,3}(.*?)(`{1,3}|$)/g, "$1")
    .replace(/^>\s+/gm, "")
    .trim();
}

async function askAI(systemPrompt, userPrompt) {
  let reply = "";
  try {
    reply = await callOpenCode(systemPrompt, userPrompt);
  } catch (e) {
    console.error("[ai] OpenCode error, falling back to OpenAI/Gemini...", e.message);
    try {
      reply = await callGemini(systemPrompt, userPrompt);
    } catch (e2) {
      console.error("[ai] Gemini fallback error, trying OpenAI...", e2.message);
      try {
        reply = await callOpenAI(systemPrompt, userPrompt);
      } catch (e3) {
        console.error("[ai] OpenAI fallback error...", e3.message);
        return "Trợ lý AI đang bận, vui lòng thử lại sau.";
      }
    }
  }
  const cleanReply = stripMarkdown(reply);
  if (cleanReply.startsWith("{") && cleanReply.endsWith("}")) {
    try {
      const parsed = JSON.parse(cleanReply);
      if (parsed.response) return stripMarkdown(parsed.response);
      if (parsed.content) return stripMarkdown(parsed.content);
      if (parsed.message) return stripMarkdown(parsed.message);
    } catch (e) {
      // not a valid JSON or parsing error, fallback to raw text
    }
  }
  return cleanReply;
}

module.exports = { askAI };
