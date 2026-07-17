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
  console.log("Sending message from user_pc (logged-in user)...");
  // Assuming 411230510 is in DB and has fb_id 36924306787215396
  const res1 = await sendWebhookMessage("36924306787215396", "gpa", "mid.pc_" + Date.now());
  console.log(`User PC Response Status: ${res1.status}, Body: ${res1.body}`);

  console.log("Sending message from user_mobile (not logged-in user)...");
  const res2 = await sendWebhookMessage("user_mobile_random_" + Date.now(), "hello", "mid.mobile_" + Date.now());
  console.log(`User Mobile Response Status: ${res2.status}, Body: ${res2.body}`);
}

runTest();
