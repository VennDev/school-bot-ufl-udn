# school-bot (Messenger Chatbot)

Cổng chatbot Messenger quản lý thông tin & tăng hiệu suất cho sinh viên UFL (sinhvien.ufl.udn.vn) sử dụng Express, SQLite, Playwright + Tor, và OpenCode Free AI API.

## Tính năng

1. **Messenger Webhook**: Xử lý tin nhắn và postback từ Facebook.
2. **Webview UI**: Giao diện responsive (Tailwind CSS) để sinh viên kết nối tài khoản UFL và cấu hình nhận thông báo (GPA, học phí, lịch học, lịch thi).
3. **Scraper Engine tự động**: 
   - Scrape 8 trang: Lịch học, Lịch thi, Điểm, Điểm rèn luyện, Học phí, Cảnh báo học vụ, Học bổng/KT/KL, Lý lịch.
   - Xoay IP Tor tự động, chạy song song nhiều account (mỗi account 1 instance Tor).
   - Tự động chạy ngầm mỗi 4 tiếng (cron job).
4. **Bộ phát hiện thay đổi (Change Detector)**: Gửi tin nhắn alert tức thì lên Messenger khi có điểm mới, đổi phòng thi, nợ học phí hoặc báo nghỉ học.
5. **Trợ lý AI (OpenCode Free API)**:
   - Sử dụng các model miễn phí như `deepseek-v4-flash-free` hoặc `nemotron-3-ultra-free` để chat.
   - Tự động tóm tắt tuần (lịch học, lịch thi sắp tới, nhắc học phí và các việc cần ưu tiên).
6. **Mã hóa AES-256-GCM**: Bảo vệ mật khẩu sinh viên trong database.

## Yêu cầu

- Node.js >= 18
- Tor (bật ControlPort 9051)

## Cài đặt

```bash
npm install
npx playwright install chromium
```

### 1. Cấu hình Tor ControlPort (để tự động đổi IP)

```bash
sudo sh -c 'echo -e "\nControlPort 9051\nCookieAuthentication 0" >> /etc/tor/torrc'
sudo systemctl restart tor
```

### 2. Cấu hình biến môi trường

Sao chép `.env.example` thành `.env` và điền thông tin:

```bash
cp .env.example .env
```

Sửa `.env`:
- `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`: Token ứng dụng Facebook Messenger.
- `ENCRYPTION_KEY`: Khóa 32-byte hex dùng mã hóa mật khẩu.
- `OPENCODE_API_KEY`: Mặc định là `public`.

## Khởi chạy

### Chạy Server & Scheduler tự động

```bash
npm start
```
Server chạy tại port cấu hình (mặc định 3000), đồng thời kích hoạt cron job chạy scraper định kỳ mỗi 4 tiếng.

### Test đăng nhập & Scrape thủ công

```bash
# Chạy scraper tuần tự
npm run scrape

# Chạy scraper song song các account
npm run scrape:parallel
```

## Dữ liệu đầu ra

Tất cả dữ liệu lưu trong file SQLite: `data/database.sqlite` (không sợ lộ file JSON tĩnh ra ngoài).

## Cấu trúc project

```
school-bot/
├── .env.example
├── .env                 # (Không commit)
├── package.json
├── public/
│   └── index.html       # Webview UI cài đặt & login
├── src/
│   ├── server.js        # Express Server Webhook & Webview APIs
│   ├── botRouter.js     # Điều hướng tin nhắn & Prompt AI
│   ├── changeDetector.js# Logic so sánh dữ liệu mới/cũ -> alerts
│   ├── cron.js          # Scheduler chạy ngầm định kỳ
│   ├── db.js            # SQLite database helper (node:sqlite native)
│   ├── crypto.js        # Mã hóa AES-256-GCM
│   ├── pages.js         # Selector / Parser 8 trang UFL
│   ├── tor.js           # Multi-instance Tor manager
│   └── ai.js            # Kết nối OpenCode AI API
└── data/                # Chứa SQLite database (auto-created)
```

## Bảo mật

- Mật khẩu lưu vào database luôn được mã hóa 2 chiều AES-256-GCM thông qua `ENCRYPTION_KEY`.
- Không bao giờ log mật khẩu ra màn hình.
- File `.env`, `.tor-instances/` và thư mục `data/` chứa database đã được cấu hình trong `.gitignore`.
