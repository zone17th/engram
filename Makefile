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
