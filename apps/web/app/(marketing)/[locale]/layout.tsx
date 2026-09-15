import type { Metadata } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { fontVariables } from '@/app/fonts';
import { ThemeProvider } from '@/components/theme-provider';
import { routing } from '@/i18n/routing';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'engram',
  description: 'Lưu mọi thứ theo từ khoá bạn tự đặt.',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function MarketingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Bắt buộc để landing render tĩnh (SSG) — P01 yêu cầu TTFB < 200 ms.
  setRequestLocale(locale);

  // `lang={locale}` chứ không phải "en" cố định: `/vi` phục vụ nội dung tiếng
  // Việt, khai báo sai làm screen reader đọc bằng giọng Anh. Đặt được ở đây vì
  // layout này CHÍNH LÀ root layout (không có app/layout.tsx phía trên), nên nó
  // vừa nhận `params.locale` vừa sở hữu thẻ <html>.
  return (
    <html lang={locale} data-theme="light" className={fontVariables}>
      <body className="bg-canvas font-sans text-body antialiased">
        <NextIntlClientProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
