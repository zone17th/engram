'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { Segmented } from '@/components/ui/segmented';

export function AuthChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const t = useTranslations('auth');
  const showSwitch = pathname === '/app/auth/login' || pathname === '/app/auth/signup';
  const isResetRoute = pathname === '/app/auth/reset-password';
  const isWideLayout = showSwitch;

  return (
    <>
      <header className="mx-auto flex max-w-container items-center gap-4 px-5 pt-6">
        {isResetRoute ? (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- ADR 0006 §6.2 requires hard navigation on /app/auth/reset-password */
          <a href="/" className="flex items-center gap-2.5 text-ink no-underline" aria-label="engram">
            <Logo />
          </a>
        ) : (
          <Link href="/" className="flex items-center gap-2.5 text-ink no-underline" aria-label="engram">
            <Logo />
          </Link>
        )}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main
        className={
          isWideLayout
            ? 'mx-auto max-w-[960px] px-5 pb-24 pt-10'
            : 'mx-auto max-w-[560px] px-5 pb-24 pt-10'
        }
      >
        {showSwitch && (
          <Segmented
            className="mb-7 flex-wrap"
            ariaLabel={`${t('nav.login')} / ${t('nav.signup')}`}
            value={pathname === '/app/auth/signup' ? 'signup' : 'login'}
            onChange={(next) => router.push(next === 'signup' ? '/app/auth/signup' : '/app/auth/login')}
            options={[
              { value: 'login', label: t('nav.login') },
              { value: 'signup', label: t('nav.signup') },
            ]}
          />
        )}
        {children}
      </main>
    </>
  );
}
