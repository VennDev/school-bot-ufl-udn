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

module.exports = { calculateGPA, getGradePoints };
