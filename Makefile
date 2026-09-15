# Windows không có make sẵn; các target dưới đây được mirror sang scripts của package.json.
COMPOSE = docker compose --env-file infra/image-pins.env -f infra/docker-compose.yml

.PHONY: api-test api-lint web-test migrate dev stack-up stack-down smoke

api-test:
	cd apps/api && go test ./...

api-lint:
	cd apps/api && gofumpt -l -w . && go vet ./...

web-test:
	pnpm -r test

migrate:
	cd apps/api && go run ./cmd/migrate up

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
