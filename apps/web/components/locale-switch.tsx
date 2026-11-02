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
  const normalized = pathname || '/';
  const withoutViPrefix =
    normalized === '/vi'
      ? '/'
      : normalized.startsWith('/vi/')
        ? normalized.slice(3)
        : normalized;
  if (targetLocale === 'en') {
    return withoutViPrefix || '/';
  }
  return withoutViPrefix === '/' ? '/vi' : `/vi${withoutViPrefix}`;
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
    if (next === locale) return;
    if (mode === 'landing') {
      router.push(toLandingLocaleHref(pathname, next));
      return;
    }
    if (typeof router.refresh === 'function') {
      router.refresh();
    }
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
      className={cn('seg shrink-0 !flex-nowrap', className)}
      aria-label={t('label')}
    >
      {LOCALE_OPTIONS.map((option) => {
        const isActive = locale === option;
        const label = t(option);
        return (
          <ToggleGroup.Item
            key={option}
            value={option}
            aria-label={label}
            aria-pressed={isActive}
            className="touch-target !px-2 font-semibold text-[13px]"
          >
            {label}
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
