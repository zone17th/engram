# P01 — Nền tảng và UI shell · Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng monorepo engram chạy được từ checkout mới — Go API (chi/pgx/sqlc/River) với health/ready/metrics, Postgres 16 + extensions, và Next.js 15 shell/landing port đúng design token của `mockups/` — mà không khẳng định auth hay crypto đã hoạt động.

**Architecture:** Một pnpm workspace chứa `apps/web` (Next.js 15 App Router), `apps/api` (Go module riêng, không nằm trong pnpm graph) và `packages/shared-types` (error code + typed client sinh từ OpenAPI). Dev chạy qua **một origin duy nhất** `http://localhost:3000`: Next rewrite `/api/:path*` sang Go ở `127.0.0.1:8080`, nên cookie path `/api`, credentials và CSP không xung đột. Go tách `cmd/{api,worker,migrate}` dùng chung `internal/config` + `internal/httpx`; Postgres là dependency bắt buộc của `readyz`, TEI là optional và mặc định `EMBEDDING_PROVIDER=noop`.

**Tech Stack:** Go 1.27 · chi v5 · pgx v5 pool · sqlc · golang-migrate · River · go-playground/validator · kelseyhightower/envconfig · `log/slog` · Prometheus client_golang · testcontainers-go · Next.js 15 · TypeScript 5 · Tailwind CSS 3.4 · shadcn/ui (Radix) · TanStack Query v5 · next-intl · Vitest · Playwright + axe · Postgres 16 (pgvector ≥ 0.8, pg_trgm, unaccent, citext, pgcrypto) · Docker Compose.

## Global Constraints

Mọi task đều ngầm bao gồm mục này. Giá trị chép nguyên văn từ [SPEC](../SPEC.md) và [P01](../phases/P01-foundation.md).

- **Tên sản phẩm luôn viết thường: `engram`.** Không viết hoa trong logo, copy, title, meta.
- **Không đổi tên tiền tố `sabk`** dù repo tên `save-all-by-keyword`: cookie `sabk_session`, hash domain `sabk.rk.lookup.v1` / `sabk.rk.wrap.v1`, AAD prefix `sabk.entry.v1`, IndexedDB `sabk.device`, export `.sabk.json`.
- **Domain production: `key.zone17th.click`.** Go module path: `github.com/zone17th/save-all-by-keyword/apps/api`.
- **Toàn bộ prose tài liệu, copy UI và comment mô tả trong repo này viết bằng tiếng Việt.** Code, identifier, commit message, lệnh giữ tiếng Anh.
- **Server không bao giờ nhận plaintext body, passphrase, RK, VK, PWK — kể cả trong log hoặc telemetry.**
- **Không log `q`, không log request body.** Access log chỉ gồm: route pattern (không phải raw path), status, latency, request ID.
- **Lỗi API dùng RFC 9457 `application/problem+json`.** Base type URI: `https://key.zone17th.click/problems/`.
- **Mọi endpoint nằm dưới `/api/v1`.** Không expose bản sao ở root. P01 chỉ có `healthz`, `readyz`, `metrics`.
- **`mockups/` là chuẩn thiết kế bắt buộc (SPEC §7.0).** Mockup thắng về thị giác; spec thắng về hành vi/dữ liệu. `mockups/tokens.css` là nguồn sự thật màu/radius/shadow/typography.
- **Không mang Tailwind Play CDN và `@import` Google Fonts vào production.** Build CSS thật, self-host font qua `next/font` để hợp CSP — giao diện phải giống hệt mockup.
- **CSP đích (SPEC §10.2):** `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'`, không inline script, nonce cho Next.
- **Exception của riêng P01 (có hạn, xem Task 16):** `script-src` và `style-src` phải kèm `'unsafe-inline'`. Lý do: nonce của Next phải sinh trong middleware theo từng request, mà trang landing bắt buộc là SSG để đạt TTFB < 200 ms — nonce ép sang dynamic rendering. P01 **không** tuyên bố đạt CSP §10.2; P06 đóng exception này khi chốt cách render landing.
- **Không port hành vi của mock vào production:** `window.SAK`, `__raw`/`__pairs`, `dataset.plain`, fake toast, fixture giả crypto đều không phải contract.
- **`EMBEDDING_PROVIDER=noop` phải làm semantic *không khả dụng*.** Không trả vector zero như kết quả semantic thật, không bật UI "Gần nghĩa" như đã hoạt động.
- **TEI là optional.** DB down ⇒ `readyz` fail; TEI down ⇒ `readyz` vẫn pass ở deployment lexical-only.
- **Hiệu năng:** landing TTFB (SSG) < 200 ms; app shell LCP < 2 s trên 4G.
- **App private `noindex`, không SSR body người dùng.**
- **Quy ước (SPEC §11.4):** nhánh `develop` → `main`, feature branch `feat/<scope>-<short>`; Conventional Commits; gofumpt + golangci-lint; ESLint + Prettier strict; migration forward-only `NNNN_description.up.sql` / `.down.sql`.
- **Không secret thật trong repo.** Chỉ `.env.example`. Image pin bằng digest, không tin tag `cpu-latest`.

---

## File Structure

```
pnpm-workspace.yaml               # workspace: apps/web, packages/*
package.json                      # scripts mirror Makefile (Windows không có make)
pnpm-lock.yaml                    # PHẢI commit: Dockerfile + CI dùng --frozen-lockfile
Makefile                          # dev/test/lint/migrate targets
.env.example                      # template env, không secret
.github/workflows/{api,web,e2e}.yml

apps/api/
  go.mod                          # module github.com/zone17th/save-all-by-keyword/apps/api
  cmd/api/main.go                 # HTTP server + graceful shutdown
  cmd/worker/main.go              # River client lifecycle
  cmd/migrate/main.go             # golang-migrate runner
  internal/config/config.go       # typed env config + SemanticAvailable()
  internal/httpx/problem.go       # RFC 9457 writer
  internal/httpx/middleware.go    # request ID + access log (không log query/body)
  internal/httpx/router.go        # chi router, mount /api/v1
  internal/httpx/health.go        # healthz / readyz handler
  internal/db/pool.go             # pgx pool + Ping
  internal/db/preflight.go        # kiểm tra extension version lúc boot
  internal/db/queries/system.sql  # sqlc source
  internal/db/gen/**              # sqlc output (committed)
  internal/obs/metrics.go         # Prometheus registry + handler
  migrations/0001_extensions.{up,down}.sql
  api/openapi.yaml                # OpenAPI 3.1, server URL /api/v1
  sqlc.yaml

packages/shared-types/
  src/problem.ts                  # ProblemDetails type + ERROR_CODES
  src/api.d.ts                    # sinh bởi openapi-typescript (committed)
  src/index.ts

apps/web/
  # KHÔNG có app/layout.tsx: hai root layout song song (xem Sai lệch có chủ ý).
  app/fonts.ts                           # next/font dùng chung cho cả hai root layout
  app/globals.css
  app/global-error.tsx                   # boundary duy nhất ở root, tự render <html>
  app/(marketing)/[locale]/layout.tsx    # ROOT LAYOUT #1 — <html lang={locale}>
  app/(marketing)/[locale]/page.tsx      # landing U1
  app/(marketing)/[locale]/not-found.tsx
  app/app/layout.tsx                     # ROOT LAYOUT #2 — <html lang={APP_LOCALE}>, noindex
  app/app/page.tsx
  app/app/error.tsx
  components/ui/*.tsx                    # primitives port từ tokens.css
  components/landing/*.tsx               # hero demo + JSON table demo
  components/app-shell/*.tsx             # header, rail, vault pill
  lib/demo-fixtures.ts                   # fixture công khai của demo
  lib/demo-search.ts                     # thuật toán demo (tách khỏi API adapter)
  styles/tokens.css                      # port từ mockups/tokens.css
  messages/{en,vi}.json
  i18n/{routing,request}.ts
  i18n/app-locale.ts                     # locale tạm của /app cho tới P02
  tailwind.config.ts                     # mirror mockups/tw.js
  next.config.ts                         # rewrite /api → Go, headers CSP
  middleware.ts                          # next-intl, loại trừ /api /app /_next
  tests/**                               # Vitest
  e2e/**                                 # Playwright + axe

infra/docker-compose.yml          # db, api, worker, web; tei dưới profile semantic
infra/image-pins.env              # digest ghi lại từ docker inspect
docs/phases/evidence/P01.md       # bằng chứng nghiệm thu
```

### Sai lệch có chủ ý so với danh sách file của P01

Bốn điểm dưới đây khác [P01 §Contract và cấu trúc dự kiến](../phases/P01-foundation.md). Ghi lại để reviewer biết là cố ý, không phải bỏ sót; nếu không đồng ý thì sửa plan trước khi làm, đừng sửa lệch trong lúc code.

- **Không có `turbo.json`.** Workspace P01 chỉ có một package Node (`apps/web`) cộng `packages/shared-types`; `apps/api` là Go module nằm ngoài pnpm graph. Turborepo lúc này chỉ thêm một tầng cache không giải quyết vấn đề gì — `package.json` scripts + `Makefile` đã đủ. Thêm `turbo.json` khi số package Node vượt quá hai (sớm nhất là P04).
- **`internal/httpx/` thay vì `internal/http/`.** `http` trùng tên package chuẩn `net/http`, buộc mọi file phải alias import. `httpx` là quy ước Go phổ biến cho lớp bọc HTTP nội bộ. Vai trò và vị trí không đổi.
- **Primitive viết tay, chưa cài shadcn/Radix.** P01 §Phạm vi ghi "Tailwind build + shadcn/Radix". Task 12 dựng `Button`/`Chip`/`Card`/`Panel`/`Switch`/`Segmented`/`Toast` bằng tay vì `tokens.css` là nguồn sự thật thị giác (SPEC §7.0) và shadcn sinh component theo token riêng, phải gỡ ra rồi map lại — nhiều việc hơn là viết thẳng. Radix vào ở P02–P03 khi cần primitive có behavior thật: `Dialog`, `Popover`, `DropdownMenu` (focus trap, `aria-*`, dismiss layer). `Switch` và `Segmented` của Task 12 khi đó đổi sang `@radix-ui/react-switch` và `react-toggle-group`, giữ nguyên class. Ghi vào phần nợ kỹ thuật của evidence.
- **Không có `app/layout.tsx`; hai root layout song song.** Next chỉ cho đặt `<html lang>` ở root layout, mà root layout không nhận được `params.locale` của segment con — nếu giữ một root layout duy nhất thì `/vi` vẫn phải phục vụ `lang="en"` (screen reader đọc tiếng Việt bằng giọng Anh), hoặc phải đọc `headers()` trong root layout và mất SSG của landing. Next hỗ trợ sẵn cách khác: *"Any layout without a `layout.js` above it is a root layout"*. Nên `app/(marketing)/[locale]/layout.tsx` và `app/app/layout.tsx` đều là root layout, mỗi cái tự render `<html>`/`<body>`; font dùng chung qua `app/fonts.ts`. Hệ quả phải chấp nhận: điều hướng giữa `/` và `/app` là full page load (đúng ý đồ — `/app` là ứng dụng riêng tư, vào bằng session), và boundary lỗi ở root phải là `app/global-error.tsx` (file duy nhất được phép tự render `<html>` khi không có root layout chung).

---

## Phần A — Go API

### Task 1: Workspace scaffold + Go module + typed config

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `pnpm-lock.yaml`, `.env.example`, `Makefile`, `apps/api/go.mod`, `apps/api/internal/config/config.go`
- Test: `apps/api/internal/config/config_test.go`

**Interfaces:**
- Consumes: (không có — task đầu tiên)
- Produces:
  - `config.Config` struct với field `Env string`, `HTTPAddr string`, `DatabaseURL string`, `AppOrigin string`, `EmbeddingProvider string`, `TEIURL string`, `LogLevel string`, `ShutdownTimeout time.Duration`
  - `func config.Load() (*Config, error)` — đọc env, validate, trả `*Config`
  - `func (c *Config) SemanticAvailable() bool` — `true` chỉ khi `EmbeddingProvider == "tei"` và `TEIURL != ""`

- [ ] **Step 1: Tạo workspace gốc**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/web'
  - 'packages/*'
```

`package.json`:
```json
{
  "name": "engram",
  "private": true,
  "packageManager": "pnpm@10.34.5",
  "engines": { "node": ">=20.19" },
  "scripts": {
    "dev": "pnpm --filter @engram/web dev",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

Sinh lockfile ngay, và commit nó ở mọi task có thêm dependency:

```bash
corepack enable
pnpm install
ls -l pnpm-lock.yaml
```

`pnpm-lock.yaml` là **deliverable bắt buộc**, không phải file sinh ra rồi bỏ: cả `apps/web/Dockerfile` lẫn ba workflow CI đều chạy `pnpm install --frozen-lockfile`, lệnh này fail nếu lockfile thiếu hoặc lệch `package.json`. Không có nó thì P01-A1 (fresh checkout) và P01-A7 (CI) đều không đạt. Mỗi lần `pnpm add` là một lần `git add pnpm-lock.yaml` trong cùng commit.

- [ ] **Step 2: Khởi tạo Go module**

```bash
mkdir -p apps/api/internal/config
cd apps/api && go mod init github.com/zone17th/save-all-by-keyword/apps/api
go get github.com/kelseyhightower/envconfig@v1.4.0
go get github.com/go-playground/validator/v10@v10.28.0
```

- [ ] **Step 3: Viết test thất bại cho config**

`apps/api/internal/config/config_test.go`:
```go
package config_test

import (
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
)

func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	base := map[string]string{
		"DATABASE_URL": "postgres://engram:engram@localhost:5432/engram?sslmode=disable",
		"APP_ORIGIN":   "http://localhost:3000",
	}
	for k, v := range base {
		if _, ok := kv[k]; !ok {
			t.Setenv(k, v)
		}
	}
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoadDefaults(t *testing.T) {
	setEnv(t, nil)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.HTTPAddr != "127.0.0.1:8080" {
		t.Errorf("HTTPAddr = %q, muốn 127.0.0.1:8080", cfg.HTTPAddr)
	}
	if cfg.EmbeddingProvider != "noop" {
		t.Errorf("EmbeddingProvider = %q, muốn noop", cfg.EmbeddingProvider)
	}
	if cfg.ShutdownTimeout != 15*time.Second {
		t.Errorf("ShutdownTimeout = %v, muốn 15s", cfg.ShutdownTimeout)
	}
}

func TestSemanticAvailable(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		teiURL   string
		want     bool
	}{
		{"noop mặc định", "noop", "", false},
		{"noop dù có TEI_URL", "noop", "http://tei:80", false},
		{"tei thiếu URL", "tei", "", false},
		{"tei đủ URL", "tei", "http://tei:80", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setEnv(t, map[string]string{
				"EMBEDDING_PROVIDER": tc.provider,
				"TEI_URL":            tc.teiURL,
			})
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if got := cfg.SemanticAvailable(); got != tc.want {
				t.Errorf("SemanticAvailable() = %v, muốn %v", got, tc.want)
			}
		})
	}
}

func TestLoadRejectsUnknownProvider(t *testing.T) {
	setEnv(t, map[string]string{"EMBEDDING_PROVIDER": "openai"})
	if _, err := config.Load(); err == nil {
		t.Fatal("Load() muốn lỗi với provider lạ, nhận nil")
	}
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("DATABASE_URL", "")
	if _, err := config.Load(); err == nil {
		t.Fatal("Load() muốn lỗi khi thiếu DATABASE_URL, nhận nil")
	}
}
```

- [ ] **Step 4: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/config/ -v`
Expected: FAIL — `undefined: config.Load`

- [ ] **Step 5: Viết implementation tối thiểu**

`apps/api/internal/config/config.go`:
```go
// Package config đọc cấu hình từ biến môi trường và validate một lần lúc boot.
package config

import (
	"fmt"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
)

// Config là toàn bộ cấu hình runtime của API/worker/migrate.
// Không chứa secret nào được log ra ngoài: Ghi log cấu hình phải dùng Redacted().
type Config struct {
	Env               string        `envconfig:"APP_ENV" default:"development" validate:"oneof=development staging production"`
	HTTPAddr          string        `envconfig:"HTTP_ADDR" default:"127.0.0.1:8080" validate:"required,hostname_port"`
	DatabaseURL       string        `envconfig:"DATABASE_URL" required:"true" validate:"required,startswith=postgres"`
	AppOrigin         string        `envconfig:"APP_ORIGIN" default:"http://localhost:3000" validate:"required,url"`
	EmbeddingProvider string        `envconfig:"EMBEDDING_PROVIDER" default:"noop" validate:"oneof=noop tei"`
	TEIURL            string        `envconfig:"TEI_URL" validate:"omitempty,url"`
	LogLevel          string        `envconfig:"LOG_LEVEL" default:"info" validate:"oneof=debug info warn error"`
	ShutdownTimeout   time.Duration `envconfig:"SHUTDOWN_TIMEOUT" default:"15s" validate:"required"`
}

// Load đọc env, áp default rồi validate. Lỗi cấu hình phải làm process chết ngay
// thay vì chạy tiếp với giá trị nửa vời.
func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("đọc env: %w", err)
	}
	if err := validator.New().Struct(&cfg); err != nil {
		return nil, fmt.Errorf("cấu hình không hợp lệ: %w", err)
	}
	return &cfg, nil
}

// SemanticAvailable cho biết tìm kiếm ngữ nghĩa có thật sự dùng được không.
// Provider noop KHÔNG sinh vector thật, nên phải báo false để UI không quảng cáo
// tính năng chưa có (P01 §Phạm vi).
func (c *Config) SemanticAvailable() bool {
	return c.EmbeddingProvider == "tei" && c.TEIURL != ""
}

// Redacted trả bản sao an toàn để log: che chuỗi kết nối DB.
func (c *Config) Redacted() map[string]any {
	return map[string]any{
		"env":                c.Env,
		"http_addr":          c.HTTPAddr,
		"app_origin":         c.AppOrigin,
		"embedding_provider": c.EmbeddingProvider,
		"semantic_available": c.SemanticAvailable(),
		"log_level":          c.LogLevel,
		"database_url":       "[redacted]",
	}
}
```

- [ ] **Step 6: Chạy lại test**

Run: `cd apps/api && go test ./internal/config/ -v`
Expected: PASS (5 test, gồm 4 subtest của `TestSemanticAvailable`)

- [ ] **Step 7: Viết `.env.example` và `Makefile`**

`.env.example`:
```bash
# engram — mẫu biến môi trường. KHÔNG đặt secret thật vào file này.
APP_ENV=development
LOG_LEVEL=info

# Một origin duy nhất cho dev: Next ở :3000 proxy /api sang Go ở :8080.
APP_ORIGIN=http://localhost:3000
HTTP_ADDR=127.0.0.1:8080
SHUTDOWN_TIMEOUT=15s

DATABASE_URL=postgres://engram:engram@localhost:5432/engram?sslmode=disable

# noop = không có embedding thật; semantic KHÔNG khả dụng.
# Đổi sang tei và điền TEI_URL khi bật profile semantic của compose.
EMBEDDING_PROVIDER=noop
TEI_URL=

# P02 mới dùng. Để trống ở P01.
OAUTH_GOOGLE_CLIENT_ID=
OAUTH_GOOGLE_CLIENT_SECRET=
EMAIL_VERIFICATION_ENABLED=false
```

`Makefile`:
```makefile
# Windows không có make sẵn; các target dưới đây được mirror sang scripts của package.json.
.PHONY: api-test api-lint web-test dev migrate

api-test:
	cd apps/api && go test ./...

api-lint:
	cd apps/api && gofumpt -l -w . && go vet ./...

web-test:
	pnpm -r test

migrate:
	cd apps/api && go run ./cmd/migrate up
```

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml Makefile .env.example apps/api
git commit -m "feat(api): scaffold workspace and typed config"
```

---

### Task 2: RFC 9457 problem writer + error code contract

**Files:**
- Create: `apps/api/internal/httpx/problem.go`, `packages/shared-types/package.json`, `packages/shared-types/src/problem.ts`, `packages/shared-types/src/index.ts`
- Test: `apps/api/internal/httpx/problem_test.go`, `packages/shared-types/src/problem.test.ts`

**Interfaces:**
- Consumes: không có
- Produces:
  - `httpx.Problem` struct: `Type string` `Title string` `Status int` `Detail string` `Instance string` `Code string`
  - `const httpx.ProblemBase = "https://key.zone17th.click/problems/"`
  - `func httpx.WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string)` — ghi `application/problem+json`, `Type = ProblemBase + code`, `Instance` = request ID
  - TS: `type ProblemDetails`, `const ERROR_CODES`, `function isProblemDetails(v: unknown): v is ProblemDetails`

- [ ] **Step 1: Viết test thất bại cho Go**

`apps/api/internal/httpx/problem_test.go`:
```go
package httpx_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func TestWriteProblemShape(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readyz?q=bimat", nil)

	httpx.WriteProblem(rec, req, http.StatusServiceUnavailable, "dependency_unavailable", "Cơ sở dữ liệu chưa sẵn sàng.")

	if got := rec.Header().Get("Content-Type"); got != "application/problem+json" {
		t.Errorf("Content-Type = %q, muốn application/problem+json", got)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, muốn 503", rec.Code)
	}

	var p httpx.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("body không phải JSON hợp lệ: %v", err)
	}
	if p.Type != "https://key.zone17th.click/problems/dependency_unavailable" {
		t.Errorf("type = %q", p.Type)
	}
	if p.Code != "dependency_unavailable" {
		t.Errorf("code = %q", p.Code)
	}
	if p.Status != http.StatusServiceUnavailable {
		t.Errorf("status trong body = %d", p.Status)
	}
}

func TestWriteProblemNeverEchoesQuery(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readyz?q=bimat", nil)

	httpx.WriteProblem(rec, req, http.StatusBadRequest, "invalid_request", "Tham số không hợp lệ.")

	if body := rec.Body.String(); contains(body, "bimat") {
		t.Fatalf("problem body lộ query người dùng: %s", body)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/httpx/ -run TestWriteProblem -v`
Expected: FAIL — `undefined: httpx.WriteProblem`

- [ ] **Step 3: Implement problem writer**

`apps/api/internal/httpx/problem.go`:
```go
// Package httpx chứa router, middleware và định dạng lỗi dùng chung của API.
package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

// RequestIDFrom là stub tạm để Task 2 build được một mình.
// Task 3 XOÁ hàm này và thay bằng bản đọc từ context trong middleware.go.
// Giữ nguyên chữ ký để Task 3 không phải sửa WriteProblem.
func RequestIDFrom(ctx context.Context) string { return "" }

// ProblemBase là namespace của các type URI theo RFC 9457.
const ProblemBase = "https://key.zone17th.click/problems/"

// Problem là body lỗi thống nhất của toàn bộ API (SPEC §5.5).
// Detail luôn là câu do server soạn sẵn — không bao giờ phản chiếu input người dùng,
// vì query có thể chứa từ khoá riêng tư.
type Problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Instance string `json:"instance,omitempty"`
	Code     string `json:"code"`
}

// problemTitles ánh xạ code sang title ngắn, ổn định theo hợp đồng.
var problemTitles = map[string]string{
	"invalid_request":        "Yêu cầu không hợp lệ",
	"dependency_unavailable": "Phụ thuộc chưa sẵn sàng",
	"internal_error":         "Lỗi máy chủ",
	"not_found":              "Không tìm thấy",
}

// WriteProblem ghi một lỗi RFC 9457. Instance dùng request ID chứ không dùng URL,
// để log và client đối chiếu được mà không lưu lại path chứa tham số.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	title, ok := problemTitles[code]
	if !ok {
		title = "Lỗi"
	}
	p := Problem{
		Type:     ProblemBase + code,
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: RequestIDFrom(r.Context()),
		Code:     code,
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(p); err != nil {
		slog.ErrorContext(r.Context(), "không ghi được problem response", slog.String("code", code))
	}
}
```

> Stub `RequestIDFrom` ở trên là nợ có hạn: Task 3 Step 7 xoá nó khỏi `problem.go` và định nghĩa bản thật trong `middleware.go`. Nếu quên, `go build` sẽ báo trùng khai báo — đó là cơ chế nhắc.

- [ ] **Step 4: Chạy lại test Go**

Run: `cd apps/api && go test ./internal/httpx/ -run TestWriteProblem -v`
Expected: PASS (2 test)

- [ ] **Step 5: Tạo package shared-types và test TS thất bại**

```bash
mkdir -p packages/shared-types/src
```

`packages/shared-types/package.json`:
```json
{
  "name": "@engram/shared-types",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/shared-types/src/problem.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PROBLEM_BASE, isProblemDetails } from './problem';

describe('problem', () => {
  it('giữ đúng namespace type URI của spec', () => {
    expect(PROBLEM_BASE).toBe('https://key.zone17th.click/problems/');
  });

  it('nhận diện body problem hợp lệ', () => {
    expect(
      isProblemDetails({
        type: `${PROBLEM_BASE}dependency_unavailable`,
        title: 'Phụ thuộc chưa sẵn sàng',
        status: 503,
        code: 'dependency_unavailable',
      }),
    ).toBe(true);
  });

  it('từ chối object thiếu code', () => {
    expect(isProblemDetails({ type: PROBLEM_BASE, title: 'x', status: 500 })).toBe(false);
  });

  it('liệt kê đủ code P01 dùng', () => {
    expect(ERROR_CODES).toContain('dependency_unavailable');
    expect(ERROR_CODES).toContain('invalid_request');
    expect(ERROR_CODES).toContain('internal_error');
    expect(ERROR_CODES).toContain('not_found');
  });
});
```

- [ ] **Step 6: Chạy test TS để chắc nó fail**

Run: `pnpm --filter @engram/shared-types test`
Expected: FAIL — không resolve được `./problem`

- [ ] **Step 7: Implement `problem.ts`**

`packages/shared-types/src/problem.ts`:
```ts
/** Namespace type URI theo RFC 9457 — phải khớp httpx.ProblemBase bên Go. */
export const PROBLEM_BASE = 'https://key.zone17th.click/problems/' as const;

/** Danh sách code lỗi ổn định. Thêm code mới ở cả Go lẫn đây trong cùng một PR. */
export const ERROR_CODES = [
  'invalid_request',
  'dependency_unavailable',
  'internal_error',
  'not_found',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Body lỗi duy nhất của API. Không có envelope nào khác (SPEC §5.5). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Request ID, không phải URL — URL có thể chứa từ khoá riêng tư. */
  instance?: string;
  code: string;
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'number' &&
    typeof v.code === 'string'
  );
}
```

`packages/shared-types/src/index.ts`:
```ts
export * from './problem';
```

- [ ] **Step 8: Chạy lại test TS**

Run: `pnpm --filter @engram/shared-types test`
Expected: PASS (4 test)

- [ ] **Step 9: Commit**

```bash
git add apps/api/internal/httpx packages/shared-types
git commit -m "feat(api): RFC 9457 problem responses and shared error codes"
```

---

### Task 3: chi router, `/api/v1/healthz`, middleware request ID + access log không rò rỉ

**Files:**
- Create: `apps/api/internal/httpx/middleware.go`, `apps/api/internal/httpx/router.go`, `apps/api/internal/httpx/health.go`
- Modify: `apps/api/internal/httpx/problem.go` (bỏ stub `RequestIDFrom`)
- Test: `apps/api/internal/httpx/middleware_test.go`, `apps/api/internal/httpx/router_test.go`

**Interfaces:**
- Consumes: `httpx.WriteProblem`, `httpx.ProblemBase` (Task 2); `config.Config` (Task 1)
- Produces:
  - `func httpx.RequestIDFrom(ctx context.Context) string`
  - `func httpx.RequestID(next http.Handler) http.Handler` — đọc/sinh `X-Request-Id`, đặt vào context và response header
  - `func httpx.AccessLog(logger *slog.Logger) func(http.Handler) http.Handler` — log `route`, `method`, `status`, `duration_ms`, `request_id`; **không** log raw path/query/body
  - `type httpx.Deps struct { Config *config.Config; Logger *slog.Logger; Ready ReadyFunc; Metrics http.Handler }`
  - `type httpx.ReadyFunc func(ctx context.Context) error`
  - `func httpx.NewRouter(d Deps) http.Handler` — mount `/api/v1/healthz`, `/api/v1/readyz`, `/api/v1/metrics`

- [ ] **Step 1: Cài chi**

```bash
cd apps/api && go get github.com/go-chi/chi/v5@v5.2.3 && go get github.com/google/uuid@v1.6.0
```

- [ ] **Step 2: Viết test thất bại cho access log**

`apps/api/internal/httpx/middleware_test.go`:
```go
package httpx_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func testDeps(buf *bytes.Buffer) httpx.Deps {
	return httpx.Deps{
		Config:  &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger:  slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})),
		Ready:   func(context.Context) error { return nil },
		Metrics: http.NotFoundHandler(),
	}
}

// Log truy cập không được chứa query người dùng: `q` là từ khoá riêng tư (SPEC §10).
func TestAccessLogNeverContainsQuery(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/healthz?q=matkhau-cua-toi", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if strings.Contains(out, "matkhau-cua-toi") || strings.Contains(out, "q=") {
		t.Fatalf("access log lộ query: %s", out)
	}
	if !strings.Contains(out, `"route":"/api/v1/healthz"`) {
		t.Fatalf("access log thiếu route pattern: %s", out)
	}
}

func TestAccessLogNeverContainsBody(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/healthz", strings.NewReader(`{"secret":"dung-log-cai-nay"}`))
	r.ServeHTTP(httptest.NewRecorder(), req)

	if strings.Contains(buf.String(), "dung-log-cai-nay") {
		t.Fatalf("access log lộ body: %s", buf.String())
	}
}

func TestRequestIDEchoedAndStable(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil)
	req.Header.Set("X-Request-Id", "abc-123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-Id"); got != "abc-123" {
		t.Errorf("X-Request-Id = %q, muốn abc-123", got)
	}
	if !strings.Contains(buf.String(), `"request_id":"abc-123"`) {
		t.Errorf("log thiếu request_id: %s", buf.String())
	}
}

func TestRequestIDGeneratedWhenAbsent(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("thiếu X-Request-Id sinh tự động")
	}
}
```

- [ ] **Step 3: Viết test thất bại cho router**

`apps/api/internal/httpx/router_test.go`:
```go
package httpx_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func TestHealthzOK(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body không phải JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf(`status = %v, muốn "ok"`, body["status"])
	}
}

// Ba endpoint vận hành chỉ tồn tại dưới /api/v1 — không có bản sao ở root (P01 §Contract).
func TestNoRootDuplicates(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, muốn 404", path, rec.Code)
		}
	}
}

func TestNotFoundReturnsProblemJSON(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/khong-ton-tai", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, muốn 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q, muốn application/problem+json", ct)
	}
}
```

- [ ] **Step 4: Chạy test để chắc chúng fail**

Run: `cd apps/api && go test ./internal/httpx/ -v`
Expected: FAIL — `undefined: httpx.NewRouter`, `undefined: httpx.Deps`

- [ ] **Step 5: Implement middleware**

`apps/api/internal/httpx/middleware.go`:
```go
package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type ctxKey int

const requestIDKey ctxKey = iota

// RequestIDFrom lấy request ID đã gắn vào context; trả "" nếu chưa qua middleware.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RequestID nhận X-Request-Id từ proxy hoặc sinh mới, rồi echo lại cho client.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// AccessLog ghi đúng bốn thứ: route pattern, method, status, latency (+ request ID).
// TUYỆT ĐỐI không log r.URL.RawQuery hay body: query chứa từ khoá riêng tư của người
// dùng và body có thể là ciphertext/plaintext không được phép rời client (SPEC §10).
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			logger.InfoContext(r.Context(), "http_request",
				slog.String("route", route),
				slog.String("method", r.Method),
				slog.Int("status", rec.status),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
				slog.String("request_id", RequestIDFrom(r.Context())),
			)
		})
	}
}
```

- [ ] **Step 6: Implement router + healthz**

`apps/api/internal/httpx/health.go`:
```go
package httpx

import (
	"encoding/json"
	"net/http"
)

// healthz chỉ trả lời "tiến trình còn sống" — không chạm DB, không chạm TEI.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

`apps/api/internal/httpx/router.go`:
```go
package httpx

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
)

// ReadyFunc kiểm tra các phụ thuộc BẮT BUỘC. TEI là optional nên không nằm ở đây.
type ReadyFunc func(ctx context.Context) error

// Deps là mọi thứ router cần, truyền tường minh để test dựng được router thật.
type Deps struct {
	Config  *config.Config
	Logger  *slog.Logger
	Ready   ReadyFunc
	Metrics http.Handler
}

// NewRouter mount toàn bộ API dưới /api/v1. Không có endpoint nào ở root.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(RequestID)
	r.Use(AccessLog(d.Logger))

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		WriteProblem(w, r, http.StatusNotFound, "not_found", "Không có tài nguyên ở đường dẫn này.")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		WriteProblem(w, r, http.StatusMethodNotAllowed, "invalid_request", "Phương thức không được hỗ trợ.")
	})

	r.Route("/api/v1", func(v1 chi.Router) {
		v1.Get("/healthz", healthz)
		v1.Get("/readyz", readyz(d))
		v1.Handle("/metrics", d.Metrics)
	})

	return r
}
```

> `readyz(d)` được viết ở Task 5. Để Task 3 chạy được, thêm bản tạm trong `health.go` và thay ở Task 5:
> ```go
> // bản tạm — Task 5 thay bằng bản kiểm tra DB thật.
> func readyz(d Deps) http.HandlerFunc {
> 	return func(w http.ResponseWriter, r *http.Request) {
> 		if err := d.Ready(r.Context()); err != nil {
> 			WriteProblem(w, r, http.StatusServiceUnavailable, "dependency_unavailable", "Phụ thuộc bắt buộc chưa sẵn sàng.")
> 			return
> 		}
> 		w.Header().Set("Content-Type", "application/json")
> 		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
> 	}
> }
> ```

- [ ] **Step 7: Bỏ stub `RequestIDFrom` trong `problem.go`**

Xoá hàm stub đã thêm ở Task 2 Step 3 (bản thật nằm trong `middleware.go`), và xoá import `"context"` nếu không còn dùng.

- [ ] **Step 8: Chạy lại toàn bộ test httpx**

Run: `cd apps/api && go test ./internal/httpx/ -v`
Expected: PASS (9 test: 2 problem + 4 middleware + 3 router)

- [ ] **Step 9: Commit**

```bash
git add apps/api/internal/httpx
git commit -m "feat(api): chi router, healthz and privacy-safe access log"
```

---

### Task 4: Migration nền (extensions) + `cmd/migrate`

**Files:**
- Create: `apps/api/migrations/0001_extensions.up.sql`, `apps/api/migrations/0001_extensions.down.sql`, `apps/api/cmd/migrate/main.go`
- Test: `apps/api/internal/db/migrate_test.go`

**Interfaces:**
- Consumes: `config.Load()` (Task 1)
- Produces:
  - Schema có sẵn: `vector`, `pg_trgm`, `unaccent`, `citext`, `pgcrypto`
  - Hàm SQL `immutable_unaccent(text) RETURNS text` — `IMMUTABLE`, để dùng được trong index biểu thức
  - Binary `go run ./cmd/migrate up|down|version`

- [ ] **Step 1: Cài golang-migrate và testcontainers**

```bash
cd apps/api
go get github.com/golang-migrate/migrate/v4@v4.19.0
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/iofs
go get github.com/testcontainers/testcontainers-go@v0.40.0
go get github.com/testcontainers/testcontainers-go/modules/postgres
go get github.com/jackc/pgx/v5@v5.7.6
```

- [ ] **Step 2: Viết test thất bại (testcontainers)**

`apps/api/internal/db/migrate_test.go`:
```go
package db_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

// startPostgres dựng Postgres có pgvector. Image phải là bản pgvector, không phải
// postgres:16 thuần — extension vector không có sẵn trong image chính thức.
func startPostgres(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("engram"),
		tcpostgres.WithUsername("engram"),
		tcpostgres.WithPassword("engram"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		t.Fatalf("khởi động Postgres: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(c) })

	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("lấy DSN: %v", err)
	}
	return dsn
}

func TestMigrateUpInstallsExtensions(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	for _, ext := range []string{"vector", "pg_trgm", "unaccent", "citext", "pgcrypto"} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_extension WHERE extname = $1`, ext).Scan(&n); err != nil {
			t.Fatalf("query pg_extension: %v", err)
		}
		if n != 1 {
			t.Errorf("extension %q chưa được cài", ext)
		}
	}
}

func TestPgvectorMeetsVersionFloor(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	var version string
	if err := conn.QueryRow(ctx, `SELECT extversion FROM pg_extension WHERE extname = 'vector'`).Scan(&version); err != nil {
		t.Fatalf("đọc extversion: %v", err)
	}
	major, minor := parseVersion(t, version)
	// Sàn spec là 0.8 → major 0 phải có minor >= 8; major >= 1 luôn đạt.
	if major == 0 && minor < 8 {
		t.Fatalf("pgvector = %s, spec yêu cầu >= 0.8", version)
	}
}

// parseVersion tách "0.8.1" thành (0, 8). PHẢI so sánh bằng số: so chuỗi thì
// "0.10" < "0.8" (lexical), tức bản mới hơn lại bị coi là không đạt sàn.
// Cùng logic với checkPgvectorFloor ở Task 7 — bản đó là runtime preflight,
// bản này là test, cố ý không chia sẻ code vì Task 4 chạy trước Task 7.
func parseVersion(t *testing.T, version string) (int, int) {
	t.Helper()
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		t.Fatalf("không đọc được version pgvector: %q", version)
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		t.Fatalf("version pgvector không hợp lệ: %q", version)
	}
	return major, minor
}

// immutable_unaccent phải IMMUTABLE thì mới dùng được trong index biểu thức.
func TestImmutableUnaccentIsImmutable(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	var volatile string
	if err := conn.QueryRow(ctx,
		`SELECT provolatile FROM pg_proc WHERE proname = 'immutable_unaccent'`).Scan(&volatile); err != nil {
		t.Fatalf("đọc pg_proc: %v", err)
	}
	if volatile != "i" {
		t.Fatalf("provolatile = %q, muốn \"i\" (immutable)", volatile)
	}

	var got string
	if err := conn.QueryRow(ctx, `SELECT immutable_unaccent('Tiếng Việt')`).Scan(&got); err != nil {
		t.Fatalf("gọi immutable_unaccent: %v", err)
	}
	if got != "Tieng Viet" {
		t.Errorf("immutable_unaccent('Tiếng Việt') = %q, muốn \"Tieng Viet\"", got)
	}
}
```

- [ ] **Step 3: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/db/ -run TestMigrateUp -v`
Expected: FAIL — `undefined: db.MigrateUp`

- [ ] **Step 4: Viết migration**

`apps/api/migrations/0001_extensions.up.sql`:
```sql
-- Extension nền cho engram. Migration forward-only (SPEC §11.4).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- unaccent() gốc là STABLE vì phụ thuộc search_path của dictionary, nên không dùng
-- được trong index biểu thức. Bọc lại với search_path cố định để thành IMMUTABLE.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
```

`apps/api/migrations/0001_extensions.down.sql`:
```sql
DROP FUNCTION IF EXISTS immutable_unaccent(text);
-- Không DROP EXTENSION: các object khác trong database có thể đang phụ thuộc,
-- và rollback app không được phá dữ liệu (P01 §Bàn giao và khôi phục).
```

- [ ] **Step 5: Implement `db.MigrateUp` / `db.MigrateDown`**

`apps/api/migrations/embed.go`:
```go
// Package migrations nhúng file SQL để binary chạy được mà không cần thư mục nguồn.
//
// File này PHẢI nằm cùng thư mục với các file .sql: `//go:embed` không đi ra
// ngoài thư mục package được, nên `//go:embed ../../migrations/*.sql` trong
// internal/db sẽ không build.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
```

`apps/api/internal/db/migrate.go`:
```go
// Package db quản lý kết nối Postgres và migration.
package db

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/zone17th/save-all-by-keyword/apps/api/migrations"
)

func newMigrator(dsn string) (*migrate.Migrate, error) {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("đọc migrations nhúng: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		return nil, fmt.Errorf("tạo migrator: %w", err)
	}
	return m, nil
}

// MigrateUp chạy toàn bộ migration còn thiếu. Không lỗi khi đã ở bản mới nhất.
func MigrateUp(dsn string) error {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer m.Close()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

// MigrateDown lùi đúng một bước. Dùng cho dev, không phải quy trình phục hồi.
func MigrateDown(dsn string) error {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer m.Close()
	if err := m.Steps(-1); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate down: %w", err)
	}
	return nil
}

// Version trả version hiện tại và cờ dirty.
func Version(dsn string) (uint, bool, error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return 0, false, err
	}
	defer m.Close()
	v, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return 0, false, fmt.Errorf("đọc version: %w", err)
	}
	return v, dirty, nil
}
```

> `migrations` là package Go thật (không phải `internal/`), nên `cmd/migrate` và `cmd/api` đều import được. Thư mục vẫn chỉ chứa `embed.go` + các file `.sql`, không có logic.

- [ ] **Step 6: Implement `cmd/migrate`**

`apps/api/cmd/migrate/main.go`:
```go
// Command migrate chạy migration từ CLI: migrate up | down | version.
package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "dùng: migrate up|down|version")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("cấu hình không hợp lệ", slog.String("err", err.Error()))
		os.Exit(1)
	}

	switch os.Args[1] {
	case "up":
		err = db.MigrateUp(cfg.DatabaseURL)
	case "down":
		err = db.MigrateDown(cfg.DatabaseURL)
	case "version":
		var v uint
		var dirty bool
		v, dirty, err = db.Version(cfg.DatabaseURL)
		if err == nil {
			fmt.Printf("version=%d dirty=%v\n", v, dirty)
		}
	default:
		fmt.Fprintf(os.Stderr, "lệnh không biết: %s\n", os.Args[1])
		os.Exit(2)
	}

	if err != nil {
		slog.Error("migration thất bại", slog.String("err", err.Error()))
		os.Exit(1)
	}
	slog.Info("migration xong", slog.String("cmd", os.Args[1]))
}
```

- [ ] **Step 7: Chạy lại test**

Run: `cd apps/api && go test ./internal/db/ -v -timeout 300s`
Expected: PASS (3 test; lần đầu tốn thời gian kéo image `pgvector/pgvector:pg16`)

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations apps/api/internal/db apps/api/cmd/migrate
git commit -m "feat(api): base migration for extensions and migrate command"
```

---

### Task 5: pgx pool + `/api/v1/readyz` (DB bắt buộc, TEI optional)

**Files:**
- Create: `apps/api/internal/db/pool.go`
- Modify: `apps/api/internal/httpx/health.go` (thay bản `readyz` tạm ở Task 3)
- Test: `apps/api/internal/httpx/ready_test.go`, `apps/api/internal/db/pool_test.go`

**Interfaces:**
- Consumes: `httpx.Deps`, `httpx.ReadyFunc`, `httpx.WriteProblem`; `config.Config.DatabaseURL`
- Produces:
  - `func db.NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error)`
  - `func db.ReadyCheck(pool *pgxpool.Pool) httpx.ReadyFunc` — `Ping` với timeout 2s
  - `readyz` trả `200 {"status":"ready","checks":{"database":"ok"},"semantic_available":false}` hoặc `503` problem+json

- [ ] **Step 1: Viết test thất bại cho readyz**

`apps/api/internal/httpx/ready_test.go`:
```go
package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func routerWithReady(buf *bytes.Buffer, cfg *config.Config, ready httpx.ReadyFunc) http.Handler {
	d := testDeps(buf)
	d.Config = cfg
	d.Ready = ready
	return httpx.NewRouter(d)
}

func TestReadyzOKWhenDatabaseUp(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return nil })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	var body struct {
		Status            string            `json:"status"`
		Checks            map[string]string `json:"checks"`
		SemanticAvailable bool              `json:"semantic_available"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body.Status != "ready" {
		t.Errorf("status = %q", body.Status)
	}
	if body.Checks["database"] != "ok" {
		t.Errorf(`checks.database = %q`, body.Checks["database"])
	}
	// Provider noop KHÔNG được quảng cáo semantic là sẵn sàng.
	if body.SemanticAvailable {
		t.Error("semantic_available = true với provider noop")
	}
}

func TestReadyzFailsWhenDatabaseDown(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return errors.New("connection refused") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, muốn 503", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q", ct)
	}
	// Chi tiết lỗi hạ tầng không được rò ra client.
	if body := rec.Body.String(); bytes.Contains([]byte(body), []byte("connection refused")) {
		t.Errorf("readyz lộ chi tiết lỗi nội bộ: %s", body)
	}
}

// Healthz phản ánh tiến trình, không phụ thuộc DB (P01-A2).
func TestHealthzStillOKWhenDatabaseDown(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return errors.New("db down") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, muốn 200", rec.Code)
	}
}

// TEI là optional: deployment lexical-only vẫn phải ready (P01 §Contract).
func TestReadyzIgnoresTEI(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "tei", TEIURL: "http://tei-khong-ton-tai:80"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return nil })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200 — TEI không được làm ready fail", rec.Code)
	}
}
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/httpx/ -run TestReadyz -v`
Expected: FAIL — body thiếu `checks` / `semantic_available` (bản tạm ở Task 3 chỉ trả `status`)

- [ ] **Step 3: Thay `readyz` trong `health.go`**

`apps/api/internal/httpx/health.go` (thay hàm `readyz` tạm):
```go
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// healthz chỉ trả lời "tiến trình còn sống" — không chạm DB, không chạm TEI.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

type readyResponse struct {
	Status            string            `json:"status"`
	Checks            map[string]string `json:"checks"`
	SemanticAvailable bool              `json:"semantic_available"`
}

// readyz kiểm tra các phụ thuộc BẮT BUỘC (hiện chỉ có Postgres). TEI là optional:
// deployment lexical-only vẫn ready khi TEI chết (P01 §Contract).
// Lý do lỗi chỉ đi vào log, không đi vào response.
func readyz(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := d.Ready(r.Context()); err != nil {
			d.Logger.ErrorContext(r.Context(), "readyz thất bại",
				slog.String("check", "database"),
				slog.String("err", err.Error()),
				slog.String("request_id", RequestIDFrom(r.Context())),
			)
			WriteProblem(w, r, http.StatusServiceUnavailable, "dependency_unavailable",
				"Phụ thuộc bắt buộc chưa sẵn sàng.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(readyResponse{
			Status:            "ready",
			Checks:            map[string]string{"database": "ok"},
			SemanticAvailable: d.Config.SemanticAvailable(),
		})
	}
}
```

- [ ] **Step 4: Implement pool**

`apps/api/internal/db/pool.go`:
```go
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool tạo pool pgx với giới hạn hợp lý cho một instance API.
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("tạo pool: %w", err)
	}
	return pool, nil
}

// ReadyCheck trả hàm kiểm tra DB cho readyz. Timeout ngắn để probe không treo.
func ReadyCheck(pool *pgxpool.Pool) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			return fmt.Errorf("ping postgres: %w", err)
		}
		return nil
	}
}
```

- [ ] **Step 5: Viết test pool với DB thật**

`apps/api/internal/db/pool_test.go`:
```go
package db_test

import (
	"context"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func TestReadyCheckPassesOnLivePool(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	if err := db.ReadyCheck(pool)(ctx); err != nil {
		t.Fatalf("ReadyCheck: %v", err)
	}
}

func TestReadyCheckFailsOnClosedPool(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	pool.Close()

	if err := db.ReadyCheck(pool)(ctx); err == nil {
		t.Fatal("ReadyCheck muốn lỗi khi pool đã đóng, nhận nil")
	}
}
```

- [ ] **Step 6: Chạy lại test**

Run: `cd apps/api && go test ./internal/httpx/ ./internal/db/ -v -timeout 300s`
Expected: PASS (httpx 13 test, db 5 test)

- [ ] **Step 7: Commit**

```bash
git add apps/api/internal/db/pool.go apps/api/internal/db/pool_test.go apps/api/internal/httpx
git commit -m "feat(api): pgx pool and readyz with database dependency check"
```

---

### Task 6: Metrics, graceful shutdown và `cmd/api`

**Files:**
- Create: `apps/api/internal/obs/metrics.go`, `apps/api/internal/obs/logger.go`, `apps/api/cmd/api/main.go`
- Modify: `apps/api/internal/httpx/middleware.go` (thêm middleware ghi metric)
- Test: `apps/api/internal/obs/metrics_test.go`, `apps/api/cmd/api/main_test.go`

**Interfaces:**
- Consumes: `httpx.NewRouter`, `httpx.Deps`, `db.NewPool`, `db.ReadyCheck`, `config.Load`
- Produces:
  - `func obs.NewRegistry() (*prometheus.Registry, *obs.Metrics)`
  - `type obs.Metrics struct { RequestDuration *prometheus.HistogramVec }` với label `route`, `method`, `status` (**không** có label chứa dữ liệu người dùng)
  - `func obs.NewLogger(level, env string) *slog.Logger`
  - `func httpx.Observe(m *obs.Metrics) func(http.Handler) http.Handler`
  - Binary `cmd/api` lắng nghe `cfg.HTTPAddr`, shutdown trong `cfg.ShutdownTimeout`

- [ ] **Step 1: Cài Prometheus client**

```bash
cd apps/api && go get github.com/prometheus/client_golang@v1.23.2
```

- [ ] **Step 2: Viết test thất bại cho metrics**

`apps/api/internal/obs/metrics_test.go`:
```go
package obs_test

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func TestMetricsLabelsContainNoUserData(t *testing.T) {
	reg, m := obs.NewRegistry()

	m.RequestDuration.WithLabelValues("/api/v1/healthz", "GET", "200").Observe(0.01)

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}

	var found bool
	for _, f := range families {
		if f.GetName() != "engram_http_request_duration_seconds" {
			continue
		}
		found = true
		for _, metric := range f.GetMetric() {
			for _, label := range metric.GetLabel() {
				switch label.GetName() {
				case "route", "method", "status":
				default:
					t.Errorf("label lạ %q — metric không được mang dữ liệu người dùng", label.GetName())
				}
				if strings.Contains(label.GetValue(), "?") {
					t.Errorf("label %q chứa query string: %q", label.GetName(), label.GetValue())
				}
			}
		}
	}
	if !found {
		t.Fatal("thiếu metric engram_http_request_duration_seconds")
	}
}

func TestRegistryHasGoAndProcessCollectors(t *testing.T) {
	reg, _ := obs.NewRegistry()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	var hasGo bool
	for _, f := range families {
		if strings.HasPrefix(f.GetName(), "go_") {
			hasGo = true
		}
	}
	if !hasGo {
		t.Error("registry thiếu Go collector")
	}
	var _ prometheus.Gatherer = reg
}
```

- [ ] **Step 3: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/obs/ -v`
Expected: FAIL — `undefined: obs.NewRegistry`

- [ ] **Step 4: Implement obs**

`apps/api/internal/obs/metrics.go`:
```go
// Package obs gom logger và metric của API.
package obs

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics là tập metric ứng dụng. Label chỉ được là giá trị có cardinality thấp
// và KHÔNG mang dữ liệu người dùng: route là pattern của chi, không phải raw path.
type Metrics struct {
	RequestDuration *prometheus.HistogramVec
}

// NewRegistry tạo registry riêng (không dùng DefaultRegisterer) để test cô lập được.
func NewRegistry() (*prometheus.Registry, *Metrics) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	m := &Metrics{
		RequestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "engram_http_request_duration_seconds",
			Help:    "Thời gian xử lý request HTTP theo route pattern.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
		}, []string{"route", "method", "status"}),
	}
	reg.MustRegister(m.RequestDuration)
	return reg, m
}
```

`apps/api/internal/obs/logger.go`:
```go
package obs

import (
	"log/slog"
	"os"
)

// NewLogger trả logger JSON. Dev cũng dùng JSON để log giống production,
// tránh chuyện "chỉ production mới lộ field".
func NewLogger(level, env string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	return slog.New(h).With(slog.String("service", "engram-api"), slog.String("env", env))
}
```

- [ ] **Step 5: Thêm middleware `Observe` vào `middleware.go`**

Thêm vào cuối `apps/api/internal/httpx/middleware.go`:
```go
// Observe ghi latency vào histogram bằng route pattern — cùng lý do như AccessLog:
// raw path có thể chứa tham số riêng tư và làm nổ cardinality.
func Observe(m *obs.Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			m.RequestDuration.
				WithLabelValues(route, r.Method, strconv.Itoa(rec.status)).
				Observe(time.Since(start).Seconds())
		})
	}
}
```

Thêm import `"strconv"` và `"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"`.
Trong `NewRouter`, thêm field `Metrics *obs.Metrics` vào `Deps` và `r.Use(Observe(d.MetricsCollector))` — đặt tên field mới là `MetricsCollector` để không đụng `Metrics http.Handler` đã có:

```go
type Deps struct {
	Config           *config.Config
	Logger           *slog.Logger
	Ready            ReadyFunc
	Metrics          http.Handler   // handler của /api/v1/metrics
	MetricsCollector *obs.Metrics   // nơi ghi số liệu
}
```

Trong `NewRouter`, sau `r.Use(AccessLog(d.Logger))`:
```go
	if d.MetricsCollector != nil {
		r.Use(Observe(d.MetricsCollector))
	}
```

- [ ] **Step 6: Implement `cmd/api`**

`apps/api/cmd/api/main.go`:
```go
// Command api chạy HTTP server của engram.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func main() {
	// -healthcheck: image distroless không có shell/wget/curl, nên healthcheck
	// của Compose gọi lại chính binary này. Nhánh phải nằm TRƯỚC run() — nếu
	// không, container healthcheck sẽ khởi động một API thứ hai và đụng port.
	healthcheck := flag.Bool("healthcheck", false, "probe /api/v1/healthz rồi thoát theo status")
	flag.Parse()
	if *healthcheck {
		if err := probeHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	if err := run(); err != nil {
		slog.Error("api dừng do lỗi", slog.String("err", err.Error()))
		os.Exit(1)
	}
}

// probeHealth gọi healthz trên chính container này. Dùng HTTP_ADDR để lấy port,
// nhưng luôn nối tới 127.0.0.1 — 0.0.0.0 là địa chỉ nghe, không phải địa chỉ gọi.
func probeHealth() error {
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8080"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("HTTP_ADDR không hợp lệ: %w", err)
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/v1/healthz")
	if err != nil {
		return fmt.Errorf("healthz không gọi được: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz trả %d", resp.StatusCode)
	}
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := obs.NewLogger(cfg.LogLevel, cfg.Env)
	logger.Info("khởi động api", slog.Any("config", cfg.Redacted()))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	reg, metrics := obs.NewRegistry()

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpx.NewRouter(httpx.Deps{
			Config:           cfg,
			Logger:           logger,
			Ready:            db.ReadyCheck(pool),
			Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
			MetricsCollector: metrics,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("nghe HTTP", slog.String("addr", cfg.HTTPAddr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("nhận tín hiệu dừng, đang đóng kết nối")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	logger.Info("api đã dừng gọn")
	return nil
}
```

- [ ] **Step 7: Viết test smoke cho metrics endpoint**

`apps/api/internal/httpx/metrics_test.go`:
```go
package httpx_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func TestMetricsEndpointExposesRequestDuration(t *testing.T) {
	var buf bytes.Buffer
	reg, metrics := obs.NewRegistry()

	r := httpx.NewRouter(httpx.Deps{
		Config:           &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger:           testDeps(&buf).Logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
	})

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "engram_http_request_duration_seconds") {
		t.Errorf("metrics thiếu histogram: %s", body)
	}
	if !strings.Contains(body, `route="/api/v1/healthz"`) {
		t.Errorf("metrics thiếu label route: %s", body)
	}
}
```

- [ ] **Step 8: Chạy toàn bộ test Go**

Run: `cd apps/api && go build ./... && go test ./... -short -v`
Expected: PASS — `config` 5, `httpx` 14, `obs` 2; `db` bị skip do `-short`

- [ ] **Step 9: Commit**

```bash
git add apps/api/internal/obs apps/api/internal/httpx apps/api/cmd/api
git commit -m "feat(api): prometheus metrics, structured logger and graceful shutdown"
```

---

### Task 7: Pipeline sqlc + preflight extension lúc boot

**Files:**
- Create: `apps/api/sqlc.yaml`, `apps/api/internal/db/queries/system.sql`, `apps/api/internal/db/preflight.go`
- Modify: `apps/api/cmd/api/main.go` (gọi preflight sau khi tạo pool)
- Test: `apps/api/internal/db/preflight_test.go`

**Interfaces:**
- Consumes: `db.NewPool`, `db.MigrateUp`
- Produces:
  - Package sinh tự động `apps/api/internal/db/gen` với `gen.New(db gen.DBTX) *gen.Queries` và `func (q *Queries) ExtensionVersions(ctx context.Context) ([]ExtensionVersionsRow, error)`
  - `func db.Preflight(ctx context.Context, pool *pgxpool.Pool) error` — lỗi khi thiếu extension hoặc pgvector < 0.8

- [ ] **Step 1: Cài sqlc**

```bash
go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.30.0
sqlc version
```

- [ ] **Step 2: Viết `sqlc.yaml` và query**

`apps/api/sqlc.yaml`:
```yaml
version: "2"
sql:
  - engine: postgresql
    schema: migrations
    queries: internal/db/queries
    gen:
      go:
        package: gen
        out: internal/db/gen
        sql_package: pgx/v5
        emit_pointers_for_null_types: true
        emit_json_tags: false
```

`apps/api/internal/db/queries/system.sql`:
```sql
-- name: ExtensionVersions :many
-- Dùng cho preflight lúc boot: khẳng định database đã cài đúng extension.
SELECT extname, extversion
FROM pg_extension
ORDER BY extname;
```

- [ ] **Step 3: Sinh code và kiểm tra drift**

```bash
cd apps/api && sqlc generate && sqlc diff
```
Expected: `sqlc diff` không in gì (exit 0). Commit cả thư mục `internal/db/gen`.

- [ ] **Step 4: Viết test thất bại cho preflight**

`apps/api/internal/db/preflight_test.go`:
```go
package db_test

import (
	"context"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func TestPreflightPassesAfterMigration(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
}

// Database chưa migrate phải làm process chết ngay với thông báo rõ ràng,
// thay vì chạy tiếp rồi lỗi khó hiểu ở query đầu tiên.
func TestPreflightFailsBeforeMigration(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	err = db.Preflight(ctx, pool)
	if err == nil {
		t.Fatal("Preflight muốn lỗi khi chưa migrate, nhận nil")
	}
	if !strings.Contains(err.Error(), "vector") {
		t.Errorf("thông báo lỗi nên nêu tên extension thiếu, nhận: %v", err)
	}
}
```

- [ ] **Step 5: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/db/ -run TestPreflight -v -timeout 300s`
Expected: FAIL — `undefined: db.Preflight`

- [ ] **Step 6: Implement preflight**

`apps/api/internal/db/preflight.go`:
```go
package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

// requiredExtensions là các extension SPEC §4.3 bắt buộc.
var requiredExtensions = []string{"citext", "pg_trgm", "pgcrypto", "unaccent", "vector"}

// minPgvector là sàn version của pgvector theo spec.
const minPgvectorMajor, minPgvectorMinor = 0, 8

// Preflight khẳng định database đã sẵn sàng về mặt schema trước khi phục vụ traffic.
// Gọi một lần lúc boot; lỗi ở đây phải làm process thoát chứ không chỉ log.
func Preflight(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := gen.New(pool).ExtensionVersions(ctx)
	if err != nil {
		return fmt.Errorf("đọc pg_extension: %w", err)
	}

	installed := make(map[string]string, len(rows))
	for _, r := range rows {
		version := ""
		if r.Extversion != nil {
			version = *r.Extversion
		}
		installed[r.Extname] = version
	}

	var missing []string
	for _, ext := range requiredExtensions {
		if _, ok := installed[ext]; !ok {
			missing = append(missing, ext)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("database thiếu extension %s — chạy `migrate up` trước", strings.Join(missing, ", "))
	}

	if err := checkPgvectorFloor(installed["vector"]); err != nil {
		return err
	}
	return nil
}

func checkPgvectorFloor(version string) error {
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return fmt.Errorf("không đọc được version pgvector: %q", version)
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return fmt.Errorf("version pgvector không hợp lệ: %q", version)
	}
	if major < minPgvectorMajor || (major == minPgvectorMajor && minor < minPgvectorMinor) {
		return fmt.Errorf("pgvector %s thấp hơn sàn %d.%d của spec", version, minPgvectorMajor, minPgvectorMinor)
	}
	return nil
}
```

> Nếu sqlc sinh `Extversion string` thay vì `*string` (tuỳ nullability suy ra từ catalog), bỏ nhánh con trỏ và gán thẳng `installed[r.Extname] = r.Extversion`. Chạy `sqlc generate` rồi đọc `internal/db/gen/models.go` để biết kiểu thật trước khi viết.

- [ ] **Step 7: Gọi preflight trong `cmd/api/main.go`**

Ngay sau `defer pool.Close()`:
```go
	if err := db.Preflight(ctx, pool); err != nil {
		return fmt.Errorf("preflight database thất bại: %w", err)
	}
	logger.Info("preflight database ok")
```
Thêm import `"fmt"`.

- [ ] **Step 8: Chạy lại test**

Run: `cd apps/api && go build ./... && go test ./internal/db/ -v -timeout 300s`
Expected: PASS (7 test)

- [ ] **Step 9: Commit**

```bash
git add apps/api/sqlc.yaml apps/api/internal/db apps/api/cmd/api/main.go
git commit -m "feat(api): sqlc pipeline and database preflight on boot"
```

---

### Task 8: `cmd/worker` — River lifecycle (chưa embed dữ liệu thật)

**Files:**
- Create: `apps/api/internal/worker/worker.go`, `apps/api/internal/worker/noop_job.go`, `apps/api/cmd/worker/main.go`, `apps/api/migrations/0002_river.up.sql`, `apps/api/migrations/0002_river.down.sql`
- Test: `apps/api/internal/worker/worker_test.go`

**Interfaces:**
- Consumes: `config.Config`, `db.NewPool`, `obs.NewLogger`
- Produces:
  - `type worker.NoopArgs struct{}` với `func (NoopArgs) Kind() string { return "noop" }`
  - `func worker.New(pool *pgxpool.Pool, logger *slog.Logger) (*river.Client[pgx.Tx], error)`
  - `func worker.Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error`

- [ ] **Step 1: Cài River**

```bash
cd apps/api
go get github.com/riverqueue/river@v0.31.0
go get github.com/riverqueue/river/riverdriver/riverpgxv5
go install github.com/riverqueue/river/cmd/river@v0.31.0
```

- [ ] **Step 2: Sinh migration của River**

```bash
cd apps/api
river migrate-get --up --all --line main > migrations/0002_river.up.sql
river migrate-get --down --all --line main > migrations/0002_river.down.sql
```

Thêm dòng đầu cho file up:
```sql
-- Sinh bởi `river migrate-get`. Không sửa tay; muốn nâng cấp thì sinh migration mới.
```

- [ ] **Step 3: Viết test thất bại**

`apps/api/internal/worker/worker_test.go`:
```go
package worker_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// Worker phải Start/Stop gọn: P01 chỉ cần lifecycle, chưa cần job thật.
func TestClientStartsAndStops(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 30*time.Second)
	defer stopCancel()
	if err := client.Stop(stopCtx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

func TestNoopJobRunsToCompletion(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, worker.NoopArgs{}, nil); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	select {
	case ev := <-subscribeCh:
		if ev.Job.Kind != "noop" {
			t.Errorf("kind = %q, muốn noop", ev.Job.Kind)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("job noop không hoàn thành trong 20s")
	}
}
```

Thêm helper dùng chung (copy từ `internal/db/migrate_test.go`, đổi tên để không trùng package):

`apps/api/internal/worker/testsupport_test.go`:
```go
package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func startPostgresForWorker(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("engram"),
		tcpostgres.WithUsername("engram"),
		tcpostgres.WithPassword("engram"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		t.Fatalf("khởi động Postgres: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(c) })

	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("lấy DSN: %v", err)
	}
	return dsn
}
```

- [ ] **Step 4: Chạy test để chắc nó fail**

Run: `cd apps/api && go test ./internal/worker/ -v -timeout 300s`
Expected: FAIL — `undefined: worker.New`

- [ ] **Step 5: Implement job noop**

`apps/api/internal/worker/noop_job.go`:
```go
// Package worker chạy job nền bằng River.
package worker

import (
	"context"
	"log/slog"

	"github.com/riverqueue/river"
)

// NoopArgs là job không làm gì. Tồn tại vì River từ chối Start khi Workers rỗng,
// và vì P01 cần chứng minh vòng đời insert → chạy → completed hoạt động.
// P05 thay bằng job embedding thật.
type NoopArgs struct{}

func (NoopArgs) Kind() string { return "noop" }

type NoopWorker struct {
	river.WorkerDefaults[NoopArgs]
	logger *slog.Logger
}

func (w *NoopWorker) Work(ctx context.Context, job *river.Job[NoopArgs]) error {
	w.logger.InfoContext(ctx, "job noop chạy", slog.Int64("job_id", job.ID))
	return nil
}
```

- [ ] **Step 6: Implement client**

`apps/api/internal/worker/worker.go`:
```go
package worker

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

// New dựng River client với queue mặc định. P01 chỉ đăng ký NoopWorker.
func New(pool *pgxpool.Pool, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	if err := river.AddWorkerSafely(workers, &NoopWorker{logger: logger}); err != nil {
		return nil, fmt.Errorf("đăng ký worker: %w", err)
	}

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger: logger,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 4},
		},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("tạo river client: %w", err)
	}
	return client, nil
}

// Run chạy worker cho tới khi nhận SIGINT/SIGTERM rồi dừng gọn.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		return fmt.Errorf("preflight database thất bại: %w", err)
	}

	client, err := New(pool, logger)
	if err != nil {
		return err
	}
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}
	logger.Info("worker đang chạy", slog.Bool("semantic_available", cfg.SemanticAvailable()))

	<-ctx.Done()

	stopCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := client.Stop(stopCtx); err != nil {
		return fmt.Errorf("stop worker: %w", err)
	}
	logger.Info("worker đã dừng gọn")
	return nil
}
```

`apps/api/cmd/worker/main.go`:
```go
// Command worker chạy job nền của engram.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("cấu hình không hợp lệ", slog.String("err", err.Error()))
		os.Exit(1)
	}
	logger := obs.NewLogger(cfg.LogLevel, cfg.Env)

	if err := worker.Run(context.Background(), cfg, logger); err != nil {
		logger.Error("worker dừng do lỗi", slog.String("err", err.Error()))
		os.Exit(1)
	}
}
```

- [ ] **Step 7: Chạy lại test**

Run: `cd apps/api && go build ./... && go test ./internal/worker/ -v -timeout 420s`
Expected: PASS (2 test)

- [ ] **Step 8: Commit**

```bash
git add apps/api/internal/worker apps/api/cmd/worker apps/api/migrations
git commit -m "feat(api): river worker lifecycle with noop job"
```

---

### Task 9: OpenAPI 3.1 + typed client sinh tự động

**Files:**
- Create: `apps/api/api/openapi.yaml`, `packages/shared-types/src/client.ts`
- Modify: `packages/shared-types/package.json` (script `generate`), `packages/shared-types/src/index.ts`
- Test: `apps/api/internal/httpx/contract_test.go`, `packages/shared-types/src/client.test.ts`

**Interfaces:**
- Consumes: `ProblemDetails`, `isProblemDetails` (Task 2); router (Task 3, 5)
- Produces:
  - `packages/shared-types/src/api.d.ts` (sinh bởi `openapi-typescript`, committed)
  - `export type ReadyResponse = paths['/readyz']['get']['responses']['200']['content']['application/json']`
  - `export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T>` — ném `ProblemError` khi response là problem+json; ném `Error` khi `path` không phải đường tương đối; `credentials: 'same-origin'` do hàm ép, caller không ghi đè được

- [ ] **Step 1: Viết `openapi.yaml`**

`apps/api/api/openapi.yaml`:
```yaml
openapi: 3.1.0
info:
  title: engram API
  version: 0.1.0
  description: |
    API của engram. Ở P01 chỉ có ba endpoint vận hành.
    Mọi lỗi dùng RFC 9457 (application/problem+json).
servers:
  # Dev và production dùng chung một origin; browser luôn gọi đường tương đối.
  - url: /api/v1
paths:
  /healthz:
    get:
      operationId: getHealthz
      summary: Tiến trình còn sống
      responses:
        '200':
          description: Tiến trình đang chạy
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status:
                    type: string
                    const: ok
  /readyz:
    get:
      operationId: getReadyz
      summary: Phụ thuộc bắt buộc đã sẵn sàng
      responses:
        '200':
          description: Sẵn sàng nhận traffic
          content:
            application/json:
              schema:
                type: object
                required: [status, checks, semantic_available]
                properties:
                  status:
                    type: string
                    const: ready
                  checks:
                    type: object
                    additionalProperties:
                      type: string
                  semantic_available:
                    type: boolean
                    description: false khi EMBEDDING_PROVIDER=noop hoặc thiếu TEI_URL.
        '503':
          description: Phụ thuộc bắt buộc chưa sẵn sàng
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/Problem'
  /metrics:
    get:
      operationId: getMetrics
      summary: Số liệu Prometheus (chỉ dành cho vận hành)
      responses:
        '200':
          description: Dạng text phơi bày của Prometheus
          content:
            text/plain:
              schema:
                type: string
components:
  schemas:
    Problem:
      type: object
      required: [type, title, status, code]
      properties:
        type:
          type: string
          format: uri
          examples: ['https://key.zone17th.click/problems/dependency_unavailable']
        title: { type: string }
        status: { type: integer }
        detail: { type: string }
        instance:
          type: string
          description: Request ID, không phải URL.
        code:
          type: string
          enum: [invalid_request, dependency_unavailable, internal_error, not_found]
```

- [ ] **Step 2: Viết contract test phía Go**

`apps/api/internal/httpx/contract_test.go`:
```go
package httpx_test

import (
	"os"
	"strings"
	"testing"
)

// OpenAPI phải khai báo đúng ba path của P01 và không khai báo endpoint ở root.
func TestOpenAPIDeclaresOnlyP01Paths(t *testing.T) {
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("đọc openapi.yaml: %v", err)
	}
	spec := string(raw)

	for _, p := range []string{"  /healthz:", "  /readyz:", "  /metrics:"} {
		if !strings.Contains(spec, p) {
			t.Errorf("openapi.yaml thiếu path %q", strings.TrimSpace(p))
		}
	}
	if !strings.Contains(spec, "url: /api/v1") {
		t.Error("server URL phải là /api/v1 (một origin, đường tương đối)")
	}
	if strings.Contains(spec, "http://localhost:8080") {
		t.Error("openapi.yaml không được hardcode origin của API — dev đi qua proxy")
	}
}
```

- [ ] **Step 3: Chạy test Go**

Run: `cd apps/api && go test ./internal/httpx/ -run TestOpenAPI -v`
Expected: PASS

- [ ] **Step 4: Viết test thất bại cho client TS**

`packages/shared-types/src/client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemError, apiFetch } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

describe('apiFetch', () => {
  it('trả body JSON khi 200', async () => {
    stubFetch(
      new Response(JSON.stringify({ status: 'ready', checks: { database: 'ok' }, semantic_available: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(apiFetch('/readyz')).resolves.toEqual({
      status: 'ready',
      checks: { database: 'ok' },
      semantic_available: false,
    });
  });

  it('ném ProblemError khi nhận problem+json', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          type: 'https://key.zone17th.click/problems/dependency_unavailable',
          title: 'Phụ thuộc chưa sẵn sàng',
          status: 503,
          code: 'dependency_unavailable',
        }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } },
      ),
    );

    await expect(apiFetch('/readyz')).rejects.toBeInstanceOf(ProblemError);
  });

  it('gọi đường tương đối dưới /api/v1 — không bao giờ cross-origin', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);

    await apiFetch('/healthz');

    expect(spy).toHaveBeenCalledWith('/api/v1/healthz', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('không cho caller ghi đè credentials', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);

    await apiFetch('/healthz', { credentials: 'include' });

    expect(spy).toHaveBeenCalledWith('/api/v1/healthz', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('từ chối path không phải đường tương đối', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    for (const bad of ['https://evil.example/steal', '//evil.example/steal', 'healthz', '/\\evil.example']) {
      await expect(apiFetch(bad)).rejects.toThrow(/đường tương đối/);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/shared-types test`
Expected: FAIL — không resolve được `./client`

- [ ] **Step 6: Sinh type và implement client**

```bash
pnpm --filter @engram/shared-types add -D openapi-typescript@^7.9.0
```

Thêm vào `packages/shared-types/package.json`:
```json
"scripts": {
  "generate": "openapi-typescript ../../apps/api/api/openapi.yaml -o ./src/api.d.ts",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

```bash
pnpm --filter @engram/shared-types generate
```

`packages/shared-types/src/client.ts`:
```ts
import type { paths } from './api';
import { type ProblemDetails, isProblemDetails } from './problem';

/** Tiền tố duy nhất. Luôn tương đối: dev proxy /api sang Go trên cùng origin. */
const API_PREFIX = '/api/v1';

export type HealthResponse = paths['/healthz']['get']['responses']['200']['content']['application/json'];
export type ReadyResponse = paths['/readyz']['get']['responses']['200']['content']['application/json'];

/**
 * Chặn mọi path có thể thoát khỏi origin. `//host` và `/\host` đều bị browser
 * hiểu là scheme-relative URL; URL tuyệt đối thì khỏi nói. Chỉ cho phép đường
 * bắt đầu bằng đúng một `/`.
 */
function assertRelativePath(path: string): void {
  const escapes = path.startsWith('//') || path.startsWith('/\\');
  if (!path.startsWith('/') || escapes) {
    throw new Error(`apiFetch chỉ nhận đường tương đối bắt đầu bằng "/": ${path}`);
  }
}

/** Lỗi mang nguyên body RFC 9457 để UI hiển thị đúng title/code. */
export class ProblemError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ProblemError';
  }
}

/**
 * apiFetch là cổng duy nhất ra API.
 * `credentials: 'same-origin'` là chủ ý: cookie `sabk_session` có path `/api`
 * và chỉ hợp lệ trên chính origin này.
 *
 * Thứ tự spread là một phần của contract: `...init` đứng TRƯỚC, `credentials`
 * đứng SAU. Nếu ngược lại, một caller truyền `{ credentials: 'include' }` sẽ
 * âm thầm mở gateway policy ra cross-origin. Caller được đổi method/body/signal,
 * không được đổi credentials.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  assertRelativePath(path);
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
    credentials: 'same-origin',
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/problem+json')) {
    const body: unknown = await res.json();
    if (isProblemDetails(body)) throw new ProblemError(body);
    throw new Error(`Lỗi không rõ định dạng (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(`Yêu cầu thất bại (HTTP ${res.status}).`);
  }
  return (await res.json()) as T;
}
```

`packages/shared-types/src/index.ts`:
```ts
export * from './problem';
export * from './client';
export type { paths, components } from './api';
```

- [ ] **Step 7: Chạy lại test TS**

Run: `pnpm --filter @engram/shared-types test && pnpm --filter @engram/shared-types typecheck`
Expected: PASS (9 test), typecheck sạch

- [ ] **Step 8: Commit**

```bash
git add apps/api/api packages/shared-types
git commit -m "feat(api): openapi 3.1 contract and generated typed client"
```

---

## Phần B — Web

### Task 10: Scaffold Next.js + Tailwind + port token (có test đối chiếu với mockup)

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/styles/tokens.css`, `apps/web/app/globals.css`, `apps/web/vitest.config.ts`
- Test: `apps/web/tests/tokens.parity.test.ts`

**Interfaces:**
- Consumes: không có
- Produces:
  - `apps/web/styles/tokens.css` — bản port 1:1 của `mockups/tokens.css`
  - `tailwind.config.ts` mirror `mockups/tw.js` (color/radius/maxWidth/fontFamily/boxShadow)
  - Lệnh `pnpm --filter @engram/web test|typecheck|build|dev`

- [ ] **Step 1: Scaffold Next.js 15**

```bash
pnpm dlx create-next-app@15 apps/web --typescript --eslint --app --src-dir=false --import-alias "@/*" --no-tailwind --use-pnpm
```

Sửa `apps/web/package.json`: đặt `"name": "@engram/web"`, thêm `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`.

Xoá các file scaffold sẽ va với cấu trúc route của P01. `app/page.tsx` ở root sẽ tranh `/` với `(marketing)/[locale]/page.tsx`; `app/layout.tsx` phải biến mất để hai layout con thành root layout (Task 11 Step 8).

```bash
rm -f apps/web/app/page.tsx apps/web/app/layout.tsx apps/web/app/favicon.ico
```

Giữ lại `apps/web/app/globals.css` — Step 6 ghi đè nội dung file này.

- [ ] **Step 2: Cài Tailwind 3.4 và deps**

```bash
pnpm --filter @engram/web add -D tailwindcss@^3.4.17 postcss@^8.5.6 autoprefixer@^10.4.21 vitest@^3.2.0 @vitejs/plugin-react@^5.0.0 jsdom@^26.0.0 @testing-library/react@^16.3.0 @testing-library/user-event@^14.6.0
pnpm --filter @engram/web add next-intl@^4.3.0 @tanstack/react-query@^5.90.0 clsx@^2.1.1 tailwind-merge@^3.3.0 @engram/shared-types@workspace:*
```

> **Quyết định (có thể đảo ngược):** dùng Tailwind **v3.4** chứ không phải v4. Lý do: `mockups/tw.js` là config dạng v3 (`theme.extend`), port 1:1 sang `tailwind.config.ts` giữ đúng tên tiện ích của mockup mà không phải dịch sang cú pháp `@theme` của v4. Nếu sau này nâng v4, phải viết lại toàn bộ mapping trong một PR riêng và chạy lại test parity ở Step 4.

- [ ] **Step 3: Viết test parity thất bại**

`apps/web/tests/tokens.parity.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

function readVars(css: string, selector: string): Map<string, string> {
  // Lấy khối `selector { ... }` đầu tiên rồi bóc các khai báo --var: value;
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`không tìm thấy selector ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);

  const vars = new Map<string, string>();
  for (const line of block.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) vars.set(m[1], m[2].replace(/\s+/g, ' '));
  }
  return vars;
}

/**
 * Ba biến font là khác biệt DUY NHẤT được phép giữa mockup và web: mockup nạp
 * font qua CDN, web self-host qua next/font để hợp CSP. Chúng được loại khỏi cả
 * phép "không thêm biến lạ" lẫn phép "giữ nguyên giá trị"; bù lại có test riêng
 * bên dưới bắt buộc chúng phải trỏ vào biến của next/font.
 */
const WEB_ONLY = new Set(['--font-display', '--font-sans', '--font-mono']);

const mockupCss = readFileSync(resolve(ROOT, 'mockups/tokens.css'), 'utf8');
const webCss = readFileSync(resolve(ROOT, 'apps/web/styles/tokens.css'), 'utf8');

describe.each([':root', "[data-theme='dark']"])('token %s', (selector) => {
  const fromMockup = readVars(mockupCss, selector);
  const fromWeb = readVars(webCss, selector);

  it('không thiếu biến nào so với mockup', () => {
    const missing = [...fromMockup.keys()].filter((k) => !fromWeb.has(k));
    expect(missing).toEqual([]);
  });

  it('không thêm biến lạ ngoài danh sách cho phép', () => {
    const extra = [...fromWeb.keys()].filter((k) => !fromMockup.has(k) && !WEB_ONLY.has(k));
    expect(extra).toEqual([]);
  });

  it('giữ nguyên giá trị của mọi biến (trừ ba biến font)', () => {
    const drifted: string[] = [];
    for (const [name, value] of fromMockup) {
      if (WEB_ONLY.has(name)) continue;
      if (fromWeb.get(name) !== value) drifted.push(`${name}: mockup=${value} web=${fromWeb.get(name)}`);
    }
    expect(drifted).toEqual([]);
  });
});

describe('font self-host', () => {
  const root = readVars(webCss, ':root');

  // Không đủ nếu chỉ bỏ qua --font-*: phải chứng minh chúng trỏ vào next/font,
  // chứ không phải bị xoá hay quay lại tên font của CDN.
  it.each([
    ['--font-display', '--font-plus-jakarta'],
    ['--font-sans', '--font-inter'],
    ['--font-mono', '--font-sometype'],
  ])('%s dùng biến %s do next/font cấp', (token, nextFontVar) => {
    expect(root.get(token)).toContain(`var(${nextFontVar})`);
  });

  it('giữ nguyên fallback stack của mockup', () => {
    const mockupRoot = readVars(mockupCss, ':root');
    for (const token of WEB_ONLY) {
      const mockupValue = mockupRoot.get(token);
      if (!mockupValue) continue;
      // Tên font đầu tiên của mockup vẫn phải còn trong chuỗi fallback của web.
      const firstFamily = mockupValue.split(',')[0].trim();
      expect(root.get(token)).toContain(firstFamily);
    }
  });
});

describe('token thương hiệu', () => {
  const root = readVars(webCss, ':root');
  it.each([
    ['--accent', '#B4128F'],
    ['--accent-hover', '#9A0F7A'],
    ['--accent-pressed', '#7D0C63'],
    ['--link', '#0091FF'],
    ['--logo-magenta', '#FA12E3'],
    ['--logo-cyan', '#12D0FA'],
    ['--product-teal', '#12A594'],
    ['--product-yellow', '#FFC800'],
    ['--app-navy', '#101F52'],
    ['--container', '1160px'],
  ])('%s = %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });
});

describe('port production', () => {
  it('không mang Tailwind Play CDN vào bundle', () => {
    expect(webCss).not.toContain('cdn.tailwindcss.com');
  });

  it('không @import Google Fonts (vi phạm CSP style-src/font-src)', () => {
    expect(webCss).not.toContain('fonts.googleapis.com');
    expect(webCss).not.toContain('@import');
  });

  it('giữ rule [hidden] thắng utility display của Tailwind', () => {
    expect(webCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});
```

- [ ] **Step 4: Chạy test để chắc nó fail**

`apps/web/vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
  },
});
```

`apps/web/tests/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

```bash
pnpm --filter @engram/web add -D @testing-library/jest-dom@^6.9.0
pnpm --filter @engram/web test
```
Expected: FAIL — `apps/web/styles/tokens.css` chưa tồn tại

- [ ] **Step 5: Port token**

```bash
cp mockups/tokens.css apps/web/styles/tokens.css
```

Rồi sửa trong `apps/web/styles/tokens.css`:
1. Xoá mọi dòng `@import url('https://fonts.googleapis.com/...')` nếu có.
2. Trong `:root`, đổi ba khai báo font sang biến do `next/font` cấp (giữ nguyên fallback stack):
```css
  --font-display: var(--font-plus-jakarta), 'Plus Jakarta Sans', sans-serif;
  --font-sans: var(--font-inter), Inter, sans-serif;
  --font-mono: var(--font-sometype), 'Sometype Mono', ui-monospace, monospace;
```
3. Thêm ghi chú đầu file:
```css
/* Port 1:1 từ mockups/tokens.css — nguồn sự thật thị giác (SPEC §7.0).
   Đổi giá trị ở đây mà không đổi bên mockup sẽ làm tests/tokens.parity.test.ts đỏ.
   Khác biệt duy nhất được phép: ba biến --font-* lấy từ next/font thay vì CDN. */
```

`--font-*` đã nằm trong `WEB_ONLY` của test parity nên bước 2 không làm test đỏ; đổi lại, `describe('font self-host')` bắt buộc giá trị mới phải chứa `var(--font-plus-jakarta|inter|sometype)` **và** giữ tên font đầu tiên của mockup trong fallback stack. Khai báo `font-family` của các class (`.t-display`, `.mono`, …) giữ nguyên `var(--font-*)` như mockup — không sửa class.

- [ ] **Step 6: Viết `tailwind.config.ts` mirror `tw.js`**

`apps/web/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

/**
 * Bản port của mockups/tw.js. Tên tiện ích phải khớp từng chữ với mockup,
 * vì markup của component được chép thẳng từ file HTML trong mockups/.
 */
const config: Config = {
  darkMode: ['class', "[data-theme='dark']"],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        surfaceAlt: 'var(--surface-alt)',
        line: 'var(--border)',
        lineStrong: 'var(--border-strong)',
        ink: 'var(--ink)',
        body: 'var(--body)',
        muted: 'var(--muted)',
        primary: 'var(--primary)',
        accent: 'var(--accent)',
        link: 'var(--link)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        error: 'var(--error)',
        paleAccent: 'var(--pale-accent)',
        paleBlue: 'var(--pale-blue)',
        palePink: 'var(--pale-pink)',
        paleOrange: 'var(--pale-orange)',
        deepPanel: 'var(--deep-panel)',
        darkFooter: 'var(--dark-footer)',
        aiPink: 'var(--ai-pink)',
        aiCyan: 'var(--ai-cyan)',
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        xxl: 'var(--r-xxl)',
        section: 'var(--r-section)',
        pill: 'var(--r-pill)',
      },
      maxWidth: { container: 'var(--container)' },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        card: 'var(--sh-card)',
        hero: 'var(--sh-hero)',
        agent: 'var(--sh-agent)',
        pop: 'var(--sh-pop)',
      },
    },
  },
  plugins: [],
};

export default config;
```

`apps/web/postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`apps/web/app/globals.css`:
```css
/* @import PHẢI đứng trước mọi at-rule khác (CSS spec) — postcss-import cảnh báo
   và có bundler sẽ bỏ qua nếu đặt sau `@tailwind`. Đặt ở dòng 1 là bản đúng. */
@import '../styles/tokens.css';

/* Thứ tự đặc hiệu vẫn đúng: token là `:root { --… }` (specificity 0,1,0 trên
   phần tử gốc) nên không đua với preflight của `@tailwind base`, còn utility
   của `@tailwind utilities` đứng sau nên vẫn thắng như thường. */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 7: Thêm test mapping Tailwind**

Thêm vào cuối `apps/web/tests/tokens.parity.test.ts`:
```ts
describe('tailwind mirror tw.js', async () => {
  const twSource = readFileSync(resolve(ROOT, 'mockups/tw.js'), 'utf8');
  const config = (await import('../tailwind.config')).default;

  it('có đủ mọi tên màu mockup dùng', () => {
    const names = [...twSource.matchAll(/^\s{8}(\w+):\s*'var\(--[\w-]+\)'/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const colors = config.theme?.extend?.colors as Record<string, string>;
    for (const name of names) {
      if (name in colors) continue;
      const radii = config.theme?.extend?.borderRadius as Record<string, string>;
      const shadows = config.theme?.extend?.boxShadow as Record<string, string>;
      expect(name in radii || name in shadows).toBe(true);
    }
  });

  it('giữ maxWidth container = var(--container)', () => {
    expect((config.theme?.extend?.maxWidth as Record<string, string>).container).toBe('var(--container)');
  });
});
```

- [ ] **Step 8: Chạy lại test**

Run: `pnpm --filter @engram/web test`
Expected: PASS (11 test)

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold next app and port design tokens from mockups"
```

---

### Task 11: Theme provider, font self-host, `next-intl` và test key parity

**Files:**
- Create: `apps/web/i18n/routing.ts`, `apps/web/i18n/request.ts`, `apps/web/i18n/app-locale.ts`, `apps/web/middleware.ts`, `apps/web/messages/en.json`, `apps/web/messages/vi.json`, `apps/web/components/theme-provider.tsx`, `apps/web/app/fonts.ts`, `apps/web/app/(marketing)/[locale]/layout.tsx`
- Modify: `apps/web/next.config.ts`
- Xoá: `apps/web/app/layout.tsx` (nếu `create-next-app` đã sinh) — xem [Sai lệch có chủ ý](#sai-lệch-có-chủ-ý-so-với-danh-sách-file-của-p01)
- Test: `apps/web/tests/i18n.parity.test.ts`, `apps/web/tests/theme-provider.test.tsx`

**Interfaces:**
- Consumes: `styles/tokens.css` (Task 10)
- Produces:
  - `export const routing = defineRouting({ locales: ['en','vi'], defaultLocale: 'en', localePrefix: 'as-needed' })`
  - `export function ThemeProvider({ children }: { children: ReactNode })` — set `data-theme` trên `<html>`, đọc `localStorage['engram.theme']`, fallback `prefers-color-scheme`
  - `export function useTheme(): { theme: 'light' | 'dark'; toggle: () => void }`
  - Biến font: `--font-plus-jakarta`, `--font-inter`, `--font-sometype` gắn trên `<html className>` qua `export const fontVariables: string` trong `app/fonts.ts`
  - `export const APP_LOCALE = 'vi'` trong `i18n/app-locale.ts` — locale tạm của `/app`, Task 15 dùng

- [ ] **Step 1: Viết test key parity thất bại**

`apps/web/tests/i18n.parity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import vi from '../messages/vi.json';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

const enKeys = flatten(en).sort();
const viKeys = flatten(vi).sort();

describe('i18n', () => {
  it('en và vi có cùng bộ key', () => {
    expect(viKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !viKeys.includes(k))).toEqual([]);
  });

  it('không có chuỗi rỗng', () => {
    for (const [locale, messages] of [['en', en], ['vi', vi]] as const) {
      const empties = flatten(messages).filter((path) => {
        const value = path.split('.').reduce<any>((acc, part) => acc?.[part], messages);
        return typeof value === 'string' && value.trim() === '';
      });
      expect(`${locale}: ${empties.join(', ')}`).toBe(`${locale}: `);
    }
  });

  // Tên sản phẩm luôn viết thường ở MỌI locale (Global Constraints).
  it('không locale nào viết hoa tên sản phẩm', () => {
    for (const messages of [en, vi]) {
      const json = JSON.stringify(messages);
      expect(json).not.toMatch(/Engram|ENGRAM/);
      expect(json).toContain('engram');
    }
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/web test i18n`
Expected: FAIL — không resolve được `../messages/en.json`

- [ ] **Step 3: Viết messages**

`apps/web/messages/vi.json`:
```json
{
  "brand": { "name": "engram", "tagline": "Gõ một từ bạn còn nhớ." },
  "nav": { "how": "Cách dùng", "privacy": "Riêng tư", "recovery": "Khôi phục", "openApp": "Mở engram" },
  "landing": {
    "heroTitle": "Gõ một từ bạn còn nhớ.",
    "heroTitleSecond": "Thấy lại thứ bạn đã quên.",
    "heroSub": "engram lưu mọi thứ theo từ khoá bạn tự đặt. Gõ một từ, thấy lại cả mẩu ghi chú.",
    "demoCaption": "Dữ liệu mẫu, gõ thoải mái — không có gì được gửi đi đâu cả.",
    "cta": "Bắt đầu bằng một từ khoá"
  },
  "app": {
    "searchPlaceholder": "Gõ từ khoá…",
    "recent": "Mục gần đây",
    "semantic": "Gần nghĩa",
    "vaultOpen": "Vault mở",
    "vaultLocked": "Vault đang khoá"
  },
  "states": {
    "emptyTitle": "Chưa có gì ở đây",
    "emptyBody": "Lưu mục đầu tiên bằng cách gõ từ khoá rồi nhấn Enter.",
    "errorTitle": "Không tải được",
    "errorBody": "Thử lại sau giây lát.",
    "retry": "Thử lại"
  },
  "footer": { "legal": "engram — lưu theo từ khoá." }
}
```

`apps/web/messages/en.json`:
```json
{
  "brand": { "name": "engram", "tagline": "Type one word you still remember." },
  "nav": { "how": "How it works", "privacy": "Privacy", "recovery": "Recovery", "openApp": "Open engram" },
  "landing": {
    "heroTitle": "Type one word you still remember.",
    "heroTitleSecond": "See the thing you forgot.",
    "heroSub": "engram stores everything under keywords you choose. Type one word, get the whole note back.",
    "demoCaption": "Sample data — type freely, nothing is sent anywhere.",
    "cta": "Start with one keyword"
  },
  "app": {
    "searchPlaceholder": "Type a keyword…",
    "recent": "Recent items",
    "semantic": "Similar meaning",
    "vaultOpen": "Vault open",
    "vaultLocked": "Vault locked"
  },
  "states": {
    "emptyTitle": "Nothing here yet",
    "emptyBody": "Save your first item by typing a keyword and pressing Enter.",
    "errorTitle": "Could not load",
    "errorBody": "Try again in a moment.",
    "retry": "Try again"
  },
  "footer": { "legal": "engram — saved by keyword." }
}
```

- [ ] **Step 4: Cấu hình next-intl**

`apps/web/i18n/routing.ts`:
```ts
import { defineRouting } from 'next-intl/routing';

/**
 * `as-needed`: `/` là en, `/vi` là vi (P01 §UI và route).
 * App riêng tư nằm ở segment tĩnh `/app`, KHÔNG có prefix locale.
 */
export const routing = defineRouting({
  locales: ['en', 'vi'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
});
```

`apps/web/i18n/request.ts`:
```ts
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return { locale, messages: (await import(`../messages/${locale}.json`)).default };
});
```

`apps/web/middleware.ts`:
```ts
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Loại trừ /api (proxy sang Go), /app (segment tĩnh, không prefix locale),
  // asset của Next và file tĩnh. Nếu middleware chạm /api, cookie path và
  // rewrite sẽ vênh nhau.
  matcher: ['/((?!api|app|_next|_vercel|.*\\..*).*)'],
};
```

`apps/web/next.config.ts`:
```ts
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Dev đi qua MỘT origin: browser gọi /api/... trên localhost:3000,
    // Next chuyển tiếp sang Go. Nhờ vậy cookie path /api, credentials và CSP
    // không xung đột, và không phải cấu hình CORS/CSRF cho dev (P01 §UI và route).
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_UPSTREAM ?? 'http://127.0.0.1:8080'}/api/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
```

- [ ] **Step 5: Viết test thất bại cho theme provider**

`apps/web/tests/theme-provider.test.tsx`:
```tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from '../components/theme-provider';

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('mặc định light khi chưa có lựa chọn nào', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('đọc lại lựa chọn đã lưu', () => {
    localStorage.setItem('engram.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggle đổi data-theme và lưu lại', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {
      await userEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('engram.theme')).toBe('dark');
  });
});
```

- [ ] **Step 6: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/web test theme`
Expected: FAIL — không resolve được `../components/theme-provider`

- [ ] **Step 7: Implement theme provider**

`apps/web/components/theme-provider.tsx`:
```tsx
'use client';

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'engram.theme';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'light' ? 'dark' : 'light';
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme phải nằm trong ThemeProvider');
  return ctx;
}
```

- [ ] **Step 8: Font self-host dùng chung + root layout của marketing**

Nếu `create-next-app` đã sinh `apps/web/app/layout.tsx`, **xoá nó**: P01 dùng hai root layout song song để `<html lang>` bám theo locale mà không mất SSG (lý do đầy đủ ở [Sai lệch có chủ ý](#sai-lệch-có-chủ-ý-so-với-danh-sách-file-của-p01)).

```bash
rm -f apps/web/app/layout.tsx
```

`apps/web/app/fonts.ts`:
```ts
import { Inter, Plus_Jakarta_Sans, Sometype_Mono } from 'next/font/google';

// next/font tải font lúc build và phục vụ từ chính origin — bắt buộc để hợp CSP
// `default-src 'self'` (SPEC §10.2). Giao diện giữ nguyên như mockup.
//
// File này tồn tại vì có HAI root layout (marketing và /app) cùng cần font.
// Gọi next/font ở hai nơi sẽ tải hai bản, mỗi bản một class hash khác nhau.
const display = Plus_Jakarta_Sans({ subsets: ['latin', 'vietnamese'], variable: '--font-plus-jakarta', display: 'swap' });
const sans = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-inter', display: 'swap' });
const mono = Sometype_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-sometype', display: 'swap' });

export const fontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
```

`apps/web/i18n/app-locale.ts`:
```ts
/**
 * Locale của `/app` ở P01. Hằng số chứ không hardcode rải rác: `<html lang>` và
 * `NextIntlClientProvider` phải luôn khớp nhau, lệch một cái là screen reader
 * đọc sai giọng.
 *
 * P02 thay hằng này bằng locale đọc từ hồ sơ người dùng (sau khi có session).
 * Ghi vào nợ kỹ thuật ở Task 18.
 */
export const APP_LOCALE = 'vi' as const;
```

`apps/web/app/(marketing)/[locale]/layout.tsx` — **root layout #1**:
```tsx
import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { fontVariables } from '@/app/fonts';
import { ThemeProvider } from '@/components/theme-provider';
import { routing } from '@/i18n/routing';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'engram',
  description: 'Lưu mọi thứ theo từ khoá bạn tự đặt.',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function MarketingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Bắt buộc để landing render tĩnh (SSG) — P01 yêu cầu TTFB < 200 ms.
  setRequestLocale(locale);

  // `lang={locale}` chứ không phải "en" cố định: `/vi` phục vụ nội dung tiếng
  // Việt, khai báo sai làm screen reader đọc bằng giọng Anh. Đặt được ở đây vì
  // layout này CHÍNH LÀ root layout (không có app/layout.tsx phía trên), nên nó
  // vừa nhận `params.locale` vừa sở hữu thẻ <html>.
  return (
    <html lang={locale} data-theme="light" className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <NextIntlClientProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Thêm test routing**

Thêm vào `apps/web/tests/i18n.parity.test.ts`:
```ts
import { routing } from '../i18n/routing';

describe('routing', () => {
  it('/ là en và /vi là vi', () => {
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('as-needed');
    expect(routing.locales).toEqual(['en', 'vi']);
  });
});
```

- [ ] **Step 10: Chạy lại test**

Run: `pnpm --filter @engram/web test && pnpm --filter @engram/web typecheck`
Expected: PASS (18 test)

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "feat(web): theme provider, self-hosted fonts and next-intl routing"
```

---

### Task 12: UI primitives port từ `tokens.css`

**Files:**
- Create: `apps/web/lib/cn.ts`, `apps/web/components/ui/button.tsx`, `apps/web/components/ui/chip.tsx`, `apps/web/components/ui/card.tsx`, `apps/web/components/ui/panel.tsx`, `apps/web/components/ui/badge-type.tsx`, `apps/web/components/ui/kbd.tsx`, `apps/web/components/ui/switch.tsx`, `apps/web/components/ui/segmented.tsx`, `apps/web/components/ui/vault-pill.tsx`, `apps/web/components/ui/toast.tsx`
- Test: `apps/web/tests/ui-primitives.test.tsx`

**Interfaces:**
- Consumes: class của `styles/tokens.css` (Task 10)
- Produces (mọi component đều forward `className` và spread props DOM còn lại):
  - `Button({ variant?: 'primary'|'secondary'|'tertiary'|'ai'|'danger', size?: 'sm'|'md' })`
  - `Chip({ count?: number, selected?: boolean })`
  - `Card`, `Panel({ tone?: 'default'|'agent' })`
  - `BadgeType({ kind: 'text'|'json' })`
  - `Kbd({ children })`
  - `Switch({ checked, onCheckedChange, label, disabled?, hint? })`
  - `Segmented({ options: {value,label}[], value, onChange })`
  - `VaultPill({ state: 'open'|'locked', minutesLeft?: number })`
  - `Toast({ message, action?: { label, onAction } })`

- [ ] **Step 1: Viết test thất bại**

`apps/web/tests/ui-primitives.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BadgeType } from '../components/ui/badge-type';
import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { Kbd } from '../components/ui/kbd';
import { Panel } from '../components/ui/panel';
import { Segmented } from '../components/ui/segmented';
import { Switch } from '../components/ui/switch';
import { VaultPill } from '../components/ui/vault-pill';

describe('Button', () => {
  it('mặc định là primary theo class của mockup', () => {
    render(<Button>Lưu</Button>);
    const btn = screen.getByRole('button', { name: 'Lưu' });
    expect(btn.className).toContain('btn');
    expect(btn.className).toContain('btn-primary');
  });

  it.each([
    ['secondary', 'btn-secondary'],
    ['tertiary', 'btn-tertiary'],
    ['ai', 'btn-ai'],
    ['danger', 'btn-danger'],
  ] as const)('variant %s dùng class %s', (variant, cls) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole('button').className).toContain(cls);
  });

  it('size sm thêm btn-sm', () => {
    render(<Button size="sm">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn-sm');
  });

  it('cho phép nối thêm className', () => {
    render(<Button className="w-full">x</Button>);
    expect(screen.getByRole('button').className).toContain('w-full');
  });
});

describe('Chip', () => {
  it('hiện số lượng khi có count', () => {
    render(<Chip count={12}>ghi-chú</Chip>);
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('đánh dấu selected bằng aria-pressed', () => {
    render(<Chip selected>ghi-chú</Chip>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('BadgeType', () => {
  it.each([
    ['text', 'badge-text'],
    ['json', 'badge-json'],
  ] as const)('kind %s dùng class %s', (kind, cls) => {
    render(<BadgeType kind={kind} />);
    const el = screen.getByText(kind.toUpperCase());
    expect(el.className).toContain('badge-type');
    expect(el.className).toContain(cls);
  });
});

describe('Panel', () => {
  it('tone agent dùng panel-agent', () => {
    render(<Panel tone="agent">nội dung</Panel>);
    expect(screen.getByText('nội dung').className).toContain('panel-agent');
  });
});

describe('Kbd', () => {
  it('render trong thẻ kbd với class kbd', () => {
    const { container } = render(<Kbd>Ctrl K</Kbd>);
    const el = container.querySelector('kbd');
    expect(el?.className).toContain('kbd');
  });
});

describe('Switch', () => {
  it('có role switch và phát onCheckedChange', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" />);
    const el = screen.getByRole('switch', { name: /Gần nghĩa/ });
    expect(el).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled thì không phát sự kiện và nêu lý do qua aria-describedby', async () => {
    const onChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onChange} label="Gần nghĩa" disabled hint="Chưa bật ở bản này" />,
    );
    const el = screen.getByRole('switch');
    await userEvent.click(el);
    expect(onChange).not.toHaveBeenCalled();
    expect(el).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Chưa bật ở bản này')).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  it('đánh dấu tab đang chọn và đổi khi click', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="tbl"
        onChange={onChange}
        options={[
          { value: 'tbl', label: 'Bảng' },
          { value: 'raw', label: 'Thô' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Bảng' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Thô' }));
    expect(onChange).toHaveBeenCalledWith('raw');
  });
});

describe('VaultPill', () => {
  it('trạng thái mở hiện thời gian còn lại', () => {
    render(<VaultPill state="open" minutesLeft={15} />);
    expect(screen.getByText(/15 phút/)).toBeInTheDocument();
  });

  it('trạng thái khoá không hiện thời gian', () => {
    render(<VaultPill state="locked" />);
    expect(screen.queryByText(/phút/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/web test ui-primitives`
Expected: FAIL — không resolve được `../components/ui/button`

- [ ] **Step 3: Viết helper `cn`**

`apps/web/lib/cn.ts`:
```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Ghép class: clsx cho điều kiện, twMerge để utility sau thắng utility trước. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Implement primitives**

`apps/web/components/ui/button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'ai' | 'danger';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  tertiary: 'btn-tertiary',
  ai: 'btn-ai',
  danger: 'btn-danger',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

/** Class .btn* đến từ styles/tokens.css — không định nghĩa lại màu ở đây. */
export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('btn', VARIANT_CLASS[variant], size === 'sm' && 'btn-sm', className)}
      {...props}
    />
  );
}
```

`apps/web/components/ui/chip.tsx`:
```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  count?: number;
  selected?: boolean;
}

export function Chip({ children, count, selected = false, className, ...props }: ChipProps) {
  return (
    <button type="button" aria-pressed={selected} className={cn('chip', selected && 'chip-on', className)} {...props}>
      <span>{children}</span>
      {count !== undefined && <span className="chip-count">{count}</span>}
    </button>
  );
}
```

`apps/web/components/ui/card.tsx`:
```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />;
}
```

`apps/web/components/ui/panel.tsx`:
```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'default' | 'agent';
}

export function Panel({ tone = 'default', className, ...props }: PanelProps) {
  return <div className={cn(tone === 'agent' ? 'panel-agent' : 'panel', className)} {...props} />;
}
```

`apps/web/components/ui/badge-type.tsx`:
```tsx
import { cn } from '@/lib/cn';

/** TEXT/JSON badge của mục lưu trữ — màu do .badge-text/.badge-json quyết định. */
export function BadgeType({ kind, className }: { kind: 'text' | 'json'; className?: string }) {
  return <span className={cn('badge-type', kind === 'json' ? 'badge-json' : 'badge-text', className)}>{kind.toUpperCase()}</span>;
}
```

`apps/web/components/ui/kbd.tsx`:
```tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('kbd', className)}>{children}</kbd>;
}
```

`apps/web/components/ui/switch.tsx`:
```tsx
'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Lý do bị khoá — hiển thị và nối vào aria-describedby. */
  hint?: string;
  className?: string;
}

export function Switch({ checked, onCheckedChange, label, disabled = false, hint, className }: SwitchProps) {
  const hintId = useId();
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => {
          if (!disabled) onCheckedChange(!checked);
        }}
        className={cn('switch', checked && 'switch-on', disabled && 'switch-disabled')}
      >
        <span className="sr-only">{label}</span>
      </button>
      <span aria-hidden="true">{label}</span>
      {hint && (
        <span id={hintId} className="t-legal text-muted">
          {hint}
        </span>
      )}
    </span>
  );
}
```

`apps/web/components/ui/segmented.tsx`:
```tsx
'use client';

import { cn } from '@/lib/cn';

export interface SegmentedOption {
  value: string;
  label: string;
}

/** Tương đương data-seg của mockup, nhưng dùng role tablist cho screen reader. */
export function Segmented({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('seg', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          className={cn('seg-btn', option.value === value && 'seg-on')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
```

`apps/web/components/ui/vault-pill.tsx`:
```tsx
import { cn } from '@/lib/cn';

/**
 * Chỉ hiển thị trạng thái được truyền vào. P01 KHÔNG có vault thật — P03 mới nối
 * vào state thật; ở đây pill nhận prop từ fixture của shell.
 */
export function VaultPill({
  state,
  minutesLeft,
  className,
}: {
  state: 'open' | 'locked';
  minutesLeft?: number;
  className?: string;
}) {
  const open = state === 'open';
  return (
    <span className={cn('vault-pill', open ? 'vault-open' : 'vault-locked', className)}>
      <span aria-hidden="true">{open ? '🔓' : '🔒'}</span>
      <span>{open ? 'Vault mở' : 'Vault đang khoá'}</span>
      {open && minutesLeft !== undefined && <span>· {minutesLeft} phút</span>}
    </span>
  );
}
```

`apps/web/components/ui/toast.tsx`:
```tsx
'use client';

import { cn } from '@/lib/cn';

/** Toast tĩnh: hiển thị thông báo + một hành động. Không tự hẹn giờ đóng ở P01. */
export function Toast({
  message,
  action,
  className,
}: {
  message: string;
  action?: { label: string; onAction: () => void };
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn('toast', className)}>
      <span>{message}</span>
      {action && (
        <button type="button" className="btn btn-tertiary btn-sm" onClick={action.onAction}>
          {action.label}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Đối chiếu class với `tokens.css`**

Mở `mockups/tokens.css` và xác nhận từng class dùng ở trên có thật: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-tertiary`, `.btn-ai`, `.btn-danger`, `.btn-sm`, `.chip`, `.chip-on`, `.chip-count`, `.card`, `.panel`, `.panel-agent`, `.badge-type`, `.badge-text`, `.badge-json`, `.kbd`, `.switch`, `.seg`, `.vault-pill`, `.toast`.
Với bất kỳ class nào **không** tồn tại trong `tokens.css` (ví dụ `.chip-on`, `.switch-on`, `.seg-on` nếu mockup dùng tên khác như `[aria-pressed='true']` hay `.on`), sửa **component** cho khớp mockup — **không** thêm class mới vào `tokens.css`. `tokens.css` là bản port 1:1 và Task 10 có test canh drift.

- [ ] **Step 6: Chạy lại test**

Run: `pnpm --filter @engram/web test ui-primitives`
Expected: PASS (16 test)

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/ui apps/web/lib apps/web/tests/ui-primitives.test.tsx
git commit -m "feat(web): ui primitives ported from mockup tokens"
```

---

### Task 13: Thuật toán demo + fixture công khai (tách hẳn khỏi API adapter)

**Files:**
- Create: `apps/web/lib/demo-fixtures.ts`, `apps/web/lib/demo-search.ts`
- Test: `apps/web/tests/demo-search.test.ts`

**Interfaces:**
- Consumes: không có (cố ý — demo **không** được import `@engram/shared-types/client`)
- Produces:
  - `export interface DemoItem { id: string; title: string; kind: 'text' | 'json'; tags: string[]; preview: string }`
  - `export const DEMO_TAGS: { name: string; count: number }[]`
  - `export const DEMO_ITEMS: DemoItem[]`
  - `export function fold(input: string): string` — bỏ dấu tiếng Việt, hạ chữ thường
  - `export function searchDemo(query: string): { tags: string[]; items: DemoItem[]; query: string }`
  - `export function markPrefix(text: string, query: string): { before: string; match: string; after: string }`

- [ ] **Step 1: Viết test thất bại**

`apps/web/tests/demo-search.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_ITEMS, DEMO_TAGS } from '../lib/demo-fixtures';
import { fold, markPrefix, searchDemo } from '../lib/demo-search';

describe('fold', () => {
  it('bỏ dấu tiếng Việt và hạ chữ thường', () => {
    expect(fold('Tiếng Việt')).toBe('tieng viet');
    expect(fold('ĐĂNG KÝ')).toBe('dang ky');
    expect(fold('cà phê sữa')).toBe('ca phe sua');
  });

  it('giữ nguyên chuỗi không dấu', () => {
    expect(fold('docker compose')).toBe('docker compose');
  });
});

describe('searchDemo', () => {
  it('query rỗng trả toàn bộ mục', () => {
    expect(searchDemo('').items).toHaveLength(DEMO_ITEMS.length);
  });

  it('gõ không dấu vẫn tìm ra mục có dấu', () => {
    const withDiacritics = DEMO_ITEMS.find((i) => /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(i.title));
    expect(withDiacritics).toBeDefined();
    const folded = fold(withDiacritics!.title).split(' ')[0];
    expect(searchDemo(folded).items.map((i) => i.id)).toContain(withDiacritics!.id);
  });

  it('khớp cả tag lẫn tiêu đề', () => {
    const tag = DEMO_TAGS[0].name;
    const result = searchDemo(tag);
    expect(result.tags).toContain(tag);
  });

  it('query không khớp gì trả danh sách rỗng', () => {
    expect(searchDemo('zzzzqqqq').items).toEqual([]);
  });

  it('trả lại query đã nhập để UI hiển thị', () => {
    expect(searchDemo('ghi chú').query).toBe('ghi chú');
  });
});

describe('markPrefix', () => {
  it('tách phần khớp tiền tố không phân biệt dấu', () => {
    expect(markPrefix('Ghi chú họp', 'ghi')).toEqual({ before: '', match: 'Ghi', after: ' chú họp' });
  });

  it('không khớp thì trả nguyên chuỗi ở after', () => {
    expect(markPrefix('Ghi chú', 'xyz')).toEqual({ before: '', match: '', after: 'Ghi chú' });
  });
});

describe('ranh giới demo (P01-A5)', () => {
  const source = [
    readFileSync(resolve(__dirname, '../lib/demo-search.ts'), 'utf8'),
    readFileSync(resolve(__dirname, '../lib/demo-fixtures.ts'), 'utf8'),
  ].join('\n');

  it('không gọi mạng', () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon/);
  });

  it('không import client API', () => {
    expect(source).not.toContain('@engram/shared-types');
  });

  it('không claim đã mã hoá', () => {
    expect(source).not.toMatch(/encrypt|mã hoá|đã mã hóa/i);
  });

  it('fixture không chứa dữ liệu trông như thật của người dùng', () => {
    const json = JSON.stringify(DEMO_ITEMS);
    expect(json).not.toMatch(/@gmail\.com|@yahoo\./i);
    expect(json).not.toMatch(/\b\d{9,}\b/);
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/web test demo-search`
Expected: FAIL — không resolve được `../lib/demo-fixtures`

- [ ] **Step 3: Viết fixture**

`apps/web/lib/demo-fixtures.ts`:
```ts
/**
 * Dữ liệu mẫu CÔNG KHAI cho demo ở landing. Không phải dữ liệu người dùng,
 * không đi qua API, không được coi là contract (P01-A5).
 * Mọi nội dung ở đây là bịa và an toàn để hiển thị cho người lạ.
 */
export interface DemoItem {
  id: string;
  title: string;
  kind: 'text' | 'json';
  tags: string[];
  preview: string;
}

export const DEMO_TAGS: { name: string; count: number }[] = [
  { name: 'ghi-chú', count: 12 },
  { name: 'công-thức', count: 7 },
  { name: 'cấu-hình', count: 5 },
  { name: 'đọc-sau', count: 4 },
  { name: 'du-lịch', count: 3 },
];

export const DEMO_ITEMS: DemoItem[] = [
  {
    id: 'd1',
    title: 'Cà phê sữa đá tỉ lệ 1:2',
    kind: 'text',
    tags: ['công-thức'],
    preview: 'Một phần cà phê phin đặc, hai phần sữa đặc, đá đầy ly.',
  },
  {
    id: 'd2',
    title: 'Ghi chú họp thứ Ba',
    kind: 'text',
    tags: ['ghi-chú'],
    preview: 'Chốt phạm vi bản thử, hẹn rà lại vào cuối tuần.',
  },
  {
    id: 'd3',
    title: 'Cấu hình máy chủ nhỏ',
    kind: 'json',
    tags: ['cấu-hình'],
    preview: '{"host":"localhost","port":8080,"tls":false}',
  },
  {
    id: 'd4',
    title: 'Sách muốn đọc năm nay',
    kind: 'text',
    tags: ['đọc-sau'],
    preview: 'Ba cuốn về trí nhớ, một cuốn về nghề bếp.',
  },
  {
    id: 'd5',
    title: 'Đường đi Đà Lạt bằng xe khách',
    kind: 'text',
    tags: ['du-lịch', 'ghi-chú'],
    preview: 'Đi chuyến đêm, xuống bến rồi bắt taxi thêm mười phút.',
  },
  {
    id: 'd6',
    title: 'Mẫu JSON của một mục engram',
    kind: 'json',
    tags: ['cấu-hình', 'ghi-chú'],
    preview: '{"keyword":"ca-phe","type":"text","tags":["công-thức"]}',
  },
];

/** JSON dùng cho bảng minh hoạ ở mục "Cách dùng" của landing. */
export const DEMO_JSON: Record<string, unknown> = {
  keyword: 'ca-phe',
  type: 'json',
  tags: ['công-thức', 'ghi-chú'],
  body: {
    ratio: '1:2',
    steps: ['pha phin', 'thêm sữa đặc', 'cho đá'],
    servings: 1,
  },
  updatedAt: '2026-09-01',
};
```

- [ ] **Step 4: Implement thuật toán demo**

`apps/web/lib/demo-search.ts`:
```ts
import { DEMO_ITEMS, DEMO_TAGS, type DemoItem } from './demo-fixtures';

/**
 * fold bỏ dấu và hạ chữ thường để gõ "ca phe" tìm ra "Cà phê".
 * Đây là bản demo chạy hoàn toàn trong trình duyệt — tìm kiếm thật của app
 * dùng immutable_unaccent + pg_trgm ở phía Postgres (P04).
 */
export function fold(input: string): string {
  return input
    .normalize('NFD')
    // \u0300-\u036f = Combining Diacritical Marks. Viết bằng escape, không dán
    // ký tự dấu trực tiếp vào regex — nhiều editor/diff sẽ nuốt mất chúng.
    // Lưu ý: markPrefix giả định chuỗi gốc ở dạng NFC (1 ký tự = 1 code point có dấu)
    // để index trên chuỗi đã fold ánh xạ đúng về chuỗi gốc.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export interface DemoSearchResult {
  tags: string[];
  items: DemoItem[];
  query: string;
}

/** searchDemo lọc fixture trong bộ nhớ. Không I/O, không mạng, không lưu gì. */
export function searchDemo(query: string): DemoSearchResult {
  const needle = fold(query.trim());
  if (needle === '') {
    return { tags: DEMO_TAGS.map((t) => t.name), items: DEMO_ITEMS, query };
  }

  const tags = DEMO_TAGS.filter((t) => fold(t.name).includes(needle)).map((t) => t.name);
  const items = DEMO_ITEMS.filter((item) => {
    const haystack = [item.title, item.preview, ...item.tags].map(fold);
    return haystack.some((text) => text.includes(needle));
  });

  return { tags, items, query };
}

/** markPrefix trả ba đoạn để UI bôi đậm phần khớp mà không cần dangerouslySetInnerHTML. */
export function markPrefix(text: string, query: string): { before: string; match: string; after: string } {
  const needle = fold(query.trim());
  if (needle === '') return { before: '', match: '', after: text };

  const index = fold(text).indexOf(needle);
  if (index === -1) return { before: '', match: '', after: text };

  return {
    before: text.slice(0, index),
    match: text.slice(index, index + needle.length),
    after: text.slice(index + needle.length),
  };
}
```

- [ ] **Step 5: Chạy lại test**

Run: `pnpm --filter @engram/web test demo-search`
Expected: PASS (14 test)

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/demo-fixtures.ts apps/web/lib/demo-search.ts apps/web/tests/demo-search.test.ts
git commit -m "feat(web): public demo fixtures and in-browser search"
```

---

### Task 14: Landing U1 — hero omnibox demo, bảng JSON, reduced motion

**Files:**
- Create: `apps/web/components/landing/hero-demo.tsx`, `apps/web/components/landing/json-table.tsx`, `apps/web/components/landing/site-header.tsx`, `apps/web/components/landing/site-footer.tsx`, `apps/web/components/landing/logo.tsx`, `apps/web/app/(marketing)/[locale]/page.tsx`
- Test: `apps/web/tests/hero-demo.test.tsx`, `apps/web/tests/json-table.test.tsx`

**Interfaces:**
- Consumes: `searchDemo`, `markPrefix`, `DEMO_JSON` (Task 13); `Button`, `Kbd`, `Panel`, `BadgeType`, `Segmented` (Task 12)
- Produces:
  - `export function HeroDemo({ autoType }: { autoType?: boolean })` — combobox demo, `role="combobox"` + `role="listbox"`, điều hướng bằng `ArrowDown`/`ArrowUp`/`Enter`/`Escape`; `autoType` mặc định `true`, test tương tác truyền `false`
  - `export function JsonTable({ data, title, labels }: JsonTableProps)` — header có badge `json` + tiêu đề + segmented; hai chế độ `tbl` / `raw`; `labels` mặc định tiếng Việt
  - `export function Logo({ className }: { className?: string })` — SVG gradient magenta→cyan, luôn kèm chữ `engram`

- [ ] **Step 1: Viết test thất bại cho hero demo**

`apps/web/tests/hero-demo.test.tsx`:
```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroDemo } from '../components/landing/hero-demo';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('demo không được gọi mạng'))));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HeroDemo', () => {
  // autoType={false} ở các ca tương tác: nếu để bật, chuỗi tự gõ chạy song song
  // với userEvent.type và làm test nhấp nháy.
  it('lọc kết quả khi gõ không dấu', async () => {
    render(<HeroDemo autoType={false} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'ca phe');

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText(/Cà phê sữa đá/)).toBeInTheDocument();
  });

  it('điều hướng bằng bàn phím và chọn bằng Enter (P01-A6)', async () => {
    render(<HeroDemo autoType={false} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'ghi');
    await userEvent.keyboard('{ArrowDown}');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent(/Ghi chú họp thứ Ba/);
  });

  it('Escape đóng danh sách', async () => {
    render(<HeroDemo autoType={false} />);
    await userEvent.type(screen.getByRole('combobox'), 'ghi');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('không gọi mạng dù gõ gì đi nữa (P01-A5)', async () => {
    render(<HeroDemo autoType={false} />);
    await userEvent.type(screen.getByRole('combobox'), 'mật khẩu ngân hàng của tôi');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('nói rõ đây là dữ liệu mẫu và không claim đã mã hoá', () => {
    render(<HeroDemo autoType={false} />);
    expect(screen.getByText(/Dữ liệu mẫu/)).toBeInTheDocument();
    expect(screen.queryByText(/mã hoá|encrypted/i)).not.toBeInTheDocument();
  });

  it('tự gõ khi không bật reduced motion', async () => {
    vi.useFakeTimers();
    render(<HeroDemo />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await vi.advanceTimersByTimeAsync(5000);
    expect(input.value).toBe('ca phe');
    vi.useRealTimers();
  });

  it('không tự gõ khi người dùng bật reduced motion (P01-A6)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.useFakeTimers();
    render(<HeroDemo />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await vi.advanceTimersByTimeAsync(5000);
    expect(input.value).toBe('');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Viết test thất bại cho bảng JSON**

`apps/web/tests/json-table.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { JsonTable } from '../components/landing/json-table';

const data = { keyword: 'ca-phe', body: { ratio: '1:2', steps: ['pha phin', 'cho đá'] } };

describe('JsonTable', () => {
  it('hiện khoá và giá trị ở chế độ bảng', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('keyword')).toBeInTheDocument();
    expect(screen.getByText('ca-phe')).toBeInTheDocument();
  });

  it('lồng object thành hàng con', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('ratio')).toBeInTheDocument();
    expect(screen.getByText('1:2')).toBeInTheDocument();
  });

  it('chuyển sang JSON thô bằng segmented', async () => {
    render(<JsonTable data={data} />);
    await userEvent.click(screen.getByRole('tab', { name: /thô/i }));
    expect(screen.getByRole('code')).toHaveTextContent('"keyword": "ca-phe"');
  });

  it('hiện mảng dưới dạng chỉ số', () => {
    render(<JsonTable data={data} />);
    expect(screen.getByText('steps')).toBeInTheDocument();
    expect(screen.getByText('pha phin')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Chạy test để chắc chúng fail**

Run: `pnpm --filter @engram/web test hero-demo json-table`
Expected: FAIL — không resolve được `../components/landing/hero-demo`

- [ ] **Step 4: Implement `Logo`**

`apps/web/components/landing/logo.tsx`:
```tsx
// 'use client' là bắt buộc: useId() là hook, không chạy trong server component.
'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Logo luôn đi kèm chữ `engram` viết thường (P01-A6). Gradient magenta→cyan
 * và stroke-dasharray chép nguyên từ mockups/index.html.
 */
export function Logo({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--logo-magenta)" />
            <stop offset="100%" stopColor="var(--logo-cyan)" />
          </linearGradient>
        </defs>
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="0.1 5.2 0.1 4 20"
        />
      </svg>
      <span className="font-display text-[18px] font-extrabold tracking-tight text-ink">engram</span>
    </span>
  );
}
```

> Đối chiếu lại `mockups/index.html` phần `<svg>` header: nếu path/attribute khác bản trên, chép **nguyên văn** từ mockup và chỉ thay `id="g"` bằng `useId()` (id cố định sẽ trùng khi render nhiều logo trên một trang).

- [ ] **Step 5: Implement `HeroDemo`**

`apps/web/components/landing/hero-demo.tsx`:
```tsx
'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BadgeType } from '@/components/ui/badge-type';
import { Kbd } from '@/components/ui/kbd';
import { markPrefix, searchDemo } from '@/lib/demo-search';

/** Chuỗi tự gõ để mời người xem thử. Dừng ngay khi có tương tác thật. */
const AUTOTYPE = 'ca phe';
const AUTOTYPE_STEP_MS = 180;

export interface HeroDemoProps {
  /**
   * Bật chuỗi tự gõ mời dùng thử. Mặc định true cho trang thật; test tương tác
   * truyền false để chuỗi tự gõ không chạy đua với userEvent.type.
   */
  autoType?: boolean;
}

export function HeroDemo({ autoType = true }: HeroDemoProps = {}) {
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState<string | null>(null);
  const touched = useRef(false);

  const result = useMemo(() => searchDemo(query), [query]);
  const options = result.items;

  // Tự gõ chỉ chạy khi KHÔNG bật reduced motion (P01-A6) và người dùng chưa chạm vào.
  useEffect(() => {
    if (!autoType) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let index = 0;
    const timer = window.setInterval(() => {
      if (touched.current || index >= AUTOTYPE.length) {
        window.clearInterval(timer);
        return;
      }
      index += 1;
      setQuery(AUTOTYPE.slice(0, index));
      setOpen(true);
    }, AUTOTYPE_STEP_MS);

    return () => window.clearInterval(timer);
  }, [autoType]);

  const choose = useCallback((index: number) => {
    const item = options[index];
    if (!item) return;
    setPicked(item.title);
    setOpen(false);
  }, [options]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    touched.current = true;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active === -1 ? 0 : active);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="panel p-6 md:p-10">
      {/*
        `data-visual-volatile` cho Playwright biết hai vùng này đổi theo thời gian
        (chuỗi tự gõ + popover kết quả) và phải mask khi so ảnh baseline — xem
        `toHaveScreenshot` ở Task 17. Chỉ là attribute, không thêm phần tử nào
        vào DOM nên layout giữ nguyên như mockup.
      */}
      <div className="omnibox-shell" data-visual-volatile>
        <input
          className="omnibox-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && options[active] ? `${listboxId}-${options[active].id}` : undefined}
          placeholder="Gõ từ khoá…"
          value={query}
          onChange={(event) => {
            touched.current = true;
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <Kbd>Ctrl K</Kbd>
      </div>

      {open && options.length > 0 && (
        <ul className="popover" role="listbox" id={listboxId} aria-label="Kết quả mẫu" data-visual-volatile>
          {options.map((item, index) => {
            const { before, match, after } = markPrefix(item.title, query);
            return (
              <li
                key={item.id}
                id={`${listboxId}-${item.id}`}
                role="option"
                aria-selected={index === active}
                className="sugg-row"
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
              >
                <span>
                  {before}
                  <mark>{match}</mark>
                  {after}
                </span>
                <span className="sugg-meta">
                  <BadgeType kind={item.kind} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="t-legal mt-3 text-muted" role="note">
        Dữ liệu mẫu, gõ thoải mái — không có gì được gửi đi đâu cả.
      </p>

      <p className="sr-only" role="status" aria-live="polite">
        {picked ? `Đã chọn ${picked}` : ''}
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Implement `JsonTable`**

`apps/web/components/landing/json-table.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { BadgeType } from '@/components/ui/badge-type';
import { Segmented } from '@/components/ui/segmented';

type Row = { path: string; key: string; value: string | null; depth: number };

/** Duyệt object thành các hàng phẳng để render bảng — không đệ quy trong JSX. */
function toRows(value: unknown, depth = 0, prefix = ''): Row[] {
  if (value === null || typeof value !== 'object') {
    return [{ path: prefix, key: prefix.split('.').pop() ?? prefix, value: String(value), depth }];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const isLeaf = child === null || typeof child !== 'object';
    const head: Row = { path, key, value: isLeaf ? String(child) : null, depth };
    return isLeaf ? [head] : [head, ...toRows(child, depth + 1, path)];
  });
}

export interface JsonTableProps {
  data: Record<string, unknown>;
  /** Tiêu đề hiện trong header card, cạnh badge `json` (theo mockups/landing.html). */
  title?: string;
  /**
   * Nhãn của segmented. Component này là client component nhưng KHÔNG gọi
   * useTranslations: test render nó trần, không có NextIntlClientProvider.
   * Trang truyền nhãn đã dịch xuống; mặc định là tiếng Việt.
   */
  labels?: { table: string; raw: string };
}

export function JsonTable({ data, title, labels }: JsonTableProps) {
  const [view, setView] = useState('tbl');
  const rows = toRows(data);
  const tableLabel = labels?.table ?? 'Bảng';
  const rawLabel = labels?.raw ?? 'JSON thô';

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface border-b border-border">
        <BadgeType kind="json" />
        {title ? <span className="text-[15px] font-semibold">{title}</span> : null}
        <div className="ml-auto">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'tbl', label: tableLabel },
              { value: 'raw', label: rawLabel },
            ]}
          />
        </div>
      </div>

      {view === 'tbl' ? (
        <table className="json-table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.path} className={row.depth > 0 ? 'json-nest' : undefined}>
                <th scope="row" style={{ paddingLeft: `${row.depth * 16}px` }}>
                  {row.key}
                </th>
                <td className="mono">{row.value ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="json-raw">
          <code role="code">{JSON.stringify(data, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Bổ sung key cho các section landing**

Thêm vào object `landing` của **cả hai** file (test parity ở Task 11 sẽ bắt nếu thiếu một bên).

`apps/web/messages/vi.json` — thêm vào `landing`:
```json
{
  "wallTitle": "Người ta lưu gì ở đây",
  "wallSub": "Toàn thứ nhỏ, hay cần, và luôn nằm ở chỗ không nhớ nổi.",
  "wallTags": ["wifi", "mã số thuế", "docker compose", "api key", "hợp đồng thuê nhà", "số tài khoản", "vlan", "biển số xe", "mã bảo hành", "dns nội bộ", "thẻ bảo hiểm", "ssh key", "lịch tiêm của bé", "wifi khách", "mã pin thẻ", "cấu hình k8s", "seri điều hoà", "mật khẩu wifi bố mẹ"],
  "jsonTitle": "Dán JSON vào, đọc như bảng",
  "jsonBody": "Cấu hình router, response API, file export — dán nguyên si. Mục lồng nhau mở ra từng tầng, mảng thành bảng có cột.",
  "jsonNote": "Sửa một ô thì chỉ ô đó đổi. Số dài như 9007199254740993 giữ nguyên từng chữ số, không bị làm tròn sau lưng bạn.",
  "jsonCardTitle": "Cấu hình router",
  "jsonViewTable": "Bảng",
  "jsonViewRaw": "JSON thô",
  "privacyTitle": "Nói thẳng chỗ nào mã hoá, chỗ nào không",
  "privacyBody1": "Nội dung entry sẽ được khoá ngay trên trình duyệt bằng khoá chỉ máy bạn giữ. Chúng tôi không có bản sao, và không có cách nào đọc.",
  "privacyBody2": "Tên mục và tag thì không mã hoá — chính chúng làm cho việc tìm kiếm chạy được. Nếu bạn bật tìm gần nghĩa, hai thứ đó được gửi tới máy chủ nhúng do chúng tôi tự vận hành. Nội dung entry thì không, kể cả khi bật.",
  "encLabel": "Được mã hoá",
  "encBody": "Nội dung mọi entry text và json.",
  "plainLabel": "Không mã hoá",
  "plainBody": "Tên mục, tên tag, thời điểm sửa, số lượng entry.",
  "cryptoNote": "XChaCha20-Poly1305 · Argon2id · khoá không rời trình duyệt",
  "recoveryTitle": "Quên passphrase không phải là mất hết",
  "recoveryBody": "Vì chúng tôi không giữ khoá của bạn, nên bạn cần đường về của riêng mình. Có ba đường, dựng sẵn từ lúc đăng ký.",
  "recoveryKeysTitle": "10 recovery key",
  "recoveryKeysBody": "In ra, cất đi. Mỗi key mở được vault một mình, dùng xong thì thôi.",
  "recoveryPasskeyTitle": "Passkey",
  "recoveryPasskeyBody": "Vân tay hoặc khoá bảo mật. Mở vault không cần gõ gì.",
  "recoveryDeviceTitle": "Thiết bị đã nhớ",
  "recoveryDeviceBody": "Máy quen của bạn mở thẳng, máy lạ thì không.",
  "ctaBody": "Miễn phí, không giới hạn số mục. Cần email và một passphrase bạn không dùng ở đâu khác.",
  "previewNote": "Bản hiện tại là bản xem trước giao diện: đăng ký, vault và mã hoá bật ở bản sau."
}
```

`apps/web/messages/en.json` — thêm vào `landing`:
```json
{
  "wallTitle": "What people keep in here",
  "wallSub": "Small things, needed often, always filed somewhere you can't recall.",
  "wallTags": ["wifi", "tax id", "docker compose", "api key", "lease", "bank account", "vlan", "plate number", "warranty code", "internal dns", "insurance card", "ssh key", "kid's vaccine dates", "guest wifi", "card pin", "k8s config", "ac serial", "parents' wifi"],
  "jsonTitle": "Paste JSON, read it as a table",
  "jsonBody": "Router config, API responses, exports — paste them as-is. Nested objects open level by level, arrays become tables with columns.",
  "jsonNote": "Edit one cell and only that cell changes. A long number like 9007199254740993 keeps every digit; nothing is rounded behind your back.",
  "jsonCardTitle": "Router config",
  "jsonViewTable": "Table",
  "jsonViewRaw": "Raw JSON",
  "privacyTitle": "Plainly: what is encrypted and what is not",
  "privacyBody1": "Entry content will be locked in your browser with a key only your machine holds. We keep no copy and have no way to read it.",
  "privacyBody2": "Item names and tags are not encrypted — they are what makes search work. If you turn on similar-meaning search, those two are sent to an embedding server we run ourselves. Entry content never is, even then.",
  "encLabel": "Encrypted",
  "encBody": "The content of every text and json entry.",
  "plainLabel": "Not encrypted",
  "plainBody": "Item names, tag names, edit times, entry counts.",
  "cryptoNote": "XChaCha20-Poly1305 · Argon2id · keys never leave the browser",
  "recoveryTitle": "Forgetting your passphrase is not losing everything",
  "recoveryBody": "Because we do not hold your key, you need your own way back. There are three, set up at sign-up.",
  "recoveryKeysTitle": "10 recovery keys",
  "recoveryKeysBody": "Print them, put them away. Each one opens the vault on its own, once.",
  "recoveryPasskeyTitle": "Passkey",
  "recoveryPasskeyBody": "Fingerprint or security key. Open the vault without typing anything.",
  "recoveryDeviceTitle": "Remembered device",
  "recoveryDeviceBody": "Your usual machine opens straight away; an unfamiliar one does not.",
  "ctaBody": "Free, no cap on items. Needs an email and a passphrase you use nowhere else.",
  "previewNote": "This build is a UI preview: sign-up, vault and encryption arrive in a later build."
}
```

> Copy `privacyBody1` đổi thì tương lai (“sẽ được khoá”) so với mockup (“được khoá”), và thêm `previewNote`: P01 chưa có crypto nên không được khẳng định nó đang chạy. Ghi vào phần nợ kỹ thuật của evidence để P03 đổi lại đúng mockup khi crypto thật đã bật.

- [ ] **Step 8: Dựng trang landing**

`apps/web/app/(marketing)/[locale]/page.tsx`:
```tsx
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { HeroDemo } from '@/components/landing/hero-demo';
import { JsonTable } from '@/components/landing/json-table';
import { SiteHeader } from '@/components/landing/site-header';
import { SiteFooter } from '@/components/landing/site-footer';
import { DEMO_JSON } from '@/lib/demo-fixtures';

// Landing phải là SSG để đạt TTFB < 200 ms (Global Constraints).
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('landing');
  const wallTags = t.raw('wallTags') as string[];

  return (
    <>
      <SiteHeader />

      {/* hero */}
      <section className="max-w-container mx-auto px-5 pt-14 pb-16">
        <h1 className="t-hero mb-4">
          {t('heroTitle')}
          <br />
          <span className="text-muted">{t('heroTitleSecond')}</span>
        </h1>
        <p className="t-body-lg mb-8 max-w-[56ch] text-muted">{t('heroSub')}</p>
        <HeroDemo />
      </section>

      {/* tường từ khoá */}
      <section className="max-w-container mx-auto px-5 pb-20">
        <h2 className="t-title-md mb-1">{t('wallTitle')}</h2>
        <p className="t-body-lg mb-7 text-muted">{t('wallSub')}</p>
        <div className="flex flex-wrap gap-2">
          {wallTags.map((tag) => (
            <span key={tag} className="chip chip-lg">
              {tag}
            </span>
          ))}
        </div>
      </section>

      {/* JSON như bảng */}
      <section id="cachdung" className="max-w-container mx-auto px-5 pb-20">
        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <div className="lg:pt-6">
            <h2 className="t-title-md mb-3">{t('jsonTitle')}</h2>
            <p className="t-body-lg mb-4 text-muted">{t('jsonBody')}</p>
            <p className="t-body text-muted">{t('jsonNote')}</p>
          </div>
          <JsonTable
            data={DEMO_JSON}
            title={t('jsonCardTitle')}
            labels={{ table: t('jsonViewTable'), raw: t('jsonViewRaw') }}
          />
        </div>
      </section>

      {/* riêng tư */}
      <section id="riengtu" className="max-w-container mx-auto px-5 pb-20">
        <div className="rounded-section p-8 md:p-12 bg-deepPanel text-white">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-start">
            <div>
              <h2 className="t-title-md mb-4 text-white">{t('privacyTitle')}</h2>
              <p className="t-body-lg mb-4 text-white/70">{t('privacyBody1')}</p>
              <p className="t-body-lg m-0 text-white/70">{t('privacyBody2')}</p>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-xl p-4 bg-white/[.06]">
                <p className="t-label mb-1 text-aiCyan">{t('encLabel')}</p>
                <p className="t-body m-0 text-white/[.86]">{t('encBody')}</p>
              </div>
              <div className="rounded-xl p-4 bg-white/[.06]">
                <p className="t-label mb-1 text-warning">{t('plainLabel')}</p>
                <p className="t-body m-0 text-white/[.86]">{t('plainBody')}</p>
              </div>
              <p className="mono text-[12px] m-0 pt-1 text-white/45">{t('cryptoNote')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* khôi phục */}
      <section id="khoiphuc" className="max-w-container mx-auto px-5 pb-20">
        <div className="panel-agent p-8 md:p-12">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center">
            <div>
              <h2 className="t-title-md mb-3">{t('recoveryTitle')}</h2>
              <p className="t-body-lg m-0">{t('recoveryBody')}</p>
            </div>
            <div className="flex flex-col gap-2.5">
              {(
                [
                  ['recoveryKeysTitle', 'recoveryKeysBody'],
                  ['recoveryPasskeyTitle', 'recoveryPasskeyBody'],
                  ['recoveryDeviceTitle', 'recoveryDeviceBody'],
                ] as const
              ).map(([titleKey, bodyKey]) => (
                <div key={titleKey} className="rounded-xl p-4 bg-canvas">
                  <p className="text-[15px] font-semibold m-0 mb-1">{t(titleKey)}</p>
                  <p className="t-body m-0 text-muted">{t(bodyKey)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-container mx-auto px-5 pb-20">
        <div className="text-center py-12">
          <h2 className="t-headline-md mb-4">{t('cta')}</h2>
          <p className="t-body-lg mb-8 max-w-[52ch] mx-auto text-muted">{t('ctaBody')}</p>
          <a href="/app" className="btn btn-primary no-underline !px-7 !py-4 !text-[16px]">
            {t('cta')}
          </a>
          <p className="t-body mt-4 text-muted">{t('previewNote')}</p>
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
```

> `bg-deepPanel`, `text-aiCyan`, `bg-canvas`, `text-muted` là các key màu đã map trong `tailwind.config.ts` ở Task 10. Nếu tên không khớp, sửa `tailwind.config.ts` cho khớp `mockups/tw.js` — **không** sửa `tokens.css`.

- [ ] **Step 9: Chạy lại test và build**

Run: `pnpm --filter @engram/web test && pnpm --filter @engram/web build`
Expected: PASS (11 test mới); build in ra `/` và `/vi` là `● (SSG)`

- [ ] **Step 10: Commit**

```bash
git add apps/web/components/landing apps/web/app apps/web/messages apps/web/tests
git commit -m "feat(web): landing hero demo and json table from mockup"
```

---

### Task 15: App shell U2 — `/app`, rail, vault pill, error boundary và trạng thái

**Files:**
- Create: `apps/web/app/app/layout.tsx`, `apps/web/app/app/page.tsx`, `apps/web/app/app/error.tsx`, `apps/web/app/global-error.tsx`, `apps/web/app/(marketing)/[locale]/not-found.tsx`, `apps/web/components/app-shell/app-header.tsx`, `apps/web/components/app-shell/rail.tsx`, `apps/web/components/app-shell/empty-state.tsx`, `apps/web/components/query-provider.tsx`
- Test: `apps/web/tests/app-shell.test.tsx`, `apps/web/tests/routing.test.ts`

**Interfaces:**
- Consumes: `Logo` (Task 14); `Chip`, `Switch`, `VaultPill`, `Card`, `BadgeType` (Task 12); `DEMO_ITEMS`, `DEMO_TAGS` (Task 13)
- Produces:
  - `export function AppHeader({ vault }: { vault: { state: 'open' | 'locked'; minutesLeft?: number } })`
  - `export function Rail({ tags, semanticAvailable }: { tags: { name: string; count: number }[]; semanticAvailable: boolean })`
  - `export function EmptyState({ title, body, action? }: { title: string; body: string; action?: { label: string; onAction: () => void } })`
  - `export function QueryProvider({ children }: { children: ReactNode })`

- [ ] **Step 1: Viết test thất bại**

`apps/web/tests/app-shell.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppHeader } from '../components/app-shell/app-header';
import { EmptyState } from '../components/app-shell/empty-state';
import { Rail } from '../components/app-shell/rail';
import { DEMO_TAGS } from '../lib/demo-fixtures';

describe('AppHeader', () => {
  it('luôn hiện chữ engram viết thường', () => {
    render(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText('engram')).toBeInTheDocument();
    expect(screen.queryByText('Engram')).not.toBeInTheDocument();
  });

  it('phản ánh trạng thái vault được truyền vào', () => {
    const { rerender } = render(<AppHeader vault={{ state: 'open', minutesLeft: 15 }} />);
    expect(screen.getByText(/15 phút/)).toBeInTheDocument();

    rerender(<AppHeader vault={{ state: 'locked' }} />);
    expect(screen.getByText(/Vault đang khoá/)).toBeInTheDocument();
  });
});

describe('Rail', () => {
  it('liệt kê tag kèm số lượng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable={false} />);
    expect(screen.getByText(DEMO_TAGS[0].name)).toBeInTheDocument();
    expect(screen.getByText(String(DEMO_TAGS[0].count))).toBeInTheDocument();
  });

  // SPEC §7 (sơ đồ omnibox): toggle semantic_suggest **ẩn** khi
  // semantic_available = false. Không render disabled — disabled vẫn là một lời
  // quảng cáo tính năng chưa có.
  it('ẩn hẳn toggle Gần nghĩa khi semantic không khả dụng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable={false} />);
    expect(screen.queryByRole('switch', { name: /Gần nghĩa/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Gần nghĩa/)).not.toBeInTheDocument();
  });

  it('hiện toggle Gần nghĩa khi semantic khả dụng', () => {
    render(<Rail tags={DEMO_TAGS} semanticAvailable />);
    const sw = screen.getByRole('switch', { name: /Gần nghĩa/ });
    expect(sw).not.toHaveAttribute('aria-disabled');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

describe('EmptyState', () => {
  it('hiện tiêu đề, mô tả và hành động', () => {
    render(<EmptyState title="Chưa có gì ở đây" body="Lưu mục đầu tiên." action={{ label: 'Thử lại', onAction: () => {} }} />);
    expect(screen.getByRole('heading', { name: 'Chưa có gì ở đây' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });
});
```

`apps/web/tests/routing.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');

describe('cấu trúc route (P01-A3)', () => {
  it('app riêng tư nằm ở segment tĩnh /app, không dưới [locale]', () => {
    expect(existsSync(resolve(WEB, 'app/app/page.tsx'))).toBe(true);
    expect(existsSync(resolve(WEB, 'app/(marketing)/[locale]/app'))).toBe(false);
  });

  it('middleware i18n không chạm /api và /app', () => {
    const mw = readFileSync(resolve(WEB, 'middleware.ts'), 'utf8');
    expect(mw).toContain('?!api|app');
  });

  it('next.config proxy /api sang upstream Go', () => {
    const config = readFileSync(resolve(WEB, 'next.config.ts'), 'utf8');
    expect(config).toContain("source: '/api/:path*'");
    expect(config).toContain('API_UPSTREAM');
  });

  it('layout /app đặt noindex', () => {
    const layout = readFileSync(resolve(WEB, 'app/app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/robots:\s*\{[^}]*index:\s*false/s);
  });

  // Hai root layout song song: không được có app/layout.tsx, và mỗi root layout
  // phải tự render <html> với lang đúng nguồn (locale của route / APP_LOCALE).
  it('không có root layout chung ở app/layout.tsx', () => {
    expect(existsSync(resolve(WEB, 'app/layout.tsx'))).toBe(false);
    expect(existsSync(resolve(WEB, 'app/global-error.tsx'))).toBe(true);
  });

  it('lang của marketing bám theo locale, không hardcode', () => {
    const layout = readFileSync(resolve(WEB, 'app/(marketing)/[locale]/layout.tsx'), 'utf8');
    expect(layout).toContain('<html lang={locale}');
    expect(layout).not.toContain('lang="en"');
  });

  it('lang của /app khớp locale truyền cho NextIntlClientProvider', () => {
    const layout = readFileSync(resolve(WEB, 'app/app/layout.tsx'), 'utf8');
    expect(layout).toContain('<html lang={APP_LOCALE}');
    expect(layout).toContain('locale={APP_LOCALE}');
    expect(layout).not.toContain('locale="vi"');
  });
});
```

- [ ] **Step 2: Chạy test để chắc chúng fail**

Run: `pnpm --filter @engram/web test app-shell routing`
Expected: FAIL — không resolve được `../components/app-shell/app-header`

- [ ] **Step 3: Implement header và rail**

`apps/web/components/app-shell/app-header.tsx`:
```tsx
import { Logo } from '@/components/landing/logo';
import { Kbd } from '@/components/ui/kbd';
import { VaultPill } from '@/components/ui/vault-pill';

/** Header dính, nền mờ, cao 68px — chép từ mockups/index.html. */
export function AppHeader({ vault }: { vault: { state: 'open' | 'locked'; minutesLeft?: number } }) {
  return (
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-container items-center justify-between px-5">
        <Logo />
        <div className="flex items-center gap-3">
          <VaultPill state={vault.state} minutesLeft={vault.minutesLeft} />
          <Kbd>Ctrl K</Kbd>
        </div>
      </div>
    </header>
  );
}
```

`apps/web/components/app-shell/rail.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { Chip } from '@/components/ui/chip';
import { Switch } from '@/components/ui/switch';

/**
 * `semanticAvailable` đến từ /api/v1/readyz. Khi EMBEDDING_PROVIDER=noop thì false
 * và toggle "Gần nghĩa" bị ẩn hoàn toàn — SPEC §7 ghi rõ `semantic_suggest` **ẩn**
 * khi `semantic_available = false`. Render nó ở trạng thái disabled vẫn là quảng
 * cáo một tính năng chưa có (P01 §Phạm vi), nên không làm.
 */
export function Rail({
  tags,
  semanticAvailable,
}: {
  tags: { name: string; count: number }[];
  semanticAvailable: boolean;
}) {
  const [semantic, setSemantic] = useState(false);

  return (
    <nav aria-label="Bộ lọc" className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Chip key={tag.name} count={tag.count}>
            {tag.name}
          </Chip>
        ))}
      </div>

      {semanticAvailable ? (
        <Switch checked={semantic} onCheckedChange={setSemantic} label="Gần nghĩa" />
      ) : null}
    </nav>
  );
}
```

`apps/web/components/app-shell/empty-state.tsx`:
```tsx
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Khớp mockups/states.html — dùng cho cả rỗng, lỗi và offline. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onAction: () => void };
}) {
  return (
    <Card className="flex flex-col items-start gap-3 p-8">
      <h2 className="t-h3 text-ink">{title}</h2>
      <p className="text-muted">{body}</p>
      {action && (
        <Button variant="secondary" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Implement layout `/app` và error boundary**

`apps/web/app/app/layout.tsx` — **root layout #2** (không có `app/layout.tsx` phía trên nên file này tự render `<html>`/`<body>`):
```tsx
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { fontVariables } from '@/app/fonts';
import { QueryProvider } from '@/components/query-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { APP_LOCALE } from '@/i18n/app-locale';
import '@/app/globals.css';

// App riêng tư: không index, không SSR body người dùng (P01 §UI và route).
export const metadata: Metadata = {
  title: 'engram',
  robots: { index: false, follow: false },
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Một nguồn duy nhất cho locale của /app: `lang` và provider không được lệch.
  // Middleware i18n cố ý không chạm /app nên không có locale từ URL ở đây;
  // P02 đọc locale từ hồ sơ người dùng và thay APP_LOCALE.
  const messages = await getMessages({ locale: APP_LOCALE });
  return (
    <html lang={APP_LOCALE} data-theme="light" className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <NextIntlClientProvider locale={APP_LOCALE} messages={messages}>
          <ThemeProvider>
            <QueryProvider>{children}</QueryProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

`apps/web/components/query-provider.tsx`:
```tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  // Tạo client trong state để mỗi request SSR có client riêng, không rò dữ liệu
  // giữa các người dùng.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

`apps/web/app/app/error.tsx`:
```tsx
'use client';

import { useEffect } from 'react';
import { EmptyState } from '@/components/app-shell/empty-state';

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Chỉ log tên lỗi. Message có thể chứa dữ liệu người dùng.
    console.error('app error:', error.name);
  }, [error]);

  return (
    <main className="mx-auto max-w-container px-5 py-16">
      <EmptyState title="Không tải được" body="Thử lại sau giây lát." action={{ label: 'Thử lại', onAction: reset }} />
    </main>
  );
}
```

`apps/web/app/global-error.tsx`:
```tsx
'use client';

import { useEffect } from 'react';
import { EmptyState } from '@/components/app-shell/empty-state';

/**
 * Boundary cuối: bắt lỗi ném ra từ chính root layout, tức cả hai root layout đều
 * đã hỏng. Vì layout hỏng nên KHÔNG có <html>/<body> nào ở trên — `global-error`
 * là file duy nhất được phép (và bắt buộc) tự render chúng.
 *
 * Nằm ngoài mọi NextIntlClientProvider nên chuỗi viết thẳng tiếng Việt — mặc
 * định của site. Không dùng fontVariables: nếu lỗi đến từ font thì càng phải
 * hiển thị được.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Chỉ log tên lỗi. Message có thể chứa dữ liệu người dùng.
    console.error('global error:', error.name);
  }, [error]);

  return (
    <html lang="vi" data-theme="light">
      <body className="bg-canvas font-sans text-body antialiased">
        <main className="mx-auto max-w-container px-5 py-16">
          <EmptyState
            title="Không tải được"
            body="Thử lại sau giây lát."
            action={{ label: 'Thử lại', onAction: reset }}
          />
        </main>
      </body>
    </html>
  );
}
```

`apps/web/app/(marketing)/[locale]/not-found.tsx` — 404 của marketing. Middleware i18n rewrite mọi URL lạ (trừ `/api`, `/app`, `/_next`, file tĩnh) vào cây `[locale]`, nên file này phục vụ cả `/duong-dan-la` lẫn `/vi/duong-dan-la`:
```tsx
import Link from 'next/link';
import { Card } from '@/components/ui/card';

/**
 * not-found là server component: không dùng EmptyState (EmptyState nhận onAction
 * nên phải là client), và không dùng <Button> (Task 12 không có `asChild`, lồng
 * <a> trong <button> là HTML sai). Dùng thẳng class `btn` của tokens.css.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-container px-5 py-16">
      <Card className="flex flex-col items-start gap-3 p-8">
        <h1 className="t-title-md m-0">Không có trang này</h1>
        <p className="t-body m-0 text-muted">Đường dẫn bạn mở không tồn tại hoặc đã đổi.</p>
        <Link href="/" className="btn btn-secondary no-underline">
          Về trang chủ
        </Link>
      </Card>
    </main>
  );
}
```

- [ ] **Step 5: Implement `/app` page**

`apps/web/app/app/page.tsx`:
```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReadyResponse, apiFetch } from '@engram/shared-types';
import { AppHeader } from '@/components/app-shell/app-header';
import { EmptyState } from '@/components/app-shell/empty-state';
import { Rail } from '@/components/app-shell/rail';
import { BadgeType } from '@/components/ui/badge-type';
import { Card } from '@/components/ui/card';
import { DEMO_ITEMS, DEMO_TAGS } from '@/lib/demo-fixtures';

export default function AppPage() {
  // Nguồn duy nhất cho cờ semantic: readyz của API, không phải biến build của web.
  const ready = useQuery({
    queryKey: ['readyz'],
    queryFn: () => apiFetch<ReadyResponse>('/readyz'),
  });

  const semanticAvailable = ready.data?.semantic_available ?? false;

  return (
    <>
      {/* P01 chưa có vault thật — pill nhận fixture của shell (P03 nối state thật). */}
      <AppHeader vault={{ state: 'locked' }} />

      <main className="mx-auto grid max-w-container gap-8 px-5 py-8 lg:grid-cols-[236px_minmax(0,1fr)]">
        <Rail tags={DEMO_TAGS} semanticAvailable={semanticAvailable} />

        <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
          <h1 id="recent-heading" className="t-h3 text-ink">
            Mục gần đây
          </h1>

          {DEMO_ITEMS.length === 0 ? (
            <EmptyState title="Chưa có gì ở đây" body="Lưu mục đầu tiên bằng cách gõ từ khoá rồi nhấn Enter." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {DEMO_ITEMS.map((item) => (
                <Card key={item.id} className="flex flex-col gap-2 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display font-bold text-ink">{item.title}</h2>
                    <BadgeType kind={item.kind} />
                  </div>
                  <p className="t-legal text-muted">{item.preview}</p>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
```

> Card ở đây dùng `DEMO_ITEMS` — cùng fixture với landing, và **không** giả vờ đã lưu bền vững. Khi P04 có CRUD thật, thay nguồn dữ liệu và xoá import fixture.

- [ ] **Step 6: Chạy lại test và build**

Run: `pnpm --filter @engram/web test && pnpm --filter @engram/web typecheck && pnpm --filter @engram/web build`
Expected: PASS (12 test mới); build liệt kê `/`, `/vi`, `/app`

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): private app shell with rail, vault pill and error states"
```

---

## Phần C — Hạ tầng, CI và bằng chứng

### Task 16: CSP headers + Docker Compose + orchestration dev một origin

**Files:**
- Create: `infra/docker-compose.yml`, `infra/image-pins.env`, `apps/web/Dockerfile`, `apps/api/Dockerfile`
- Modify: `apps/web/next.config.ts` (headers CSP), `Makefile`, `package.json`
- Test: `apps/web/tests/csp.test.ts`, `apps/api/internal/httpx/e2e_compose_test.go` (bỏ qua — thay bằng smoke script ở Step 7)

**Interfaces:**
- Consumes: `cmd/api`, `cmd/worker`, `cmd/migrate` (Task 4, 6, 8); build Next (Task 15)
- Produces:
  - Header CSP trên mọi response HTML: đúng SPEC §10.2 ở mọi directive **trừ** `'unsafe-inline'` trong `script-src`/`style-src` (exception của P01, xem Global Constraints)
  - Service compose: `db`, `migrate`, `api`, `worker`, `web`; `tei` dưới profile `semantic`
  - `make dev` / `pnpm dev:stack` — DB trong Docker, API + worker + Next chạy trên máy

- [ ] **Step 1: Viết test CSP thất bại**

`apps/web/tests/csp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

async function cspFor(path: string): Promise<string> {
  const headers = await (nextConfig.headers?.() ?? Promise.resolve([]));
  const entry = headers.find((h) => h.source === '/:path*');
  expect(entry, 'next.config phải khai báo headers cho /:path*').toBeDefined();
  const csp = entry!.headers.find((h) => h.key === 'Content-Security-Policy');
  expect(csp, `thiếu CSP cho ${path}`).toBeDefined();
  return csp!.value;
}

describe('CSP (SPEC §10.2 + exception P01)', () => {
  it('khoá default-src về self', async () => {
    expect(await cspFor('/')).toContain("default-src 'self'");
  });

  it('cho phép wasm-unsafe-eval để libsodium chạy trong worker', async () => {
    expect(await cspFor('/')).toContain("'wasm-unsafe-eval'");
  });

  /**
   * Test này KHOÁ exception lại thay vì lờ đi: nếu ai đó bỏ 'unsafe-inline'
   * mà chưa dựng nonce, test đỏ và họ biết là landing sẽ hỏng hydration, chứ
   * không phải "siết CSP thành công". Khi P06 dựng nonce xong thì đổi test này
   * sang `not.toContain("'unsafe-inline'")` + `toMatch(/'nonce-/)`.
   */
  it('exception P01: script-src và style-src còn unsafe-inline, chưa có nonce', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/'nonce-/);
  });

  it('exception chỉ nới inline, không nới origin ngoài', async () => {
    const csp = await cspFor('/');
    expect(csp).not.toContain("'unsafe-eval'; ");
    expect(csp).not.toMatch(/script-src[^;]*https?:\/\//);
  });

  it('chặn nhúng iframe và object', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('connect-src chỉ self — không cho gọi origin khác', async () => {
    const csp = await cspFor('/');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*https?:\/\//);
  });

  it('không cho phép font/style từ CDN ngoài', async () => {
    const csp = await cspFor('/');
    expect(csp).not.toContain('fonts.gstatic.com');
    expect(csp).not.toContain('cdn.tailwindcss.com');
  });
});

describe('header bảo mật khác', () => {
  it('đặt Referrer-Policy và X-Content-Type-Options', async () => {
    const headers = await (nextConfig.headers?.() ?? Promise.resolve([]));
    const values = headers.flatMap((h) => h.headers).map((h) => h.key);
    expect(values).toContain('Referrer-Policy');
    expect(values).toContain('X-Content-Type-Options');
  });
});
```

- [ ] **Step 2: Chạy test để chắc nó fail**

Run: `pnpm --filter @engram/web test csp`
Expected: FAIL — `next.config` chưa có `headers()`

- [ ] **Step 3: Thêm headers vào `next.config.ts`**

Thêm vào `nextConfig` (sau `rewrites`):
```ts
  async headers() {
    // Nguồn: SPEC §10.2. `wasm-unsafe-eval` là bắt buộc để libsodium-wrappers-sumo
    // chạy trong Web Worker ở P03; không thêm origin ngoài nào khác vì font đã
    // self-host qua next/font và CSS đã build sẵn.
    //
    // EXCEPTION P01 — 'unsafe-inline' ở script-src và style-src:
    // Next nhúng script inline (`self.__next_f.push(...)` chở RSC payload) vào
    // chính HTML tĩnh. Cách đúng là nonce sinh trong middleware theo từng
    // request, nhưng nonce ép Next render dynamic, còn landing phải là SSG để
    // đạt TTFB < 200 ms. Bỏ 'unsafe-inline' mà chưa có nonce = trang trắng,
    // không phải CSP chặt hơn. P06 chốt cách render landing rồi đóng exception.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
```

> **Đây là exception có ghi nhận, không phải "CSP đúng SPEC".** Ghi vào `docs/phases/evidence/P01.md` như nợ kỹ thuật kèm đúng lý do ở comment trên. P01 không được tick ô "CSP nghiêm" của SPEC §10.2. Hai đường đóng exception ở P06, chọn một: (a) middleware sinh nonce + landing chuyển sang dynamic có cache ở CDN, đo lại TTFB; (b) giữ SSG và dùng CSP hash-based cho script inline của Next. Không sửa vặt ở P01.

- [ ] **Step 4: Ghi image pin bằng digest thật**

Pin **mọi** image, kể cả base image của hai Dockerfile — constraint "build tái lập" không loại trừ image build.

```bash
mkdir -p infra
for img in \
  pgvector/pgvector:pg16 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  golang:1.27-alpine \
  node:22-alpine \
  gcr.io/distroless/static-debian12:nonroot \
  mcr.microsoft.com/playwright:v1.56.0-noble
do
  docker pull "$img"
done
{
  echo "# Digest chốt lúc $(date -u +%Y-%m-%dT%H:%M:%SZ). KHÔNG tự tay sửa —"
  echo "# chạy lại lệnh trong Task 16 Step 4 để cập nhật."
  echo "POSTGRES_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' pgvector/pgvector:pg16)"
  echo "TEI_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/huggingface/text-embeddings-inference:cpu-latest)"
  echo "GO_BUILD_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' golang:1.27-alpine)"
  echo "NODE_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine)"
  echo "DISTROLESS_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' gcr.io/distroless/static-debian12:nonroot)"
  echo "PLAYWRIGHT_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' mcr.microsoft.com/playwright:v1.56.0-noble)"
} > infra/image-pins.env
cat infra/image-pins.env
```

Expected: sáu dòng dạng `...@sha256:...`. Không bịa digest — luôn lấy từ `docker inspect`.

`PLAYWRIGHT_IMAGE` không dùng trong compose; nó là image sinh và so ảnh baseline ở Task 17. Pin ở đây vì lý do y hệt: đổi image là đổi bản render font, và 18 ảnh baseline lập tức sai.

`cpu-latest` của TEI là tag di động: digest ở đây là ảnh chụp tại thời điểm chạy lệnh, không phải version bất biến. Ghi ngày vào file (dòng comment ở trên) để lần sau biết pin đã cũ bao lâu.

- [ ] **Step 5: Viết compose**

`infra/docker-compose.yml`:
```yaml
# Đọc digest từ image-pins.env: docker compose --env-file infra/image-pins.env ...
name: engram

services:
  db:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: engram
      POSTGRES_PASSWORD: engram
      POSTGRES_DB: engram
    ports: ['5432:5432']
    volumes: ['engram-db:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U engram -d engram']
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    build: { context: .., dockerfile: apps/api/Dockerfile }
    command: ['/app/migrate', 'up']
    environment:
      DATABASE_URL: postgres://engram:engram@db:5432/engram?sslmode=disable
    depends_on:
      db: { condition: service_healthy }
    restart: 'no'

  api:
    build: { context: .., dockerfile: apps/api/Dockerfile }
    command: ['/app/api']
    environment:
      DATABASE_URL: postgres://engram:engram@db:5432/engram?sslmode=disable
      HTTP_ADDR: 0.0.0.0:8080
      APP_ORIGIN: http://localhost:3000
      EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER:-noop}
      TEI_URL: ${TEI_URL:-}
    ports: ['8080:8080']
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ['CMD', '/app/api', '-healthcheck']
      interval: 10s
      timeout: 3s
      retries: 5

  worker:
    build: { context: .., dockerfile: apps/api/Dockerfile }
    command: ['/app/worker']
    environment:
      DATABASE_URL: postgres://engram:engram@db:5432/engram?sslmode=disable
      EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER:-noop}
      TEI_URL: ${TEI_URL:-}
    depends_on:
      migrate: { condition: service_completed_successfully }

  web:
    build: { context: .., dockerfile: apps/web/Dockerfile }
    environment:
      # Browser vẫn chỉ nói chuyện với web trên một origin; Next proxy tiếp sang api.
      API_UPSTREAM: http://api:8080
    ports: ['3000:3000']
    depends_on: [api]

  # TEI là OPTIONAL. Không bật profile này thì EMBEDDING_PROVIDER=noop và
  # semantic không khả dụng — readyz vẫn pass (P01 §Contract).
  tei:
    image: ${TEI_IMAGE}
    profiles: ['semantic']
    command: ['--model-id', 'BAAI/bge-m3']
    ports: ['8081:80']
    volumes: ['engram-tei:/data']

volumes:
  engram-db:
  engram-tei:
```

> Cờ `-healthcheck` đã được implement ở Task 6 Step 6 (`probeHealth` trong `cmd/api/main.go`), gọi `127.0.0.1:$HTTP_ADDR-port/api/v1/healthz` rồi exit theo status. Không dùng `CMD-SHELL` + `wget` được: image là `distroless/static`, không có shell.

Kiểm tra nhánh healthcheck hoạt động trước khi tin vào compose:

```bash
cd apps/api && go build -o /tmp/api ./cmd/api
HTTP_ADDR=0.0.0.0:8080 /tmp/api & sleep 1
HTTP_ADDR=0.0.0.0:8080 /tmp/api -healthcheck && echo "exit 0 — ok"
kill %1
```
Expected: in ra `exit 0 — ok`, và **không** có dòng log `nghe HTTP` thứ hai (nếu có, nhánh healthcheck đang nằm sau `run()`).

- [ ] **Step 6: Viết Dockerfile**

Base image nhận qua `ARG` để digest nằm một chỗ duy nhất là `infra/image-pins.env`. Giá trị mặc định là tag, chỉ để `docker build` trần chạy được; compose luôn truyền digest xuống.

`apps/api/Dockerfile`:
```dockerfile
ARG GO_BUILD_IMAGE=golang:1.27-alpine
ARG DISTROLESS_IMAGE=gcr.io/distroless/static-debian12:nonroot

FROM ${GO_BUILD_IMAGE} AS build
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api ./
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api \
 && CGO_ENABLED=0 go build -o /out/worker ./cmd/worker \
 && CGO_ENABLED=0 go build -o /out/migrate ./cmd/migrate

FROM ${DISTROLESS_IMAGE}
COPY --from=build /out/ /app/
USER nonroot
ENTRYPOINT []
```

`apps/web/Dockerfile`:
```dockerfile
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
# pnpm-lock.yaml PHẢI có trong repo: --frozen-lockfile fail nếu thiếu hoặc lệch.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @engram/web build

FROM ${NODE_IMAGE}
WORKDIR /app
RUN corepack enable
COPY --from=build /src ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@engram/web", "start"]
```

Truyền digest xuống trong compose — thêm vào service `api` và `web`:
```yaml
  api:
    build:
      context: ..
      dockerfile: apps/api/Dockerfile
      args:
        GO_BUILD_IMAGE: ${GO_BUILD_IMAGE}
        DISTROLESS_IMAGE: ${DISTROLESS_IMAGE}
```
```yaml
  web:
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
      args:
        NODE_IMAGE: ${NODE_IMAGE}
```
(`worker` dùng chung image với `api` nên nhận cùng hai arg.)

- [ ] **Step 7: Thêm target dev và smoke script**

Thêm vào `Makefile`:
```makefile
COMPOSE = docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml

.PHONY: dev stack-up stack-down smoke

# dev: chỉ DB chạy trong Docker; API/worker/web chạy trên máy để hot reload.
# CHỈ MỘT tiến trình sở hữu cổng web (Next ở :3000) — compose đầy đủ dùng `make stack-up`.
dev:
	$(COMPOSE) up -d db
	cd apps/api && go run ./cmd/migrate up
	cd apps/api && go run ./cmd/api & \
	cd apps/api && go run ./cmd/worker & \
	pnpm --filter @engram/web dev

stack-up:
	$(COMPOSE) up -d --build

stack-down:
	$(COMPOSE) down

smoke:
	bash scripts/smoke.sh
```

Mirror sang `package.json` (Windows thường không có `make`):
```json
"scripts": {
  "stack:up": "docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml up -d --build",
  "stack:down": "docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml down",
  "smoke": "bash scripts/smoke.sh"
}
```

`scripts/smoke.sh`:
```bash
#!/usr/bin/env bash
# Kiểm tra P01-A3 và P01-A2 trên stack đang chạy. Chạy sau `make stack-up`.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

echo "==> healthz đi qua proxy cùng origin"
curl -fsS "$BASE/api/v1/healthz" | grep -q '"status":"ok"'

echo "==> readyz báo sẵn sàng và KHÔNG quảng cáo semantic khi provider noop"
ready=$(curl -fsS "$BASE/api/v1/readyz")
echo "$ready" | grep -q '"status":"ready"'
echo "$ready" | grep -q '"semantic_available":false'

echo "==> không có bản sao endpoint ở root"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = "404"

echo "==> landing và app trả 200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/vi")" = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app")" = "200"

echo "==> CSP có mặt trên HTML"
curl -fsSI "$BASE/" | grep -qi "content-security-policy"

echo "OK — smoke pass"
```

```bash
chmod +x scripts/smoke.sh
```

- [ ] **Step 8: Chạy thử toàn bộ stack**

```bash
pnpm stack:up
pnpm smoke
```
Expected: in `OK — smoke pass`

Kiểm tra P01-A2 bằng tay:
```bash
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml stop db
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/readyz   # 503
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/healthz  # 200
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml start db
sleep 10
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/readyz   # 200 trở lại
```

- [ ] **Step 9: Chạy lại test CSP và commit**

Run: `pnpm --filter @engram/web test csp`
Expected: PASS (6 test)

```bash
git add infra apps/web/next.config.ts apps/web/Dockerfile apps/api/Dockerfile apps/web/tests/csp.test.ts Makefile package.json scripts
git commit -m "feat(infra): compose stack, pinned images, csp headers and smoke script"
```

---

### Task 17: CI — `api.yml`, `web.yml`, `e2e.yml`

**Files:**
- Create: `.github/workflows/api.yml`, `.github/workflows/web.yml`, `.github/workflows/e2e.yml`, `apps/api/.golangci.yml`, `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`, `apps/web/e2e/__screenshots__/*.png` (18 ảnh baseline, commit)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: mọi lệnh test/build của Task 1–16
- Produces: ba workflow chạy trên PR vào `develop` và `main`

- [ ] **Step 1: Cập nhật `.gitignore`**

Thêm vào cuối `.gitignore`:
```gitignore
# Build output
node_modules/
.next/
out/
dist/

# Go
apps/api/bin/

# Test artifacts. `test-results/` giữ ảnh -actual/-diff khi toHaveScreenshot đỏ.
# Ảnh baseline trong apps/web/e2e/__screenshots__/ thì PHẢI commit — không ignore.
playwright-report/
test-results/

# Env thật — chỉ .env.example được commit
.env
.env.local
```

- [ ] **Step 2: Cấu hình golangci-lint**

`apps/api/.golangci.yml`:
```yaml
version: "2"
linters:
  enable:
    - errcheck
    - govet
    - ineffassign
    - staticcheck
    - unused
    - bodyclose
    - rowserrcheck
    - sqlclosecheck
formatters:
  enable:
    - gofumpt
```

- [ ] **Step 3: Viết `api.yml`**

`.github/workflows/api.yml`:
```yaml
name: api

on:
  pull_request:
    branches: [develop, main]
    paths: ['apps/api/**', '.github/workflows/api.yml']
  push:
    branches: [develop, main]

jobs:
  check:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/api
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27.0'
          cache-dependency-path: apps/api/go.sum

      - name: go vet
        run: go vet ./...

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v8
        with:
          version: v2.6.0
          working-directory: apps/api

      # Pin version như sqlc/golangci-lint. `@latest` làm CI đổi hành vi ngoài
      # tầm kiểm soát của commit — build không còn tái lập. Database lỗ hổng vẫn
      # luôn mới vì govulncheck query vuln.go.dev lúc chạy, không nằm trong binary.
      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@v1.1.4
          govulncheck ./...

      - name: sqlc diff
        run: |
          go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.30.0
          sqlc diff

      - name: unit tests
        run: go test ./... -short -race

      # testcontainers cần Docker — runner ubuntu-latest có sẵn.
      - name: integration tests
        run: go test ./... -race -timeout 600s

      - name: build
        run: go build ./...
```

- [ ] **Step 4: Viết `web.yml`**

`.github/workflows/web.yml`:
```yaml
name: web

on:
  pull_request:
    branches: [develop, main]
    paths: ['apps/web/**', 'packages/**', '.github/workflows/web.yml']
  push:
    branches: [develop, main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10.34.5

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: openapi client không bị drift
        run: |
          pnpm --filter @engram/shared-types generate
          git diff --exit-code packages/shared-types/src/api.d.ts

      - name: lint
        run: pnpm -r lint

      - name: typecheck
        run: pnpm -r typecheck

      # Bao gồm tokens.parity (token khớp mockup), i18n.parity (en/vi cùng key),
      # csp (SPEC §10.2) và demo-search (ranh giới demo).
      - name: unit tests
        run: pnpm -r test

      - name: build
        run: pnpm --filter @engram/web build
```

- [ ] **Step 5: Viết Playwright config và smoke spec**

```bash
pnpm --filter @engram/web add -D @playwright/test@^1.56.0 @axe-core/playwright@^4.10.0
```

`apps/web/playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },

  // Ảnh baseline nằm cạnh test, tên không chứa platform: baseline CHỈ được sinh
  // trong image Playwright (xem Step 7), nên mọi nơi render ra cùng một byte.
  snapshotPathTemplate: 'e2e/__screenshots__/{projectName}-{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      // Ngưỡng rõ ràng thay vì "nhìn thấy đúng là được". 0.5% pixel cho phép
      // sai khác antialiasing của font; lệch layout thật luôn vượt xa mức này.
      maxDiffPixelRatio: 0.005,
      // Ngưỡng per-pixel: dưới mức này coi như cùng màu (nhiễu nén ảnh).
      threshold: 0.2,
      animations: 'disabled',
      // 'css' để ảnh theo CSS pixel, không nhân theo devicePixelRatio của máy.
      scale: 'css',
    },
  },

  projects: [
    { name: 'mobile-390', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
```

`apps/web/e2e/smoke.spec.ts`:
```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PAGES = ['/', '/vi', '/app'];

for (const path of PAGES) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${path} @ ${theme} — không tràn viewport, không lỗi a11y (P01-A4)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(path);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

      // P01-A4: không tràn ngang ở bất kỳ breakpoint nào.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `trang ${path} tràn ngang ${overflow}px`).toBeLessThanOrEqual(0);

      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

      // P01-A4 "khớp mockup": so với ảnh baseline đã được duyệt bằng mắt so với
      // mockups/*.html (Step 7). `page.screenshot` trần chỉ lưu ảnh, không so gì
      // cả — lệch layout vẫn pass. `toHaveScreenshot` mới là cái chặn.
      await expect(page).toHaveScreenshot(`${theme}-${path.replace(/\//g, '_') || 'root'}.png`, {
        fullPage: true,
        // Hero tự gõ và caret nhấp nháy làm ảnh đổi mỗi lần chụp.
        mask: [page.locator('[data-visual-volatile]')],
      });
    });
  }
}

test('logo luôn là chữ engram viết thường (P01-A6)', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.getByText('engram').first()).toBeVisible();
    await expect(page.getByText('Engram')).toHaveCount(0);
  }
});

test('demo ở landing không gửi request nào ra ngoài (P01-A5)', async ({ page }) => {
  const outbound: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api')) outbound.push(req.url());
  });

  await page.goto('/');
  await page.getByRole('combobox').fill('mật khẩu ngân hàng của tôi');
  await page.waitForTimeout(1000);

  expect(outbound, `demo gọi API: ${outbound.join(', ')}`).toEqual([]);
});

test('healthz đi qua proxy cùng origin (P01-A3)', async ({ request }) => {
  const res = await request.get('/api/v1/healthz');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });

  const root = await request.get('/healthz');
  expect(root.status()).toBe(404);
});
```

- [ ] **Step 6: Viết `e2e.yml`**

`.github/workflows/e2e.yml`:
```yaml
name: e2e

on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop, main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with: { version: 10.34.5 }

      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }

      - run: pnpm install --frozen-lockfile

      - name: dựng stack
        run: |
          docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml up -d --build
          for i in $(seq 1 60); do
            if curl -fsS http://localhost:3000/api/v1/healthz >/dev/null; then break; fi
            sleep 3
          done

      - name: smoke
        run: bash scripts/smoke.sh

      # Chạy Playwright TRONG image chính thức, cùng bản với lệnh sinh baseline ở
      # Task 17 Step 7. Nếu chạy thẳng trên runner thì font hệ thống khác image và
      # toHaveScreenshot đỏ vì antialiasing, không phải vì UI sai.
      # --network host để thấy stack compose ở localhost:3000 của runner.
      - name: playwright
        run: |
          set -a; . infra/image-pins.env; set +a
          docker run --rm --network host \
            -v "$PWD":/work -w /work \
            "$PLAYWRIGHT_IMAGE" \
            npx --yes pnpm@10.34.5 --filter @engram/web exec playwright test

      - name: log khi thất bại
        if: failure()
        run: docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml logs --no-color

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-artifacts
          path: |
            apps/web/playwright-report/
            apps/web/test-results/
```

- [ ] **Step 7: Sinh và duyệt ảnh baseline**

Ảnh baseline **phải** sinh trong đúng image Playwright mà CI dùng. Render font trên Windows/macOS khác Linux, baseline sinh ở máy cá nhân sẽ làm CI đỏ ngay lần đầu.

```bash
pnpm stack:up
set -a; . infra/image-pins.env; set +a
docker run --rm --network host \
  -v "$PWD":/work -w /work \
  "$PLAYWRIGHT_IMAGE" \
  npx --yes pnpm@10.34.5 --filter @engram/web exec playwright test --update-snapshots
```

Lệnh này sinh 18 ảnh (3 viewport × 2 theme × 3 trang) vào `apps/web/e2e/__screenshots__/`.

**Cổng thủ công — đây là chỗ chữ "khớp mockup" của P01-A4 được quyết định.** Mở từng ảnh cạnh mockup tương ứng (`mockups/landing.html` cho `/` và `/vi`, `mockups/index.html` cho `/app`) ở cùng viewport và cùng theme, đối chiếu: khoảng cách dọc giữa các section, bề rộng container, màu nền/viền card, cỡ và trọng lượng chữ tiêu đề, vị trí header/rail. Ảnh nào lệch thì **sửa code rồi chạy lại `--update-snapshots`**, không commit ảnh lệch. Dán ba ảnh 1440px (light) vào `docs/phases/evidence/P01.md` ở Task 18.

Sau khi ảnh đã đúng, chạy lại ở chế độ so sánh để chắc là ổn định (chạy hai lần liên tiếp không đỏ):

```bash
docker run --rm --network host -v "$PWD":/work -w /work \
  "$PLAYWRIGHT_IMAGE" \
  npx --yes pnpm@10.34.5 --filter @engram/web exec playwright test
```
Expected: mọi test pass, không có file `*-diff.png` nào được sinh ra.

> Từ đây, mọi thay đổi UI làm lệch quá `maxDiffPixelRatio` sẽ làm CI đỏ. Đúng ý đồ: người sửa phải chạy `--update-snapshots`, xem lại ảnh mới so với mockup, rồi commit ảnh cùng commit code — reviewer thấy diff ảnh trong PR.

- [ ] **Step 8: Commit**

```bash
git add .github .gitignore apps/api/.golangci.yml apps/web/playwright.config.ts apps/web/e2e
git commit -m "ci: api, web and e2e workflows with axe, viewport and visual baselines"
```

---

### Task 18: README fresh clone + ghi bằng chứng nghiệm thu

**Files:**
- Modify: `README.md`
- Create: `docs/phases/evidence/P01.md`

**Interfaces:**
- Consumes: mọi lệnh và acceptance của Task 1–17
- Produces: hướng dẫn chạy từ checkout mới (P01-A1) và bảng bằng chứng A1–A7

- [ ] **Step 1: Viết phần "Chạy tại máy" trong `README.md`**

Thêm vào `README.md` (giữ nguyên phần giới thiệu sẵn có):

````markdown
## Chạy tại máy

Yêu cầu: Node ≥ 20.19, pnpm 10.34.5, Go 1.27, Docker.

```bash
git clone https://github.com/zone17th/save-all-by-keyword.git
cd save-all-by-keyword
cp .env.example .env
pnpm install
```

### Cách 1 — toàn bộ trong Docker

```bash
pnpm stack:up     # db + migrate + api + worker + web
pnpm smoke        # kiểm tra nhanh
```

Mở http://localhost:3000. Dừng bằng `pnpm stack:down`.

### Cách 2 — chỉ DB trong Docker, phần còn lại chạy trên máy

```bash
make dev
```

Trên Windows (không có `make`), chạy từng lệnh trong ba terminal:

```bash
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml up -d db
```

```bash
cd apps/api && go run ./cmd/migrate up && go run ./cmd/api
```

```bash
pnpm --filter @engram/web dev
```

**Không cần TEI hay OAuth thật để xem landing.** `EMBEDDING_PROVIDER=noop` là mặc định;
tìm kiếm ngữ nghĩa sẽ hiển thị là chưa khả dụng, đúng như thực tế.

Muốn thử TEI (tải model ~2 GB):

```bash
docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml --profile semantic up -d tei
EMBEDDING_PROVIDER=tei TEI_URL=http://localhost:8081 pnpm stack:up
```

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
pnpm --filter @engram/web exec playwright test
```

### Một origin duy nhất

Trình duyệt chỉ nói chuyện với `http://localhost:3000`. Next chuyển tiếp `/api/*`
sang Go (`API_UPSTREAM`, mặc định `http://127.0.0.1:8080`). Đừng gọi thẳng cổng 8080
từ trình duyệt — cookie phiên có path `/api` và CSP chỉ cho `connect-src 'self'`.
````

- [ ] **Step 2: Kiểm chứng README bằng một checkout sạch (P01-A1)**

```bash
cd /tmp && rm -rf engram-fresh
git clone https://github.com/zone17th/save-all-by-keyword.git engram-fresh
cd engram-fresh && git checkout develop
cp .env.example .env && pnpm install && pnpm stack:up && pnpm smoke
```
Expected: `OK — smoke pass`. Bất kỳ bước nào phải làm thêm mà README không ghi thì **sửa README ngay**, không chỉ ghi nhớ.

- [ ] **Step 3: Viết bằng chứng**

`docs/phases/evidence/P01.md`:
```markdown
# Bằng chứng nghiệm thu — P01

> Ghi theo [quy tắc chung](../README.md#7-bằng-chứng-nghiệm-thu).
> Commit: `<sha>` · Ngày: `<yyyy-mm-dd>` · Người chạy: `<tên>`

| ID | Ca | Bằng chứng | Kết quả |
|---|---|---|---|
| P01-A1 | Fresh checkout + env mẫu | Log `pnpm install && pnpm stack:up && pnpm smoke` từ clone sạch ở `/tmp` | |
| P01-A2 | Ready dependency | Ba dòng status code: readyz 503 khi `docker compose stop db`, healthz 200 cùng lúc, readyz 200 sau `start db` | |
| P01-A3 | Proxy/routing | Output `scripts/smoke.sh` + test Playwright `healthz đi qua proxy cùng origin` | |
| P01-A4 | Visual | 18 ảnh baseline trong `apps/web/e2e/__screenshots__/` (3 viewport × 2 theme × 3 trang) đã đối chiếu tay với mockup ở Task 17 Step 7; `toHaveScreenshot` pass với `maxDiffPixelRatio` 0.005 + assert overflow ≤ 0 | |
| P01-A5 | Demo boundary | Test Playwright `demo ở landing không gửi request nào ra ngoài` + Vitest `ranh giới demo (P01-A5)` | |
| P01-A6 | Keyboard/i18n | Vitest `hero-demo` (ArrowDown/Enter/Escape, reduced motion) + `i18n.parity` + Playwright `logo luôn là chữ engram viết thường` | |
| P01-A7 | CI | Link ba run xanh: `api`, `web`, `e2e` | |

## Nợ kỹ thuật chuyển sang phase sau

- **CSP chưa đạt SPEC §10.2**: `script-src`/`style-src` còn `'unsafe-inline'`, chưa có nonce, vì nonce ép landing sang dynamic rendering còn landing phải là SSG (TTFB < 200 ms). P06 chọn một trong hai: nonce + landing dynamic-có-cache, hoặc CSP hash-based giữ SSG.
- `VaultPill` ở `/app` nhận state cứng `locked` từ shell — P03 nối vào state vault thật.
- `/app` hiển thị `DEMO_ITEMS`; P04 thay bằng dữ liệu thật và xoá import fixture.
- Job `noop` của River chỉ để chứng minh lifecycle — P05 thay bằng job embedding.
- Primitive UI viết tay, chưa có Radix. P02–P03 thay `Switch`/`Segmented` bằng `@radix-ui/react-switch` / `react-toggle-group` và thêm `Dialog`/`Popover`/`DropdownMenu`, giữ nguyên class từ `tokens.css`.
- Landing dùng `landing.privacyBody1` ở thì tương lai và có `landing.previewNote`: P01 chưa có crypto. P03 đổi lại đúng copy mockup và bỏ `previewNote` khi vault thật đã bật.
- Chưa có `turbo.json`: workspace mới có một package Node. Thêm khi số package Node vượt hai (sớm nhất P04).
- `/app` khoá cứng locale bằng hằng `APP_LOCALE = 'vi'` (dùng cho cả `<html lang>` lẫn `NextIntlClientProvider`). P01 chưa có session nên chưa có hồ sơ để đọc locale. P02 thay hằng này bằng locale của người dùng và bỏ file `i18n/app-locale.ts`.

## Ảnh chụp

Không đưa ảnh chứa recovery key, passphrase hay dữ liệu thật của người dùng vào đây.
Mọi ảnh của P01 chỉ chứa fixture công khai trong `apps/web/lib/demo-fixtures.ts`.
```

- [ ] **Step 4: Điền bằng chứng thật**

Chạy lần lượt từng ca ở Step 3, dán output/đường dẫn thật vào cột "Bằng chứng" và đánh dấu cột "Kết quả" là `pass` hoặc `fail` kèm lý do. Không để ô trống.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/phases/evidence/P01.md
git commit -m "docs: fresh-clone guide and P01 acceptance evidence"
```

---

## Đối chiếu acceptance

| ID | Task phụ trách |
|---|---|
| P01-A1 | 16 (compose, smoke), 18 (README + clone sạch) |
| P01-A2 | 5 (readyz + healthz độc lập), 16 Step 8 (kiểm bằng tay) |
| P01-A3 | 3 (không bản sao ở root), 11 (rewrite + middleware matcher), 15 (test routing), 17 (Playwright) |
| P01-A4 | 10 (token parity), 12 (primitives), 14 (landing), 15 (shell), 17 (3 viewport × 2 theme, overflow, `toHaveScreenshot` so baseline đã duyệt với mockup) |
| P01-A5 | 13 (ranh giới demo), 14 (không fetch, không claim mã hoá), 17 (Playwright chặn request) |
| P01-A6 | 11 (i18n parity + `engram` viết thường), 14 (bàn phím + reduced motion), 17 (axe + logo) |
| P01-A7 | 17 (ba workflow) |

| Mục phạm vi P01 | Task phụ trách |
|---|---|
| Monorepo `apps/web` / `apps/api` / `packages/shared-types` | 1, 2, 10 |
| Postgres 16 + pgvector ≥ 0.8, pg_trgm, unaccent, citext, pgcrypto | 4, 7 |
| Entrypoint api/worker/migrate | 4, 6, 8 |
| Cấu hình typed, graceful shutdown | 1, 6 |
| Health/ready | 3, 5 |
| Log request ID không log body/query | 3 |
| Worker có lifecycle, chưa embed thật | 8 |
| Migration nền + sqlc pipeline | 4, 7 |
| Compose, TEI profile optional, `noop` không quảng cáo semantic | 5, 15, 16 |
| Web shell/providers/error boundary/`next-intl`/Tailwind + shadcn | 10, 11, 12, 15 |
| Port CSS var/font/icon từ mockup | 10, 12, 14 |
| Landing hero demo + JSON table | 13, 14 |
| App shell U2 | 15 |
| Trạng thái lỗi/rỗng theo `states.html` | 15 |
| OpenAPI 3.1 + typed client + RFC 9457 | 2, 9 |
| Pin runtime/image, không tin `cpu-latest` | 16, 17 |
