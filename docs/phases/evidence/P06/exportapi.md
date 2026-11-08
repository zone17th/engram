# Bằng chứng nghiệm thu — P06 · Task 11 (`exportapi`)

> Lane `exportapi` (W2, P06-T11) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) mục 2.4–2.8, bảng canonical mục 3, mục 4.2 và Task 11.

## 1. Bàn giao theo từng mục Task 11

| Hạng mục Task 11 | File | Trạng thái |
|---|---|---|
| `POST /api/v1/exports` (`exportCreate`) | `apps/api/internal/export/exporthttp/api.go` | Pause gate (`EXPORT_CREATE_PAUSED` → `503 dependency_unavailable` + `Retry-After: 600`, chạy **trước** `RequireOrigin`/Idempotency nên không ghi `idempotency_key`/`rate_event`) → `RequireOrigin` + `RequireSession` + `RequireCSRF` + `RequireJSONContent` + body 16 KiB + `Idempotency` → `export.Service.Create`. **Không** mount `UserLimiter(ScopeExportCreate)` (C05); quota chỉ là `ConsumeTx` trong tx tạo job. `kind` khác `"encrypted"`/field lạ → `400`. |
| `GET /exports/latest`, `GET /exports/{id}`, `GET /exports/{id}/download` | `api.go` | `RequireSession`; owner check trong service → `404 not_found`; ID không phải UUID v4 → `400`. Download stream `ENGX1` → `.sabk.json` với `Cache-Control: no-store, no-transform`, `Content-Type: application/json`, `Content-Disposition: attachment; filename="engram-backup-YYYY-MM-DD.sabk.json"`, `X-Content-Type-Options: nosniff`; write deadline riêng 30 phút (server `WriteTimeout` 30 s sẽ cắt file lớn). Lỗi đọc/xác thực khung sau khi đã gửi header → `panic(http.ErrAbortHandler)`: client nhận lỗi transport, không bao giờ nhận `200` cụt (review r1 R1-01). Log lỗi chỉ ghi `route` pattern + `error_class` cố định, không ghi chuỗi lỗi thô (path spool, job/attempt ID; R1-03). |
| `POST /exports/{id}/cancel` (`exportCancel`) | `api.go` | S + C + JSON + body 16 KiB + I; body chỉ nhận đúng object `{}` (`null`/mảng/scalar/field lạ/trùng/trailing → `400`, R1-02); `200 cancelled` idempotent; `failed` → `409 export_not_ready`; `expired`/quá hạn → `410 export_expired`; không hoàn lượt. |
| `GET /exports/{id}/decrypted-pages` (`exportDecryptedPages`) | `api.go` | `RequireSession` + `RequireReauth("export.decrypted")`, không CSRF, không quota; thiếu token → `401 reauth_required`, sai → `401 reauth_invalid`; cursor sai/lặp → `400 invalid_request`. |
| `POST /api/v1/audit/export-decrypted` (`exportDecryptedAudit`) | `api.go` | S + C + JSON + A(`export.decrypted`) + I; body chỉ nhận đúng object `{}`; `204`; replay cùng key không ghi thêm; audit `export.decrypted` `meta={}` + `user_notification` + `security_notice` qua `export.Service.RecordDecryptedAudit`. |
| Wire | `apps/api/internal/compose/export_http.go`, `apps/api/cmd/api/main.go` | `compose.NewExportHTTP` dựng `exporthttp.API` từ `compose.NewExport`; `main.go` thêm `exporthttp.Mount(exportAPI)` vào `compose.MountAll`. |

**`httpx/router.go` không đổi (có chủ đích):** mọi nhóm route (`auth`, `vault`, `item`, `tag`, `entry`, `search`) mount qua `Deps.MountAPI` = `compose.MountAll(...)` từ `cmd/api/main.go`; export đi cùng đường đó nên `router.go` (mount `/metrics`, `Observe` của `ops-obs`) giữ nguyên.

## 2. Kết quả kiểm tra

| Kiểm tra | Lệnh (cwd `apps/api`) | Kết quả |
|---|---|---|
| Endpoint theo bảng canonical | `go test -v -race -run 'TestExportHTTP' ./internal/export/exporthttp` | Xem `reports/exportapi/merge-ready.md` (cloud, SHA cuối) |
| Quota không qua middleware (C05) | `go test -v -race -run 'TestExportHTTPCreateCoalesceNotRateLimited\|TestExportHTTPCreateFourthIs429\|TestExportHTTPDecryptedPagesNoQuota' ./internal/export/exporthttp` | như trên |
| Idempotency + CSRF + Origin + Reauth | `go test -v -race -run 'TestExportHTTP.*Idempotency\|TestExportHTTP.*CSRF\|TestExportHTTP.*Origin\|TestExportHTTP.*Reauth' ./internal/export/exporthttp` | như trên |

Ánh xạ test → hàng mục 3: `TestExportHTTPEndpoints` (sub-test cho latest, create validation/`vault_absent`, ready get/download headers, cross-user `404` + `400` ID, decrypted-pages + cursor `400`, `409`/`410` theo `queued`/`running`/`cancelled`/`failed`/quá hạn/`expired`, cancel body, audit `204`, pause `503`); `TestExportHTTPCreateCoalesceNotRateLimited`; `TestExportHTTPCreateFourthIs429`; `TestExportHTTPDecryptedPagesNoQuota`; `TestExportHTTPCreateIdempotency`; `TestExportHTTPMutationsCSRF`; `TestExportHTTPMutationsOrigin`; `TestExportHTTPDecryptedReauth`; `TestExportHTTPStrictEmptyObjectBodies` (R1-02); `TestExportHTTPDownloadCorruptStreamAborts` (R1-01, HTTP thật, snapshot nhiều khung); `TestExportHTTPDownloadErrorLogPrivacy` (R1-03). Fixture dùng River insert-only thật: sub-test audit kiểm đúng 1 audit `meta={}` + 1 `user_notification` + 1 `security_notice_mail` gắn `notification_id`, và replay không tăng (R1-04).
