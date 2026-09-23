# Windows không có make sẵn; các target dưới đây được mirror sang scripts của package.json.

.PHONY: api-test api-lint web-test migrate dev stack-up stack-down smoke e2e

api-test:
	cd apps/api && go test ./...

api-lint:
	cd apps/api && gofumpt -l -w . && go vet ./...

web-test:
	pnpm -r test

migrate:
	node scripts/dev.mjs migrate

# dev: chỉ DB chạy trong Docker; API/worker/web chạy trên máy để hot reload.
# CHỈ MỘT tiến trình sở hữu cổng web (Next ở :3000) — compose đầy đủ dùng `make stack-up`.
dev:
	node scripts/dev.mjs

stack-up:
	node scripts/dev.mjs compose-up

stack-down:
	node scripts/dev.mjs compose-down

smoke:
	node scripts/smoke.mjs

e2e:
	node scripts/e2e.mjs
