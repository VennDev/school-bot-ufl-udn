const https = require("https");
const http = require("http");
const db = require("./db");
const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";

function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === "http:" ? http : https;
    const req = transport.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + (u.search || ""),
      method: options.method || "GET",
      headers: options.headers || {},
      family: 4,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText),
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);

    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function getTemperature() {
  const setting = await db.getSystemSetting("ai_temperature", process.env.AI_TEMPERATURE || "0.35");
  const parsed = parseFloat(setting);
  return Number.isFinite(parsed) ? Math.max(0.0, Math.min(1.0, parsed)) : 0.35;
}

async function callCustomAI(systemPrompt, userPrompt) {
  const endpoint = await db.getSystemSetting("custom_ai_url", process.env.CUSTOM_AI_URL || "https://api.xah.io");
  const apiKey = await db.getSystemSetting("custom_ai_key", process.env.CUSTOM_AI_KEY || "sk-fd9b9e1238c55a1e034267163a5b4ec8fa72e8fa8b1516879ecfd7300896ebaf");
  const model = await db.getSystemSetting("custom_ai_model", process.env.CUSTOM_AI_MODEL || "cuong5a115a11/deepseek-v4.1-flash");
  const temp = await getTemperature();

  if (!endpoint || !apiKey) throw new Error("Custom AI not configured");

  const url = endpoint.replace(/\/+$/, "") + (endpoint.includes("/v1") ? "/chat/completions" : "/v1/chat/completions");

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: temp
    })
  }, 25000);

  if (!res.ok) throw new Error(`Custom AI HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("Empty or invalid Custom AI response");
}

async function callOpenCode(systemPrompt, userPrompt) {
  const apiKey = await db.getSystemSetting("opencode_api_key", process.env.OPENCODE_API_KEY || "public");
  const model = await db.getSystemSetting("opencode_model", process.env.OPENCODE_MODEL || "mimo-v2.5-free");
  const temp = await getTemperature();

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
      temperature: temp
    }),
  }, 25000);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("Empty or invalid response structure");
}

async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = await db.getSystemSetting("openai_api_key", process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("No OpenAI API key");
  const temp = await getTemperature();

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
      temperature: temp
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
  const temp = await getTemperature();

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
        temperature: temp
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
async function withRetry(fn, maxRetries = 1, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.status || error.statusCode;
      const msg = error.message || "";
      const isClientError = (status >= 400 && status < 500 && status !== 429) ||
        /\b(?:400|401|403|404)\b/.test(msg) ||
        msg.includes("No Gemini API key") ||
        msg.includes("No OpenAI API key") ||
        msg.includes("Custom AI not configured");
      if (isClientError) throw error;

      const isTransient = status === 429 || (status >= 500)
        || error.name === "AbortError"
        || error.code === "ENOTFOUND"
        || error.code === "ECONNRESET"
        || error.code === "EPIPE"
        || msg.includes("fetch failed");
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
  const provider = await db.getSystemSetting("ai_provider", process.env.AI_PROVIDER || "custom");
  let reply = "";

  const providers = [];
  if (provider === "custom") {
    providers.push({ name: "Custom AI", fn: () => callCustomAI(systemPrompt, userPrompt) });
    providers.push({ name: "OpenCode", fn: () => callOpenCode(systemPrompt, userPrompt) });
    providers.push({ name: "Gemini", fn: () => callGemini(systemPrompt, userPrompt) });
    providers.push({ name: "OpenAI", fn: () => callOpenAI(systemPrompt, userPrompt) });
  } else if (provider === "opencode") {
    providers.push({ name: "OpenCode", fn: () => callOpenCode(systemPrompt, userPrompt) });
    providers.push({ name: "Custom AI", fn: () => callCustomAI(systemPrompt, userPrompt) });
    providers.push({ name: "Gemini", fn: () => callGemini(systemPrompt, userPrompt) });
    providers.push({ name: "OpenAI", fn: () => callOpenAI(systemPrompt, userPrompt) });
  } else if (provider === "gemini") {
    providers.push({ name: "Gemini", fn: () => callGemini(systemPrompt, userPrompt) });
    providers.push({ name: "Custom AI", fn: () => callCustomAI(systemPrompt, userPrompt) });
    providers.push({ name: "OpenCode", fn: () => callOpenCode(systemPrompt, userPrompt) });
    providers.push({ name: "OpenAI", fn: () => callOpenAI(systemPrompt, userPrompt) });
  } else {
    providers.push({ name: "OpenAI", fn: () => callOpenAI(systemPrompt, userPrompt) });
    providers.push({ name: "Custom AI", fn: () => callCustomAI(systemPrompt, userPrompt) });
    providers.push({ name: "OpenCode", fn: () => callOpenCode(systemPrompt, userPrompt) });
    providers.push({ name: "Gemini", fn: () => callGemini(systemPrompt, userPrompt) });
  }

  for (const p of providers) {
    try {
      reply = await withRetry(p.fn);
      if (reply) break;
    } catch (e) {
      console.error(`[ai] ${p.name} failed:`, e.message);
    }
  }

  if (!reply) {
    console.error("[ai] All providers exhausted");
    return "Trợ lý AI đang bận, vui lòng thử lại sau.";
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
