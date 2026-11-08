# Bằng chứng nghiệm thu — P06 · Task 5b-BE (`consentbe`)

> Lane `consentbe` (W1, P06-T5b-BE) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) mục 2.10, mục 3, mục 4.2 và Task 5b.

## 1. Bàn giao theo từng mục Task 5b-BE

| Hạng mục Task 5b-BE | File đã cập nhật | Trạng thái |
|---|---|---|
| Query `MarkSemanticConsentSeen` + sqlc (`C15`, `N-05`) | `apps/api/internal/db/queries/auth.sql`, `apps/api/internal/db/gen/auth.sql.go` | Hoàn tất: `UPDATE app_user SET semantic_consent_seen_at = COALESCE(semantic_consent_seen_at, now()) WHERE id = $1 AND deleted_at IS NULL;` (`sqlc v1.30.0`, `sqlc diff` = 0). |
| `SettingsPatch`, `PatchSettings`, `BuildMe` | `apps/api/internal/auth/service.go`, `apps/api/internal/auth/dto.go` | Hoàn tất: `SettingsPatch.SemanticConsentSeen *bool`; `false` → `ErrInvalidRequest` (`400 invalid_request`); `true` ghi `MarkSemanticConsentSeen` trong cùng transaction với `semantic_suggest` (không tạo service/handler song song, không nhận giờ từ client, không sửa signup); `Me.SemanticConsentSeenAt *time.Time` (`semantic_consent_seen_at`, nullable); PATCH chỉ có `semantic_consent_seen: true` không ghi dòng audit `settings.change` rỗng (`secevent` thuộc `contract`). |
| Handler `PATCH /api/v1/me/settings` | `apps/api/internal/auth/authhttp/handlers.go` | Hoàn tất: decode `semantic_consent_seen` (`null`/kiểu sai → `400 invalid_request`). |
| Kiểm thử hợp đồng & hành vi | `apps/api/internal/auth/authhttp/settings_contract_test.go`, `apps/api/internal/auth/settings_semantic_test.go` | Hoàn tất: `TestSemanticConsentDefaultOffPassword`, `TestSemanticConsentDefaultOffOAuth`, `TestPatchSettingsConsentSeenServerTime`, `TestPatchSettingsConsentSeenFalseRejected`, `TestSemanticConsentNoEmbedBeforeOptIn`. |

## 2. Kiểm tra đã chạy

| Kiểm tra | Lệnh | Host | Kết quả |
|---|---|---|---|
| Consent BE (5 test mục Task 5b) | `(cd apps/api && CGO_ENABLED=1 go test -v -race -count=1 -run 'TestSemanticConsentDefaultOffPassword\|TestSemanticConsentDefaultOffOAuth\|TestPatchSettingsConsentSeenServerTime\|TestPatchSettingsConsentSeenFalseRejected\|TestSemanticConsentNoEmbedBeforeOptIn' ./internal/auth ./internal/auth/authhttp)` | `cursor-runner` | PASS (`CONSENT_BE_EXIT=0`, 5/5 `--- PASS:` tại `c09b0e1` — `reports/consentbe/cloud-test-2.md`) |
| Regression `auth` + `httpx` + `sqlc diff` + `golangci-lint` | `(cd apps/api && CGO_ENABLED=1 go test -race -count=1 ./internal/auth/... ./internal/httpx/...)` + `sqlc diff` + `golangci-lint run ./internal/auth/...` | `cursor-runner` | PASS (`AUTH_PKG_EXIT=0`, `SQLC_DIFF_EXIT=0`, `GOLANGCI_LINT_EXIT=0` tại `c09b0e1` — `reports/consentbe/cloud-test-2.md`) |
| Full CI replica (`.cursor/cloud/specs/full.txt`) | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/full.txt --lane consentbe --out reports/consentbe/cloud-test-full.md` | `cursor-runner` | Xem `reports/consentbe/merge-ready.md` |
