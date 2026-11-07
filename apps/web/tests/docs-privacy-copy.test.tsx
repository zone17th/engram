import { act, cleanup, render, screen, within, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsPageContent } from '@/app/(marketing)/[locale]/docs/docs-page-content';
import LandingPage from '@/app/(marketing)/[locale]/page';
import { SiteFooter } from '@/components/landing/site-footer';
import { ThemeProvider } from '@/components/theme-provider';
import { LegalPageContent } from '@/features/auth/legal-page-content';
import { AuthExplainerCompact } from '@/features/auth/auth-explainer';
import { CSRF_COOKIE } from '@/lib/api/csrf';
import en from '../messages/en.json';
import viMessages from '../messages/vi.json';

const mocks = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'vi',
  pathname: '/',
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

function lookupKey(obj: Record<string, unknown>, ns: string | undefined, key: string): string {
  const path = ns ? `${ns}.${key}` : key;
  const val = path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return JSON.stringify(val);
  return path;
}

function lookupRaw(obj: Record<string, unknown>, ns: string | undefined, key: string): unknown {
  const path = ns ? `${ns}.${key}` : key;
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

vi.mock('next-intl/server', () => ({
  setRequestLocale: (locale: string) => {
    mocks.locale = locale === 'vi' ? 'vi' : 'en';
  },
  getLocale: async () => mocks.locale,
  getTranslations: async (arg?: string | { locale?: string; namespace?: string }) => {
    const ns = typeof arg === 'string' ? arg : arg?.namespace;
    const loc = (typeof arg === 'object' && arg?.locale ? arg.locale : mocks.locale) === 'vi' ? 'vi' : 'en';
    const messages = (loc === 'vi' ? viMessages : en) as unknown as Record<string, unknown>;
    const t = (key: string) => lookupKey(messages, ns, key);
    t.raw = (key: string) => lookupRaw(messages, ns, key);
    return t;
  },
}));

function renderInLocale(ui: ReactNode, locale: 'en' | 'vi') {
  const messages = locale === 'vi' ? viMessages : en;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ThemeProvider initialTheme="light" initialLocale={locale}>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locale = 'en';
  mocks.pathname = '/';
  document.cookie = `${CSRF_COOKIE}=; path=/; max-age=0`;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  document.cookie = `${CSRF_COOKIE}=; path=/; max-age=0`;
  vi.unstubAllGlobals();
});

describe('Task 7 docsprivacy — /docs, /vi/docs, privacy/legal truth, FU-T24-ABSCLAIMS, ux-audit P06', () => {
  it('renders /docs (en) with all 7 anchor IDs, PT-01..PT-15 (PT-13 corrected), 8 days backup retention, exact §2.6 quota, semantic default off, and no cross-locale strings', async () => {
    mocks.locale = 'en';
    mocks.pathname = '/docs';
    const ui = await DocsPageContent({ locale: 'en' });
    const { container } = renderInLocale(ui, 'en');

    const main = container.querySelector('main#main-content');
    expect(main).not.toBeNull();

    for (const id of ['batdau', 'rieng-tu', 'tim-kiem', 'khoi-phuc', 'du-lieu', 'gioi-han', 'lien-he']) {
      expect(container.querySelector(`section#${id}`), `missing #${id}`).not.toBeNull();
    }

    const text = container.textContent ?? '';
    // PT-01..PT-03: E2E entry body, separate login/passphrase, password reset does not unlock vault, L-8 untampered code caveat
    expect(text).toContain('XChaCha20-Poly1305');
    expect(text).toContain('has not been tampered with');
    expect(text).toContain('completely separate');
    expect(text).toContain('never unlocks or resets your vault');

    // PT-04..PT-06: plaintext metadata, exact byte size (no padding), send-gate after colon
    expect(text).toContain('exact byte size');
    expect(text).toContain('not padded to hide exact length');
    expect(text).toContain('after name: is never sent');

    // PT-07..PT-08 & §2.10: semantic default off, OpenRouter, turning off stops sending and deletes vectors
    expect(text).toContain('Off by default; you turn it on when you want');
    expect(text).toContain('OpenRouter');
    expect(text).toContain('deletes all vectors for your account');
    expect(text).not.toMatch(/on by default/i);

    // PT-09..PT-12: 3 recovery paths, rewrap without old passphrase, consume=delete/regenerate/rotate 10, passkey PRF/revoke, old backup limit + PITR
    expect(text).toContain('without needing your old passphrase');
    expect(text).toContain('WebAuthn PRF');
    expect(text).toContain('rotate all 10');
    expect(text).toContain('no cryptographic revocation of old snapshots');
    expect(text).toContain('point-in-time recovery (PITR)');

    // PT-13 (corrected per §2.2/2.3/2.6): readable export excludes trash, quota matches §2.6 verbatim
    expect(text).toContain('.sabk.json');
    expect(text).toContain('24 hours');
    expect(text).toContain('Readable exports include active items only and do not include items in the 30-day trash window');
    expect(text).toContain('Each new backup or readable export counts as 1; up to 3 per hour, including cancelled ones.');

    // PT-14..PT-15: 30-day trash, 8-day internal backups, 90-day unlinked audit log, telemetry/cookies/no selling
    expect(text).toContain('30 days');
    expect(text).toContain('8 days');
    expect(text).toContain('90 days');
    expect(text).not.toContain('later release');

    // Locale-aware links & LocaleSwitch
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeInTheDocument();
    const docsThemeBtn = screen.getByRole('button', { name: en.auth.theme.toggle });
    expect(docsThemeBtn).toHaveClass('min-h-11', 'min-w-11');
    const retentionRegion = screen.getByRole('region', { name: en.docs.s5.heading });
    expect(retentionRegion).toHaveAttribute('tabindex', '0');
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('/privacy');
    expect(links).toContain('/terms');
    expect(links).not.toContain('/vi/privacy');

    // No Vietnamese leak on English page
    expect(text).not.toContain('Phần 1');
    expect(text).not.toContain('Tắt mặc định');
  });

  it('renders /vi/docs (vi) with all 7 anchor IDs, PT-01..PT-15 (PT-13 corrected), "8 ngày", exact §2.6 quota, "Tắt mặc định; bạn bật khi muốn", and no cross-locale strings', async () => {
    mocks.locale = 'vi';
    mocks.pathname = '/vi/docs';
    const ui = await DocsPageContent({ locale: 'vi' });
    const { container } = renderInLocale(ui, 'vi');

    expect(container.querySelector('main#main-content')).not.toBeNull();
    for (const id of ['batdau', 'rieng-tu', 'tim-kiem', 'khoi-phuc', 'du-lieu', 'gioi-han', 'lien-he']) {
      expect(container.querySelector(`section#${id}`), `missing #${id}`).not.toBeNull();
    }

    const text = container.textContent ?? '';
    expect(text).toContain('không bị can thiệp');
    expect(text).toContain('Tắt mặc định; bạn bật khi muốn');
    expect(text).not.toContain('mặc định bật');
    expect(text).not.toContain('ở bản phát hành tiếp theo');
    expect(text).toContain('Bản đọc được chỉ gồm các mục đang dùng, không gồm thùng rác');
    expect(text).toContain('Mỗi lần tạo bản sao lưu mới hoặc bản đọc được mới tính 1 lượt; tối đa 3 lượt mỗi giờ, kể cả lượt đã huỷ.');
    expect(text).toContain('30 ngày');
    expect(text).toContain('8 ngày');
    expect(text).toContain('90 ngày');
    expect(text).toContain('24 giờ');

    expect(screen.getByRole('radiogroup', { name: 'Ngôn ngữ' })).toBeInTheDocument();
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('/vi/privacy');
    expect(links).toContain('/vi/terms');
    expect(links).not.toContain('/privacy');

    // No English section headings on Vietnamese page
    expect(text).not.toContain('Section 1');
    expect(text).not.toContain('Get started in three minutes');
  });

  it('renders /privacy, /vi/privacy, /terms with LocaleSwitch, locale-aware /docs link, updated exportDeleteBody, main#main-content, and F-15 back-to-login hiding when signed in', async () => {
    mocks.locale = 'en';
    mocks.pathname = '/privacy';
    const enPrivacy = await LegalPageContent({ locale: 'en', activeSection: 'privacy' });
    const { container: enContainer, unmount: unmountEn } = renderInLocale(enPrivacy, 'en');

    expect(enContainer.querySelector('main#main-content')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeInTheDocument();
    const legalThemeBtn = screen.getByRole('button', { name: en.auth.theme.toggle });
    expect(legalThemeBtn).toHaveClass('min-h-11', 'min-w-11');
    const legalLogoLink = enContainer.querySelector('header a[aria-label="engram"]');
    expect(legalLogoLink?.querySelector('.min-\\[420px\\]\\:inline')).not.toBeNull();
    expect(screen.getByRole('link', { name: en.legal.backToLogin })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.legal.contact.docsCta })).toHaveAttribute('href', '/docs');

    const enText = enContainer.textContent ?? '';
    expect(enText).not.toContain('later release');
    expect(enText).not.toMatch(/on by default/i);
    expect(enText).toContain('8 days');
    expect(enText).toContain('Each new backup or readable export counts as 1; up to 3 per hour, including cancelled ones.');
    unmountEn();

    mocks.locale = 'vi';
    mocks.pathname = '/vi/privacy';
    const viPrivacy = await LegalPageContent({ locale: 'vi', activeSection: 'privacy' });
    const { container: viContainer, unmount: unmountVi } = renderInLocale(viPrivacy, 'vi');

    expect(viContainer.querySelector('main#main-content')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Ngôn ngữ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: viMessages.legal.contact.docsCta })).toHaveAttribute('href', '/vi/docs');

    const viText = viContainer.textContent ?? '';
    expect(viText).not.toContain('ở bản phát hành tiếp theo');
    expect(viText).not.toContain('mặc định bật');
    expect(viText).toContain('8 ngày');
    expect(viText).toContain('Mỗi lần tạo bản sao lưu mới hoặc bản đọc được mới tính 1 lượt; tối đa 3 lượt mỗi giờ, kể cả lượt đã huỷ.');
    unmountVi();

    // F-15: when signed in (hasSession=true or active session cookie), "Back to sign in" / "Về đăng nhập" is hidden
    mocks.locale = 'vi';
    mocks.pathname = '/vi/terms';
    const signedInLegal = await LegalPageContent({ locale: 'vi', activeSection: 'terms', hasSession: true });
    const { unmount: unmountSignedIn } = renderInLocale(signedInLegal, 'vi');
    expect(screen.queryByRole('link', { name: viMessages.legal.backToLogin })).toBeNull();
    unmountSignedIn();

    const termsUi = await LegalPageContent({ locale: 'en', activeSection: 'terms' });
    const sessionPayload = btoa('v1|sess|session-id|1762473600|nonce');
    document.cookie = `${CSRF_COOKIE}=${sessionPayload}.sig; path=/`;
    renderInLocale(termsUi, 'en');
    expect(screen.queryByRole('link', { name: en.legal.backToLogin })).toBeNull();
  });

  it('renders / and /vi landing pages with updated privacy/recovery copy, main#main-content, skip link, 44px touch classes, visible Sign in on mobile, and locale-aware footer links', async () => {
    mocks.locale = 'en';
    mocks.pathname = '/';
    const enLanding = await LandingPage({ params: Promise.resolve({ locale: 'en' }) });
    const { container: enContainer, unmount: unmountEn } = renderInLocale(enLanding, 'en');
    expect(enContainer.querySelector('main#main-content')).not.toBeNull();
    const skipLink = screen.getByRole('link', { name: en.nav.skipToContent });
    expect(skipLink).toHaveAttribute('href', '#main-content');

    // F-05 & F-09: header logo, locale switch items, theme toggle, Sign in, and Create account have min-h-11 min-w-11 and Sign in is not hidden on mobile
    const signInLink = screen.getByRole('link', { name: en.nav.signIn });
    const primaryNav = enContainer.querySelector('nav[aria-label="Primary"]');
    expect(primaryNav).toHaveClass('flex-wrap', 'rounded-2xl', 'sm:rounded-pill');
    expect(signInLink).toHaveClass('min-h-11', 'min-w-11');
    expect(signInLink.className).not.toContain('hidden');

    const group = screen.getByRole('radiogroup', { name: 'Language' });
    const enRadio = within(group).getByRole('radio', { name: 'English (EN)' });
    expect(enRadio).toHaveClass('min-h-11', 'min-w-11');

    // F-10 & F-16: footer has Docs, Privacy Policy, Terms of Service, Contact links with locale-aware hrefs
    const enFooters = enContainer.querySelectorAll('footer');
    const footer = enFooters[enFooters.length - 1]!;
    const footerHrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(footerHrefs).toContain('/docs');
    expect(footerHrefs).toContain('/privacy');
    expect(footerHrefs).toContain('/terms');
    expect(footerHrefs).toContain('/docs#lien-he');

    const enText = enContainer.textContent ?? '';
    expect(enText).toContain(en.landing.plainBody);
    expect(enText).toContain(en.landing.privacyBody2);
    expect(enText).toContain(en.landing.recoveryKeysBody);
    expect(enText).not.toMatch(/on by default/i);
    unmountEn();

    mocks.locale = 'vi';
    mocks.pathname = '/vi';
    const viLanding = await LandingPage({ params: Promise.resolve({ locale: 'vi' }) });
    const { container: viContainer } = renderInLocale(viLanding, 'vi');

    expect(viContainer.querySelector('main#main-content')).not.toBeNull();
    const viFooters = viContainer.querySelectorAll('footer');
    const viFooterEl = viFooters[viFooters.length - 1]!;
    const viFooterHrefs = Array.from(viFooterEl.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(viFooterHrefs).toContain('/vi/docs');
    expect(viFooterHrefs).toContain('/vi/privacy');
    expect(viFooterHrefs).toContain('/vi/terms');
    expect(viFooterHrefs).toContain('/vi/docs#lien-he');

    const viText = viContainer.textContent ?? '';
    expect(viText).toContain(viMessages.landing.plainBody);
    expect(viText).toContain(viMessages.landing.privacyBody2);
    expect(viText).toContain(viMessages.landing.recoveryKeysBody);
    expect(viText).not.toContain('mặc định bật');
  });

  it('qualifies absolute encryption claims (FU-T24-ABSCLAIMS) in auth.explainer.compactEncrypted, auth.signup.privacyNote, and recovery leads', () => {
    expect(en.auth.explainer.compactEncrypted).toMatch(/untampered|tampered/i);
    expect(viMessages.auth.explainer.compactEncrypted).toContain('không bị can thiệp');

    expect(en.auth.signup.privacyNote).toMatch(/untampered|tampered/i);
    expect(viMessages.auth.signup.privacyNote).toContain('không bị can thiệp');

    expect(en.landing.recoveryBody).toMatch(/untampered|tampered/i);
    expect(viMessages.landing.recoveryBody).toContain('không bị can thiệp');

    expect(en.docs.s4.lead).toMatch(/untampered|tampered/i);
    expect(viMessages.docs.s4.lead).toContain('không bị can thiệp');

    const { unmount } = renderInLocale(<AuthExplainerCompact />, 'en');
    expect(screen.getByTestId('auth-explainer-compact')).toHaveTextContent(/untampered/i);
    unmount();

    renderInLocale(<AuthExplainerCompact />, 'vi');
    expect(screen.getByTestId('auth-explainer-compact')).toHaveTextContent('không bị can thiệp');
  });
});
