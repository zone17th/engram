# P06 — Hoàn thiện và phát hành beta MVP

> Kế hoạch · MVP 6/6 · Phụ thuộc: [P01](P01-foundation.md)–[P05](P05-search.md) đạt gate.
> Nguồn: [SPEC](../SPEC.md) §3.11, §7.7–§7.8, §9 exports, §10, §11.

## Mục tiêu và đầu ra

Bản beta dùng được với dữ liệu thật, đủ toàn bộ MVP: auth, vault/passkey/RK/DevKey, Item/Tag/text/JSON, lexical+semantic, encrypted/decrypted export và vận hành có backup/restore. Không bàn giao bản chỉ mô phỏng các nút Settings hoặc copy privacy chưa đúng với thực tế.

P06 là tích hợp/release, không là nơi trì hoãn validation, tenant checks, crypto review, UI errors hay a11y của các phase trước.

## Phạm vi

- Export encrypted snapshot qua server job; decrypted JSON bằng client, cảnh báo + re-auth, progress/cancel/failure/download.
- Xoá tài khoản có re-auth, confirmation và retention/audit đúng spec; phân biệt reset vault giữ item/tag với account delete xoá account data.
- Landing/docs/privacy/help cho en/vi, giải thích plaintext metadata, recovery/revoke/backup limitations và semantic toggle. Giữ [landing.html](../../mockups/landing.html), không thêm pricing.
- Rà U1–U20 và các trạng thái còn thiếu, responsive/light-dark/keyboard/axe/contrast, network/offline/error handling, loading performance.
- Logging/metrics/traces/alerts, secrets/deployment/CSP/proxy/HTTPS, Postgres backups/PITR, restore rehearsal và release/rollback runbooks.
- Review/pentest và các required checks của repo trước beta/GA theo scope công bố; không dùng từ "audited" chỉ vì đã chạy scanner.

Ngoài phạm vi: import backup UI, rotate VK, media, passkey login, share hay extension. P07/P08 chưa triển khai không chặn MVP.

## UI và export contract

U17 dựa [settings.html](../../mockups/settings.html) `#dulieu`. Trước code bổ sung lựa chọn encrypted/decrypted, progress, download lỗi/hết hạn và delete account confirmation vào file đó. U20 đã có [docs.html](../../mockups/docs.html); P06 rà lại copy privacy cho khớp hành vi thật rồi rà đủ [states.html](../../mockups/states.html), sau đó cập nhật §7.0/mockups README.

| Export | Yêu cầu |
|---|---|
| Encrypted `.sabk.json` | Server chỉ cần session/quyền user, không cần VK; snapshot nhất quán của item/tag/item_tag và ciphertext+envelope+IDs. Khối vault phải đủ để mở lại snapshot mà không cần live server: `vault_key_id`, `version`, **`kdf` (tham số Argon2id + salt), `wrapK`, cặp public key, `wrapP`**; các hàng RK gồm `lookup_hash` + wrap (không plaintext); các passkey wrap gồm `cred_id`, `prf_salt`, `vk_wrap`, `pubkey`; kèm manifest version/time (§3.11) |
| Decrypted JSON | Client unlock + re-auth, fetch ciphertext theo page và decrypt local; body text và body JSON được lưu **dưới dạng chuỗi gốc** kèm type để không mất số/key trùng/order khi đóng gói |
| Snapshot | Quy định deleted/purged content rõ trong manifest; baseline gồm active + soft-deleted chưa purge với tombstone, không gồm dữ liệu đã purge; docs/UI mô tả đúng |
| Download | Owner authorization ở create/status/download; output expiry, storage cleanup và cancel/error; không public bucket/link đoán được |
| Memory | Không load toàn vault vào memory chỉ để xuất; page/stream/batch và progress, có fallback browser được kiểm thử; không đưa plaintext lên server làm fallback |

Chốt schema file versioned và sample fixture trước implementation, dùng ciphertext fixtures để thử khôi phục bằng tool/test trước khi có import UI P07. Với snapshot đổi giữa lúc export, dùng snapshot ID/transaction hoặc equivalent consistent capture; không ghép entry trước reset với vault sau reset. Decrypted export kiểm tra key_id/version snapshot, abort nếu không còn key đọc được; lock/logout/cancel xoá buffer/object URL/draft tạm.

Endpoint owner: `POST /exports`, `GET /exports/{id}`, download/cancel semantics và `POST /audit/export-decrypted`; bổ sung `/me` delete/account removal contract vào §9/OpenAPI. Rate limit thuộc phase này theo §9.1: export **3/giờ/user**, đếm cả job bị huỷ giữa chừng để không lách bằng cancel liên tục. Server không chứng minh client đã decrypt xong; audit ghi intent/result phù hợp, không coi client event là bằng chứng mật mã.

## Vận hành và bảo mật

- Production domain tạm `key.zone17th.click`, TLS nginx `/` → web, `/api` → Go. Chốt RP/origin/WebAuthn và cookie cùng domain. Dev/local không được quảng cáo như bản production đã deploy.
- TEI/DB/metrics chỉ nội bộ hoặc endpoint vận hành có access control; proxy log không raw q/body. CSP/nonce/WASM/worker/fonts/connect-src và OAuth/CAPTCHA config chạy được thực tế, không copy CSP mẫu khiến luồng auth hỏng.
- Error telemetry chỉ metadata đã scrub; thử nội dung canary bí mật để kiểm tra network/log/Sentry không có body/RK/passphrase. Export download URL và token không xuất hiện trong log.
- Backup WAL/base hàng ngày/PITR 7 ngày, encrypted at rest. RPO ≤15 phút, RTO ≤2 giờ là mục tiêu phải đo qua rehearsal trên môi trường tương đương.
- Restore runbook có session/re-auth revoke, rollback RK/passkey revocation warning, DB migrations và secret/config/key_id consistency. Không hứa PITR duy trì trạng thái consume mới hơn snapshot.
- Crypto/envelope ADR + review hai người theo §11.4 phải có bằng chứng; PRF authenticator/browser compatibility có smoke test thật, không chỉ virtual mock. Nếu thiếu thì ghi blocker tương ứng, không đánh dấu pass.
- Release artifacts: image/runtime pins, SBOM, bundle manifest, migration sequence, rollback plan tương thích dữ liệu; branding domain/trademark chưa tra không được ghi đã xác nhận.

## File và trình tự

File dự kiến: `apps/api/internal/export/**`, jobs/storage adapter, account-deletion handler, `apps/web/features/export/**`, `features/settings/data/**`, marketing docs/routes/messages, `infra/nginx/**`, backup/monitoring config, `docs/runbooks/**`, `docs/privacy/**`, `docs/phases/evidence/P06.md`.

1. Freeze MVP contract checklist, xác nhận gate P01–P05 và mockup/copy lệch đã đóng.
2. Chốt export/account deletion schema/route rồi implement và chạy snapshot/ownership/cancel tests.
3. Hoàn tất docs/privacy và state coverage, cross-browser/mobile/axe/performance.
4. Review/pentest, fix finding rồi verify; chuẩn bị deploy environment và secrets qua config.
5. Restore/rollback rehearsal trên staging, kiểm tra provider OAuth/PRF/email thật; tổng hợp release evidence và triển khai beta theo phạm vi được giao khi thực hiện phase.

## Acceptance và release gate

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P06-A1 | Full E2E | Signup → 10 RK → passkey optional → quick-add → JSON edit → máy mới unlock → search → export; en/vi |
| P06-A2 | Encrypted export | Snapshot có đủ `kdf`, `wrapK`, pubkeys, `wrapP`, RK rows và passkey wraps theo §3.11; mở lại được **chỉ bằng file + passphrase** trên máy không có session, sau khi live server đã rotate hoặc consume các wrap tương ứng; concurrent reset không tạo snapshot hỏng |
| P06-A3 | Decrypted export | JSON large-number/duplicate-key giữ raw string; re-auth/cancel/lock đúng, plaintext không upload |
| P06-A4 | Delete/reset khác nhau | Account delete xoá data và revoke access; reset giữ item/tag; audit retention 90 ngày theo policy, backup limits được nói rõ |
| P06-A5 | UI chất lượng | U1–U20 có owner, khớp mockup và không còn nút toast giả; visual 390/768/1440, light/dark, keyboard/axe không còn blocker |
| P06-A11 | Rate limit export | Job thứ 4 trong một giờ bị từ chối kèm thời điểm thử lại; huỷ job rồi tạo lại vẫn tính vào hạn mức; job đang chạy không bị mất khi chạm hạn |
| P06-A6 | NFR | Search report P05, G1 quick-add, landing TTFB <200 ms và app LCP <2 s theo profile §10.1; ghi môi trường/phương pháp |
| P06-A7 | Security | Required crypto review/PRF/OAuth checks hoàn tất; secrets/log canary/tenant/export access/CSP/CSRF tests pass; không blocker còn mở |
| P06-A8 | DR | Restore rehearsal có RPO/RTO đo được và data verify; runbook không dựa vào reset vault |
| P06-A9 | Release | Staging smoke, deploy+rollback rehearsal, observability alert và runbook có owner; config/image pins ghi lại |
| P06-A10 | Coverage | Mọi US1–US17 và acceptance bắt buộc P01–P06 có evidence, optional sau MVP được ghi riêng |

Chỉ gọi **beta MVP hoàn tất** khi toàn bộ các điều kiện bắt buộc đạt. Chạy được local là cột mốc khác; thiếu deploy credentials, hardware PRF, crypto reviewer hoặc restore evidence phải được nêu là giới hạn chưa hoàn tất, không tự bỏ gate.
