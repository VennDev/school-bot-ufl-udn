const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/school-bot";

let connected = false;

async function connect() {
  if (connected) return;
  await mongoose.connect(MONGO_URI);
  connected = true;
  console.log("[db] MongoDB connected");
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

// ---------- Models ----------

let User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting;

function initModels() {
  User = mongoose.model("User", userSchema);
  Settings = mongoose.model("Settings", settingsSchema);
  ScrapedData = mongoose.model("ScrapedData", scrapedDataSchema);
  ChangeLog = mongoose.model("ChangeLog", changeLogSchema);
  StudyGoal = mongoose.model("StudyGoal", studyGoalSchema);
  StudySession = mongoose.model("StudySession", studySessionSchema);
  SystemSetting = mongoose.model("SystemSetting", systemSettingSchema);
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

  async getModelsData(modelName, page = 1, limit = 10) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");

    const skip = (page - 1) * limit;
    const total = await Model.countDocuments();
    const data = await Model.find().skip(skip).limit(limit).lean();

    return { total, data, page, limit };
  },

  async getAllModelDataForExport(modelName) {
    await ensureInit();
    const models = { User, Settings, ScrapedData, ChangeLog, StudyGoal, StudySession, SystemSetting };
    const Model = models[modelName];
    if (!Model) throw new Error("Model not found");
    return Model.find().lean();
  }
};
