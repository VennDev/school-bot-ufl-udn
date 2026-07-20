const db = require("./db");
const crypto = require("./crypto");
const messenger = require("./messenger");
const { askAI } = require("./ai");
const { calculateGPA, extractGPA, extractDRL, getAcademicEvaluation, getScholarshipAndActivityAdvice } = require("./gpaHelper");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

// Load static response nodes
let staticNodes = [];
try {
  staticNodes = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../static_nodes.json"), "utf8"));
} catch (e) {
  console.error("Failed to load static_nodes.json:", e.message);
}

// Memory map for login sessions
const loginSessions = new Map();

// Get base URL for Webview from request
let appBaseUrl = "http://localhost:3000";

function setBaseUrl(url) {
  appBaseUrl = url;
}

function formatCanhBao(data, showAll = false) {
  if (!data || !data.length) return "Không có cảnh báo học vụ mới nào.";
  let txt = "[!] THÔNG BÁO HỌC VỤ MỚI NHẤT:\n";
  const currentYear = new Date().getFullYear().toString();
  
  let filtered = data;
  if (!showAll) {
    // Only keep items matching current year (e.g. content contains "/2026" or "2026")
    filtered = data.filter(item => {
      const content = item.content || JSON.stringify(item);
      return content.includes(currentYear) || content.includes("/" + currentYear.slice(2));
    });
  }
  
  if (!filtered.length) {
    return showAll ? "Không có cảnh báo học vụ nào." : "Không có cảnh báo học vụ mới của năm nay.";
  }

  filtered.slice(0, 3).forEach((item, idx) => {
    txt += `\n${idx + 1}. ${item.content || JSON.stringify(item)}`;
  });
  return txt;
}

function formatKetQuaHocTap(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm học tập.";

  let gpa = extractGPA(rawKq);
  const targetTable = rawKq.find((t) => t.headers && t.headers.includes("Tên học phần"));

  if (!gpa) {
    if (!targetTable) return "Chưa cập nhật bảng điểm chính.";
    const courses = targetTable.rows.map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
    gpa = calculateGPA(courses);
  }

  if (!gpa) return "Không thể đọc dữ liệu điểm học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  let txt = `📊 KẾT QUẢ HỌC TẬP (Dữ liệu từ UFLS):\n`;
  txt += `- GPA Học kỳ: ${gpa.gpaSemester}/4.0\n`;
  txt += `- GPA Tích lũy: ${gpa.gpaAccumulated}/4.0\n`;
  txt += `- Tín chỉ tích lũy: ${gpa.creditsAccumulated} TC\n`;
  txt += `- Xếp loại học lực: ${evalResult.rank}\n`;
  if (drl) {
    txt += `- Điểm rèn luyện: ${drl.score}/100 (${drl.rank})\n`;
  }
  txt += `\n💬 Nhận xét: ${evalResult.comment}\n`;

  if (evalResult.warning) {
    txt += `\n${evalResult.warning}\n`;
  }

  if (advice) {
    txt += `\n💡 TƯ VẤN & KHUYẾN NGHỊ (Quy chế UFLS):\n${advice}`;
  }

  if (targetTable && targetTable.rows) {
    txt += `\n📝 Chi tiết điểm môn gần đây:`;
    targetTable.rows.slice(0, 5).forEach((r) => {
      txt += `\n- ${r[2]}: ${r[6]} (${r[8]})`;
    });
  }

  return txt;
}

function formatLichThi(data, showAll = false) {
  if (!data || !data.length || data.length < 2) return "Không có lịch thi sắp tới.";
  let txt = "[~] LỊCH THI:\n";
  const currentYear = new Date().getFullYear().toString();
  
  let rows = data.slice(1);
  if (!showAll) {
    rows = rows.filter(r => {
      const dateStr = r[3] || "";
      return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
    });
  }

  if (!rows.length) return showAll ? "Không có lịch thi." : "Không có lịch thi trong năm nay.";

  rows.slice(0, 5).forEach((r) => {
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
        const cleaned = r.map(cell => cell.trim().replace(/\s+/g, " ")).filter(Boolean);
        if (cleaned.some(cell => cell.includes("Học phí") || cell.includes("Số tiền") || cell.includes("Nợ"))) {
          txt += `\n- ${cleaned.join(" | ")}`;
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

function formatTienDo(scrapedData) {
  const rawKq = scrapedData.ket_qua_hoc_tap ? JSON.parse(scrapedData.ket_qua_hoc_tap) : null;
  const rawDrl = scrapedData.diem_ren_luyen ? JSON.parse(scrapedData.diem_ren_luyen) : null;

  if (!rawKq || !rawKq.length) return "Chưa có dữ liệu điểm để tính tiến độ.";

  let gpa = extractGPA(rawKq);
  const targetTable = rawKq.find((t) => t.headers && t.headers.includes("Tên học phần"));

  if (!gpa && targetTable) {
    const courses = targetTable.rows.map((r) => ({
      name: r[2],
      credits: r[3],
      score10: r[6]
    }));
    gpa = calculateGPA(courses);
  }

  if (!gpa) return "Không thể đọc thông tin tiến độ học tập.";

  const drl = extractDRL(rawDrl);
  const evalResult = getAcademicEvaluation(gpa.gpaAccumulated, gpa.gpaSemester);
  const advice = getScholarshipAndActivityAdvice(gpa.gpaSemester10 || null, gpa.gpaAccumulated, drl ? drl.score : null, gpa.creditsAccumulated);

  const rows = targetTable ? targetTable.rows || [] : [];
  const earned = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return grade && !["f", "chưa đạt"].includes(grade) && r[6] !== "0";
  });
  const remaining = rows.filter((r) => {
    const grade = (r[8] || "").toLowerCase();
    return !grade || grade === "f" || grade === "chưa đạt" || r[6] === "0";
  });
  const remainingCredits = remaining.reduce((sum, r) => sum + (parseFloat(r[3]) || 0), 0);

  let txt = `📈 TIẾN ĐỘ HỌC TẬP (Quy chế UFLS):\n`;
  txt += `- GPA Tích lũy: ${gpa.gpaAccumulated}/4.0 (${evalResult.rank})\n`;
  txt += `- Tín chỉ đã tích lũy: ${gpa.creditsAccumulated} TC\n`;
  txt += `- Số môn hoàn thành: ${earned.length} môn\n`;
  txt += `- Số tín chỉ nợ/chưa hoàn thành: ${remainingCredits} TC\n`;
  if (drl) {
    txt += `- Điểm rèn luyện: ${drl.score}/100 (${drl.rank})\n`;
  }
  txt += `\n💬 Nhận xét: ${evalResult.comment}\n`;

  if (evalResult.warning) {
    txt += `\n${evalResult.warning}\n`;
  }

  if (advice) {
    txt += `\n💡 TƯ VẤN & KHUYẾN NGHỊ (Quy chế UFLS):\n${advice}`;
  }

  if (remaining.length > 0) {
    txt += "\n📝 Các môn chưa hoàn thành gần đây:\n";
    remaining.slice(0, 5).forEach((r) => {
      txt += `- ${r[2]} (${r[3]} TC): ${r[6] || "Chưa học/Chưa có điểm"}\n`;
    });
  }
  return txt;
}

async function handleMessage(senderPsid, messageText) {
  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  await db.logInteraction(senderPsid, "message", text);
  const user = await db.getUser(senderPsid);

  console.log(`[botRouter] Received message from "${senderPsid}": "${text}"`);
  console.log(`[botRouter] Database user check: ${user ? `Found user "${user.username}"` : "User not found"}`);

  // Handle Sync command
  if (lowerText === "/sync" || lowerText === "đồng bộ" || lowerText === "sync") {
    if (!user) {
      return messenger.sendTextMessage(senderPsid, "Bạn chưa kết nối tài khoản. Vui lòng gõ /login để đăng nhập.");
    }
    await messenger.sendTextMessage(senderPsid, "Đang khởi động đồng bộ dữ liệu tức thời từ cổng sinh viên. Quá trình có thể mất 1-2 phút...");
    const scraperPath = path.resolve(__dirname, "./scrape.js");
    const execCmd = `node "${scraperPath}" --account="${user.username.replace(/"/g, '\\"')}"`;
    exec(execCmd, (err) => {
      if (err) {
        messenger.sendTextMessage(senderPsid, "[X] Quá trình đồng bộ dữ liệu tức thời thất bại hoặc bị nghẽn mạng.");
      }
    });
    return;
  }

  // Handle Menu command
  if (lowerText === "/menu" || lowerText === "menu" || lowerText === "xem menu" || lowerText === "cho xem menu") {
    const s = await db.getSettings(senderPsid);
    const menuText = "📚 MENU CHỨC NĂNG UFL BOT\nChọn phím tắt bên dưới để tra cứu nhanh thông tin học vụ của bạn hoặc hỏi các câu hỏi mẫu:";
    return messenger.sendButtons(senderPsid, menuText, [
      {
        type: "postback",
        title: "Tra cứu học vụ",
        payload: "MENU_POSTBACK"
      },
      {
        type: "postback",
        title: "Câu hỏi thường gặp",
        payload: "FAQ_POSTBACK"
      }
    ]);
  }

  if (lowerText === "xem menu hoc vu") {
    const menuText = "📚 MENU TRA CỨU HỌC VỤ\nChọn thông tin bạn muốn kiểm tra:";
    return messenger.sendQuickReplies(senderPsid, menuText, [
      { title: "Lịch học", payload: "LICH_HOC" },
      { title: "Lịch thi (năm nay)", payload: "LICH_THI" },
      { title: "Tất cả Lịch thi", payload: "ALL_LICH_THI" },
      { title: "Điểm số", payload: "DIEM_SO" },
      { title: "Đồng bộ", payload: "SYNC_POSTBACK" },
      { title: "Tiến độ", payload: "TIEN_DO" },
      { title: "Học phí", payload: "HOC_PHI" },
      { title: "Cài đặt", payload: "MENU_POSTBACK" }
    ]);
  }

  if (lowerText === "xem menu cau hoi" || lowerText === "câu hỏi thường gặp") {
    const menuText = "💡 CÂU HỎI THƯỜNG GẶP\nChọn câu hỏi mẫu bên dưới để xem trả lời nhanh từ quy chế:";
    return messenger.sendQuickReplies(senderPsid, menuText, [
      { title: "Quy chế học bổng", payload: "QC_HOCBONG" },
      { title: "Cảnh báo học vụ", payload: "QC_CANHBAO" },
      { title: "Xếp loại học lực", payload: "QC_XEPLOAI" },
      { title: "Học & Thi cải thiện", payload: "QC_CAITHIEN" }
    ]);
  }

  if (lowerText === "qc_hocbong" || lowerText === "quy chế học bổng") {
    const node = staticNodes.find(n => n.keywords.includes("quy chế học bổng"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (lowerText === "qc_canhbao" || lowerText === "cảnh báo học vụ") {
    const node = staticNodes.find(n => n.keywords.includes("cảnh báo học vụ"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (lowerText === "qc_xeploai" || lowerText === "xếp loại học lực") {
    const node = staticNodes.find(n => n.keywords.includes("xếp loại học lực"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }
  if (lowerText === "qc_caithien" || lowerText === "thi cải thiện") {
    const node = staticNodes.find(n => n.keywords.includes("thi cải thiện"));
    return messenger.sendTextMessage(senderPsid, node ? node.response : "Không tìm thấy thông tin.");
  }

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
      return messenger.sendButtons(senderPsid, "Xin chào! Mình có thể giúp gì cho bạn?\nĐể bắt đầu sử dụng, vui lòng đăng nhập tài khoản sinh viên UFL.", [
        {
          type: "postback",
          title: "Đăng nhập ngay",
          payload: "LOGIN_POSTBACK"
        }
      ]);
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
        const child =         exec(execCmd, (err, stdout, stderr) => {
          if (err) {
            console.error(`[async-sync] Scrape for ${username} failed:`, err.message);
            messenger.sendTextMessage(senderPsid, "[X] Đăng nhập thất bại ở cả kết nối Direct IP và Tor.");
          } else {
            console.log(`[async-sync] Scrape for ${username} succeeded.`);
          }
        });
        child.stdout.on("data", (data) => {
          console.log(`[async-sync-process-stdout] ${data.trim()}`);
        });
        child.stderr.on("data", (data) => {
          console.error(`[async-sync-process-stderr] ${data.trim()}`);
        });
        return;
      }
    }
  }

  // Quick keywords
  const data = await db.getScrapedData(senderPsid) || {};
  console.log(`[botRouter] Querying data for keywords. Message: "${text}"`);
  
  if (lowerText === "lịch thi" || lowerText === "lich thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const currentYear = new Date().getFullYear().toString();
    const filtered = raw.slice(1).filter(r => {
      const dateStr = r[3] || "";
      return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
    });

    if (!filtered.length) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi trong năm nay. Gõ 'tất cả lịch thi' để xem toàn bộ.");
    }

    const elements = filtered.slice(0, 5).map((r) => ({
      title: `Thi: ${r[2] || "Môn học"}`,
      subtitle: `Ngày: ${r[3]} (${r[5]})\nPhòng: ${r[9]} | SBD: ${r[8]} | HT: ${r[10]}`,
      buttons: [
        {
          type: "postback",
          title: "Xem Điểm",
          payload: "DIEM_SO"
        }
      ]
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (lowerText === "tất cả lịch thi" || lowerText === "tat ca lich thi") {
    const raw = data.lich_thi ? JSON.parse(data.lich_thi) : null;
    if (!raw || !raw.length || raw.length < 2) {
      return messenger.sendTextMessage(senderPsid, "Không có lịch thi sắp tới.");
    }
    const elements = raw.slice(1, 6).map((r) => ({
      title: `Thi: ${r[2] || "Môn học"}`,
      subtitle: `Ngày: ${r[3]} (${r[5]})\nPhòng: ${r[9]} | SBD: ${r[8]} | HT: ${r[10]}`,
      buttons: [
        {
          type: "postback",
          title: "Xem Điểm",
          payload: "DIEM_SO"
        }
      ]
    }));
    return messenger.sendGenericTemplate(senderPsid, elements);
  }

  if (lowerText === "lịch học" || lowerText === "lich hoc") {
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

  if (lowerText.startsWith("lịch học thứ") || lowerText.startsWith("lịch học t") || lowerText.startsWith("lịch học cn") || lowerText.startsWith("lịch học chủ nhật") || lowerText.startsWith("lich hoc thu") || lowerText.startsWith("lich hoc t") || lowerText.startsWith("lich hoc cn") || lowerText.startsWith("lich hoc chu nhat")) {
    const dayPart = text.replace(/lịch học /i, "").replace(/lich hoc /i, "").trim();
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

  if (lowerText === "điểm số" || lowerText === "gpa" || lowerText === "diem so" || lowerText === "diem") {
    return messenger.sendTextMessage(senderPsid, formatKetQuaHocTap(data));
  }

  if (lowerText === "tiến độ" || lowerText === "tín chỉ" || lowerText === "tien do" || lowerText === "tin chi") {
    return messenger.sendTextMessage(senderPsid, formatTienDo(data));
  }

  if (lowerText === "học vụ" || lowerText === "thông báo" || lowerText === "hoc vu" || lowerText === "thong bao") {
    const raw = data.canh_bao ? JSON.parse(data.canh_bao) : null;
    return messenger.sendTextMessage(senderPsid, formatCanhBao(raw, false));
  }

  if (lowerText === "tất cả thông báo" || lowerText === "tat ca thong bao" || lowerText === "tất cả học vụ" || lowerText === "tat ca hoc vu") {
    const raw = data.canh_bao ? JSON.parse(data.canh_bao) : null;
    return messenger.sendTextMessage(senderPsid, formatCanhBao(raw, true));
  }

  if (lowerText === "học phí" || lowerText === "tiền" || lowerText === "hoc phi" || lowerText === "tien") {
    const raw = data.hoc_phi ? JSON.parse(data.hoc_phi) : null;
    return messenger.sendTextMessage(senderPsid, formatHocPhi(raw));
  }

  if (lowerText === "hồ sơ" || lowerText === "hồ sơ sinh viên" || lowerText === "ho so" || lowerText === "lý lịch" || lowerText === "ly lich") {
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

    const statsPrompt = `Bạn là trợ lý AI UFL. Hãy phân tích tiến độ học tập của sinh viên dựa trên dữ liệu sau:
${JSON.stringify(cleanDataForStats, null, 2)}

Yêu cầu định dạng phản hồi bắt buộc:
1. Trả lời ngắn gọn, trực diện, không dài dòng.
2. Sử dụng định dạng khung cố định sau:
[+] Tóm tắt: (1-2 câu nhận xét chung)
[+] Phân tích chi tiết:
- Tiến độ học tập & GPA: (Mô tả ngắn)
- Lịch thi & Học phí: (Mô tả ngắn)
[+] Lời khuyên: (1 câu khuyên học tập)`;

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

    const summaryPrompt = `Bạn là trợ lý AI UFL. Hãy tóm tắt tuần học tập cho sinh viên dựa trên dữ liệu sau:
${JSON.stringify(cleanDataForSummary, null, 2)}

Yêu cầu định dạng phản hồi bắt buộc:
[+] Tóm tắt tuần học: (Nhận xét tổng quan tuần tới ngắn trong 1 câu)
[+] Lịch trình:
- Lịch học chính: (Các môn cần học tuần tới)
- Lịch thi & Học phí: (Các môn thi sắp tới, tình trạng học phí/nợ nếu có)
[+] Nhiệm vụ ưu tiên: (Bullet point ngắn gọn các việc cần làm)`;

    await messenger.sendTextMessage(senderPsid, "AI đang tổng hợp và tóm tắt tuần của bạn...");
    const summaryResult = await askAI(summaryPrompt, "Hãy tóm tắt tuần học tập của tôi.");
    return messenger.sendTextMessage(senderPsid, summaryResult);
  }

  // Ask AI (Free text)
  const rawGrades = data.ket_qua_hoc_tap ? JSON.parse(data.ket_qua_hoc_tap) : null;
  const targetGradeTable = rawGrades ? rawGrades.find((t) => t.headers && t.headers.includes("Tên học phần")) : null;
  const gradesRows = targetGradeTable ? (targetGradeTable.rows || []) : [];

  // Filter cleanData sent to AI based on current year to prevent AI from seeing old schedule/exams/announcements by default
  const today = new Date();
  const currentYear = today.getFullYear().toString();
  const isRequestingAll = lowerText.includes("tất cả") || lowerText.includes("tat ca") || lowerText.includes("toàn bộ") || lowerText.includes("toan bo");

  const filteredAnnouncements = data.canh_bao ? JSON.parse(data.canh_bao) : [];
  const filteredExams = data.lich_thi ? JSON.parse(data.lich_thi) : [];
  const filteredSchedule = data.lich_hoc ? JSON.parse(data.lich_hoc) : [];

  // Parse exam date to check if it's in the future
  const parseExamDate = (dateStr) => {
    if (!dateStr) return null;
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    return null;
  };

  const cleanData = {
    user: { username: user.username },
    current_time: today.toISOString().split("T")[0] + " (Today is " + today.toLocaleDateString("vi-VN") + ")",
    announcements: isRequestingAll 
      ? filteredAnnouncements.slice(0, 5) 
      : filteredAnnouncements.filter(item => {
          const content = item.content || JSON.stringify(item);
          return content.includes(currentYear) || content.includes("/" + currentYear.slice(2));
        }).slice(0, 3),
    gpa_data: gradesRows, // Send full grades data so AI can calculate/analyze any semester or whole course
    exams: isRequestingAll 
      ? filteredExams.slice(0, 5)
      : filteredExams.slice(1).filter(r => {
          const examDate = parseExamDate(r[3]);
          // Only show upcoming exams (examDate >= today or date string analysis fallback)
          if (examDate) {
            const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            return examDate >= todayReset;
          }
          const dateStr = r[3] || "";
          return dateStr.includes(currentYear) || dateStr.includes("/" + currentYear.slice(2));
        }).slice(0, 3),
    tuition: data.hoc_phi ? JSON.parse(data.hoc_phi) : [],
    schedule: filteredSchedule.slice(0, 4) // schedule usually represents current semester, but we pass it as is
  };

  // RAG: Query matching regulation nodes from DB
  const regs = await db.searchRegNodes(messageText, 4);
  let regContextText = "";
  if (regs && regs.length > 0) {
    regContextText = "\n[!] QUY CHẾ ĐÀO TẠO THAM KHẢO (Được trích xuất từ tài liệu UFLS):\n";
    regs.forEach((r, idx) => {
      regContextText += `\nĐoạn ${idx + 1} (Trang số ${r.start_page} trong tài liệu sổ tay gốc):\n${r.content}\n`;
    });
  }

  // Load custom system rules
  let systemPrompt = "";
  try {
    systemPrompt = fs.readFileSync(path.resolve(__dirname, "../rules.txt"), "utf8");
  } catch (e) {
    console.error("Failed to load rules.txt:", e.message);
  }

  if (!systemPrompt) {
    systemPrompt = `Bạn là trợ lý AI hữu ích hỗ trợ sinh viên trường Đại học Ngoại ngữ - Đại học Đà Nẵng (UFL).`;
  }

  systemPrompt += `\nDưới đây là thông tin học vụ của sinh viên (định dạng JSON):\n${JSON.stringify(cleanData, null, 2)}\n${regContextText}`;

  await messenger.sendTextMessage(senderPsid, "Trợ lý AI đang suy nghĩ...");
  const reply = await askAI(systemPrompt, messageText);
  return messenger.sendTextMessage(senderPsid, reply);
}

module.exports = { handleMessage, setBaseUrl };
