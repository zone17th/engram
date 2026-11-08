# Bằng chứng nghiệm thu · P06 — Task 7 (`docsprivacy`)

- **Lane:** `docsprivacy` (W1, P06-T7)
- **Branch:** `phase06/docsprivacy` (từ `origin/phase06/beta` `3a5156a`)
- **Mục tiêu:** Triển khai đầy đủ Task 7 của [2026-11-07-P06-beta.md](../../plans/2026-11-07-P06-beta.md) mục 2.2/2.3/2.6/2.10, mục 3 và bảng phân công mục 4.2 (hàng `docsprivacy`).

---

## 1. Bàn giao theo từng mục Task 7

| Hạng mục Task 7 | File đã cập nhật / tạo mới | Trạng thái |
|---|---|---|
| Route SSG `/docs` + `/vi/docs` (`generateStaticParams`, `generateMetadata`) + `docs-page-content.tsx` (`PT-01..PT-15` với `PT-13` bản đã sửa theo mục 2.2/2.3/2.6: bản đọc được không gồm thùng rác, quota đúng câu mục 2.6; tìm theo nghĩa "Tắt mặc định; bạn bật khi muốn" theo mục 2.10; chu kỳ **8 ngày** rời mọi bản sao lưu nội bộ; đủ **7 anchor IDs** `#batdau`, `#rieng-tu`, `#tim-kiem`, `#khoi-phuc`, `#du-lieu`, `#gioi-han`, `#lien-he`) | `apps/web/app/(marketing)/[locale]/docs/page.tsx`, `apps/web/app/(marketing)/[locale]/docs/docs-page-content.tsx`, `apps/web/app/(marketing)/[locale]/docs/docs-client-actions.tsx` | Hoàn tất |
| `legal-page-content.tsx`: thêm `LocaleSwitch`, link `/docs` theo locale (`legal.contact.docsCta`), cập nhật `legal.deletion.exportDeleteBody` (bỏ "ở bản phát hành tiếp theo"; nêu rõ `.sabk.json` 24h chỉ chủ tài khoản tải, bản đọc được giải mã trên máy không gồm thùng rác, xoá tài khoản 2 bước, 30 ngày thùng rác / **8 ngày** mọi bản sao lưu nội bộ / 90 ngày nhật ký kiểm toán đã gỡ liên kết, quota đúng câu mục 2.6), ẩn nút `Về đăng nhập` / `Back to sign in` khi đã có phiên đăng nhập (`F-15`) | `apps/web/features/auth/legal-page-content.tsx`, `apps/web/app/(marketing)/[locale]/docs/docs-client-actions.tsx` | Hoàn tất |
| `landing.*` copy + `FU-T24-ABSCLAIMS`: cập nhật `landing.plainBody` (`name`, `tag`, `hint`, `type`, `size`, `timestamps`, `counts`, `q`), `landing.privacyBody2` (tìm theo nghĩa tắt mặc định; tắt → ngừng gửi ngay + xoá vector trên máy chủ engram), `landing.recoveryKeysBody` (dùng 1 lần trên máy chủ, tạo bù hoặc xoay cả 10 key), bổ sung vế điều kiện `L-8` ("miễn là mã ứng dụng tải về trình duyệt không bị can thiệp" / "as long as the app code delivered to your browser is untampered with") vào `auth.explainer.compactEncrypted`, `auth.signup.privacyNote`, `landing.recoveryBody` và `docs.s4.lead` | `apps/web/messages/en.json`, `apps/web/messages/vi.json` | Hoàn tất |
| `ux-audit` P06 findings: **F-02** (`components/locale-switch.tsx`, `features/auth/locale-sync.tsx`, `i18n/app-locale.ts` đồng bộ `user.locale` ↔ `sabk_locale` khi đổi ngôn ngữ trên phiên đang đăng nhập; thêm `LocaleSwitch` trên trang legal; không sửa `middleware.ts`), **F-05** (vùng chạm `min-h-11 min-w-11` trên `LocaleSwitch` và logo/nút trong `site-header.tsx`), **F-06** (skip link `#main-content` trong `site-header.tsx`, `legal-page-content.tsx`, `docs-page-content.tsx` + `<main id="main-content">` trên `/`, legal, docs), **F-09** (bỏ `hidden sm:inline-flex` trên nút `Đăng nhập`/`Sign in` ở `site-header.tsx` để hiển thị tại 390px), **F-10 & F-16** (footer `site-footer.tsx` có đủ link Tài liệu `/docs`, Chính sách quyền riêng tư `/privacy`, Điều khoản sử dụng `/terms`, Liên hệ `/docs#lien-he` theo đúng locale), **F-15** (ẩn `Về đăng nhập` trên trang legal khi có session) | `apps/web/components/locale-switch.tsx`, `apps/web/features/auth/locale-sync.tsx`, `apps/web/i18n/app-locale.ts`, `apps/web/components/landing/site-header.tsx`, `apps/web/components/landing/site-footer.tsx`, `apps/web/app/(marketing)/[locale]/page.tsx` | Hoàn tất |
| Unit tests & E2E specs | `apps/web/tests/docs-privacy-copy.test.tsx`, `apps/web/tests/locale-switch.test.tsx`, `apps/web/tests/app-locale.test.ts`, `apps/web/e2e/smoke.spec.ts`, `apps/web/e2e/a11y.spec.ts` | Hoàn tất |
| Khắc phục phản hồi `visual-r1` (`BLK-DOCSPRIVACY-01`, `MED-DOCSPRIVACY-02`, `LOW-DOCSPRIVACY-03`) | `apps/web/components/landing/site-header.tsx` (`flex-wrap rounded-2xl sm:rounded-pill` cho nav ở `<640px` để `scrollWidth <= 390` tại `390px` cả `en`/`vi` mà vẫn giữ đủ 6 control `>= 44×44px`), `apps/web/app/(marketing)/[locale]/docs/docs-client-actions.tsx` (`MarketingThemeButton` với `touch-target min-h-11 min-w-11`), `apps/web/app/(marketing)/[locale]/docs/docs-page-content.tsx` (`MarketingThemeButton` + vùng cuộn bảng `#du-lieu` có `tabIndex={0} role="region"` và vệt mờ cuộn ngang trên mobile), `apps/web/features/auth/legal-page-content.tsx` (`MarketingThemeButton` + `<Logo wordmarkClassName="hidden min-[420px]:inline" />`) | Hoàn tất |

---

## 2. Kết quả kiểm thử mục tiêu (Targeted Local Checks)

Chạy từng file đơn lẻ tại `apps/web`:

| Lệnh | Kết quả | Exit code |
|---|---|---|
| `pnpm exec vitest run tests/docs-privacy-copy.test.tsx` | `1 passed (5 tests)` | `0` |
| `pnpm exec vitest run tests/locale-switch.test.tsx` | `1 passed (6 tests)` | `0` |
| `pnpm exec vitest run tests/app-locale.test.ts` | `1 passed (9 tests)` | `0` |
| `pnpm exec vitest run tests/i18n.parity.test.ts` | `1 passed (10 tests)` | `0` |

*(Ghi chú: bộ E2E `e2e/smoke.spec.ts` và `e2e/a11y.spec.ts --grep docs` cùng visual review 390/768/1440 × light/dark × vi/en được bàn giao cho các bước `pi/reviewer_fe`, `pi/tester_visual`, `pi/tester_cloud` theo đúng quy trình điều phối của lane `docsprivacy`.)*
