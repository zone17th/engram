# engram

> Một phần trí nhớ của bạn, được lưu bên ngoài đầu — với phần nội dung riêng tư chỉ bạn mới đọc được.

**engram** là web app để lưu những mẩu thông tin nhỏ và tìm lại thật nhanh. Mỗi thông tin là một **mục (Item)** có tên, tag và các entry `text` hoặc `json`. Mọi thao tác đi qua một ô nhập duy nhất:

- `wifi: Abc123` — lưu nhanh một đoạn văn bản;
- `wi` — tìm theo tên mục hoặc tag;
- `#nhà` — lọc theo tag.

## Tính năng chính

- **Tìm kiếm ba lớp** trên tên mục và tag: prefix, fuzzy và semantic. Kết quả khớp trực tiếp luôn đứng trước; semantic có thể tắt.
- **Mã hoá đầu-cuối thân entry.** Tên mục, tag và kiểu entry để plaintext để server tìm được; nội dung text/JSON chỉ trình duyệt của bạn đọc được.
- **Vault** mở bằng passphrase (Argon2id), 10 recovery key dùng một lần, passkey (WebAuthn PRF) hoặc thiết bị đã nhớ.
- Giao diện English (mặc định) và Tiếng Việt.

## Công nghệ

- Web: Next.js 15, crypto chạy trong Web Worker (libsodium).
- API và worker: Go (chi, pgx, sqlc, River).
- Dữ liệu: PostgreSQL 16 với pgvector và pg_trgm.
- Embedding: `noop` (mặc định), TEI tự host hoặc API tương thích OpenAI ([ADR 0004](docs/adr/0004-embedding-provider-openai-compat.md)).

## Cấu trúc repo

| Thư mục | Nội dung |
|---|---|
| `apps/web` | Frontend Next.js |
| `apps/api` | API, worker và migration (Go) |
| `packages/shared-types` | Kiểu TypeScript sinh từ OpenAPI |
| `infra` | Docker Compose và image pin |
| `scripts` | Dev stack, smoke, e2e, sinh secret |
| `docs` | SPEC, kế hoạch theo phase, ADR |
| `mockups` | Mockup UI tĩnh |

## Chạy tại máy

Yêu cầu: Node ≥ 20.19, pnpm 10.34.5, Go 1.26+, Docker với Compose.

```bash
git clone https://github.com/zone17th/engram.git
cd engram
cp .env.example .env               # PowerShell: Copy-Item .env.example .env
pnpm install
node scripts/gen-dev-secrets.mjs   # tuỳ chọn: sinh secret AUTH_* cho .env
```

Toàn bộ trong Docker:

```bash
pnpm stack:up     # db + migrate + api + worker + web
pnpm smoke        # kiểm tra nhanh
pnpm stack:down
```

Hoặc chỉ DB trong Docker, phần còn lại chạy trên máy:

```bash
pnpm dev:stack    # hoặc: make dev
```

Mở <http://localhost:3000>. Trình duyệt chỉ nói chuyện với origin này; Next chuyển `/api/*` sang Go.

Không cần TEI hay OAuth thật để chạy local: `EMBEDDING_PROVIDER=noop` là mặc định, `AUTH_FAKE_OAUTH=true` (chỉ development/e2e) giả lập Google/GitHub, mail xác thực được ghi ra `.data/mail-sink`.

## Kiểm thử

```bash
cd apps/api && go test ./... -short   # không cần Docker
cd apps/api && go test ./...          # cần Docker (testcontainers)
pnpm -r test                          # test web và packages
pnpm e2e                              # Playwright, ma trận auth
```

## Tài liệu

- [`docs/SPEC.md`](docs/SPEC.md) — đặc tả sản phẩm: domain, kiến trúc, mã hoá, tìm kiếm, UI, schema, API.
- [`docs/phases/`](docs/phases/README.md) — kế hoạch P01–P08 (MVP là P01–P06).
- [`docs/adr/`](docs/adr/) — các quyết định kiến trúc.
- [`mockups/`](mockups/README.md) — chuẩn bố cục và thị giác. Xem bằng `python -m http.server 5178 --directory mockups`.

## Trạng thái

- P01 (nền tảng) và P02 (tài khoản, session) đã vào `develop`; P03 (vault và recovery) đang làm.
- `develop` là nhánh tích hợp, `main` là nhánh release.

## Tên gọi

Trong thần kinh học, **engram** là dấu vết mà một ký ức để lại. Tên luôn viết thường: `engram`. Module Go/pnpm còn giữ đường dẫn cũ `save-all-by-keyword`.
