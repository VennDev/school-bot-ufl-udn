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
  chuyen_nganh_chinh: String,
  chuyen_nganh_2: String,
  so_sanh_chuyen_nganh: String,
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
  chunk_id: { type: String, index: true },
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

function rankConversionNodes(queryText, nodeList) {
  const q = (queryText || "").toLowerCase();
  const hasSuPham = /sư phạm/i.test(q);

  const facultyWeights = [
    { pattern: /sư phạm\s*(?:tiếng\s*)?anh|ngành sư phạm anh|khoa sư phạm|sư phạm/i, target: /Khoa Sư phạm Ngoại ngữ/i, weight: 35 },
    { pattern: /tiếng anh chuyên ngành|chuyên ngành/i, target: /Khoa tiếng Anh chuyên ngành/i, weight: 35 },
    { pattern: /quốc tế học/i, target: /Khoa Quốc tế học/i, weight: 35 },
    { pattern: /khoa tiếng anh|ngành ngôn ngữ anh|ngôn ngữ anh/i, target: /Khoa tiếng Anh\b/i, weight: 30 },
    { pattern: /tiếng pháp|ngôn ngữ pháp|pháp/i, target: /Khoa tiếng Pháp/i, weight: 25 },
    { pattern: /tiếng trung|trung quốc|ngôn ngữ trung/i, target: /Khoa tiếng Trung Quốc/i, weight: 25 },
    { pattern: /tiếng nhật|nhật bản|ngôn ngữ nhật/i, target: /Khoa Ngôn ngữ và Văn hóa Nhật Bản/i, weight: 25 },
    { pattern: /tiếng hàn|hàn quốc|ngôn ngữ hàn/i, target: /Khoa Ngôn ngữ và Văn hóa Hàn Quốc/i, weight: 25 },
    { pattern: /ngoại ngữ 2|nn2|ngoại ngữ ii/i, target: /Ngoại ngữ 2|Ngoại ngữ II/i, weight: 25 },
  ];

  const certWeights = [
    { pattern: /ielts|toefl|toeic|cambridge/i, target: hasSuPham ? /Khoa Sư phạm Ngoại ngữ/i : /Khoa tiếng Anh\b|Khoa tiếng Anh chuyên ngành/i, weight: 15 },
    { pattern: /delf|dalf|tcf/i, target: hasSuPham ? /Khoa Sư phạm Ngoại ngữ/i : /Khoa tiếng Pháp/i, weight: 20 },
    { pattern: /hskk?|tocfl/i, target: hasSuPham ? /Khoa Sư phạm Ngoại ngữ/i : /Khoa tiếng Trung Quốc/i, weight: 20 },
    { pattern: /jlpt|nat-?test/i, target: /Khoa Ngôn ngữ và Văn hóa Nhật Bản/i, weight: 25 },
    { pattern: /topik/i, target: /Khoa Ngôn ngữ và Văn hóa Hàn Quốc/i, weight: 25 },
  ];

  const stopWords = new Set(["cho", "cua", "được", "duoc", "bao", "nhiêu", "nhieu", "nào", "nao", "gì", "gi", "là", "la", "thì", "thi", "và", "va", "có", "co", "không", "khong", "tôi", "toi", "mình", "minh", "với", "voi", "như", "nhu", "thế", "the", "bằng", "các"]);
  const words = q.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));

  return nodeList.map(n => {
    let score = 0;
    const title = n.title || "";
    const content = n.content || "";
    const titleLower = title.toLowerCase();
    const contentLower = content.toLowerCase();

    for (const fw of facultyWeights) {
      if (fw.pattern.test(q) && fw.target.test(title)) {
        score += fw.weight;
      }
    }

    for (const cw of certWeights) {
      if (cw.pattern.test(q) && cw.target.test(title)) {
        score += cw.weight;
      }
    }

    for (const w of words) {
      if (titleLower.includes(w)) score += 5;
      if (contentLower.includes(w)) score += 1;
    }

    if (/Khoản \d+/i.test(title)) score += 3;

    return { node: n, score };
  }).sort((a, b) => b.score - a.score).map(r => r.node);
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
      chuyen_nganh_chinh: data.chuyen_nganh_chinh ? JSON.stringify(data.chuyen_nganh_chinh) : null,
      chuyen_nganh_2: data.chuyen_nganh_2 ? JSON.stringify(data.chuyen_nganh_2) : null,
      so_sanh_chuyen_nganh: data.so_sanh_chuyen_nganh ? JSON.stringify(data.so_sanh_chuyen_nganh) : null,
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

  async getChangeLogs(fbId, limit = 20, type = null) {
    await ensureInit();
    const filter = { fb_id: fbId };
    if (type) filter.type = type;
    return ChangeLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
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

    // Mirror to file fallback so searchRegNodes works even without MongoDB.
    try {
      const dataDir = path.resolve(__dirname, "../data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "rag_nodes.json"),
        JSON.stringify(nodes, null, 2),
        "utf8"
      );
      console.log(`[db] Wrote ${nodes.length} nodes to data/rag_nodes.json fallback.`);
    } catch (err) {
      console.warn("[db] Failed to write rag_nodes.json fallback:", err.message);
    }
  },

  async searchRegNodes(queryText, limit = 4, category = null) {
    await ensureInit();

    // Normalize common abbreviations
    const normalizedQuery = queryText
      .replace(/\bcdr\b/gi, "chuẩn đầu ra")
      .replace(/\bnn\b/gi, "ngoại ngữ")
      .replace(/\bdrl\b/gi, "điểm rèn luyện")
      // Tách mức chứng chỉ dính liền: "hsk5" -> "hsk 5", "ielts5.5" -> "ielts 5.5"
      .replace(/\b(hsk|hskk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|vstep)\s*(\d)/gi, "$1 $2");

    const isCertConversion = category === "certificate_conversion" ||
      /(?:quy đổi|miễn học|miễn thi).*?(?:chứng chỉ|hsk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|cambridge)|(?:chứng chỉ|hsk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|cambridge).*?(?:quy đổi|miễn học|miễn thi)/i.test(normalizedQuery) ||
      /quyết định\s*(?:số\s*)?1221|qđ\s*1221/i.test(normalizedQuery);

    if (isCertConversion) {
      try {
        const convNodes = await RegNode.find({ category: "certificate_conversion" }).lean();
        if (convNodes.length > 0) {
          const ranked = rankConversionNodes(normalizedQuery, convNodes).slice(0, limit);
          if (ranked.length > 0) return ranked;
        }
      } catch (err) {
        console.warn("[db] MongoDB conversion query failed:", err.message);
      }
      const ragPath = path.resolve(__dirname, "../data/rag_nodes.json");
      if (fs.existsSync(ragPath)) {
        try {
          const allNodes = JSON.parse(fs.readFileSync(ragPath, "utf8"));
          const convNodes = allNodes.filter(n => n.category === "certificate_conversion");
          if (convNodes.length > 0) {
            return rankConversionNodes(normalizedQuery, convNodes).slice(0, limit);
          }
        } catch (fErr) {
          console.error("[db] rag_nodes.json read failed:", fErr.message);
        }
      }
    }

    const filter = category ? { category } : {};
    let results = [];

    // 1. Search in MongoDB/Mongoose database if initialized and has records
    try {

      // Direct exact matches for official documents (công văn/quyết định/thông báo số ...) or appendices (phụ lục ...)
      const docMatch = queryText.match(/(?:công văn|quyết định|thông báo)\s*(?:số)?\s*([0-9]+\/[a-zđ\-]+)/i)
        || queryText.match(/\b(?:qđ|qd)[\s-]*(\d{3,4})\b/i);
      const appendixMatch = queryText.match(/phụ lục\s*([ivx0-9]+(?:\.[0-9]+)?)/i);
      const certMatch = normalizedQuery.match(/\b(hskk|hsk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|vstep)\b/i)
        || normalizedQuery.match(/\b(?:chứng chỉ|quy đổi|miễn học|miễn thi)\b/i);
      const isCdrQuery = /chuẩn đầu ra\s*(?:ngoại ngữ|tin học)?/i.test(normalizedQuery);
      const langMatch = normalizedQuery.match(/\b(pháp|nhật|trung|hàn|nga|anh|thái)\b/i);

      // Certificate conversion queries (QD 1221 / quy đổi điểm chứng chỉ quốc tế)
      const certLangMap = {
        "anh": /IELTS|TOEIC|TOEFL|Cambridge|tiếng Anh/i,
        "pháp": /DELF|DALF|TCF|tiếng Pháp/i,
        "trung": /HSK|HSKK|TOCFL|tiếng Trung/i,
        "nhật": /JLPT|NAT-?Test|tiếng Nhật/i,
        "hàn": /TOPIK|tiếng Hàn/i,
        "nga": /ТРКИ|ТБУ|ТЭУ|tiếng Nga/i,
        "thái": /tiếng Thái/i,
      };
      const certNameMatch = normalizedQuery.match(/\b(hskk|hsk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|vstep)\b/i);

      if (docMatch) {
        const escaped = docMatch[1].replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        const docNodes = await RegNode.find({ content: { $regex: new RegExp(escaped, "i") } }).limit(limit).lean();
        if (docNodes.length) results = docNodes;
      } else if (appendixMatch) {
        const escaped = appendixMatch[1].replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        const appNodes = await RegNode.find({ content: { $regex: new RegExp(`PHỤ\\s+LỤC\\s+${escaped}`, "i") } }).limit(limit).lean();
        if (appNodes.length) results = appNodes;
      } else if (certNameMatch) {
        // Cụ thể theo tên chứng chỉ (HSK 5, IELTS 5.5, TOPIK II, JLPT N3...):
        // ưu tiên node quy đổi điểm (QĐ 1221) trước, sau đó mới tới các node khác.
        const certRegex = new RegExp(certNameMatch[1].replace(/[.\-]/g, "[.\\-]?"), "i");
        const rankCert = n => {
          const content = n.content || "";
          const mentions = (content.match(new RegExp(certRegex.source, "gi")) || []).length;
          const conversionBonus = /quy đổi điểm|miễn học|miễn thi/i.test(content) ? 4 : 0;
          const tableBonus = /(\d+\s*[-–~]\s*\d+|\d+\/\d+)/.test(content) ? 2 : 0;
          const categoryBonus = n.category === "certificate_conversion" ? 6 : 0;
          return mentions + conversionBonus + tableBonus + categoryBonus;
        };
        // Ưu tiên tìm trong category quy đổi điểm trước (QĐ 1221 + phụ lục quy đổi).
        const certInCategory = await RegNode.find({
          category: "certificate_conversion",
          content: { $regex: certRegex }
        }).limit(40).lean();
        let certNodes = certInCategory;
        if (certNodes.length < limit) {
          const more = await RegNode.find({ content: { $regex: certRegex } }).limit(60).lean();
          const seen = new Set(certNodes.map(n => n._id?.toString()));
          for (const n of more) {
            if (!seen.has(n._id?.toString())) certNodes.push(n);
          }
        }
        const ranked = certNodes.sort((a, b) => rankCert(b) - rankCert(a));
        if (ranked.length) results = ranked.slice(0, limit);
      } else if (certMatch && langMatch) {
        // Ví dụ: "quy đổi điểm chứng chỉ tiếng Hàn"
        const langRegex = certLangMap[langMatch[1].toLowerCase()] || new RegExp(langMatch[1], "i");
        const langNodes = await RegNode.find({
          content: { $regex: langRegex }
        }).limit(limit).lean();
        if (langNodes.length) results = langNodes;
      } else if (isCdrQuery && langMatch) {
        // Query asks for certificates / CĐR for a specific language (e.g. "tên các chứng chỉ cho cdr pháp / nhật / trung")
        const lang = langMatch[1].toLowerCase();
        const langMap = {
          "pháp": /2\.\s*Tiếng Pháp|DELF|TCF/i,
          "nhật": /JLPT|NAT-TEST|J[\.-]TEST|tiếng Nhật/i,
          "trung": /HSK|TOCFL|tiếng Trung/i,
          "hàn": /TOPIK|tiếng Hàn/i,
          "nga": /ТРКИ|ТБУ|ТЭУ|tiếng Nga/i,
          "anh": /TOEIC|IELTS|TOEFL|VSTEP|tiếng Anh/i,
        };
        const langRegex = langMap[lang] || new RegExp(lang, "i");
        // Look in category vstep for conversion tables (Phụ lục II.1, II.2, II.3, II.4)
        const langNodes = await RegNode.find({
          category: "vstep",
          content: { $regex: langRegex }
        }).limit(limit).lean();
        if (langNodes.length) results = langNodes;
      } else if (isCdrQuery) {
        // Specifically look for Phụ lục I.1 (2021 trở về trước) or I.2 (2022 trở về sau) or general CĐR tables
        const wants2021OrOlder = /2021|2020|2019|trước/i.test(normalizedQuery);
        const targetAppendix = wants2021OrOlder ? /PHỤ LỤC I\.1/i : /PHỤ LỤC I\.2/i;
        const cdrNodes = await RegNode.find({ content: { $regex: targetAppendix } }).limit(2).lean();
        // Also include the other appendix or general CĐR rules for completeness
        const otherAppendix = wants2021OrOlder ? /PHỤ LỤC I\.2/i : /PHỤ LỤC I\.1/i;
        const moreCdr = await RegNode.find({ content: { $regex: otherAppendix } }).limit(2).lean();
        const combined = [...cdrNodes, ...moreCdr];
        if (combined.length) results = combined.slice(0, limit);
      }

      const isDrlSearch = !results.length && /rèn luyện|ý thức công dân|điều 7|điều 4|điều 5|điều 6|điều 8/i.test(queryText);
      if (isDrlSearch) {
        // Query directly for criteria nodes
        results = await RegNode.find({
          content: { $regex: /(?:Khung điểm đánh giá kết quả rèn luyện|Điều [4-8]\. Đánh giá về)/i }
        }).limit(limit).lean();
      }

      if (!results.length) {
        results = await RegNode.find(
          { ...filter, $text: { $search: queryText } },
          { score: { $meta: "textScore" } }
        ).sort({ score: { $meta: "textScore" } }).limit(limit).lean();
      }

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

        // Normalize text and extract phrases/expansions for precision scoring
        const normalize = (str) => String(str || "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[đĐ]/g, "d")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

        const queryNorm = normalize(normalizedQuery);
        const stopWords = new Set([
          "cho", "cua", "duoc", "bao", "nhieu", "nao", "gi", "la",
          "va", "co", "khong", "toi", "minh", "voi", "nhu", "the",
          "nhung", "cac", "mot", "trong", "tai", "khi", "de", "hay",
          "neu", "se", "ra", "ve", "o"
        ]);
        const keywords = queryNorm.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));

        // Multi-word phrases
        const rawTokens = queryNorm.split(/\s+/).filter(w => w.length >= 2);
        const phrases = [];
        for (let i = 0; i < rawTokens.length - 1; i++) {
          phrases.push(`${rawTokens[i]} ${rawTokens[i + 1]}`);
        }
        for (let i = 0; i < rawTokens.length - 2; i++) {
          phrases.push(`${rawTokens[i]} ${rawTokens[i + 1]} ${rawTokens[i + 2]}`);
        }

        // Domain synonym expansions
        const expansions = [];
        if (queryNorm.includes("ket thuc hoc phan")) expansions.push("kthp");
        if (queryNorm.includes("kthp")) expansions.push("ket thuc hoc phan");
        if (queryNorm.includes("chuan dau ra")) expansions.push("cdr");
        if (queryNorm.includes("diem ren luyen")) expansions.push("drl");
        if (queryNorm.includes("hoc bong")) expansions.push("hbkkht", "khuyen khich hoc tap");
        if (queryNorm.includes("on thi")) expansions.push("on thi kthp", "thoi gian danh cho on thi");
        if (queryNorm.includes("hoan thi")) expansions.push("diem i", "xin hoan thi");
        if (queryNorm.includes("canh bao")) expansions.push("canh bao hoc tap", "buoc thoi hoc", "xu ly ket qua hoc tap");
        if (queryNorm.includes("no bao nhieu tin chi") || queryNorm.includes("no tin chi")) expansions.push("no dong", "no dong vuot qua 24");
        if (queryNorm.includes("binh thuong")) expansions.push("hang binh thuong", "thang diem 4,0");
        if (queryNorm.includes("khoa luan")) expansions.push("khoa luan tot nghiep", "hoc phan chuyen mon");
        if (queryNorm.includes("thuc tap")) expansions.push("thuc tap tot nghiep");
        if (queryNorm.includes("chuyen doi tin chi") || queryNorm.includes("cong nhan")) expansions.push("chuyen doi sang tin chi", "khoi luong toi da");
        if (queryNorm.includes("co ten") || queryNorm.includes("danh sach")) expansions.push("danh sach thi", "co ten trong danh sach");

        // Number words & student years
        if (queryNorm.includes("nam hai")) expansions.push("nam thu hai", "trinh do nam thu hai");
        if (queryNorm.includes("nam nhat")) expansions.push("nam thu nhat", "trinh do nam thu nhat");
        if (queryNorm.includes("nam ba")) expansions.push("nam thu ba", "trinh do nam thu ba");
        if (queryNorm.includes("gpa")) expansions.push("diem trung binh", "diem trung binh tich luy");
        if (queryNorm.includes("dong hoc phi") || queryNorm.includes("chua the dong")) expansions.push("nop hoc phi", "hoan thanh hoc phi", "gia han thoi gian nop hoc phi");

        const certNameMatch = normalizedQuery.match(/\b(hskk|hsk|tocfl|topik|jlpt|nat-?test|delf|dalf|tcf|ielts|toeic|toefl|vstep)\b/i);
        const numbersInQuery = queryNorm.match(/\b(?:\d+[\/.,]\d+|\d+)\b/g) || [];

        if (keywords.length > 0) {
          const matchedNodes = nodes.filter(n => {
            if (category && n.category !== category) return false;

            const contentLower = normalize(n.content || "");
            const titleLower = normalize(n.title || "");

            let hits = 0;
            // 1. Phrase hits
            phrases.forEach(p => {
              if (contentLower.includes(p)) hits += 4;
              if (titleLower.includes(p)) hits += 8;
            });
            // 2. Expansion hits
            expansions.forEach(exp => {
              if (contentLower.includes(exp)) hits += 6;
              if (titleLower.includes(exp)) hits += 10;
            });
            // 3. Keyword hits
            keywords.forEach(kw => {
              if (contentLower.includes(kw)) hits += 1;
              if (titleLower.includes(kw)) hits += 3;
            });
            // 4. Number / threshold match
            numbersInQuery.forEach(num => {
              if (contentLower.includes(num)) hits += 3;
            });

            // Ưu tiên node quy đổi điểm chứng chỉ (QĐ 1221) khi hỏi về chứng chỉ
            if (certNameMatch && hits > 0) {
              const certMentions = (contentLower.match(new RegExp(certNameMatch[1], "g")) || []).length;
              if (certMentions > 0 || titleLower.includes(certNameMatch[1])) {
                hits += Math.min(certMentions, 12) * 2;
                if (n.category === "certificate_conversion") hits += 6;
                if (/quy doi diem|mien hoc|mien thi/i.test(contentLower)) hits += 3;
              }
            }

            n.temp_score = hits;
            return hits > 0;
          });

          // Sort by hits descending and take top matching nodes
          matchedNodes.sort((a, b) => b.temp_score - a.temp_score);
          const topFileNodes = matchedNodes.slice(0, limit).map(n => ({
            chunk_id: n.chunk_id,
            title: n.title,
            category: n.category,
            source_url: n.source_url,
            content: n.content,
            start_page: n.start_page,
            end_page: n.end_page
          }));

          // Merge and avoid duplicate content chunks
          const existingKeys = new Set(results.map(r => r.chunk_id || r.content));
          topFileNodes.forEach(fn => {
            const key = fn.chunk_id || fn.content;
            if (!existingKeys.has(key)) {
              results.push(fn);
              existingKeys.add(key);
            }
          });
        }
      } catch (fileErr) {
        console.error("[db] Failed to read/search rag_nodes.json:", fileErr.message);
      }
    }

    // Trim results to limit
    results = results.slice(0, limit);

    // 3. Fallback: if category filter returned fewer than 2 results, search all nodes without category filter
    if (results.length < 2 && category) {
      const fallbackResults = await this.searchRegNodes(queryText, limit, null);
      const seen = new Set(results.map(r => r.chunk_id || r.content));
      for (const fr of fallbackResults) {
        if (!seen.has(fr.chunk_id || fr.content)) {
          results.push(fr);
          seen.add(fr.chunk_id || fr.content);
        }
      }
      results = results.slice(0, limit);
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

  async deleteAllRecords(modelName) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting, Interaction, RegNode, OtnToken };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");
    await Model.deleteMany({});
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
    const normalizedContent = typeof content === "string" ? content.trim() : String(content ?? "").trim();
    if (!fbId || !["user", "assistant"].includes(role) || !normalizedContent) return false;
    await ensureInit();
    await Conversation.create({ fb_id: fbId, role, content: normalizedContent });
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

  // Aggregate usage stats from Interaction + ChangeLog for the last N days or a date range.
  // Returns daily buckets: { date, messages, activeUsers, syncs, alerts }.
  async getUsageStats(days = 30, fromDate = null, toDate = null) {
    await ensureInit();
    let since, until;
    if (fromDate && toDate) {
      since = new Date(fromDate);
      since.setHours(0, 0, 0, 0);
      until = new Date(toDate);
      until.setHours(23, 59, 59, 999);
    } else {
      since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
      until = null;
    }
    const matchFilter = { createdAt: { $gte: since } };
    if (until) matchFilter.createdAt.$lte = until;

    // Messages + unique users + syncs per day (from Interaction)
    const interactionPipeline = [
      { $match: matchFilter },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          messages: { $sum: 1 },
          uniqueUsers: { $addToSet: "$fb_id" },
          syncs: { $sum: { $cond: [{ $or: [
            { $eq: ["$action", "sync"] },
            { $regexMatch: { input: "$payload", regex: /^(?:\/sync|SYNC_POSTBACK|sync_postback)$/i } },
          ] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ];
    const interactionRows = await Interaction.aggregate(interactionPipeline);

    // Alerts per day (from ChangeLog)
    const alertPipeline = [
      { $match: Object.assign({ type: "alert" }, matchFilter) },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          alerts: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ];
    const alertRows = await ChangeLog.aggregate(alertPipeline);

    // Merge into daily buckets
    const alertMap = new Map(alertRows.map(r => [r._id, r.alerts]));
    const stats = interactionRows.map(r => ({
      date: r._id,
      messages: r.messages,
      activeUsers: r.uniqueUsers.length,
      syncs: r.syncs,
      alerts: alertMap.get(r._id) || 0,
    }));

    // Fill in alert-only days that had zero interactions
    for (const [date, alerts] of alertMap) {
      if (!stats.some(s => s.date === date)) {
        stats.push({ date, messages: 0, activeUsers: 0, syncs: 0, alerts });
      }
    }
    stats.sort((a, b) => a.date.localeCompare(b.date));

    return stats;
  },
};
