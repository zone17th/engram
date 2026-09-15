import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { fontVariables } from '@/app/fonts';
import { QueryProvider } from '@/components/query-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { APP_LOCALE } from '@/i18n/app-locale';
import '@/app/globals.css';

// App riêng tư: không index, không SSR body người dùng (P01 §UI và route).
export const metadata: Metadata = {
  title: 'engram',
  robots: { index: false, follow: false },
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Một nguồn duy nhất cho locale của /app: `lang` và provider không được lệch.
  // Middleware i18n cố ý không chạm /app nên không có locale từ URL ở đây;
  // P02 đọc locale từ hồ sơ người dùng và thay APP_LOCALE.
  const messages = await getMessages({ locale: APP_LOCALE });
  return (
    <html lang={APP_LOCALE} data-theme="light" className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <NextIntlClientProvider locale={APP_LOCALE} messages={messages}>
          <ThemeProvider>
            <QueryProvider>{children}</QueryProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
