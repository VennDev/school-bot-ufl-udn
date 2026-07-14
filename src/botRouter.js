const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { askAI } = require("./ai");
const { exec } = require("child_process");
const path = require("path");

// Memory map for login sessions
const loginSessions = new Map();

// Get base URL for Webview from request
let appBaseUrl = "http://localhost:3000";

function setBaseUrl(url) {
  appBaseUrl = url;
}

function formatCanhBao(data) {
  if (!data || !data.length) return "Không có cảnh báo học vụ mới nào.";
  let txt = "[!] THÔNG BÁO HỌC VỤ MỚI NHẤT:\n";
  data.slice(0, 3).forEach((item, idx) => {
    txt += `\n${idx + 1}. ${item.content || JSON.stringify(item)}`;
  });
  return txt;
}

function formatKetQuaHocTap(data) {
  if (!data || !data.length) return "Chưa có dữ liệu điểm học tập.";
  // Search for the table containing STT, Ten hoc phan, TBCHP, Diem chu
  const targetTable = data.find((t) => t.headers && t.headers.includes("Tên học phần"));
  if (!targetTable) return "Chưa cập nhật bảng điểm chính.";

  let txt = "[=] ĐIỂM SỐ GẦN ĐÂY:\n";
  const rows = targetTable.rows || [];
  rows.slice(0, 5).forEach((r) => {
    // headers: STT, Ky hieu, Ten hoc phan, So tin chi, Diem thanh phan, Diem thi, TBCHP, Diem so, Diem chu
    txt += `\n- ${r[2]}: ${r[6]} (${r[8]})`;
  });
  return txt;
}

function formatLichThi(data) {
  if (!data || !data.length || data.length < 2) return "Không có lịch thi sắp tới.";
  let txt = "[~] LỊCH THI SẮP TỚI:\n";
  data.slice(1, 5).forEach((r) => {
    // STT, Ma hoc phan, Ten hoc phan, Ngay thi, Ca thi, Gio thi, Lan thi, Dot thi, SBD, Phong thi, Hinh thuc
    txt += `\n- Môn: ${r[2]}\n  Ngày: ${r[3]} (${r[5]})\n  Phòng: ${r[9]} - HT: ${r[10]}\n`;
  });
  return txt;
}

function formatHocPhi(data) {
  if (!data || !data.length) return "Chưa có dữ liệu học phí.";
  let txt = "[$] TÀI CHÍNH & HỌC PHÍ:\n";
  data.forEach((t) => {
    if (t.rows) {
      t.rows.forEach((r) => {
        if (r.some(cell => cell.includes("Học phí") || cell.includes("Số tiền") || cell.includes("Nợ"))) {
          txt += `\n- ${r.join(" | ")}`;
        }
      });
    }
  });
  return txt.length > 30 ? txt : "Không có công nợ học phí.";
}

function formatThongTinSV(data) {
  if (!data) return "Chưa có dữ liệu hồ sơ sinh viên.";
  let txt = "[i] THÔNG TIN HỒ SƠ SINH VIÊN:\n";
  // data is parsed object from thong_tin_sv JSON (typically key-value details)
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "string") {
      txt += `\n- ${k}: ${v}`;
    }
  }
  return txt;
}

function formatLichHoc(data, dayFilter) {
  if (!data || !data.length) return "Không có lịch học nào sắp tới.";
  const targetTable = data.find((t) => t.headers && t.headers.includes("Tên học phần"));
  if (!targetTable) return "Chưa cập nhật bảng lịch học chính thức.";

  const rows = targetTable.rows || [];
  let filtered = rows;
  if (dayFilter) {
    const dayMap = {
      "2": "thứ 2", "3": "thứ 3", "4": "thứ 4", "5": "thứ 5", "6": "thứ 6", "7": "thứ 7", "cn": "chủ nhật",
      "thu2": "thứ 2", "thu3": "thứ 3", "thu4": "thứ 4", "thu5": "thứ 5", "thu6": "thứ 6", "thu7": "thứ 7",
    };
    const targetDay = dayMap[dayFilter] || dayFilter;
    filtered = rows.filter((r) => {
      const thu = (r[0] || "").toLowerCase();
      return thu.includes(targetDay) || thu === targetDay;
    });
  }

  let txt = dayFilter
    ? `[~] LỊCH HỌC ${dayFilter.toUpperCase()}:\n`
    : "[~] LỊCH HỌC TUẦN NÀY:\n";

  if (!filtered.length) return txt + "Không có tiết học nào.";

  filtered.slice(0, 7).forEach((r) => {
    txt += `\n- ${r[0] || ""} | Tiết ${r[1]} | ${r[2] || "Môn học"} | Phòng ${r[3]} | ${r[4] || ""}`;
  });
  return txt;
}

function formatTienDo(data) {
  if (!data || !data.length) return "Chưa có dữ liệu điểm để tính tiến độ.";
  const targetTable = data.find((t) => t.headers && t.headers.includes("Tên học phần"));
  if (!targetTable) return "Chưa cập nhật bảng điểm.";

  const rows = targetTable.rows || [];
  const earned = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return grade && !["f", "chưa đạt"].includes(grade) && r[6] !== "0";
  });
  const totalCredits = earned.reduce((sum, r) => sum + (parseFloat(r[3]) || 0), 0);
  const remaining = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return !grade || grade === "f" || grade === "chưa đạt" || r[6] === "0";
  });
  const remainingCredits = remaining.reduce((sum, r) => sum + (parseFloat(r[3]) || 0), 0);
  const gpaAvg = earned.length
    ? (earned.reduce((sum, r) => sum + (parseFloat(r[6]) || 0), 0) / earned.length).toFixed(2)
    : "N/A";

  let txt = "[^] TIẾN ĐỘ HỌC TẬP:\n";
  txt += `\n[=] GPA trung bình: ${gpaAvg}`;
  txt += `\n[OK] Đã hoàn thành: ${earned.length} môn (${totalCredits} tín chỉ)`;
  txt += `\n(~) Còn lại: ${remaining.length} môn (${remainingCredits} tín chỉ)`;

  if (remaining.length > 0) {
    txt += "\n\n[#] Môn chưa hoàn thành:\n";
    remaining.slice(0, 5).forEach((r) => {
      txt += `\n- ${r[2]} (${r[3]} tín chỉ): ${r[6] || "Chưa có điểm"}`;
    });
  }
  return txt;
}

async function handleMessage(senderPsid, messageText) {
  const user = await db.getUser(senderPsid);
  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  console.log(`[botRouter] Received message from "${senderPsid}": "${text}"`);
  console.log(`[botRouter] Database user check: ${user ? `Found user "${user.username}"` : "User not found"}`);

  // Handle Logout command
  if (lowerText === "/logout") {
    console.log(`[botRouter] Processing /logout command for "${senderPsid}"`);
    if (user) {
      await db.deleteUser(senderPsid);
      loginSessions.delete(senderPsid);
      return messenger.sendTextMessage(senderPsid, "Đã ngắt kết nối tài khoản sinh viên thành công.");
    }
    return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản nào.");
  }

  // Handle Login command
  if (lowerText === "/login") {
    console.log(`[botRouter] Processing /login command for "${senderPsid}"`);
    if (user) {
      const dataExist = await db.getScrapedData(senderPsid);
      if (dataExist) {
        return messenger.sendTextMessage(senderPsid, `Bạn hiện đã đăng nhập với tài khoản sinh viên *${user.username}* và dữ liệu đã được đồng bộ.`);
      }
      return messenger.sendTextMessage(senderPsid, `Bạn hiện đã đăng nhập với tài khoản *${user.username}*. Đang chờ đồng bộ dữ liệu hoặc bạn có thể gõ "cài đặt" để cấu hình.`);
    }
    loginSessions.set(senderPsid, { step: "AWAITING_USERNAME" });
    return messenger.sendTextMessage(senderPsid, "Vui lòng nhập Mã sinh viên của bạn để kết nối UFL Productivity Hub:");
  }

  // Handle User Settings
  if (lowerText === "/settings" || lowerText === "cài đặt") {
    console.log(`[botRouter] Processing settings view for "${senderPsid}"`);
    const s = await db.getSettings(senderPsid);
    const textStatus = `[*] CÀI ĐẶT THÔNG BÁO CỦA BẠN:\n
- GPA: ${s.notify_gpa ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle gpa)
- Lịch học: ${s.notify_schedule ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle lich)
- Lịch thi: ${s.notify_exam ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle thi)
- Học phí: ${s.notify_tuition ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle hocphi)
- Thông báo học vụ: ${s.notify_announcement ? "Bật [ON]" : "Tắt [OFF]"} (Gõ: toggle thongbao)
- Email: ${s.email || "Chưa có"} (Gõ: email <địa chỉ email>)`;
    
    return messenger.sendQuickReplies(senderPsid, textStatus, [
      { title: "Toggle GPA", payload: "TOGGLE_GPA" },
      { title: "Toggle Lịch", payload: "TOGGLE_LICH" },
      { title: "Toggle Lịch Thi", payload: "TOGGLE_THI" },
      { title: "Toggle Học Phí", payload: "TOGGLE_HOCPHI" },
      { title: "Toggle Thông báo", payload: "TOGGLE_THONGBAO" },
    ]);
  }

  // Handle toggle interactions
  if (lowerText.startsWith("toggle ") || lowerText.startsWith("toggle_")) {
    console.log(`[botRouter] Processing toggle setting command for "${senderPsid}"`);
    const key = lowerText.replace("toggle ", "").replace("toggle_", "").trim();
    const s = await db.getSettings(senderPsid);
    
    if (key === "gpa") s.notify_gpa = s.notify_gpa ? 0 : 1;
    else if (key === "lich") s.notify_schedule = s.notify_schedule ? 0 : 1;
    else if (key === "thi") s.notify_exam = s.notify_exam ? 0 : 1;
    else if (key === "hocphi") s.notify_tuition = s.notify_tuition ? 0 : 1;
    else if (key === "thongbao") s.notify_announcement = s.notify_announcement ? 0 : 1;
    else return messenger.sendTextMessage(senderPsid, "Lệnh toggle không hợp lệ.");

    await db.saveSettings(senderPsid, s);
    return handleMessage(senderPsid, "/settings");
  }

  // Handle email save
  if (lowerText.startsWith("email ")) {
    console.log(`[botRouter] Processing email save for "${senderPsid}"`);
    const email = text.replace(/email /i, "").trim();
    const s = await db.getSettings(senderPsid);
    s.email = email;
    await db.saveSettings(senderPsid, s);
    return messenger.sendTextMessage(senderPsid, `Đã cập nhật email nhận thông báo: ${email}`);
  }

  // Handle Login State Machine
  if (!user) {
    const session = loginSessions.get(senderPsid);
    console.log(`[botRouter] Login State Machine. Current session for "${senderPsid}":`, session);
    
    // If not in login session and doesn't trigger explicit /login, do not proceed with login state machine
    if (!session && lowerText !== "/login") {
      return messenger.sendTextMessage(senderPsid, "Bạn chưa đăng nhập. Vui lòng gõ `/login` để bắt đầu kết nối tài khoản sinh viên.");
    }
    
    if (session) {
      if (session.step === "AWAITING_USERNAME") {
        console.log(`[botRouter] Login State Machine: AWAITING_USERNAME -> username "${text}" received.`);
        // Validate student code format (simple digit check or basic length check to reject garbage strings)
        if (!/^\d+$/.test(text)) {
          return messenger.sendTextMessage(senderPsid, "Mã sinh viên không hợp lệ. Vui lòng nhập lại (chỉ gồm các chữ số):");
        }
        session.username = text;
        session.step = "AWAITING_PASSWORD";
        loginSessions.set(senderPsid, session);
        return messenger.sendTextMessage(senderPsid, "Nhận mã sinh viên thành công. Vui lòng nhập Mật khẩu cổng sinh viên của bạn (thông tin được mã hóa bảo mật):");
      }

      if (session.step === "AWAITING_PASSWORD") {
        console.log(`[botRouter] Login State Machine: AWAITING_PASSWORD -> password received, starting scrape process.`);
        const username = session.username;
        const passwordEnc = crypto.encrypt(text);
        
        // Save user
        await db.saveUser(senderPsid, username, passwordEnc, "0");
        loginSessions.delete(senderPsid);

        await messenger.sendTextMessage(senderPsid, "Đang kết nối & tiến hành đồng bộ dữ liệu lần đầu. Quá trình này có thể mất 1-2 phút qua Tor, vui lòng đợi...");

        // Trigger async scrape immediately for this user
        const scraperPath = path.resolve(__dirname, "./scrape.js");
        const execCmd = `node "${scraperPath}" --account="${username.replace(/"/g, '\\"')}"`;
        console.log(`[botRouter] Executing scrape command: ${execCmd}`);
        exec(execCmd, (err) => {
          if (err) {
            console.error(`[async-sync] Scrape for ${username} failed:`, err.message);
            messenger.sendTextMessage(senderPsid, "[X] Đồng bộ lần đầu thất bại. Vui lòng kiểm tra lại tài khoản mật khẩu bằng cách gõ /logout và đăng nhập lại.");
          } else {
            console.log(`[async-sync] Scrape for ${username} succeeded.`);
            messenger.sendTextMessage(senderPsid, "[OK] Đồng bộ dữ liệu thành công! Bạn có thể sử dụng các lệnh: Lịch học, Lịch thi, Điểm số, Học phí, hoặc Tóm tắt tuần.");
          }
        });
        return;
      }
    }
  }

  // Quick keywords
  const data = await db.getScrapedData(senderPsid) || {};
  console.log(`[botRouter] Querying data for keywords. Message: "${text}"`);
  
  if (text === "lịch thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const elements = raw.slice(1, 5).map((r) => ({
      title: `Thi: ${r[2] || "Môn học"}`,
      subtitle: `Ngày: ${r[3]} (${r[5]})\nPhòng: ${r[9]} | SBD: ${r[8]} | HT: ${r[10]}`,
      buttons: [
        {
          type: "postback",
          title: "Xem Điểm",
          payload: "XEM_DIEM"
        }
      ]
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (text === "lịch học") {
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const targetTable = raw ? raw.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
    const rows = targetTable ? targetTable.rows || [] : [];
    if (!rows.length) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch học nào sắp tới.");
    }
    const elements = rows.slice(0, 5).map((r) => ({
      title: `${r[2] || "Môn học"}`,
      subtitle: `${r[0] || ""} | Tiết ${r[1]} | Phòng ${r[3]} | ${r[4] || ""}`,
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (lowerText.startsWith("lịch học thứ") || lowerText.startsWith("lịch học t") || lowerText.startsWith("lịch học cn") || lowerText.startsWith("lịch học chủ nhật")) {
    const dayPart = text.replace(/lịch học /i, "").trim();
    const raw = data.lich_hoc ? JSON.parse(data.lich_hoc) : null;
    const targetTable = raw ? raw.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
    const rows = targetTable ? targetTable.rows || [] : [];
    
    const dayMap = {
      "2": "thứ 2", "3": "thứ 3", "4": "thứ 4", "5": "thứ 5", "6": "thứ 6", "7": "thứ 7", "cn": "chủ nhật",
      "thu2": "thứ 2", "thu3": "thứ 3", "thu4": "thứ 4", "thu5": "thứ 5", "thu6": "thứ 6", "thu7": "thứ 7",
    };
    const targetDay = dayMap[dayPart.toLowerCase()] || dayPart.toLowerCase();
    const filtered = rows.filter((r) => {
      const thu = (r[0] || "").toLowerCase();
      return thu.includes(targetDay) || thu === targetDay;
    });

    if (!filtered.length) {
      return messenger.sendTextMessage(senderPsid, `Không có lịch học nào vào ${dayPart}.`);
    }

    const elements = filtered.slice(0, 5).map((r) => ({
      title: `${r[2] || "Môn học"}`,
      subtitle: `Tiết ${r[1]} | Phòng ${r[3]} | ${r[4] || ""}`,
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (text === "điểm số" || text === "gpa") {
    const raw = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : null;
    const targetTable = raw ? raw.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
    const rows = targetTable ? targetTable.rows || [] : [];
    if (!rows.length) {
      return messenger.sendTextMessage(senderPsid, "Chưa có dữ liệu điểm học tập.");
    }
    const elements = rows.slice(0, 5).map((r) => ({
      title: `${r[2] || "Môn học"}`,
      subtitle: `Điểm: ${r[6]} (${r[8]}) | Tín chỉ: ${r[3]}`,
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (text === "tiến độ" || text === "tín chỉ" || text === "tien do") {
    const raw = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : null;
    return messenger.sendTextMessage(senderPsid, formatTienDo(raw));
  }

  if (text === "học vụ" || text === "thông báo") {
    const raw = data.canh_bao ? JSON.parse(data.canh_bao) : null;
    return messenger.sendTextMessage(senderPsid, formatCanhBao(raw));
  }

  if (text === "học phí" || text === "tiền") {
    const raw = data.hoc_phi ? JSON.parse(data.hoc_phi) : null;
    return messenger.sendTextMessage(senderPsid, formatHocPhi(raw));
  }

  if (text === "hồ sơ" || text === "hồ sơ sinh viên" || text === "ho so" || text === "lý lịch" || text === "ly lich") {
    const raw = data.thong_tin_sv ? JSON.parse(data.thong_tin_sv) : null;
    return messenger.sendTextMessage(senderPsid, formatThongTinSV(raw));
  }

  // AI Study Statistics
  if (text === "thống kê" || text === "thong ke" || text === "phân tích" || text === "phan tich") {
    const cleanDataForStats = {
      user: { username: user.username },
      diem: data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap).slice(0, 10) : [],
      lich_thi: data.lich_thi ? JSON.parse(data.lich_thi).slice(0, 5) : [],
      hoc_phi: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
      canh_bao: data.canh_bao ? JSON.parse(data.canh_bao).slice(0, 3) : []
    };

    const statsPrompt = `Bạn là trợ lý AI UFL. Nhiệm vụ của bạn là phân tích thống kê học tập cho sinh viên.
Dữ liệu:
${JSON.stringify(cleanDataForStats, null, 2)}

Hãy phân tích ngắn gọn:
1. Số môn đã hoàn thành, TBCHP trung bình, xu hướng điểm.
2. Các môn thi sắp tới và mức độ ưu tiên.
3. Tình trạng học phí và cảnh báo nếu có.
4. Nhận xét tổng quan và lời khuyên học tập.

Viết bằng tiếng Việt, ngắn gọn, thân thiện, động viên.`;

    await messenger.sendTextMessage(senderPsid, "AI đang phân tích dữ liệu học tập của bạn...");
    const statsResult = await askAI(statsPrompt, "Hãy thống kê và phân tích tiến độ học tập của tôi.");
    return messenger.sendTextMessage(senderPsid, statsResult);
  }

  // AI Weekly Summary
  if (text === "tóm tắt tuần" || text === "tóm tắt" || text === "tom tat") {
    const cleanDataForSummary = {
      user: { username: user.username },
      lich_hoc: data.lich_hoc ? JSON.parse(data.lich_hoc).slice(0, 5) : [],
      lich_thi: data.lich_thi ? JSON.parse(data.lich_thi).slice(0, 3) : [],
      hoc_phi: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
      canh_bao: data.canh_bao ? JSON.parse(data.canh_bao).slice(0, 2) : []
    };

    const summaryPrompt = `Bạn là trợ lý AI UFL. Nhiệm vụ của bạn là viết một bản tóm tắt tuần học tập cho sinh viên.
Hãy dựa vào dữ liệu sau đây:
${JSON.stringify(cleanDataForSummary, null, 2)}

Hãy tóm tắt ngắn gọn dưới dạng bullet points bao gồm:
1. Lịch học chính cần chú ý tuần tới.
2. Môn thi sắp tới (nếu có).
3. Tình trạng học phí cần hoàn thành (đặc biệt lưu ý cảnh báo cấm thi nếu nợ).
4. Các việc cần ưu tiên trong tuần.
Hãy viết với phong cách động viên sinh viên học tập tốt, ngắn gọn, thân thiện bằng tiếng Việt.`;

    await messenger.sendTextMessage(senderPsid, "AI đang tổng hợp và tóm tắt tuần của bạn...");
    const summaryResult = await askAI(summaryPrompt, "Hãy tóm tắt tuần học tập của tôi.");
    return messenger.sendTextMessage(senderPsid, summaryResult);
  }

  // Ask AI (Free text)
  const cleanData = {
    user: { username: user.username },
    announcements: data.canh_bao ? JSON.parse(data.canh_bao).slice(0, 3) : [],
    gpa_recent: data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap).slice(0, 2) : [],
    exams: data.lich_thi ? JSON.parse(data.lich_thi).slice(0, 3) : [],
    tuition: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
    schedule: data.lich_hoc ? JSON.parse(data.lich_hoc).slice(0, 4) : []
  };

  const systemPrompt = `Bạn là trợ lý AI hữu ích hỗ trợ sinh viên trường Đại học Ngoại ngữ - Đại học Đà Nẵng (UFL).
Dưới đây là thông tin học vụ của sinh viên (định dạng JSON):
${JSON.stringify(cleanData, null, 2)}

Hãy trả lời câu hỏi của sinh viên ngắn gọn, chính xác bằng tiếng Việt. Không tự bịa thông tin ngoài context được cung cấp. Nếu không biết hoặc không có dữ liệu, hãy bảo sinh viên truy cập cài đặt để đồng bộ lại.`;

  await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang suy nghĩ...");
  const reply = await askAI(systemPrompt, messageText);
  return messenger.sendTextMessage(senderPsid, reply);
}

module.exports = { handleMessage, setBaseUrl };
