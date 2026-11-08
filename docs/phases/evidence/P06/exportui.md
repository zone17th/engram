# Bằng chứng nghiệm thu P06 — Tasks 12 & 13 (`exportui`)

- **Lane:** `exportui` (P06-T12 + P06-T13)
- **Branch:** `phase06/exportui`
- **Nguồn:** [plan P06](../../../plans/2026-11-07-P06-beta.md) mục 2.5–2.9, 3, 4.2 (`exportui` row), Task 12 & Task 13; `mockups/settings.html` `#dulieu`, `#plainDlg`, `#xoataikhoan`, `#deleteDlg`, `#resetDlg`.

## 1. Bàn giao theo hạng mục Task 12 (U17a: `.sabk.json` backup + Readable Decrypted Export)

| # | Hạng mục Task 12 | File đã cập nhật / tạo mới | Trạng thái |
|---|---|---|---|
| 1 | `EncryptedBackupCard` (`#dulieu` `.sabk.json` — 5 sub-states: `exp-idle`, `exp-preparing`, `exp-ready`, `exp-failed`, `exp-expired` + `exp-limit`, `exp-offline`, details `<details>`) | `apps/web/features/settings/data/encrypted-backup-card.tsx`, `apps/web/features/settings/data/encrypted-backup-card.test.tsx`, `apps/web/lib/api/export.ts`, `apps/web/lib/api/export.test.ts` | Hoàn tất |
| 2 | `ReadableExportDialog` (`#plainDlg` — 7 `pl-*` views: `pl-confirm`, `pl-locked`, `pl-progress`, `pl-done`, `pl-failed`, `pl-reauth-expired`, `pl-too-large`) + client streaming decrypt runner + `POST /audit/export-decrypted` | `apps/web/features/settings/data/readable-export-dialog.tsx`, `apps/web/features/settings/data/decrypted-export-runner.ts`, `apps/web/features/settings/data/readable-export-dialog.test.tsx`, `apps/web/features/settings/data/decrypted-export-runner.test.ts` | Hoàn tất |
| 3 | Offline restore harness `.sabk.json` (100% client-side, `fetch` = 0 calls) + fixtures | `apps/web/features/settings/data/sabk-offline-restore.test.ts`, `apps/web/features/settings/data/__fixtures__/sabk-v1-sample.json` | Hoàn tất |
| 4 | Audit catalog (`entry.import`, `export.encrypted`, `export.decrypted`, `account.delete`) + Settings `#dulieu` / `#xoataikhoan` mount | `apps/web/lib/audit/audit-catalog.ts`, `apps/web/tests/audit-catalog.test.ts`, `apps/web/app/app/settings/page.tsx`, `apps/web/tests/settings-data.test.tsx` | Hoàn tất |

## 2. Bàn giao theo hạng mục Task 13 (U17b: 2-Step Delete Account + Reset Backup + `?deleted=1`)

| # | Hạng mục Task 13 | File đã cập nhật / tạo mới | Trạng thái |
|---|---|---|---|
| 1 | `DangerZoneSection` (`#xoataikhoan`) + `DeleteAccountDialog` (`#deleteDlg` — 6 `del-*` views: `del-s1`, `del-s2`, `del-busy`, `del-failed`, `del-reauth-expired`, `del-done`), focus/keyboard/Escape, OAuth `returnTo=/app/settings?reauth=account.delete#xoataikhoan` | `apps/web/features/settings/data/danger-zone-section.tsx`, `apps/web/features/settings/data/delete-account-dialog.tsx`, `apps/web/features/settings/data/delete-account-dialog.test.tsx`, `apps/web/lib/api/account.ts`, `apps/web/lib/api/account.test.ts` | Hoàn tất |
| 2 | Cleanup local sau `204 DELETE /api/v1/me`: `vault.lock({ broadcast: false, reason: 'logout' })` + `purgeDeviceKeysOnRevoked(user.id)` + `clearPrivateCache()` + `queryClient.clear()` + redirect `/app/auth/login?deleted=1` | `apps/web/features/settings/data/delete-account-dialog.tsx`, `apps/web/features/settings/data/delete-account-dialog.test.tsx` | Hoàn tất |
| 3 | Banner `#login-account-deleted-banner` (`role="status"`) trên `/app/auth/login?deleted=1` + dọn query bằng `history.replaceState` | `apps/web/features/auth/forms/login-form.tsx`, `apps/web/features/settings/data/delete-account-dialog.test.tsx` | Hoàn tất |
| 4 | `ResetVaultDialog` (`#resetDlg`) bước 2 `rst-s2` có nút "Tải bản sao lưu trước" / "Download backup first" đóng dialog, cuộn và focus `#dulieu` (`F-42` / `F-27`) | `apps/web/features/settings/security/vault/reset-vault-dialog.tsx`, `apps/web/features/settings/security/vault/vault-security.test.tsx` | Hoàn tất |
| 5 | Bản dịch `vi` + `en` và E2E `content-export-delete.spec.ts` | `apps/web/messages/vi.json`, `apps/web/messages/en.json`, `apps/web/tests/i18n.parity.test.ts`, `apps/web/e2e/content-export-delete.spec.ts` | Hoàn tất |

## 3. Kiểm chứng đơn vị (Targeted Vitest + Typecheck)

| Lệnh | Nơi chạy | Kết quả | Exit |
|---|---|---|---|
| `pnpm exec vitest run lib/api/export.test.ts` | `apps/web` (local) | 4 passed | `0` |
| `pnpm exec vitest run lib/api/account.test.ts` | `apps/web` (local) | 3 passed | `0` |
| `pnpm exec vitest run features/settings/data/encrypted-backup-card.test.tsx` | `apps/web` (local) | 6 passed | `0` |
| `pnpm exec vitest run features/settings/data/readable-export-dialog.test.tsx` | `apps/web` (local) | 7 passed | `0` |
| `pnpm exec vitest run features/settings/data/decrypted-export-runner.test.ts` | `apps/web` (local) | 6 passed | `0` |
| `pnpm exec vitest run features/settings/data/sabk-offline-restore.test.ts` | `apps/web` (local) | 1 passed | `0` |
| `pnpm exec vitest run features/settings/data/delete-account-dialog.test.tsx` | `apps/web` (local) | 6 passed | `0` |
| `pnpm exec vitest run features/settings/security/vault/vault-security.test.tsx` | `apps/web` (local) | 37 passed | `0` |
| `pnpm exec vitest run tests/settings-data.test.tsx` | `apps/web` (local) | 3 passed | `0` |
| `pnpm exec vitest run tests/audit-catalog.test.ts` | `apps/web` (local) | 6 passed | `0` |
| `pnpm exec vitest run tests/i18n.parity.test.ts` | `apps/web` (local) | 10 passed | `0` |
| `pnpm run typecheck && pnpm run lint` | `apps/web` (local) | 0 errors | `0` |
