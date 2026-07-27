const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
if (!global.crypto) {
  global.crypto = require("crypto").webcrypto || require("crypto");
}

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/school-bot";

let connected = false;
let mongoServer = null;

async function connect() {
  if (connected) return;
  
  const options = {
    serverSelectionTimeoutMS: 3000,
  };

  try {
    await mongoose.connect(MONGO_URI, options);
    connected = true;
    console.log("[db] MongoDB connected to native instance");
  } catch (err) {
    console.warn(`[db] Local MongoDB connection failed (${err.message}). Falling back to MongoMemoryServer...`);
    try {
      const { MongoMemoryServer } = require("mongodb-memory-server");
      mongoServer = await MongoMemoryServer.create();
      const memoryUri = mongoServer.getUri();
      await mongoose.connect(memoryUri);
      connected = true;
      console.log(`[db] MongoDB connected to In-Memory instance: ${memoryUri}`);
    } catch (memErr) {
      console.error("[db] Fatal: Failed to initialize MongoMemoryServer", memErr);
      throw memErr;
    }
  }
}

// ---------- Schemas ----------

const userSchema = new mongoose.Schema({
  fb_id: { type: String, unique: true, required: true },
  username: String,
  password_enc: String,
  role: { type: String, default: "0" },
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
  fb_id: { type: String, unique: true, required: true },
  notify_gpa: { type: Number, default: 1 },
  notify_schedule: { type: Number, default: 1 },
  notify_exam: { type: Number, default: 1 },
  notify_tuition: { type: Number, default: 1 },
  notify_announcement: { type: Number, default: 1 },
  email: { type: String, default: null },
});

const scrapedDataSchema = new mongoose.Schema({
  fb_id: { type: String, unique: true, required: true },
  canh_bao: String,
  thong_tin_sv: String,
  ket_qua_hoc_tap: String,
  diem_ren_luyen: String,
  lich_thi: String,
  hoc_bong_ktkl: String,
  lich_hoc: String,
  hoc_phi: String,
  updated_at: Number,
});

const changeLogSchema = new mongoose.Schema({
  fb_id: String,
  type: String,
  content: String,
}, { timestamps: true });

const studyGoalSchema = new mongoose.Schema({
  fb_id: { type: String, unique: true, required: true },
  target_hours: Number,
  target_gpa: Number,
}, { timestamps: true });

const studySessionSchema = new mongoose.Schema({
  fb_id: String,
  subject: String,
  duration_mins: Number,
  date: String,
}, { timestamps: true });

const systemSettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: String,
});

const interactionSchema = new mongoose.Schema({
  fb_id: String,
  action: String,
  payload: String,
}, { timestamps: true });

const otnTokenSchema = new mongoose.Schema({
  fb_id: { type: String, required: true },
  token: { type: String, unique: true, required: true },
  topic: { type: String, required: true },
}, { timestamps: true });

const conversationSchema = new mongoose.Schema({
  fb_id: { type: String, required: true, index: true },
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
}, { timestamps: true });
conversationSchema.index({ fb_id: 1, createdAt: -1 });

const regNodeSchema = new mongoose.Schema({
  title: String,
  category: { type: String, index: true },
  source_url: String,
  content: { type: String, required: true },
  start_page: Number,
  end_page: Number,
  start_line: Number,
  end_line: Number,
});
regNodeSchema.index({ content: "text", title: "text" });

// ---------- Models ----------

let User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting, Interaction, RegNode, OtnToken, Conversation;

function initModels() {
  User = mongoose.model("User", userSchema);
  Settings = mongoose.model("Settings", settingsSchema);
  ScrapedData = mongoose.model("ScrapedData", scrapedDataSchema);
  ChangeLog = mongoose.model("ChangeLog", changeLogSchema);
  StudyGoal = mongoose.model("StudyGoal", studyGoalSchema);
  StudySession = mongoose.model("StudySession", studySessionSchema);
  SystemSetting = mongoose.model("SystemSetting", systemSettingSchema);
  Interaction = mongoose.model("Interaction", interactionSchema);
  RegNode = mongoose.model("RegNode", regNodeSchema);
  OtnToken = mongoose.model("OtnToken", otnTokenSchema);
  Conversation = mongoose.model("Conversation", conversationSchema);
}

// ---------- Lazy init ----------

async function ensureInit() {
  await connect();
  if (!User) initModels();
}

// ---------- Exported helpers (same API as SQLite version) ----------

module.exports = {
  async getUser(fbId) {
    await ensureInit();
    return User.findOne({ fb_id: fbId }).lean();
  },

  async saveUser(fbId, username, passwordEnc, role = "0") {
    await ensureInit();
    await User.findOneAndUpdate(
      { fb_id: fbId },
      { username, password_enc: passwordEnc, role },
      { upsert: true, returnDocument: "after" }
    );
    await Settings.findOneAndUpdate(
      { fb_id: fbId },
      { $setOnInsert: { fb_id: fbId } },
      { upsert: true }
    );
  },

  async deleteUser(fbId) {
    await ensureInit();
    await User.deleteOne({ fb_id: fbId });
    await Settings.deleteOne({ fb_id: fbId });
    await ScrapedData.deleteOne({ fb_id: fbId });
    await StudyGoal.deleteOne({ fb_id: fbId });
    await StudySession.deleteMany({ fb_id: fbId });
  },

  async getAllUsers() {
    await ensureInit();
    return User.find().lean();
  },

  async getSettings(fbId) {
    await ensureInit();
    const s = await Settings.findOne({ fb_id: fbId }).lean();
    return s || {
      fb_id: fbId,
      notify_gpa: 1,
      notify_schedule: 1,
      notify_exam: 1,
      notify_tuition: 1,
      notify_announcement: 1,
      email: null,
    };
  },

  async saveSettings(fbId, settings) {
    await ensureInit();
    await Settings.findOneAndUpdate(
      { fb_id: fbId },
      { $set: settings },
      { upsert: true }
    );
  },

  async getScrapedData(fbId) {
    await ensureInit();
    return ScrapedData.findOne({ fb_id: fbId }).lean();
  },

  async saveScrapedData(fbId, data) {
    await ensureInit();
    const doc = {
      fb_id: fbId,
      canh_bao: data.canh_bao ? JSON.stringify(data.canh_bao) : null,
      thong_tin_sv: data.thong_tin_sv ? JSON.stringify(data.thong_tin_sv) : null,
      ket_qua_hoc_tap: data.ket_qua_hoc_tap ? JSON.stringify(data.ket_qua_hoc_tap) : null,
      diem_ren_luyen: data.diem_ren_luyen ? JSON.stringify(data.diem_ren_luyen) : null,
      lich_thi: data.lich_thi ? JSON.stringify(data.lich_thi) : null,
      hoc_bong_ktkl: data.hoc_bong_ktkl ? JSON.stringify(data.hoc_bong_ktkl) : null,
      lich_hoc: data.lich_hoc ? JSON.stringify(data.lich_hoc) : null,
      hoc_phi: data.hoc_phi ? JSON.stringify(data.hoc_phi) : null,
      updated_at: Date.now(),
    };
    await ScrapedData.findOneAndUpdate(
      { fb_id: fbId },
      { $set: doc },
      { upsert: true }
    );
  },

  // Clear a single scraped page field (for /testpage retry)
  async clearScrapedPage(fbId, dbKey) {
    await ensureInit();
    await ScrapedData.findOneAndUpdate(
      { fb_id: fbId },
      { $set: { [dbKey]: null, updated_at: Date.now() } }
    );
  },

  async logChange(fbId, type, content) {
    await ensureInit();
    await ChangeLog.create({ fb_id: fbId, type, content });
  },

  async getChangeLogs(fbId, limit = 20) {
    await ensureInit();
    return ChangeLog.find({ fb_id: fbId }).sort({ createdAt: -1 }).limit(limit).lean();
  },

  async getSystemSetting(key, defaultValue = "") {
    await ensureInit();
    const row = await SystemSetting.findOne({ key }).lean();
    return row ? row.value : defaultValue;
  },

  async saveSystemSetting(key, value) {
    await ensureInit();
    await SystemSetting.findOneAndUpdate(
      { key },
      { value: String(value) },
      { upsert: true }
    );
  },

  async logInteraction(fbId, action, payload) {
    await ensureInit();
    await Interaction.create({ fb_id: fbId, action, payload });
  },

  async saveRegNodes(nodes) {
    await ensureInit();
    await RegNode.deleteMany({});
    const ops = nodes.map(n => ({
      insertOne: { document: n }
    }));
    await RegNode.bulkWrite(ops);
  },

  async searchRegNodes(queryText, limit = 4, category = null) {
    await ensureInit();
    const filter = category ? { category } : {};
    let results = [];

    // 1. Search in MongoDB/Mongoose database if initialized and has records
    try {
      results = await RegNode.find(
        { ...filter, $text: { $search: queryText } },
        { score: { $meta: "textScore" } }
      ).sort({ score: { $meta: "textScore" } }).limit(limit).lean();

      if (!results.length) {
        const keywords = queryText.split(" ").filter(w => w.length > 2);
        if (keywords.length) {
          const regexes = keywords.map(w => new RegExp(w, "i"));
          results = await RegNode.find({
            ...filter,
            $or: regexes.map(r => ({ content: r }))
          }).limit(limit).lean();
        }
      }
    } catch (dbErr) {
      console.warn("[db] MongoDB searchRegNodes failed, fallback to file search:", dbErr.message);
    }

    // 2. Search fallback/supplement in local data/rag_nodes.json
    const ragPath = path.resolve(__dirname, "../data/rag_nodes.json");
    if (fs.existsSync(ragPath)) {
      try {
        const fileContent = fs.readFileSync(ragPath, "utf8");
        const nodes = JSON.parse(fileContent);
        
        // Split queries into keywords
        const keywords = queryText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        
        if (keywords.length > 0) {
          const matchedNodes = nodes.filter(n => {
            // Apply category filter if specified
            if (category && n.category !== category) return false;
            
            // Text matching score based on keyword hits in content or title
            const contentLower = (n.content || "").toLowerCase();
            const titleLower = (n.title || "").toLowerCase();
            
            let hits = 0;
            keywords.forEach(kw => {
              if (contentLower.includes(kw)) hits++;
              if (titleLower.includes(kw)) hits += 2; // Weight title match higher
            });
            
            n.temp_score = hits;
            return hits > 0;
          });

          // Sort by hits descending and take top matching nodes
          matchedNodes.sort((a, b) => b.temp_score - a.temp_score);
          const topFileNodes = matchedNodes.slice(0, limit).map(n => ({
            title: n.title,
            category: n.category,
            source_url: n.source_url,
            content: n.content
          }));

          // Merge and avoid duplicate content chunks
          const existingContents = new Set(results.map(r => r.content));
          topFileNodes.forEach(fn => {
            if (!existingContents.has(fn.content)) {
              results.push(fn);
            }
          });
        }
      } catch (fileErr) {
        console.error("[db] Failed to read/search rag_nodes.json:", fileErr.message);
      }
    }

    // Trim results to limit
    results = results.slice(0, limit);

    // 3. Fallback: if category filtered returned nothing, search all nodes without category filter
    if (!results.length && category) {
      return this.searchRegNodes(queryText, limit, null);
    }

    return results;
  },

  async getModelsData(modelName, page = 1, limit = 10) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting, Interaction, RegNode };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");

    const skip = (page - 1) * limit;
    const total = await Model.countDocuments();
    const data = await Model.find().skip(skip).limit(limit).lean();

    return { total, data, page, limit };
  },

  async getAllModelDataForExport(modelName) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting, Interaction, RegNode };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");
    return Model.find().lean();
  },

  async deleteRecord(modelName, id) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting, Interaction, RegNode, OtnToken };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");
    await Model.findByIdAndDelete(id);
  },

  // ---------- OTN Token Helpers ----------
  async saveOtnToken(fbId, token, topic) {
    await ensureInit();
    await OtnToken.findOneAndUpdate(
      { token },
      { fb_id: fbId, token, topic },
      { upsert: true }
    );
  },

  async getAndConsumeOtnToken(fbId, topic) {
    await ensureInit();
    // Try to find a token specifically for this topic first, otherwise fall back to any topic
    let doc = await OtnToken.findOne({ fb_id: fbId, topic }).sort({ createdAt: 1 });
    if (!doc) {
      doc = await OtnToken.findOne({ fb_id: fbId }).sort({ createdAt: 1 });
    }
    if (doc) {
      await OtnToken.deleteOne({ _id: doc._id });
      return doc.token;
    }
    return null;
  },

  async getOtnTokenCount(fbId) {
    await ensureInit();
    return OtnToken.countDocuments({ fb_id: fbId });
  },

  // ---------- Conversation History ----------
  async saveConversation(fbId, role, content) {
    await ensureInit();
    await Conversation.create({ fb_id: fbId, role, content });
    // Keep only last 10 entries (5 pairs) per user
    const count = await Conversation.countDocuments({ fb_id: fbId });
    if (count > 10) {
      const oldest = await Conversation.find({ fb_id: fbId })
        .sort({ createdAt: 1 })
        .limit(count - 10)
        .select("_id")
        .lean();
      await Conversation.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
    }
  },

  async getConversationHistory(fbId, limit = 6) {
    await ensureInit();
    return Conversation.find({ fb_id: fbId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("role content -_id")
      .lean();
  },
};
