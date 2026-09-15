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

## Chạy tại máy

Yêu cầu: Node ≥ 20.19, pnpm 10.34.5, Go 1.27 (hoặc `GOTOOLCHAIN=auto` với `go` 1.25+ theo `apps/api/go.mod`), Docker + plugin Compose (`docker compose`).

```bash
git clone https://github.com/zone17th/engram.git
cd engram
cp .env.example .env
pnpm install
```

PowerShell tương đương với lệnh sao chép đầu tiên là `Copy-Item .env.example .env`.
Các lệnh host dev đọc `.env` làm giá trị mặc định; biến đã có trong shell vẫn được giữ
nguyên để dễ override cục bộ.

### Cách 1 — toàn bộ trong Docker

```bash
pnpm stack:up     # db + migrate + api + worker + web
pnpm smoke        # kiểm tra nhanh
```

Mở http://localhost:3000. Dừng bằng `pnpm stack:down`.
`pnpm smoke` dùng Node, tự chờ có giới hạn để stack detached kịp sẵn sàng và không cần
Bash trên Windows.

### Cách 2 — chỉ DB trong Docker, phần còn lại chạy trên máy

```bash
make dev
```

`make dev` và `pnpm dev:stack` đều khởi động DB, chạy migration, API, worker và Next
dev bằng cùng một env loader. Trên Windows (không có `make`), dùng:

```powershell
pnpm dev:stack
```

Nếu cần chạy từng tiến trình để debug, nạp env vào từng terminal PowerShell bằng cách
dot-source helper trước lệnh Go hoặc pnpm:

```powershell
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml up -d db
```

```powershell
. .\scripts\load-env.ps1
Set-Location apps/api
go run ./cmd/migrate up
go run ./cmd/api
```

```powershell
. .\scripts\load-env.ps1
Set-Location apps/api
go run ./cmd/worker
```

```powershell
. .\scripts\load-env.ps1
pnpm --filter @engram/web dev
```

Chạy riêng migration bằng `make migrate` hoặc `pnpm migrate` sau khi DB đã sẵn sàng.

**Không cần TEI hay OAuth thật để xem landing.** `EMBEDDING_PROVIDER=noop` là mặc định;
tìm kiếm ngữ nghĩa sẽ hiển thị là chưa khả dụng, đúng như thực tế.

Muốn thử TEI (tải model ~2 GB):

```bash
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml --profile semantic up -d tei
EMBEDDING_PROVIDER=tei TEI_URL=http://tei:80 pnpm stack:up
```

Trong PowerShell, đặt override trước khi chạy stack:

```powershell
$env:EMBEDDING_PROVIDER = 'tei'
$env:TEI_URL = 'http://tei:80'
pnpm stack:up
```

Các lệnh trên dành cho full Compose, nên API/worker dùng DNS nội bộ `tei:80`. Nếu
chạy API và worker trên máy với `pnpm dev:stack`, dùng `TEI_URL=http://localhost:8081`
và giữ cổng `8081:80` của service `tei`.

### Kiểm thử

```bash
cd apps/api && go test ./... -short     # không cần Docker
```

```bash
cd apps/api && go test ./...            # cần Docker (testcontainers)
```

```bash
pnpm -r test
```

```bash
pnpm --filter @engram/web exec playwright install chromium
pnpm --filter @engram/web e2e
```

### Một origin duy nhất

Trình duyệt chỉ nói chuyện với `http://localhost:3000`. Next chuyển tiếp `/api/*`
sang Go (`API_UPSTREAM`, mặc định host dev là `http://127.0.0.1:8080`; Compose build
được truyền `http://api:8080`). Đừng gọi thẳng cổng 8080
từ trình duyệt — cookie phiên có path `/api` và CSP chỉ cho `connect-src 'self'`.
Full Compose chỉ cần `COMPOSE_API_UPSTREAM` khi cố ý đổi DNS mặc định; không dùng
`API_UPSTREAM` của host dev cho container.

## Trạng thái phát triển

Implementation P01 (nền tảng và UI shell) đã được tích hợp vào `develop`. Bằng chứng và các mục nghiệm thu còn mở nằm trong [evidence P01](docs/phases/evidence/P01.md).

- `develop` là nhánh tích hợp.
- `main` là nhánh release.
- Sản phẩm dự kiến là web app online-only, multi-user, xây dựng với Next.js 15, Go (chi, pgx, sqlc, River) và PostgreSQL 16 (pgvector, pg_trgm).
- Giao diện hỗ trợ English (mặc định) và Tiếng Việt.

## Về tên gọi

Trong thần kinh học, **engram** là dấu vết vật lý mà một ký ức để lại. Cái tên này gợi đúng điều sản phẩm muốn làm: ghi lại một dấu vết nhỏ để lần sau có thể tìm về, ngay cả khi bạn chỉ còn nhớ một phần.

Tên được viết thường trong mọi ngữ cảnh: `engram`, không phải `Engram` hay `ENGRAM`.

Repo GitHub là [zone17th/engram](https://github.com/zone17th/engram); module Go/pnpm còn giữ đường dẫn lịch sử `save-all-by-keyword`. Domain đang dùng tạm là `key.zone17th.click`. Trước khi in ấn hoặc đăng ký chính thức, cần kiểm tra thêm domain và nhãn hiệu.
