# Bằng chứng nghiệm thu — P06 · Task 3 (`accountdelbe`)

> Lane `accountdelbe` (W1, P06-T3) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) mục 2.9, mục 3, mục 4.2 và Task 3.

## 1. Bàn giao theo từng mục Task 3

| Hạng mục Task 3 | File cập nhật / tạo mới | Trạng thái |
|---|---|---|
| `DeleteUserAllGenerations` dưới `generation.LockGenerationSetShared` | `apps/api/internal/embedding/store/delete.go`, `apps/api/internal/embedding/store/delete_test.go` | Hoàn tất: xoá vector `item` + `tag` của user trên mọi generation `state <> 'dropped'` (cả `tei` và `openai_compat`, `active`/`pending`/`retired`); giữ nguyên user khác. |
| `Service.DeleteAccount` + `Service.DeleteAccountByEmail` chung một hàm transaction | `apps/api/internal/auth/account_delete.go`, `apps/api/internal/auth/account_delete_test.go` | Hoàn tất: thứ tự khoá `LockGenerationSetShared` → `app_user FOR UPDATE` → `vault FOR UPDATE` → `export_job FOR UPDATE` → `LockUserContent`; `DeleteUserAllGenerations`; `CancelUserExportJobs` + `InsertExportFileCleanup` (`reason='account_delete'`, không chứa `user_id`/email); xoá `river_job` user-scoped (`embed_item`, `embed_tag`, `reembed_user`, `export_encrypted`); đánh dấu claim idempotency `done` rồi `DELETE FROM app_user`; ghi `audit_log` `event='account.delete'`, `user_id=NULL`, `meta='{}'`; sau commit enqueue `export_file_cleanup` (`exportcleanup.Args{CleanupID}`). Retry 1 lần cho `40P01`/`55P03`. |
| `DELETE /api/v1/me` (`accountDelete`) + mount 1 dòng | `apps/api/internal/auth/authhttp/account_delete_handler.go`, `apps/api/internal/auth/authhttp/account_delete_handler_test.go`, `apps/api/internal/auth/authhttp/routes.go` | Hoàn tất: `RequireOrigin` + `RequireSession` + `RequireCSRF` + `RequireJSONContent` + trần 16 KiB + `Idempotency.Lookup` + `RequireReauth("account.delete")` + `UserLimiter(ScopeVaultSensitive)` + `Idempotency.Claim` → `ClearAuthCookies` + `Cache-Control: no-store` + `204`. |
| Admin CLI `account-delete --email <email> --confirm` + Dockerfile `/app/admin` (`N-07`) | `apps/api/cmd/admin/main.go`, `apps/api/cmd/admin/account_delete.go`, `apps/api/cmd/admin/account_delete_test.go`, `apps/api/Dockerfile` | Hoàn tất: thiếu `--confirm` / `--email` / email sai định dạng → exit `2` trước khi chạm DB; có `--confirm` gọi `Service.DeleteAccountByEmail` (cùng transaction), chỉ in `user_id=<uuid> audit_id=<id>` (không in email/PII). Stage `build` trong `apps/api/Dockerfile` build thêm `/out/admin` → image runtime có `/app/admin` cạnh `/app/api`, `/app/worker`, `/app/migrate`. |

## 2. Kiểm tra nghiệm thu Task 3
## 2. Kiểm tra nghiệm thu Task 3 (`44e75ad`)

| Kiểm tra | Lệnh | Host | Kết quả |
|---|---|---|---|
| Delete vs Reset (`P06-A4`) | `(cd apps/api && CGO_ENABLED=1 go test -v -race -run 'TestDeleteAccount\|TestDeleteAccountCleanupRecordSurvives\|TestDeleteAccountCancelsExportJobs\|TestDeleteAccountByEmail' ./internal/auth && CGO_ENABLED=1 go test -v -race -run 'TestAdminDeleteAccountByEmail\|TestAdminRequiresConfirm' ./cmd/admin)` | `cursor-runner` | PASS (`ACCOUNTDELBE_EXIT=0`, `reports/accountdelbe/cloud-test-5.md`, `cloud-test-5.logs/a.log` @ `44e75ad`). |
| Vector cleanup mọi generation | `(cd apps/api && CGO_ENABLED=1 go test -v -race -run 'TestDeleteUserAllGenerations' ./internal/embedding/store)` | `cursor-runner` | PASS (`STORE_DELETE_EXIT=0`, `reports/accountdelbe/cloud-test-5.md`, `cloud-test-5.logs/b.log` @ `44e75ad`). |
| Security gates (`P06-A7`) | `(cd apps/api && CGO_ENABLED=1 go test -v -run 'TestDeleteAccount_SecurityGates' ./internal/auth/authhttp)` | `cursor-runner` | PASS (`SECURITY_GATES_EXIT=0`, `reports/accountdelbe/cloud-test-5.md`, `cloud-test-5.logs/c.log` @ `44e75ad`: `403 csrf_invalid`, `401 reauth_required`/`reauth_invalid`, `400 account_delete_confirm_invalid`, `204` xoá cookie). |
| Admin trong image (`N-07`) | `docker build -f apps/api/Dockerfile -t engram-api:ci-admin . && docker run --rm --entrypoint /app/admin engram-api:ci-admin --help && docker image inspect engram-api:ci-admin >/dev/null` | `cursor-runner` | PASS (`ADMIN_IMAGE_EXIT=0`, `reports/accountdelbe/cloud-test-5.md`, `cloud-test-5.logs/d.log` @ `44e75ad`). |
| Regression `go-unit` + `go-race-integration` | `.cursor/cloud/specs/go-unit.txt` + `.cursor/cloud/specs/go-race-integration.txt` | `cursor-runner` | PASS (`GOFMT_EXIT=0`, `GO_UNIT_EXIT=0`, `GO_VET_EXIT=0`, `GOLANGCI_LINT_EXIT=0`, `GOVULNCHECK_EXIT=0`, `GO_BUILD_EXIT=0` trong `cloud-test-6-go-unit.md`; `GO_INTEGRATION_EXIT=0`, `CONTENT_PERF_EXIT=0` trong `cloud-test-7-go-race-integration.md` @ `44e75ad`). |
