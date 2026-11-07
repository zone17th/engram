'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/theme-provider';
import { readCsrfToken } from '@/lib/api/csrf';

function detectActiveSessionCookie(): boolean {
  try {
    const raw = readCsrfToken();
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    if (typeof atob !== 'function') return false;
    const encoded = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const payload = atob(padded).split('|');
    return payload.length === 5 && payload[0] === 'v1' && payload[1] === 'sess' && payload[2] !== '';
  } catch {
    return false;
  }
}

export function LegalBackToLoginLink({
  label,
  hasSession,
}: {
  label: string;
  hasSession?: boolean;
}) {
  const [signedIn, setSignedIn] = useState<boolean>(() => Boolean(hasSession));

  useEffect(() => {
    if (hasSession !== undefined) {
      setSignedIn(hasSession);
      return;
    }
    if (detectActiveSessionCookie()) {
      setSignedIn(true);
    }
  }, [hasSession]);

  if (signedIn) return null;

  return (
    <Link href="/app/auth/login" className="btn btn-tertiary touch-target min-h-11 min-w-11 !text-body no-underline">
      {label}
    </Link>
  );
}

export function MarketingThemeButton() {
  const { theme, toggle } = useTheme();
  const t = useTranslations('auth.theme');
  const toggleLabel = t('toggle');
  const titleLabel = theme === 'dark' ? t('switchToLight') : t('switchToDark');

  return (
    <button
      type="button"
      className="btn btn-tertiary btn-icon touch-target min-h-11 min-w-11 !px-3"
      onClick={toggle}
      aria-label={toggleLabel}
      title={titleLabel}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
