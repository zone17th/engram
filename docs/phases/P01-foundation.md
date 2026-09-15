# P01 — Nền tảng và UI shell

> Kế hoạch · MVP 1/6 · Phụ thuộc: spec + mockup hiện có.
> Nguồn: [SPEC](../SPEC.md) §4, §7.0, §7.8, §11; [bản đồ phase](README.md).

## Mục tiêu và đầu ra

Một checkout mới chạy được web/API/DB bằng quy trình được ghi trong README; CI build/test phần hiện có. Người xem nhận ra engram qua landing và shell đúng mockup, trên desktop/mobile và cả hai theme. Không có lời khẳng định auth hoặc crypto đã hoạt động ở phase này.

## Phạm vi

- Monorepo `apps/web`, `apps/api`, `packages/shared-types`; Next.js 15 App Router/TypeScript, Go chi/pgx/sqlc/River, Postgres 16 + pgvector ≥ 0.8, pg_trgm, unaccent, citext, pgcrypto theo spec.
- Entrypoint API/worker/migrate, cấu hình typed, graceful shutdown, health/ready, log request ID không log body/query. Worker có lifecycle nhưng chưa embed dữ liệu thật.
- Migration nền/extensions và sqlc pipeline; bảng business được phase sở hữu thêm khi cần, không chép toàn bộ schema rồi tạo service giả.
- Compose local; TEI profile optional, `EMBEDDING_PROVIDER=noop` không cần model download. Cấu hình semantic effective off khi provider noop; không trả vector zero như kết quả semantic thật.
- Web shell/providers, error boundary nền, `next-intl`, Tailwind build + shadcn/Radix; port CSS vars/font/icon từ mockup.
- Landing với hero omnibox demo tương tác bằng fixture công khai, JSON table minh hoạ, CTA/link điều hướng rõ. App shell U2 có header, rail, slot omnibox/recent/detail/settings.

Ngoài phạm vi: auth/session thật (P02), vault (P03), CRUD/JSON engine thật (P04), TEI ranking (P05), public deployment/docs hoàn chỉnh (P06). Các màn preview shell dùng fixture tách biệt, không giả vờ lưu bền vững.

## UI và route

| Surface | Chuẩn | Yêu cầu |
|---|---|---|
| Landing U1 | [landing.html](../../mockups/landing.html) | Hero là ô demo gõ được; reduced motion dừng tự gõ; không gửi text demo tới analytics/API người dùng |
| Shell U2 | [index.html](../../mockups/index.html) | Giữ header/rail/card rhythm, responsive và vault pill theo state được truyền vào |
| Shared controls | [tokens.css](../../mockups/tokens.css), [tw.js](../../mockups/tw.js) | Button/chip/dialog/toast/segmented switch/focus; không đổi tầng màu chức năng |

Route web chuẩn: `/` cho en, `/vi` cho vi; app `/app`, `/app/items/:id`, `/app/settings`; các đường `/items/:id` trong mô tả flow được hiểu là resource/API hoặc shorthand navigation, không dựng app thứ hai ngoài `/app`. API giữ `/api/v1`. Auth route cụ thể chốt cùng mockup P02. App private `noindex`, không SSR body user.

Dev đi qua một origin web: proxy `/api` đến Go để cookie path `/api`, credentials và CSP không xung đột. Chốt cách proxy bằng Next rewrite hoặc reverse proxy dev, ghi README/OpenAPI server URL; không để browser gọi port API khác origin theo config demo mà quên CORS/CSRF. Chỉ một tiến trình sở hữu cổng web: `make dev` dùng DB/API/worker + Next dev, còn full Compose dùng profile/command riêng.

## Contract và cấu trúc dự kiến

- `GET /api/v1/healthz`: process sống; `GET /api/v1/readyz`: dependencies bắt buộc sẵn sàng; TEI optional không làm lexical-only deployment unready. `GET /api/v1/metrics` là endpoint vận hành, hạn chế exposure ở P06. Bảng §9.2 viết tắt ba path này thành `/healthz · /readyz · /metrics`, tất cả đều nằm dưới prefix `/api/v1` — không expose thêm bản ở root.
- `packages/shared-types`: error shape/envelope definitions có chỗ đặt, không tạo một envelope khác §5.5. OpenAPI 3.1 sinh typed client; RFC 9457 lỗi thống nhất.
- Env template gồm DB, app origin, OAuth placeholder, email verification false, provider/TEI flags. Không secret thật; pin runtime/dependency/image phù hợp build tái lập, không tin `cpu-latest` là version bất biến.
- File dự kiến: `pnpm-workspace.yaml`, `turbo.json`, `apps/web/app/**`, `apps/web/styles/tokens.css`, `apps/web/messages/{en,vi}.json`, `apps/web/components/**`, `apps/api/cmd/{api,worker,migrate}/`, `apps/api/internal/{http,db}/`, `apps/api/api/openapi.yaml`, `infra/docker-compose.yml`, `.github/workflows/**`, `Makefile`.

## Trình tự triển khai

1. Chốt runtime, route/proxy và dev commands; scaffold workspace cùng health/ready.
2. Thêm migrations/extensions, pool/sqlc và worker lifecycle; verify startup DB thiếu/chưa ready.
3. Port token và component primitives từ mockup, giữ light/dark/font roles; self-host/font build tương thích CSP.
4. Dựng landing demo và shell bằng fixture, tách demo adapter khỏi API adapter.
5. Wire i18n/theme/responsive, CI và hướng dẫn fresh clone. Trạng thái lỗi/rỗng lấy theo [`mockups/states.html`](../../mockups/states.html); ca chưa có trong đó thì bổ sung vào file này trước khi làm UI tương ứng.

## Acceptance

| ID | Ca nghiệm thu | Đạt khi |
|---|---|---|
| P01-A1 | Fresh checkout + env mẫu | Cài dependency/build/migrate/start theo README; không cần TEI/OAuth thật để xem landing |
| P01-A2 | Ready dependency | DB down làm ready fail, health vẫn phản ánh process; DB trở lại phục hồi đúng |
| P01-A3 | Proxy/routing | `/api/v1/healthz` đi Go cùng origin; `/app` và marketing route không va chạm |
| P01-A4 | Visual | Landing/shell khớp mockup ở 390/768/1440px, light/dark; không tràn viewport |
| P01-A5 | Demo boundary | Demo chỉ dùng dữ liệu mẫu; không lưu text nhập lên server hoặc claim đã encrypt |
| P01-A6 | Keyboard/i18n | Demo dùng keyboard được, reduced motion đúng; en/vi key parity, logo luôn `engram` |
| P01-A7 | CI | Lint/typecheck/build web, Go checks và migration smoke phù hợp phần đã viết đều pass |

## Bàn giao và khôi phục

P02 nhận shell/token/route/client API/config/logging đã hoạt động. Ghi bằng chứng theo [quy tắc chung](README.md#7-bằng-chứng-nghiệm-thu). Migration nền chạy từ DB rỗng; rollback app không xoá volume dữ liệu. Không coi `make clean` hoặc drop DB là quy trình phục hồi mặc định.
