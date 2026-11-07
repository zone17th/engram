# Bằng chứng nghiệm thu — P06 · Task 2 (`exportbe`)

> Lane `exportbe` (W1, P06-T2) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) mục 2.1–2.8, mục 3, mục 4.2 và Task 2.

## 1. Bàn giao theo từng mục Task 2

| Hạng mục Task 2 | File đã cập nhật / tạo mới | Trạng thái |
|---|---|---|
| Queries `export.sql` → `export.sql.go` | `apps/api/internal/db/queries/export.sql`, `apps/api/internal/db/gen/export.sql.go` | Hoàn tất: `CreateExportJob`, `GetActiveExportJobForUpdate`, `GetLatestExportJob`, `GetExportJobForOwner`, `ClaimExportJob`, `GetExportJobClaimState`, `ReleaseExportLease`, `RenewExportLease`, `FinalizeExportReady` + `ExpireReplacedExports`, `FailExportAttempt`, `CancelExportJob`, `UpdateExportProgress`, `ListStaleRunningExports`, `MarkExportWorkerLost`, `ExportTagsBatch`/`ExportItemsBatch`/`ExportItemTagsBatch`/`ExportEntriesBatch`. Không có query phục vụ `decrypted-pages` (R2-02). |
| `export.Service` (`Create`, `Cancel`, `Latest`, `Get`, `OpenDownload`, `RecordDecryptedAudit`) | `apps/api/internal/export/service.go`, `apps/api/internal/compose/export.go` | Hoàn tất: thứ tự `Create` mục 2.4 (`EXPORT_CREATE_PAUSED` → idempotency → advisory lock → coalesce chỉ `queued`/`running` → `ConsumeTx(ScopeExportCreate)` → `INSERT export_job` → River `InsertTx` cùng tx); `Latest` map `ready` quá hạn → `expired`; `Cancel` ghi `export_file_cleanup`; `OpenDownload` stream `ENGX1`. |
| At-rest `ENGX1` frame codec & layout fixture | `apps/api/internal/export/atrest.go`, `apps/api/internal/export/atrest_test.go`, `apps/api/internal/export/testdata/engx1_layout.bin` | Hoàn tất: header 53 B (`ENGX\x01 ‖ nonce_prefix 16 B ‖ job_id 16 B ‖ attempt_id 16 B`), khung `uint32_be(ct_len) ‖ final_flag ‖ ciphertext`, HKDF-SHA256 `engram/export-at-rest/v1`, XChaCha20-Poly1305, kiểm `ct_len ∈ [16, 65552]` và `flag ∈ {0,1}` trước cấp phát, từ chối khung không-final rỗng / truncate / reorder / append / header lệch. |
| River worker `export_encrypted`, `export_file_cleanup`, `export_prune` (15m) | `apps/api/internal/export/worker.go`, `apps/api/internal/export/prune_job.go`, `apps/api/internal/worker/worker.go`, `apps/api/internal/worker/worker_test.go` | Hoàn tất: claim CAS → nhánh 0 hàng (`JobCancel` terminal / `JobSnooze` lease sống) → snapshot `REPEATABLE READ READ ONLY` → stream `ENGX1` từng lô + renew lease + tiến độ → Finalize CAS (`app_user FOR SHARE` → `vault FOR SHARE` → `export_job FOR UPDATE`, kiểm `vault_key_id`, expire `ready` cũ cùng tx) → audit `export.encrypted` + `security_notice`; lỗi attempt nhả lease CAS; reconciler `worker_lost`. |
| Fixture `.sabk.json` v1 từ `js-v1.json` & Offline Restore (`P06-A2`) | `apps/api/internal/export/testdata/sabk_v1_sample.sabk.json`, `apps/api/internal/export/sabk_restore_test.go` | Hoàn tất: sinh từ `packages/crypto-vectors/vectors/js-v1.json`, qua `vault.ValidateVaultKeyID` (`vk:AAECAwQFBgcICQoLDA0ODw`), `vault.ValidateEnvelopeStruct`, `wrapP` 105 B; chứng minh mở lại `VK`, seed `wrapP` và toàn bộ `entries` chỉ bằng file + passphrase / RK / PRF output. |
| `DecryptedPages` đọc độc quyền từ file `.sabk.enc` (`P06-A3`, R2-02) | `apps/api/internal/export/decrypted_pages.go`, `apps/api/internal/export/service_test.go` | Hoàn tất: đọc qua `ENGX1` reader + `json.Decoder.Token`/offset, lọc `deleted_at IS NULL`, trả trang ≤ 1 MiB + cursor HMAC (`engram/export-cursor/v1` ràng buộc `user_id ‖ job_id ‖ attempt_id ‖ section ‖ ordinal`); pgx tracer chứng minh chỉ query `export_job`. |
| `DELETE /vault` huỷ job & ghi cleanup trong tx reset | `apps/api/internal/vault/reset.go`, `apps/api/internal/vault/reset_test.go` | Hoàn tất: khoá `app_user FOR UPDATE` → `vault FOR UPDATE` → `CancelUserExportJobs` + `InsertExportFileCleanup` (`reason='reset'`) trong cùng transaction reset. |

## 2. Kết quả kiểm tra

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Snapshot `.sabk.json` & Offline Restore (`P06-A2`) | `go test -v -race -run 'TestExportEncrypted\|TestSabkOfflineRestore\|TestExportFinalizeCASKeepsAtomic\|TestExportPeakMemory' ./internal/export` | PASS (`HeapInuse` delta `1.31 MiB <= 16 MiB` cho 2 000 × 256 KiB entries; `EXPORTBE_EXIT=0`) |
| Lease/retry/rescue (C04) | `go test -v -race -run 'TestExportClaimSnoozeWhileLeaseLive\|TestExportAttemptErrorReleasesLease\|TestExportLateOldAttemptCannotOverwrite\|TestExportTerminalNeverRevived\|TestExportReconcilerWorkerLost' ./internal/export` | PASS |
| Quota + coalesce (`P06-A11`, R2-04) | `go test -v -race -run 'TestExportCreateRateLimit\|TestExportCreateCoalesceActiveOnly\|TestExportCreateReadyNotCoalesced\|TestExportCreatePaused' ./internal/export` | PASS |
| At-rest `ENGX1` (`P06-A7`) | `go test -v -run 'TestAtRestENGX1' ./internal/export` | PASS (10/10 sub-tests) |
| Decrypted pages snapshot (`P06-A3`, R2-02) | `go test -v -run 'TestExportDecryptedPages' ./internal/export` | PASS |
| Cleanup worker & Reset integration | `go test -v -race -run 'TestExportFileCleanupWorker' ./internal/export` + `go test -v -race -run 'TestResetCancelsExportJobsAndRecordsCleanup' ./internal/vault` | PASS |
