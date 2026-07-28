const assert = require("assert");
const { createMessageBatcher } = require("../src/botRouter");

(async () => {
  const calls = [];
  const batchMessage = createMessageBatcher(async (senderPsid, text) => {
    calls.push({ senderPsid, text });
    return "ok";
  }, 10);

  const results = await Promise.all([
    batchMessage("user-1", "Mình muốn hỏi GPA"),
    batchMessage("user-1", "và lịch thi sắp tới?")
  ]);

  assert.deepStrictEqual(results, ["ok", "ok"]);
  assert.deepStrictEqual(calls, [{
    senderPsid: "user-1",
    text: "Mình muốn hỏi GPA\nvà lịch thi sắp tới?"
  }]);
  console.log("Message batcher OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
