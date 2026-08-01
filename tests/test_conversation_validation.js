const assert = require("assert");
const db = require("../src/db");

(async () => {
  assert.strictEqual(await db.saveConversation("", "assistant", ""), false);
  assert.strictEqual(await db.saveConversation("user-1", "assistant", "   "), false);
  assert.strictEqual(await db.saveConversation("user-1", "invalid", "reply"), false);
  console.log("Conversation validation guard passed OK!");
})();
