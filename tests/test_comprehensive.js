const assert = require("assert");
const { detectGrades, checkAndNotify } = require("../src/changeDetector");

console.log("=== KIỂM TRA TOÀN DIỆN CÁC LỖI TIỀM ẨN TRONG BÁO ĐIỂM ===");

// Dữ liệu chuẩn ban đầu
const baseOldData = {
  ketQuaHocTap: [
    {
      headers: ["STT", "Mã ký hiệu", "Tên học phần", "Tín chỉ", "Lớp", "Điểm thi", "Điểm TBCHP", "Điểm chữ", "Đạt"],
      rows: [
        ["1", "KH01", "Triết học Mác-Lênin", "3", "L01", "7.0", "7.5", "B", "Đạt"]
      ]
    }
  ]
};

// Dữ liệu có điểm mới môn thứ 2
const baseNewData = {
  ketQuaHocTap: [
    {
      headers: ["STT", "Mã ký hiệu", "Tên học phần", "Tín chỉ", "Lớp", "Điểm thi", "Điểm TBCHP", "Điểm chữ", "Đạt"],
      rows: [
        ["1", "KH01", "Triết học Mác-Lênin", "3", "L01", "7.0", "7.5", "B", "Đạt"],
        ["2", "KH02", "Tư tưởng Hồ Chí Minh", "2", "L02", "8.5", "8.8", "A", "Đạt"]
      ]
    }
  ]
};

// Mock Messenger & Mailer để đo xem tin nhắn có thực sự được phát đi không
let messageSent = [];
const mockMessenger = require("../src/messenger");
mockMessenger.sendUtilityMessage = async (fbId, templateKey, params) => {
  messageSent.push({ fbId, templateKey, params });
  return { message_id: "mock_mid_123" };
};

(async () => {
  // --- TEST 1: Khi user TẮT `notify_gpa` ---
  console.log("\n[TEST 1] User tắt cài đặt notify_gpa:");
  messageSent = [];
  await checkAndNotify("user_01", baseOldData, baseNewData, { notify_gpa: 0 });
  console.log("-> Số tin nhắn đã phát:", messageSent.length);
  assert.strictEqual(messageSent.length, 0, "Khi notify_gpa = 0 thì không được gửi tin");

  // --- TEST 2: Khi user BẬT `notify_gpa` ---
  console.log("\n[TEST 2] User bật cài đặt notify_gpa:");
  messageSent = [];
  await checkAndNotify("user_01", baseOldData, baseNewData, { notify_gpa: 1 });
  console.log("-> Tin nhắn phát đi:", messageSent);
  assert.strictEqual(messageSent.length, 1, "Phải phát đi 1 tin nhắn khi có điểm mới");
  assert.ok(messageSent[0].params[0].includes("Tư tưởng Hồ Chí Minh"), "Tin nhắn phải chứa tên môn mới");

  // --- TEST 3: Lần đầu quét dữ liệu (oldRaw bị null/rỗng do chưa có cache) ---
  console.log("\n[TEST 3] Lần đầu sync dữ liệu (oldRaw = null/empty):");
  messageSent = [];
  await checkAndNotify("user_01", { ketQuaHocTap: null }, baseNewData, { notify_gpa: 1 });
  console.log("-> Số tin nhắn đã phát:", messageSent.length);
  assert.strictEqual(messageSent.length, 0, "Lần đầu sync phải bị chặn (tránh spam toàn bộ điểm quá khứ)");

  // --- TEST 4: Web trường trả về Mã ký hiệu rỗng/trùng (r[1] bị rỗng) ---
  console.log("\n[TEST 4] Web trường trả về Mã ký hiệu (r[1]) bị rỗng hoặc không cố định:");
  const badKeyOldData = [
    {
      headers: ["STT", "Mã ký hiệu", "Tên học phần"],
      rows: [["1", "", "Triết học Mác-Lênin", "", "", "", "7.5", "B"]]
    }
  ];
  const badKeyNewData = [
    {
      headers: ["STT", "Mã ký hiệu", "Tên học phần"],
      rows: [
        ["1", "", "Triết học Mác-Lênin", "", "", "", "7.5", "B"],
        ["2", "", "Tư tưởng Hồ Chí Minh", "", "", "", "8.8", "A"]
      ]
    }
  ];
  const alertsBadKey = detectGrades(badKeyOldData, badKeyNewData);
  console.log("-> Kết quả detectGrades khi Mã ký hiệu rỗng:", alertsBadKey);
  // Vì r[1] rỗng "" nên Map chỉ giữ được 1 item key "", dẫn đến nhận diện sai!

  console.log("\n=======================================================");
  console.log("TỔNG HỢP NGUYÊN NHÂN CHÍNH KHẾN BOT KHÔNG BÁO ĐIỂM TRÊN WEB:");
  console.log("1. CÀI ĐẶT: User đang để `notify_gpa: 0` -> Bot bỏ qua hoàn toàn.");
  console.log("2. FIRST SYNC: Lần đầu quét DB trống `oldRaw = null` -> Bot cố ý bỏ qua để tránh spam.");
  console.log("3. WEB HTML: Web trường trả về `r[1]` (Mã ký hiệu) bị rỗng hoặc đổi tiêu đề cột bảng điểm.");
  console.log("=======================================================");
})();
