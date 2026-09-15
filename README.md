# engram

> Một phần trí nhớ của bạn, được lưu bên ngoài đầu — với phần nội dung riêng tư chỉ bạn mới đọc được.

**engram** là một web app giúp bạn lưu lại những mẩu thông tin nhỏ và tìm chúng thật nhanh khi cần. Mỗi thông tin nằm trong một **mục (Item)**, có tên, tag và các entry theo kiểu dữ liệu phù hợp.

Bạn chỉ cần một ô nhập duy nhất:

- `wifi: Abc123` để lưu nhanh một đoạn văn bản;
- `wi` để tìm theo tên mục hoặc tag;
- `#nhà` để lọc theo tag.

Gợi ý tìm kiếm kết hợp prefix, fuzzy và semantic search. Embedding được tự host bằng TEI với model `BAAI/bge-m3`, nên dữ liệu không phải đi qua OpenAI, Gemini hay Cohere.

## engram làm gì?

### Lưu được những thứ nhỏ nhưng quan trọng

Một Item có thể có nhiều tag và nhiều entry. Ở MVP, entry hỗ trợ hai kiểu:

- `text` cho ghi chú hoặc nội dung tự do;
- `json` cho dữ liệu có cấu trúc, được hiển thị dưới dạng bảng lồng nhau.

Tên mục có thể trùng nhau; tag được chuẩn hoá và duy trì tính duy nhất. Cách tổ chức này phù hợp với những thứ thường được lưu rải rác như thông tin Wi-Fi, cấu hình, ghi chú công việc hoặc các mẩu dữ liệu cần tìm lại sau này.

### Tìm lại từ những gì bạn còn nhớ

Search của engram chạy trên tên mục và tag, kết hợp ba lớp:

1. **Prefix** — tìm ngay khi bạn mới gõ vài ký tự.
2. **Fuzzy** — vẫn tìm được khi gõ thiếu hoặc sai một chút.
3. **Semantic** — hiểu những cụm từ gần nghĩa, chẳng hạn tìm “mật khẩu wifi” có thể gợi ra mục `wifi-password` hoặc tag `mạng-nhà`.

Kết quả semantic được bổ sung sau kết quả lexical để những gì khớp trực tiếp vẫn xuất hiện trước. Bạn có thể tắt semantic cho từng lần tìm bằng nút `≈` hoặc trong phần cài đặt; việc lập chỉ mục vẫn tiếp tục chạy. Ở cấp deployment, có thể tắt hoàn toàn cả hai phần semantic và indexing.

## Riêng tư và mã hoá

engram mã hoá đầu-cuối **thân của entry** — phần text hoặc JSON mà bạn lưu. `name`, tag và kiểu entry vẫn ở dạng plaintext để server có thể thực hiện tìm kiếm.

Vault được mở từ passphrase thông qua Argon2id và KEK bọc Vault Key. Người dùng cũng có thể mở vault bằng một trong 10 recovery key hoặc passkey (WebAuthn PRF). Recovery key chỉ dùng một lần trên live server; việc xoá bản wrap của recovery key hoặc passkey không xoá các bản sao đã có trong backup.

Khi cần, bạn có thể đặt passphrase mới sau khi xác thực lại tài khoản bằng Vault Key từ passkey, thiết bị đã nhớ hoặc phiên đang mở. Reset vault sẽ xoá các entry nhưng giữ lại item và tag.

engram không dùng BIP39 và không phụ thuộc KMS bên ngoài.

## Tài liệu và mockup

- [`docs/SPEC.md`](docs/SPEC.md) — đặc tả sản phẩm: domain model, kiến trúc, E2E, search, UI, schema, API và roadmap.
- [`docs/phases/`](docs/phases/README.md) — kế hoạch triển khai P01–P08, trong đó MVP là P01–P06.
- [`mockups/`](mockups/README.md) — bộ mockup UI tĩnh cho landing, tìm kiếm, chi tiết item, cài đặt, đăng nhập, onboarding, mở khoá, khôi phục và các trạng thái lỗi.
- [`clickup.design.md`](clickup.design.md) — nguồn token thị giác được dùng cho mockup.

Để xem mockup cục bộ:

```bash
python -m http.server 5178 --directory mockups
```

Sau đó mở <http://localhost:5178/landing.html>. Mockup là chuẩn tham chiếu cho bố cục và thị giác; spec là nguồn chính cho hành vi và dữ liệu.

## Trạng thái phát triển

engram hiện đang ở **Phase 0 — giai đoạn đặc tả**.

- `develop` là nhánh tích hợp.
- `main` là nhánh release.
- Sản phẩm dự kiến là web app online-only, multi-user, xây dựng với Next.js 15, Go (chi, pgx, sqlc, River) và PostgreSQL 16 (pgvector, pg_trgm).
- Giao diện hỗ trợ English (mặc định) và Tiếng Việt.

## Về tên gọi

Trong thần kinh học, **engram** là dấu vết vật lý mà một ký ức để lại. Cái tên này gợi đúng điều sản phẩm muốn làm: ghi lại một dấu vết nhỏ để lần sau có thể tìm về, ngay cả khi bạn chỉ còn nhớ một phần.

Tên được viết thường trong mọi ngữ cảnh: `engram`, không phải `Engram` hay `ENGRAM`.

Tên repo hiện vẫn là `save-all-by-keyword` vì lý do lịch sử; domain đang dùng tạm là `key.zone17th.click`. Trước khi in ấn hoặc đăng ký chính thức, cần kiểm tra thêm domain và nhãn hiệu.
