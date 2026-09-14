# save-all-by-keyword

Lưu mọi thông tin dưới **keyword**, tìm lại trong tích tắc.

Một ô nhập duy nhất: gõ `wifi: Abc123` để lưu, gõ `wi` để tìm. Gợi ý keyword theo prefix, fuzzy (gõ sai vẫn ra) và **semantic** ("gần nghĩa", nhờ pgvector). Nội dung entry được **mã hoá đầu-cuối (E2E)** — key chỉ nằm ở browser của bạn, server không đọc được.

## Điểm chính

- **Web app, online, multi-device**: đăng nhập ở đâu cũng có dữ liệu; unlock bằng encryption passphrase.
- **Keyword plaintext, nội dung ciphertext**: server tìm kiếm/gợi ý trên keyword; nội dung là bí mật của bạn.
- **Stack**: Next.js (App Router, SSR cho landing/docs) · Go (chi + pgx + sqlc + River) · Postgres + pgvector + pg_trgm · libsodium trong browser.
- **i18n**: English (mặc định) và Tiếng Việt.

## Tài liệu

- [`docs/SPEC.md`](docs/SPEC.md) — spec đầy đủ: domain model, kiến trúc, mô hình mã hoá E2E, thiết kế search/suggest, UI/UX, schema, API, roadmap, câu hỏi mở.

## Trạng thái

Đang ở giai đoạn spec (Phase 0). Branch `develop` là nhánh tích hợp, `main` là release.
