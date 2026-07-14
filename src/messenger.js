const db = require("./db");

async function callSendAPI(sender_psid, response) {
  const pageToken = db.getSystemSetting("fb_page_token", process.env.FB_PAGE_TOKEN || "");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: sender_psid },
        message: response,
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error("[messenger] API Error:", data.error.message);
    }
  } catch (e) {
    console.error("[messenger] Fetch failed:", e.message);
  }
}

async function sendTextMessage(sender_psid, text) {
  return callSendAPI(sender_psid, { text });
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
  sendButtons,
  sendQuickReplies,
  sendGenericTemplate,
};
