const BENCHMARK_QUERIES = [
  // A. Cảnh báo học tập và buộc thôi học (5 câu)
  {
    id: "CA01",
    topic: "Cảnh báo học tập",
    query: "Khi nào số tín chỉ không đạt trong một học kỳ khiến sinh viên bị cảnh báo học tập?",
    gold_rule: "Quy chế đào tạo, Điều 22 khoản 1(a)",
    gold_page: 20,
    check_regex: /vượt quá 50% khối lượng/i
  },
  {
    id: "CA02",
    topic: "Cảnh báo học tập",
    query: "Nợ bao nhiêu tín chỉ từ đầu khóa thì có thể bị cảnh báo học tập?",
    gold_rule: "Quy chế đào tạo, Điều 22 khoản 1(a)",
    gold_page: 20,
    check_regex: /vượt quá 24/i
  },
  {
    id: "CA03",
    topic: "Cảnh báo học tập",
    query: "Mức GPA học kỳ nào dẫn đến cảnh báo học tập?",
    gold_rule: "Quy chế đào tạo, Điều 22 khoản 1(b)",
    gold_page: 20,
    check_regex: /dưới 0,8 đối với học kỳ đầu/i
  },
  {
    id: "CA04",
    topic: "Cảnh báo học tập",
    query: "Sinh viên năm hai có GPA tích lũy dưới mức nào thì bị cảnh báo?",
    gold_rule: "Quy chế đào tạo, Điều 22 khoản 1(c)",
    gold_page: 20,
    check_regex: /1,4 đối với sinh viên trình độ năm thứ hai/i
  },
  {
    id: "CA05",
    topic: "Cảnh báo học tập",
    query: "Bị cảnh báo học tập liên tiếp bao nhiêu lần thì có thể bị buộc thôi học?",
    gold_rule: "Quy chế đào tạo, Điều 22 khoản 2(a)",
    gold_page: 20,
    check_regex: /vượt quá 02 lần cảnh báo/i
  },

  // B. Học bổng khuyến khích học tập (7 câu)
  {
    id: "HB01",
    topic: "Học bổng",
    query: "Điều kiện chung về kết quả học tập, rèn luyện và kỷ luật để được xét học bổng khuyến khích học tập là gì?",
    gold_rule: "Mục 3.3.2, Điều 2 khoản 1",
    gold_page: 132,
    check_regex: /loại Khá trở lên/i
  },
  {
    id: "HB02",
    topic: "Học bổng",
    query: "Sinh viên khóa 2021 trở về sau phải hoàn thành tối thiểu bao nhiêu khối lượng học tập để xét học bổng?",
    gold_rule: "Mục 3.3.2, Điều 2 khoản 2",
    gold_page: 132,
    check_regex: /2\/3 khối lượng học tập/i
  },
  {
    id: "HB03",
    topic: "Học bổng",
    query: "Có học phần dưới điểm C thì sinh viên có được xét học bổng không?",
    gold_rule: "Mục 3.3.2, Điều 2 khoản 3",
    gold_page: 132,
    check_regex: /đạt điểm C trở lên/i
  },
  {
    id: "HB04",
    topic: "Học bổng",
    query: "Sinh viên học kỳ đầu của khóa học có được xét học bổng khuyến khích học tập không?",
    gold_rule: "Mục 3.3.2, Điều 2 khoản 5",
    gold_page: 133,
    check_regex: /học kỳ đầu.*chưa được xét/is
  },
  {
    id: "HB05",
    topic: "Học bổng",
    query: "Sinh viên đang bảo lưu hoặc kéo dài thời gian học có được xét học bổng không?",
    gold_rule: "Mục 3.3.2, Điều 1",
    gold_page: 132,
    check_regex: /kéo dài thời gian học.*không được xét/is
  },
  {
    id: "HB06",
    topic: "Học bổng",
    query: "Học bổng loại Giỏi bằng bao nhiêu phần trăm học bổng loại Khá?",
    gold_rule: "Mục 3.3.2, Điều 3 khoản 2",
    gold_page: 133,
    check_regex: /110%/i
  },
  {
    id: "HB07",
    topic: "Học bổng",
    query: "Quỹ học bổng khuyến khích học tập được trích tối thiểu bao nhiêu phần trăm từ nguồn thu học phí?",
    gold_rule: "Mục 3.3.2, Điều 4",
    gold_page: 133,
    check_regex: /tối thiểu bằng 8%/i
  },

  // C. Điều kiện dự thi và hoãn thi (7 câu)
  {
    id: "THI01",
    topic: "Dự thi và hoãn thi",
    query: "Việc chưa hoàn thành học phí có ảnh hưởng đến quyền dự thi kết thúc học phần không?",
    gold_rule: "Quy định tổ chức thi, Điều 6 khoản 2",
    gold_page: 37,
    check_regex: /chưa đóng học phí.*xử lý không cho thi/is
  },
  {
    id: "THI02",
    topic: "Dự thi và hoãn thi",
    query: "Nếu chưa thể đóng học phí vì lý do chính đáng thì sinh viên cần làm gì?",
    gold_rule: "Quy định tổ chức thi, Điều 6 khoản 2",
    gold_page: 37,
    check_regex: /xin gia hạn thời gian nộp học phí/i
  },
  {
    id: "THI03",
    topic: "Dự thi và hoãn thi",
    query: "Muốn dự thi, ngoài đủ điều kiện học phần thì sinh viên cần có tên ở đâu?",
    gold_rule: "Quy định tổ chức thi, Điều 6 khoản 3",
    gold_page: 37,
    check_regex: /danh sách thi do phòng KT&ĐBCLGD lập/i
  },
  {
    id: "THI04",
    topic: "Dự thi và hoãn thi",
    query: "Sau khi vắng thi vì lý do chính đáng, sinh viên có bao nhiêu ngày để nộp đơn xin hoãn thi và nộp ở đâu?",
    gold_rule: "Quy định tổ chức thi, Điều 7 khoản 1",
    gold_page: 37,
    check_regex: /07 ngày làm\s+việc kể từ ngày thi/i
  },
  {
    id: "THI05",
    topic: "Dự thi và hoãn thi",
    query: "Sinh viên đã được hoãn thi muốn dự thi lại phải nộp đơn trước ngày thi bao lâu?",
    gold_rule: "Quy định tổ chức thi, Điều 7 khoản 2",
    gold_page: 37,
    check_regex: /trước ngày thi ít nhất là 07 ngày làm việc/i
  },
  {
    id: "THI06",
    topic: "Dự thi và hoãn thi",
    query: "Sinh viên được nhận điểm I (hoãn thi) phải hoàn tất học phần đó trong tối đa bao nhiêu học kỳ chính?",
    gold_rule: "Quy định tổ chức thi, Điều 5 khoản 1",
    gold_page: 36,
    check_regex: /tối\s+đa là 02 học kỳ chính tiếp theo/i
  },
  {
    id: "THI07",
    topic: "Dự thi và hoãn thi",
    query: "Lịch thi được công bố chậm nhất trước đợt thi bao lâu?",
    gold_rule: "Quy định tổ chức thi, Điều 8 khoản 4",
    gold_page: 38,
    check_regex: /chậm nhất 03 tuần trước ngày bắt đầu đợt thi/i
  },

  // D. Chuẩn đầu ra ngoại ngữ (6 câu)
  {
    id: "NN01",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Những chứng chỉ tiếng Anh quốc tế nào được công nhận để xét chuẩn đầu ra ngoại ngữ?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 4 khoản 3",
    gold_page: 64,
    check_regex: /Linguaskill/i
  },
  {
    id: "NN02",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Chứng chỉ ngoại ngữ phải còn thời hạn bao lâu tại thời điểm nộp?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 6",
    gold_page: 65,
    check_regex: /02\s*năm tính từ ngày cấp/i
  },
  {
    id: "NN03",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Sinh viên có thể nộp chứng chỉ xét chuẩn đầu ra vào những thời điểm nào?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 6",
    gold_page: 65,
    check_regex: /trong vòng 15 ngày/i
  },
  {
    id: "NN04",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Sau khi chứng chỉ được hậu kiểm và công nhận, kết quả có hiệu lực trong bao lâu?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 6",
    gold_page: 65,
    check_regex: /hiệu lực trong toàn khoá học/i
  },
  {
    id: "NN05",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Chỉ có tên chứng chỉ trong danh mục thì đã đủ để được công nhận chuẩn đầu ra chưa?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 7",
    gold_page: 65,
    check_regex: /Phụ lục II\.[1-4]/i
  },
  {
    id: "NN06",
    topic: "Chuẩn đầu ra ngoại ngữ",
    query: "Ngoài việc nộp chứng chỉ, trường hợp nào sinh viên có thể được xét công nhận tương đương chuẩn đầu ra ngoại ngữ?",
    gold_rule: "Quy định chuẩn đầu ra ngoại ngữ, Điều 8",
    gold_page: 65,
    check_regex: /ngành ngôn ngữ nước ngoài|sư phạm ngôn ngữ nước ngoài/i
  },

  // E. Học lực, tín chỉ và tốt nghiệp (5 câu)
  {
    id: "E01",
    topic: "Học lực, tín chỉ, tốt nghiệp",
    query: "Điểm trung bình tích lũy đạt từ mức nào trở lên để sinh viên được xếp hạng “bình thường” trên thang 4.0?",
    gold_rule: "Quy chế đào tạo, Điều 21 khoản 2",
    gold_page: 20,
    check_regex: /Hạng bình thường.*2,0/i
  },
  {
    id: "E02",
    topic: "Học lực, tín chỉ, tốt nghiệp",
    query: "Khối lượng tối đa được công nhận, chuyển đổi tín chỉ là bao nhiêu phần trăm chương trình đào tạo?",
    gold_rule: "Quy chế đào tạo, Điều 23 khoản 3",
    gold_page: 21,
    check_regex: /không vượt quá 50% khối lượng/i
  },
  {
    id: "E03",
    topic: "Học lực, tín chỉ, tốt nghiệp",
    query: "Điều kiện để sinh viên làm khoá luận tốt nghiệp thay vì học hai học phần chuyên môn cuối khoá là gì?",
    gold_rule: "Quy chế đào tạo, Điều 25 khoản 2",
    gold_page: 21,
    check_regex: /trừ thực tập tốt nghiệp/i
  },
  {
    id: "E04",
    topic: "Học lực, tín chỉ, tốt nghiệp",
    query: "Điều kiện để đăng ký thực tập tốt nghiệp là gì?",
    gold_rule: "Quy chế đào tạo, Điều 24 khoản 1",
    gold_page: 21,
    check_regex: /trừ học phần chuyên môn, khóa luận/i
  },
  {
    id: "E05",
    topic: "Học lực, tín chỉ, tốt nghiệp",
    query: "Thời gian ôn thi kết thúc học phần được bố trí tối thiểu bao nhiêu cho mỗi tín chỉ?",
    gold_rule: "Quy định tổ chức thi, Điều 5 khoản 2",
    gold_page: 36,
    check_regex: /2\/3 ngày cho một tín chỉ/i
  }
];

module.exports = { BENCHMARK_QUERIES };
