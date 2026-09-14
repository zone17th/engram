# save-all-by-keyword

Lưu mọi thông tin theo **mục (Item)**: một tên (`name`), nhiều **tag**, nhiều **entry có kiểu** — rồi tìm lại trong tích tắc.

Một ô nhập: gõ `wifi: Abc123` để lưu văn bản, gõ `wi` để tìm **tên mục và tag**, gõ `#nhà` để lọc theo tag. Gợi ý theo prefix, fuzzy, và **semantic** (TEI self-host, `BAAI/bge-m3`). Chỉ **thân entry** (text hoặc JSON) được **mã hoá đầu-cuối** — `name` và tag là plaintext để search chạy được.

Tên repo giữ `save-all-by-keyword` (lịch sử). Thực thể chính không còn là "keyword": xem [glossary trong spec](docs/SPEC.md#14-glossary).

## Điểm chính

- **Web, online-only, multi-user**: Next.js 15 + Go (chi, pgx, sqlc, River) + Postgres 16 (pgvector, pg_trgm). Domain tạm `key.zone17th.click`.
- **Item + Tag + typed Entry**: `name` được trùng; tag unique theo dạng chuẩn hoá; entry thuộc đúng một mục. MVP: `text` và `json` (bảng lồng nhau + import JSON).
- **E2E chỉ body**: quên encryption passphrase = mất nội dung; không recovery key. Reset vault xoá entry, giữ item và tag.
- **Search lai**: lexical + semantic trên name và tag; tắt semantic bằng env, setting user, hoặc nút `≈` trên omnibox.
- **Miễn phí**, không gói trả phí. Embedding không gửi ra OpenAI/Gemini/Cohere.
- **i18n**: English (mặc định) và Tiếng Việt.

## Tài liệu

- [`docs/SPEC.md`](docs/SPEC.md) — spec đầy đủ: domain model, kiến trúc, E2E, search, UI (omnibox + JSON table), schema, API, roadmap, câu hỏi mở.

## Trạng thái

Đang ở giai đoạn spec (Phase 0). Branch `develop` là nhánh tích hợp, `main` là release.
