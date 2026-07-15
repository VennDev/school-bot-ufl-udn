function getGradePoints(score10) {
  if (score10 >= 8.5) return { letter: "A", point4: 4 };
  if (score10 >= 7.0) return { letter: "B", point4: 3 };
  if (score10 >= 5.5) return { letter: "C", point4: 2 };
  if (score10 >= 4.0) return { letter: "D", point4: 1 };
  return { letter: "F", point4: 0 };
}

function parseScore(val) {
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

function calculateGPA(courses) {
  // courses: array of { name, credits, score10 }
  let totalCreditsSemester = 0;
  let weightedPointsSemester = 0;

  let totalCreditsAccumulated = 0;
  let weightedPointsAccumulated = 0;

  courses.forEach((c) => {
    const nameLower = c.name.toLowerCase();
    
    // Ngoại lệ: Không tính GDQP và GDTC vào GPA
    if (nameLower.includes("giáo dục quốc phòng") || nameLower.includes("giáo dục thể chất") || nameLower.includes("gdqp") || nameLower.includes("gdtc")) {
      return;
    }

    const credits = parseInt(c.credits);
    const score10 = parseScore(c.score10);
    
    if (isNaN(credits) || score10 === null) return;

    const { letter, point4 } = getGradePoints(score10);

    // Tính học kỳ (gồm cả F)
    totalCreditsSemester += credits;
    weightedPointsSemester += point4 * credits;

    // Tính tích lũy (chỉ lấy A, B, C, D)
    if (letter !== "F") {
      totalCreditsAccumulated += credits;
      weightedPointsAccumulated += point4 * credits;
    }
  });

  const gpaSemester = totalCreditsSemester > 0 ? (weightedPointsSemester / totalCreditsSemester) : 0;
  const gpaAccumulated = totalCreditsAccumulated > 0 ? (weightedPointsAccumulated / totalCreditsAccumulated) : 0;

  return {
    gpaSemester: parseFloat(gpaSemester.toFixed(2)),
    gpaAccumulated: parseFloat(gpaAccumulated.toFixed(2)),
    creditsAccumulated: totalCreditsAccumulated,
  };
}

function extractGPA(tables) {
  if (!tables || !tables.length) return null;

  let gpaSemester = null;
  let gpaAccumulated = null;
  let creditsAccumulated = 0;

  for (const table of tables) {
    const headers = table.headers || [];
    const rows = table.rows || [];

    // 1. Kiểm tra bảng tổng hợp học kỳ (dạng bảng tóm tắt học kỳ)
    const idxGpaSem4 = headers.findIndex(h => {
      const l = h.toLowerCase();
      return (l.includes("đtbchk") || l.includes("học kỳ")) && (l.includes("he 4") || l.includes("hệ 4") || l.includes("4.0"));
    });
    const idxGpaAcc4 = headers.findIndex(h => {
      const l = h.toLowerCase();
      return (l.includes("đtbctl") || l.includes("tích lũy")) && (l.includes("he 4") || l.includes("hệ 4") || l.includes("4.0"));
    });
    const idxCreditsAcc = headers.findIndex(h => {
      const l = h.toLowerCase();
      return l.includes("tín chỉ tích lũy") || l.includes("tc tích lũy") || l.includes("tctl");
    });

    if (idxGpaAcc4 !== -1 && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      gpaSemester = parseFloat(lastRow[idxGpaSem4]) || null;
      gpaAccumulated = parseFloat(lastRow[idxGpaAcc4]) || null;
      creditsAccumulated = parseInt(lastRow[idxCreditsAcc]) || 0;
      if (gpaAccumulated !== null && !isNaN(gpaAccumulated)) {
        return { gpaSemester, gpaAccumulated, creditsAccumulated };
      }
    }

    // 2. Tìm kiếm trong các ô dạng text
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const cell = String(row[i]).toLowerCase();
        
        if ((cell.includes("tích lũy") || cell.includes("đtbctl")) && (cell.includes("hệ 4") || cell.includes("he 4") || cell.includes("4.0"))) {
          const match = cell.match(/(\d+[\.,]\d+)/);
          if (match) {
            gpaAccumulated = parseFloat(match[1].replace(",", "."));
          } else if (row[i + 1]) {
            const nextMatch = String(row[i + 1]).match(/(\d+[\.,]\d+)/);
            if (nextMatch) gpaAccumulated = parseFloat(nextMatch[1].replace(",", "."));
          }
        }
        
        if ((cell.includes("học kỳ") || cell.includes("đtbchk")) && (cell.includes("hệ 4") || cell.includes("he 4") || cell.includes("4.0"))) {
          const match = cell.match(/(\d+[\.,]\d+)/);
          if (match) {
            gpaSemester = parseFloat(match[1].replace(",", "."));
          } else if (row[i + 1]) {
            const nextMatch = String(row[i + 1]).match(/(\d+[\.,]\d+)/);
            if (nextMatch) gpaSemester = parseFloat(nextMatch[1].replace(",", "."));
          }
        }

        if (cell.includes("tín chỉ tích lũy") || cell.includes("tổng số tín chỉ tích lũy") || cell.includes("sct tích lũy") || cell.includes("tc tích lũy")) {
          const match = cell.match(/(\d+)/);
          if (match) {
            creditsAccumulated = parseInt(match[1]);
          } else if (row[i + 1]) {
            const nextMatch = String(row[i + 1]).match(/(\d+)/);
            if (nextMatch) creditsAccumulated = parseInt(nextMatch[1]);
          }
        }
      }
    }
  }

  if (gpaAccumulated !== null && !isNaN(gpaAccumulated)) {
    return {
      gpaSemester: gpaSemester || 0,
      gpaAccumulated,
      creditsAccumulated
    };
  }

  return null;
}

function getAcademicEvaluation(gpaAccumulated, gpaSemester) {
  let rank = "Chưa xếp loại";
  let comment = "";
  let warning = "";

  if (gpaAccumulated >= 3.6) {
    rank = "Xuất sắc";
    comment = "Thành tích học tập vô cùng ấn tượng! Hãy tiếp tục duy trì phong độ đỉnh cao này nhé.";
  } else if (gpaAccumulated >= 3.2) {
    rank = "Giỏi";
    comment = "Kết quả xuất sắc! Bạn đang có lộ trình học tập rất tốt, phát huy tiếp nhé.";
  } else if (gpaAccumulated >= 2.5) {
    rank = "Khá";
    comment = "Học lực Khá vững vàng. Cố gắng thêm chút nữa để đạt mục tiêu Giỏi/Xuất sắc.";
  } else if (gpaAccumulated >= 2.0) {
    rank = "Trung bình";
    comment = "Học lực ở mức an toàn nhưng cần nỗ lực nhiều hơn để cải thiện GPA.";
  } else if (gpaAccumulated >= 1.0) {
    rank = "Yếu";
    comment = "Kết quả học tập đang dưới mức trung bình. Hãy tập trung cải thiện điểm số để tránh các rủi ro học vụ.";
    warning = "⚠️ Cảnh báo: Học lực xếp hạng Yếu theo Điều 21.2 quy chế đào tạo.";
  } else {
    rank = "Kém";
    comment = "Cần nghiêm túc xem xét lại phương pháp học tập ngay lập tức.";
    warning = "🚨 Cảnh báo nghiêm trọng: GPA < 1.0. Nguy cơ cao bị cảnh báo học tập hoặc buộc thôi học.";
  }

  // Cảnh báo dựa trên GPA học kỳ (Điều 22.1.b)
  if (gpaSemester !== null && gpaSemester < 1.0) {
    warning += warning ? "\n" : "";
    warning += `⚠️ Cảnh báo học vụ: GPA học kỳ (${gpaSemester}) dưới 1.0 có nguy cơ bị cảnh báo học tập (Điều 22.1.b).`;
  }

  return { rank, comment, warning };
}

module.exports = { calculateGPA, extractGPA, getGradePoints, getAcademicEvaluation };
