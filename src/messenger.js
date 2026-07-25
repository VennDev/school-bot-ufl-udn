const db = require("./db");

async function callSendAPI(sender_psid, response, messagingType, tag) {
  const pageToken = await db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`;
  const body = {
    recipient: { id: sender_psid },
    message: response,
  };
  // messaging_type: "MESSAGE_TAG" with a valid tag bypasses the 24h window.
  // Tags CONFIRMED_EVENT_UPDATE and ACCOUNT_UPDATE deprecated April 27, 2026.
  // ponytail: migrate to Utility Templates before that deadline.
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
      console.error("[messenger] API Error:", data.error.message, "| tag:", tag || "none");
    }
  } catch (e) {
    console.error("[messenger] Fetch failed:", e.message);
  }
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

// Proactive notification with Message Tag — bypasses 24h window.
// tag: "ACCOUNT_UPDATE" for grades/tuition, "CONFIRMED_EVENT_UPDATE" for exams/schedule.
async function sendTaggedTextMessage(sender_psid, text, tag) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await callSendAPI(sender_psid, { text: chunk }, "MESSAGE_TAG", tag);
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

module.exports = {
  sendTextMessage,
  sendTaggedTextMessage,
  sendButtons,
  sendQuickReplies,
  sendGenericTemplate,
};
