const assert = require("assert");
const { createMessageBatcher } = require("../src/botRouter");

(async () => {
  const calls = [];
  const batchMessage = createMessageBatcher(async (senderPsid, text) => {
    calls.push({ senderPsid, text });
    return "ok";
  }, 10);

  const results = await Promise.all([
    batchMessage("user-1", "Bạn"),
    batchMessage("user-1", "có"),
    batchMessage("user-1", "biết")
  ]);

  assert.deepStrictEqual(results, ["ok", "ok", "ok"]);
  assert.deepStrictEqual(calls, [{
    senderPsid: "user-1",
    text: "Bạn\ncó\nbiết"
  }]);
  console.log("Message batcher OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
