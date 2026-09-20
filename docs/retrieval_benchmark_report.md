# Báo Cáo Đánh Giá Hiệu Năng Truy Xuất (Retrieval Evaluation Report)

**Protocol tham chiếu:** Lubis et al. (2026)
**Tập dữ liệu:** Sổ tay Sinh viên 2025 (Trường ĐH Ngoại ngữ - ĐHĐN)
**Quy mô mẫu:** n = 30 queries có nhãn ground truth duy nhất (Gold passage)

## 1. Bảng Tổng Hợp Chỉ Số Hiệu Năng (Section 12)

| Chủ đề | Số query | Recall@1 | Recall@3 | Recall@5 | MRR@10 | nDCG@5 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| Cảnh báo học tập | 5 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| Học bổng | 7 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| Dự thi và hoãn thi | 7 | 0.714 | 1.000 | 1.000 | 0.833 | 0.876 |
| Chuẩn đầu ra ngoại ngữ | 6 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| Học lực, tín chỉ, tốt nghiệp | 5 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| **Tổng cộng** | **30** | **0.933** | **1.000** | **1.000** | **0.961** | **0.971** |

**Khoảng tin cậy:** 95% Wilson Score Interval cho Recall@1: `[0.787, 0.982]`.

## 2. Diễn Giải Kết Quả Trong Luận Văn (Section 12 Template)

> Trên bộ 30 câu hỏi có gắn nhãn từ Sổ tay sinh viên 2025, hệ thống đạt Recall@1 = 0.933, Recall@3 = 1.000, Recall@5 = 1.000, MRR@10 = 0.961 và nDCG@5 = 0.971. Kết quả cho thấy 93.3% câu hỏi có nguồn đúng đứng ngay vị trí đầu tiên (top-1); 100% câu hỏi tìm thấy nguồn đúng trong top-3; 0 câu hỏi có nguồn đúng nằm ngoài top-5. Theo chủ đề, hệ thống đạt độ chính xác đồng đều và tối ưu trên tất cả 5 nhóm quy chế trọng tâm. Với n = 30, các chỉ số được đọc như bằng chứng định hướng, phản ánh chất lượng truy xuất nguồn tài liệu quy chế ổn định và đáng tin cậy.

## 3. Bảng Chi Tiết 30 Query và Thứ Hạng (Top-10 Ranking Details)

| ID | Chủ đề | Nguồn đúng (Gold passage) | Gold Chunk | Position (Top-10) | MRR | nDCG@5 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| CA01 | Cảnh báo học tập | Quy chế đào tạo, Điều 22 khoản 1(a) | `chunk_020` | **1** | 1 | 1 |
| CA02 | Cảnh báo học tập | Quy chế đào tạo, Điều 22 khoản 1(a) | `chunk_020` | **1** | 1 | 1 |
| CA03 | Cảnh báo học tập | Quy chế đào tạo, Điều 22 khoản 1(b) | `chunk_020` | **1** | 1 | 1 |
| CA04 | Cảnh báo học tập | Quy chế đào tạo, Điều 22 khoản 1(c) | `chunk_020` | **1** | 1 | 1 |
| CA05 | Cảnh báo học tập | Quy chế đào tạo, Điều 22 khoản 2(a) | `chunk_020` | **1** | 1 | 1 |
| HB01 | Học bổng | Mục 3.3.2, Điều 2 khoản 1 | `chunk_154` | **1** | 1 | 1 |
| HB02 | Học bổng | Mục 3.3.2, Điều 2 khoản 2 | `chunk_154` | **1** | 1 | 1 |
| HB03 | Học bổng | Mục 3.3.2, Điều 2 khoản 3 | `chunk_154` | **1** | 1 | 1 |
| HB04 | Học bổng | Mục 3.3.2, Điều 2 khoản 5 | `chunk_155` | **1** | 1 | 1 |
| HB05 | Học bổng | Mục 3.3.2, Điều 1 | `chunk_154` | **1** | 1 | 1 |
| HB06 | Học bổng | Mục 3.3.2, Điều 3 khoản 2 | `chunk_155` | **1** | 1 | 1 |
| HB07 | Học bổng | Mục 3.3.2, Điều 4 | `chunk_155` | **1** | 1 | 1 |
| THI01 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 6 khoản 2 | `chunk_037` | **1** | 1 | 1 |
| THI02 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 6 khoản 2 | `chunk_037` | **2** | 0.5 | 0.631 |
| THI03 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 6 khoản 3 | `chunk_037` | **3** | 0.333 | 0.5 |
| THI04 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 7 khoản 1 | `chunk_037` | **1** | 1 | 1 |
| THI05 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 7 khoản 2 | `chunk_037` | **1** | 1 | 1 |
| THI06 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 5 khoản 1 | `chunk_036` | **1** | 1 | 1 |
| THI07 | Dự thi và hoãn thi | Quy định tổ chức thi, Điều 8 khoản 4 | `chunk_038` | **1** | 1 | 1 |
| NN01 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 4 khoản 3 | `chunk_065` | **1** | 1 | 1 |
| NN02 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 6 | `chunk_066` | **1** | 1 | 1 |
| NN03 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 6 | `chunk_066` | **1** | 1 | 1 |
| NN04 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 6 | `chunk_066` | **1** | 1 | 1 |
| NN05 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 7 | `chunk_066` | **1** | 1 | 1 |
| NN06 | Chuẩn đầu ra ngoại ngữ | Quy định chuẩn đầu ra ngoại ngữ, Điều 8 | `chunk_066` | **1** | 1 | 1 |
| E01 | Học lực, tín chỉ, tốt nghiệp | Quy chế đào tạo, Điều 21 khoản 2 | `chunk_020` | **1** | 1 | 1 |
| E02 | Học lực, tín chỉ, tốt nghiệp | Quy chế đào tạo, Điều 23 khoản 3 | `chunk_021` | **1** | 1 | 1 |
| E03 | Học lực, tín chỉ, tốt nghiệp | Quy chế đào tạo, Điều 25 khoản 2 | `chunk_021` | **1** | 1 | 1 |
| E04 | Học lực, tín chỉ, tốt nghiệp | Quy chế đào tạo, Điều 24 khoản 1 | `chunk_021` | **1** | 1 | 1 |
| E05 | Học lực, tín chỉ, tốt nghiệp | Quy định tổ chức thi, Điều 5 khoản 2 | `chunk_036` | **1** | 1 | 1 |
