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
  }, 90000);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("Empty or invalid response structure");
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
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("Empty or invalid OpenAI response");
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
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("Empty or invalid Gemini response");
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

// Retry wrapper: retries up to `maxRetries` times on transient errors
// (abort, network, 429 rate-limit, 5xx server). Client errors (4xx except
// 429) are not retried — they indicate a permanent problem.
async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.status || error.statusCode;
      const isTransient = !status || status === 429 || status >= 500
        || error.name === "AbortError"
        || error.code === "ENOTFOUND"
        || error.code === "ECONNRESET"
        || error.code === "EPIPE";
      if (!isTransient) throw error;
      if (attempt < maxRetries) {
        const backoff = delayMs * Math.pow(2, attempt);
        console.log(`[ai] Retry ${attempt + 1}/${maxRetries} after ${backoff}ms: ${error.message}`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastError;
}

async function askAI(systemPrompt, userPrompt) {
  let reply = "";
  try {
    reply = await withRetry(() => callOpenCode(systemPrompt, userPrompt));
  } catch (e) {
    console.error("[ai] OpenCode failed, trying Gemini...", e.message);
    try {
      reply = await withRetry(() => callGemini(systemPrompt, userPrompt));
    } catch (e2) {
      console.error("[ai] Gemini failed, trying OpenAI...", e2.message);
      try {
        reply = await withRetry(() => callOpenAI(systemPrompt, userPrompt));
      } catch (e3) {
        console.error("[ai] All providers exhausted:", e3.message);
        return "Trợ lý AI đang bận, vui lòng thử lại sau.";
      }
    }
  }
  const cleanReply = stripMarkdown(reply);
  if (!cleanReply) return "Trợ lý AI đang bận, vui lòng thử lại sau.";
  if (cleanReply.startsWith("{") && cleanReply.endsWith("}")) {
    try {
      const parsed = JSON.parse(cleanReply);
      for (const value of [parsed.response, parsed.content, parsed.message]) {
        if (typeof value !== "string") continue;
        const parsedReply = stripMarkdown(value);
        if (parsedReply) return parsedReply;
      }
      return "Trợ lý AI đang bận, vui lòng thử lại sau.";
    } catch (e) {
      // not a valid JSON or parsing error, fallback to raw text
    }
  }
  return cleanReply;
}

module.exports = { askAI };
