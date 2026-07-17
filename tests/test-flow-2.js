const http = require("http");

async function sendWebhookMessage(senderId, text, mid) {
  const PORT = process.env.PORT || 3000;
  const payload = {
    object: "page",
    entry: [
      {
        id: "page_id_123",
        time: Date.now(),
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: "page_id_123" },
            timestamp: Date.now(),
            message: { mid: mid, text: text }
          }
        ]
      }
    ]
  };

  const postData = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: PORT,
        path: "/webhook",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function runTest() {
  console.log("Sending first message from user_a (new mobile user)...");
  const res1 = await sendWebhookMessage("mobile_user_a_" + Date.now(), "hello", "mid.mob_a_" + Date.now());
  console.log(`User A Response Status: ${res1.status}, Body: ${res1.body}`);

  await new Promise(r => setTimeout(r, 1000));

  console.log("Sending message from user_b (new mobile user)...");
  const res2 = await sendWebhookMessage("mobile_user_b_" + Date.now(), "hello", "mid.mob_b_" + Date.now());
  console.log(`User B Response Status: ${res2.status}, Body: ${res2.body}`);
}

runTest();
