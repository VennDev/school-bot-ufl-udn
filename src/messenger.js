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
    return data;
  } catch (e) {
    console.error("[messenger] Fetch failed:", e.message);
    return { error: e };
  }
}

// ---- Utility Message sender (replaces Message Tags) ----
// Sends a proactive message outside 24h window using a pre-approved Utility Template.
// templateName: one of UTILITY_TEMPLATES keys or a raw template name string.
// params: array of text values to fill into the template's {{1}}, {{2}}, ... placeholders.
async function callSendUtility(sender_psid, templateName, params = []) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`;

  // Build the correct Facebook Utility Template payload
  const body = {
    recipient: { id: sender_psid },
    messaging_type: "UTILITY",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "utility",
          template_name: templateName,
          locale: "vi",
          components: [
            {
              type: "body",
              parameters: params.map(p => ({
                type: "text",
                text: String(p)
              }))
            }
          ]
        }
      }
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

// Fallback method: Send message via Page Inbox API using Admin's User Access Token.
// Bypasses the 24-hour limit without requiring App Review or Utility Templates,
// by simulating a Page Admin replying in the Facebook Page Inbox thread.
async function sendViaPageInbox(sender_psid, text) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const userToken = await db.getSystemSetting("fb_user_token", process.env.FB_USER_TOKEN || "");
  const pageId = await db.getSystemSetting("fb_page_id", process.env.FB_PAGE_ID || "");
  
  if (!pageToken || !pageId) {
    throw new Error("Chưa cấu hình FB Page Token hoặc FB Page ID");
  }

  // 1. Find conversation thread ID for this PSID using Page Token via "/me" alias (foolproof Page ID)
  const convUrl = `https://graph.facebook.com/v21.0/me/conversations?user_id=${sender_psid}&access_token=${pageToken}`;
  const convRes = await fetch(convUrl);
  const convData = await convRes.json();
  
  if (convData.error) {
    throw new Error(`Inbox Thread Search Error: ${convData.error.message}`);
  }
  
  const thread = convData.data?.[0];
  if (!thread) {
    throw new Error("Không tìm thấy hội thoại giữa Page và user này");
  }
  
  const threadId = thread.id;
  const tokenToUse = userToken || pageToken;

  // 2. Post message to thread using User Access Token (bypasses 24h limit) or Page Token as fallback
  const msgUrl = `https://graph.facebook.com/v21.0/${threadId}/messages?access_token=${tokenToUse}`;
  const msgRes = await fetch(msgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text
    })
  });
  
  const msgData = await msgRes.json();
  if (msgData.error) {
    throw new Error(`Inbox Send Message Error: ${msgData.error.message}`);
  }
  
  return msgData;
}

// Preferred API: send proactive notification via Utility Template (bypasses 24h window).
// If Utility Template fails (error 10) AND standard tags fail, fall back to Page Inbox API (User Access Token).
async function sendUtilityMessage(sender_psid, templateName, params = []) {
  const textContent = Array.isArray(params) ? params.join("\n") : String(params);

  try {
    const resolvedName = UTILITY_TEMPLATES[templateName] || templateName;
    console.log(`[messenger] Trying Utility Template: ${resolvedName}`);
    return await callSendUtility(sender_psid, resolvedName, params);
  } catch (e) {
    console.warn(`[messenger] Utility Template failed (${e.message}). Trying Page Inbox via FB User Token...`);
    
    try {
      const inboxRes = await sendViaPageInbox(sender_psid, textContent);
      console.log(`[messenger] Page Inbox send succeeded for ${sender_psid}!`);
      return inboxRes;
    } catch (inboxErr) {
      console.warn(`[messenger] Page Inbox failed (${inboxErr.message}). Falling back to Message Tag...`);
      
      const tagMap = {
        ACCOUNT_UPDATE: "ACCOUNT_UPDATE",
        EVENT_REMINDER: "CONFIRMED_EVENT_UPDATE",
        TUITION_ALERT: "ACCOUNT_UPDATE",
        ANNOUNCEMENT: "CONFIRMED_EVENT_UPDATE"
      };
      const tag = tagMap[templateName] || "ACCOUNT_UPDATE";

      const res = await callSendAPI(sender_psid, { text: textContent }, "MESSAGE_TAG", tag);
      if (res.error) {
        throw new Error(`Gửi tin thất bại mọi phương thức. Utility: ${e.message} | Inbox: ${inboxErr.message} | Tag: ${res.error.message}`);
      }
      return res;
    }
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
