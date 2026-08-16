process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const https = require("https");
const querystring = require("querystring");

const HOST = "sinhvien.ufl.udn.vn";
const USERNAME = process.env.SCHOOL_USERNAME;
const PASSWORD = process.env.SCHOOL_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("Missing SCHOOL_USERNAME and SCHOOL_PASSWORD");
  process.exit(1);
}

function request(opts, postBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

(async () => {
  const postData = querystring.stringify({
    Role: "0",
    UserName: USERNAME,
    Password: PASSWORD,
  });

  const loginRes = await request({
    hostname: HOST,
    path: "/DangNhap/SaveToken",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  }, postData);

  const cookies = (loginRes.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .join("; ");

  if (loginRes.status === 302 && loginRes.headers.location) {
    const pageRes = await request({
      hostname: HOST,
      path: loginRes.headers.location,
      method: "GET",
      headers: { Cookie: cookies },
    });
    console.log(`Status: ${pageRes.status}`);
    console.log(pageRes.status === 200 ? "Login OK" : "Login failed");
    console.log(`Body (500): ${pageRes.body.substring(0, 500)}`);
  }

  // Logout để không tích session
  const logoutRes = await request({
    hostname: HOST,
    path: "/DangNhap/Signout",
    method: "GET",
    headers: { Cookie: cookies },
  });
  console.log(`Logout: ${logoutRes.status}`);
})();
