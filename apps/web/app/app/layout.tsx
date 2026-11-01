import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { fontVariables } from '@/app/fonts';
import { QueryProvider } from '@/components/query-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { UndoToastProvider } from '@/components/ui/undo-toast';
import { LocaleThemeSync } from '@/features/auth/locale-sync';
import { RouteGuard } from '@/features/auth/route-guard';
import { SessionProvider } from '@/features/auth/session-provider';
import { ReauthMessagesProvider } from '@/features/auth/use-reauth';
import { VaultProvider } from '@/features/vault/vault-provider';
import { resolveAppLocale } from '@/i18n/app-locale';
import { THEME_COOKIE, resolveInitialTheme, themeToDataAttribute } from '@/lib/preferences/cookies';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'engram',
  robots: { index: false, follow: false },
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const locale = await resolveAppLocale();
  const themePref = resolveInitialTheme({
    cookieTheme: cookieStore.get(THEME_COOKIE)?.value ?? null,
  });
  const initialResolved = themePref === 'system' ? 'light' : themeToDataAttribute(themePref);
  const messages =
    locale === 'vi'
      ? (await import('../../messages/vi.json')).default
      : (await import('../../messages/en.json')).default;

  return (
    <html lang={locale} data-theme={initialResolved} className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider initialTheme={themePref} initialLocale={locale}>
            <QueryProvider>
              <UndoToastProvider>
                <ReauthMessagesProvider auth={messages.auth}>
                  <SessionProvider>
                    <VaultProvider silentUnlockOnLoad>
                      <LocaleThemeSync />
                      <RouteGuard>{children}</RouteGuard>
                    </VaultProvider>
                  </SessionProvider>
                </ReauthMessagesProvider>
              </UndoToastProvider>
            </QueryProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
