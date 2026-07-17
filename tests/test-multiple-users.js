const http = require("http");

async function runTest() {
  const PORT = process.env.PORT || 3000;
  
  const payload = {
    object: "page",
    entry: [
      {
        id: "page_id_123",
        time: Date.now(),
        messaging: [
          {
            sender: { id: "user_a" },
            recipient: { id: "page_id_123" },
            timestamp: Date.now(),
            message: { mid: "mid.user_a_msg_1", text: "hello" }
          },
          {
            sender: { id: "user_b" },
            recipient: { id: "page_id_123" },
            timestamp: Date.now(),
            message: { mid: "mid.user_b_msg_1", text: "hello" }
          }
        ]
      }
    ]
  };

  const postData = JSON.stringify(payload);

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
      res.on("end", () => {
        console.log(`[test] Response Status: ${res.statusCode}`);
        console.log(`[test] Response Body: ${body}`);
      });
    }
  );

  req.on("error", (e) => {
    console.error(`[test] Request error: ${e.message}`);
  });

  req.write(postData);
  req.end();
}

runTest();
