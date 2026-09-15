# engram

Một phần trí nhớ của bạn, đặt ở ngoài đầu bạn — và không ai đọc được ngoài bạn.

Lưu mọi thông tin theo **mục (Item)**: một tên (`name`), nhiều **tag**, nhiều **entry có kiểu** — rồi tìm lại trong tích tắc.

Một ô nhập: gõ `wifi: Abc123` để lưu văn bản, gõ `wi` để tìm **tên mục và tag**, gõ `#nhà` để lọc theo tag. Gợi ý theo prefix, fuzzy, và **semantic** (TEI self-host, `BAAI/bge-m3`). Chỉ **thân entry** (text hoặc JSON) được **mã hoá đầu-cuối** — `name` và tag là plaintext để search chạy được.

## Tên

**engram** — trong thần kinh học là **dấu vết vật lý mà một ký ức để lại**: thứ được ghi xuống để lần sau tìm về được.

Viết thường trong mọi ngữ cảnh: `engram`. Không `Engram`, không `ENGRAM`.

Chọn từ này vì ba lý do:

- **Đúng thứ sản phẩm bán.** Chỗ chứa thì Notes, Keep, Notion đều có; lưu được không phải điểm khác biệt. Thứ khác biệt là **tìm lại được từ mảnh vụn bạn còn giữ** — nhớ một từ, sai dấu cũng được, là đủ. Đó đúng là cách trí nhớ người hoạt động, và là lý do có cả prefix, fuzzy lẫn gần nghĩa.
- **Đúng kiến trúc đã chọn.** Một entry chính là một dấu vết: thân mã hoá, còn `name` và tag để trần làm đường dẫn tìm về. Và mã hoá là thứ *cho phép* nói câu "một phần trí nhớ" — không ai đổ hết mọi thứ vào một cái app mà người khác đọc được.
- **Đọc được ở cả hai ngôn ngữ.** "en-gram" — không cụm phụ âm lạ, kết thúc bằng `m` là âm tiếng Việt có sẵn, nghe xong viết lại đúng chính tả.

Đã cân nhắc và loại:

- `keyword` — chỉ tả cơ chế, quá phổ thông để sở hữu hay làm SEO.
- `khoá` — mạnh trong tiếng Việt (*từ khoá* + *khoá* mã hoá, đúng hai nửa sản phẩm trong một âm tiết) nhưng người ngoài không đọc và không gõ được dấu.

Cần biết khi dùng tên:

- Tên repo giữ `save-all-by-keyword` vì lịch sử. Domain tạm `key.zone17th.click`.
- Ở Mỹ, "engram" cũng là thuật ngữ trung tâm của Scientology. Không phải rủi ro pháp lý, nhưng là nhiễu cần lường khi viết nội dung tiếng Anh.
- **Chưa tra domain và nhãn hiệu** — phải kiểm trước khi in hay đăng ký gì.
- Thực thể chính trong code không còn là "keyword": xem [glossary trong spec](docs/SPEC.md#14-glossary).

## Điểm chính

- **Web, online-only, multi-user**: Next.js 15 + Go (chi, pgx, sqlc, River) + Postgres 16 (pgvector, pg_trgm). Domain tạm `key.zone17th.click`.
- **Item + Tag + typed Entry**: `name` được trùng; tag unique theo dạng chuẩn hoá; entry thuộc đúng một mục. MVP: `text` và `json` (bảng lồng nhau + import JSON).
- **E2E chỉ body**: passphrase → Argon2id → KEK bọc Vault Key; **10 recovery key** và **passkey (WebAuthn PRF)** cũng mở vault. Còn VK qua passkey/thiết bị đã nhớ/phiên đang mở thì có thể đặt passphrase mới sau re-auth tài khoản. RK dùng một lần trên live server; xoá RK/passkey wrap không vô hiệu hoá bản copy trong backup. Reset vault xoá entry, giữ item và tag. Không BIP39, không KMS ngoài.
- **Search lai**: lexical + semantic trên name và tag; semantic đến sau giữ nguyên vị trí kết quả lexical. Setting user hoặc nút `≈` tắt semantic khi tìm kiếm, còn indexing vẫn chạy; env deployment có thể tắt cả hai.
- **Miễn phí**, không gói trả phí. Embedding không gửi ra OpenAI/Gemini/Cohere.
- **i18n**: English (mặc định) và Tiếng Việt.

## Tài liệu

- [`docs/SPEC.md`](docs/SPEC.md) — spec đầy đủ: domain model, kiến trúc, E2E (passphrase, 10 recovery key, passkey PRF), search, UI, schema, API, roadmap.
- [`docs/phases/`](docs/phases/README.md) — spec triển khai P01–P08: phạm vi, phụ thuộc, mockup ownership, contract và acceptance. MVP là P01–P06.
- [`mockups/`](mockups/README.md) — mockup UI tĩnh (landing, tìm kiếm, chi tiết mục, cài đặt, đăng nhập, onboarding, mở khoá, khôi phục, trạng thái lỗi, tài liệu). Chạy bằng `python -m http.server 5178 --directory mockups`. **Đây là tiêu chuẩn thiết kế**: plan và implementation bám theo bộ này.
- [`clickup.design.md`](clickup.design.md) — nguồn token thị giác mà mockup lấy tầng chức năng từ đó.

## Trạng thái

Đang ở giai đoạn spec (Phase 0). Branch `develop` là nhánh tích hợp, `main` là release.
