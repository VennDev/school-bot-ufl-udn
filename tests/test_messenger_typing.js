const assert = require("assert");
const db = require("../src/db");
const { sendTypingAction } = require("../src/messenger");

(async () => {
  const originalFetch = global.fetch;
  const originalSetting = db.getSystemSetting;
  const calls = [];
  db.getSystemSetting = async () => "test-token";
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { json: async () => ({ recipient_id: "psid" }) };
  };
  await sendTypingAction("psid", "typing_on");
  await sendTypingAction("psid", "typing_off");
  assert.deepStrictEqual(calls.map(call => call.body), [
    { recipient: { id: "psid" }, sender_action: "typing_on" },
    { recipient: { id: "psid" }, sender_action: "typing_off" },
  ]);

  global.fetch = async () => { throw new Error("network failure"); };
  await assert.doesNotReject(() => sendTypingAction("psid", "typing_on"));
  global.fetch = originalFetch;
  db.getSystemSetting = originalSetting;
  console.log("Messenger typing helper test passed OK!");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
