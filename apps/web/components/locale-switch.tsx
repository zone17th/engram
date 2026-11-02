'use client';

import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/cn';
import { setPreferenceCookies } from '@/lib/preferences/cookies';

export type SupportedLocale = 'en' | 'vi';

const LOCALE_OPTIONS: ReadonlyArray<SupportedLocale> = ['en', 'vi'];

export function toLandingLocaleHref(pathname: string, targetLocale: SupportedLocale): string {
  const raw = pathname || '/';
  const match = /^([^?#]*)(.*)$/.exec(raw);
  const pathPart = match?.[1] || '/';
  const suffix = match?.[2] ?? '';

  let withoutLocalePrefix = pathPart;
  if (pathPart === '/vi' || pathPart === '/en') {
    withoutLocalePrefix = '/';
  } else if (pathPart.startsWith('/vi/') || pathPart.startsWith('/en/')) {
    withoutLocalePrefix = pathPart.slice(3);
  }

  const basePath =
    targetLocale === 'en'
      ? withoutLocalePrefix || '/'
      : withoutLocalePrefix === '/'
        ? '/vi'
        : `/vi${withoutLocalePrefix}`;

  return `${basePath}${suffix}`;
}

export function LocaleSwitch({
  mode = 'refresh',
  className,
}: {
  mode?: 'refresh' | 'landing';
  className?: string;
}) {
  const locale = (useLocale() === 'vi' ? 'vi' : 'en') as SupportedLocale;
  const t = useTranslations('localeSwitch');
  const { theme } = useTheme();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  const handleSelect = (next: SupportedLocale) => {
    setPreferenceCookies(next, theme);
    if (mode === 'landing') {
      const suffix =
        typeof window !== 'undefined' && !pathname.includes('?') && !pathname.includes('#')
          ? `${window.location.search}${window.location.hash}`
          : '';
      router.push(toLandingLocaleHref(`${pathname}${suffix}`, next));
      return;
    }
    router.refresh();
  };

  return (
    <ToggleGroup.Root
      type="single"
      value={locale}
      onValueChange={(next) => {
        if (next === 'en' || next === 'vi') {
          handleSelect(next);
        }
      }}
      className={cn('seg shrink-0 !flex-nowrap !p-0.5 sm:!p-[3px]', className)}
      aria-label={t('label')}
    >
      {LOCALE_OPTIONS.map((option) => {
        const shortLabel = t(option);
        const ariaLabel = option === 'en' ? t('enAria') : t('viAria');
        return (
          <ToggleGroup.Item
            key={option}
            value={option}
            aria-label={ariaLabel}
            lang={option}
            className="touch-target !px-1.5 sm:!px-2 font-semibold text-[13px]"
          >
            {shortLabel}
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
