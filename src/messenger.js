const db = require("./db");

// ---- Utility Template names (create via: npm run setup-templates) ----
// ponytail: if template names change, update here AND re-run setup-templates.
const UTILITY_TEMPLATES = {
  ACCOUNT_UPDATE: "ufl_account_update",   // grades, account status
  EVENT_REMINDER: "ufl_exam_reminder",     // exam date/time/room reminders
  TUITION_ALERT: "ufl_tuition_alert",      // tuition debt warnings
  ANNOUNCEMENT: "ufl_announcement",        // academic announcements, schedule changes
};

async function callSendAPI(sender_psid, response, messagingType, tag) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`;
  const body = {
    recipient: { id: sender_psid },
    message: response,
  };
  if (messagingType) body.messaging_type = messagingType;
  if (tag) body.tag = tag;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      console.error("[messenger] API Error:", data.error.message, "| type:", messagingType || "RESPONSE");
    }
  } catch (e) {
    console.error("[messenger] Fetch failed:", e.message);
  }
}

// ---- Utility Message sender (replaces Message Tags) ----
// Sends a proactive message outside 24h window using a pre-approved Utility Template.
// templateName: one of UTILITY_TEMPLATES keys or a raw template name string.
// params: array of text values to fill into the template's {{1}}, {{2}}, ... placeholders.
async function callSendUtility(sender_psid, templateName, params = []) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`;

  const textContent = Array.isArray(params) ? params.join("\n") : String(params);

  // Send via Messenger MESSAGE_TAG ACCOUNT_UPDATE (standard Meta Utility Message Tag)
  const body = {
    recipient: { id: sender_psid },
    messaging_type: "MESSAGE_TAG",
    tag: "ACCOUNT_UPDATE",
    message: {
      text: textContent || "[UFL Bot] Thử nghiệm tin nhắn Utility (ACCOUNT_UPDATE)."
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    console.error("[messenger] FB Utility Error details:", JSON.stringify(data.error));
    throw new Error(`FB Error (${data.error.code}): ${data.error.message} | Full: ${JSON.stringify(data.error)}`);
  }
  return data;
}

function chunkText(text) {
  if (!text) return [];
  if (text.length <= 2000) return [text];
  const chunks = [];
  let current = text;
  while (current.length > 0) {
    if (current.length <= 2000) {
      chunks.push(current);
      break;
    }
    let cutIdx = current.lastIndexOf("\n", 2000);
    if (cutIdx <= 0) cutIdx = current.lastIndexOf(" ", 2000);
    if (cutIdx <= 0) cutIdx = 2000;
    chunks.push(current.substring(0, cutIdx));
    current = current.substring(cutIdx).trim();
  }
  return chunks;
}

async function sendTextMessage(sender_psid, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await callSendAPI(sender_psid, { text: chunk });
  }
}

// Preferred API: send proactive notification via Utility Template (bypasses 24h window).
// templateName: key of UTILITY_TEMPLATES (e.g. "ACCOUNT_UPDATE", "EVENT_REMINDER").
// params: array of strings filling {{1}}, {{2}}, ... in order.
async function sendUtilityMessage(sender_psid, templateName, params = []) {
  const resolvedName = UTILITY_TEMPLATES[templateName] || templateName;
  return await callSendUtility(sender_psid, resolvedName, params);
}

async function sendButtons(sender_psid, text, buttons) {
  return callSendAPI(sender_psid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons,
      },
    },
  });
}

async function sendQuickReplies(sender_psid, text, replies) {
  return callSendAPI(sender_psid, {
    text,
    quick_replies: replies.map((r) => ({
      content_type: "text",
      title: r.title,
      payload: r.payload,
    })),
  });
}

async function sendGenericTemplate(sender_psid, elements) {
  return callSendAPI(sender_psid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: elements,
      },
    },
  });
}

async function ensureUtilityTemplateCreated() {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const pageId = await db.getSystemSetting("fb_page_id", process.env.FB_PAGE_ID || "");
  if (!pageToken || !pageId) return { success: false, error: "Thiếu FB_PAGE_TOKEN hoặc FB_PAGE_ID" };

  const url = `https://graph.facebook.com/v21.0/${pageId}/message_templates?access_token=${pageToken}`;
  const tmpl = {
    name: "ufl_account_update",
    language: "vi",
    category: "UTILITY",
    components: [{ type: "BODY", text: "{{1}}" }],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tmpl),
    });
    const data = await res.json();
    if (data.error) {
      if (data.error.code === 100 && data.error.error_subcode === 2654) {
        return { success: true, message: "Template đã tồn tại sẵn" };
      }
      return { success: false, error: `${data.error.message} (Code: ${data.error.code})` };
    }
    return { success: true, message: `Tạo template thành công (ID: ${data.id})` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  sendTextMessage,
  sendUtilityMessage,     // proactive notifications via Utility Templates
  ensureUtilityTemplateCreated,
  UTILITY_TEMPLATES,      // template name constants
  sendButtons,
  sendQuickReplies,
  sendGenericTemplate,
};
