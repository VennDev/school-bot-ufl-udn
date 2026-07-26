const db = require("./db");

// ---- Utility Template names (create via: npm run setup-templates) ----
// ponytail: if template names change, update here AND re-run setup-templates.
const UTILITY_TEMPLATES = {
  ACCOUNT_UPDATE: "ufl_account_update",   // grades, account status
  EVENT_REMINDER: "ufl_exam_reminder",     // exam date/time/room reminders
  TUITION_ALERT: "ufl_tuition_alert",      // tuition debt warnings
  ANNOUNCEMENT: "ufl_announcement",        // academic announcements, schedule changes
};

async function callSendAPI(sender_psid, response, messagingType, tag, customToken) {
  const pageToken = customToken || await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
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
    return data;
  } catch (e) {
    console.error("[messenger] Fetch failed:", e.message);
    return { error: e };
  }
}

// ---- Utility Message sender (replaces Message Tags) ----
// Sends a proactive message outside 24h window using Pages Utility Messaging.
// If approved by Meta, messaging_type: "UTILITY" with message.text works.
async function callSendUtility(sender_psid, templateName, params = []) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`;

  const textContent = Array.isArray(params) ? params.join("\n") : String(params);

  const body = {
    recipient: { id: sender_psid },
    messaging_type: "UTILITY",
    message: {
      text: textContent || "[UFL Bot] Thông báo tiện ích"
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

// Derive a full Page Access Token with Admin privileges from FB User Access Token (Func.vn technique)
async function getAdminDerivedPageToken() {
  const userToken = await db.getSystemSetting("fb_user_token", process.env.FB_USER_TOKEN || "");
  const pageId = await db.getSystemSetting("fb_page_id", process.env.FB_PAGE_ID || "");
  if (!userToken || !pageId) return null;

  try {
    const url = `https://graph.facebook.com/v21.0/${pageId}?fields=access_token&access_token=${userToken}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.access_token) {
      console.log("[messenger] Successfully derived Page Access Token from Admin User Token!");
      return data.access_token;
    } else if (data.error) {
      console.warn("[messenger] Could not derive Page Token:", data.error.message);
    }
  } catch (e) {
    console.warn("[messenger] Error deriving Page Token:", e.message);
  }
  return null;
}

// Preferred API: multi-tier waterfall sender for proactive notifications.
// Tier 1: Try 24h window RESPONSE message (100% success if user chatted recently).
// Tier 2: Try Admin-derived Page Token (from fb_user_token) with CONFIRMED_EVENT_UPDATE tag.
// Tier 3: Try Default Page Token with CONFIRMED_EVENT_UPDATE tag.
// Tier 4: Try Utility Template.
async function sendUtilityMessage(sender_psid, templateName, params = []) {
  const textContent = Array.isArray(params) ? params.join("\n") : String(params);
  const msgObj = { text: textContent };

  // Tier 1: Standard RESPONSE message (inside 24h window)
  console.log(`[messenger] Tier 1: Trying 24h RESPONSE message to ${sender_psid}...`);
  const res1 = await callSendAPI(sender_psid, msgObj, "RESPONSE");
  if (!res1.error) {
    console.log(`[messenger] Tier 1 (24h RESPONSE) succeeded!`);
    return res1;
  }

  console.warn(`[messenger] Tier 1 failed (${res1.error.message}). User outside 24h window. Trying Tier 2 (Admin User Token)...`);

  // Tier 2: Admin-derived Page Token (from fb_user_token)
  const adminPageToken = await getAdminDerivedPageToken();
  if (adminPageToken) {
    console.log(`[messenger] Tier 2: Trying Admin Page Token (MESSAGE_TAG: CONFIRMED_EVENT_UPDATE)...`);
    const res2 = await callSendAPI(sender_psid, msgObj, "MESSAGE_TAG", "CONFIRMED_EVENT_UPDATE", adminPageToken);
    if (!res2.error) {
      console.log(`[messenger] Tier 2 (Admin Page Token Tag) succeeded!`);
      return res2;
    }

    console.log(`[messenger] Tier 2: Trying Admin Page Token (RESPONSE)...`);
    const res2Resp = await callSendAPI(sender_psid, msgObj, "RESPONSE", null, adminPageToken);
    if (!res2Resp.error) {
      console.log(`[messenger] Tier 2 (Admin Page Token RESPONSE) succeeded!`);
      return res2Resp;
    }
  }

  // Tier 3: Default Page Token with MESSAGE_TAG
  console.log(`[messenger] Tier 3: Trying Default Page Token (MESSAGE_TAG: CONFIRMED_EVENT_UPDATE)...`);
  const res3 = await callSendAPI(sender_psid, msgObj, "MESSAGE_TAG", "CONFIRMED_EVENT_UPDATE");
  if (!res3.error) {
    console.log(`[messenger] Tier 3 (Default Page Token Tag) succeeded!`);
    return res3;
  }

  // Tier 4: Utility Template
  try {
    const resolvedName = UTILITY_TEMPLATES[templateName] || templateName;
    console.log(`[messenger] Tier 4: Trying Utility Template: ${resolvedName}...`);
    return await callSendUtility(sender_psid, resolvedName, params);
  } catch (e) {
    console.error(`[messenger] All notification tiers failed for ${sender_psid}. Last error: ${e.message}`);
    throw new Error(`Gửi thông báo thất bại: ${res1.error?.message || e.message}`);
  }
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
  return { success: true, message: "Sẵn sàng gửi Utility Message (messaging_type: UTILITY)" };
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
