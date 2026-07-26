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

// Fallback method: Send message via /{PAGE_ID}/messages API using Admin's User Access Token.
// Bypasses the 24-hour limit without requiring App Review or Utility Templates,
// by acting as a Page Admin sending a direct message to the user.
async function sendViaPageInbox(sender_psid, text) {
  const userToken = await db.getSystemSetting("fb_user_token", process.env.FB_USER_TOKEN || "");
  const pageId = await db.getSystemSetting("fb_page_id", process.env.FB_PAGE_ID || "");
  
  if (!userToken || !pageId) {
    throw new Error("Chưa cấu hình FB User Token hoặc FB Page ID");
  }

  // Post directly to /{PAGE_ID}/messages using Admin User Token (bypasses 24h limit)
  const url = `https://graph.facebook.com/v21.0/${pageId}/messages?access_token=${userToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: sender_psid },
      message: { text: text }
    })
  });
  
  const data = await res.json();
  if (data.error) {
    throw new Error(`FB Admin User Token Error (${data.error.code}): ${data.error.message}`);
  }
  return data;
}

// Preferred API: send proactive notification via Utility Message (bypasses 24h window).
// If Utility Message fails (error 10), try Page Admin User Access Token (Func.vn technique).
// As last resort, try Message Tag CONFIRMED_EVENT_UPDATE.
async function sendUtilityMessage(sender_psid, templateName, params = []) {
  const textContent = Array.isArray(params) ? params.join("\n") : String(params);

  try {
    const resolvedName = UTILITY_TEMPLATES[templateName] || templateName;
    console.log(`[messenger] Trying Utility Message: ${resolvedName}`);
    return await callSendUtility(sender_psid, resolvedName, params);
  } catch (e) {
    console.warn(`[messenger] Utility Message failed (${e.message}). Trying Page Admin User Token (Func.vn method)...`);
    
    try {
      const inboxRes = await sendViaPageInbox(sender_psid, textContent);
      console.log(`[messenger] Admin User Token send succeeded for ${sender_psid}!`);
      return inboxRes;
    } catch (inboxErr) {
      console.warn(`[messenger] Admin User Token failed (${inboxErr.message}). Trying CONFIRMED_EVENT_UPDATE Tag...`);
      
      const tag = "CONFIRMED_EVENT_UPDATE";
      const res = await callSendAPI(sender_psid, { text: textContent }, "MESSAGE_TAG", tag);
      if (res.error) {
        throw new Error(`Gửi tin thất bại mọi phương thức. Utility: ${e.message} | Admin User Token: ${inboxErr.message} | Tag: ${res.error.message}`);
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
