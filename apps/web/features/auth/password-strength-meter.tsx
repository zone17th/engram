'use client';

import { useTranslations } from 'next-intl';

export type PasswordStrengthLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Local-only password strength estimator (0..4) for account login passwords.
 * Nothing is sent over the network.
 */
export function evaluateAccountPasswordStrength(password: string): PasswordStrengthLevel {
  if (!password) return 0;
  const charCount = Array.from(password).length;
  const byteLength = new TextEncoder().encode(password).length;
  if (charCount < 12 || byteLength > 1024) return 1;

  const uniqueChars = new Set(Array.from(password.toLowerCase())).size;
  if (uniqueChars <= 2) return 1;

  let classes = 0;
  if (/\p{Ll}/u.test(password)) classes += 1;
  if (/\p{Lu}/u.test(password)) classes += 1;
  if (/\p{Nd}/u.test(password)) classes += 1;
  if (/[^\p{L}\p{Nd}]/u.test(password)) classes += 1;

  if (charCount >= 18 && (classes >= 2 || uniqueChars >= 8)) return 4;
  if (charCount >= 14 && (classes >= 2 || uniqueChars >= 7)) return 3;
  if (classes >= 3 && uniqueChars >= 7) return 3;
  return 2;
}

const BAR_COLORS: Record<PasswordStrengthLevel, string> = {
  0: 'var(--border-strong)',
  1: 'var(--error)',
  2: 'var(--warning)',
  3: 'var(--success)',
  4: 'var(--success)',
};

export function PasswordStrengthMeter({
  password,
  id,
  noteId,
}: {
  password: string;
  id?: string;
  noteId?: string;
}) {
  const t = useTranslations('auth.strength');
  const score = evaluateAccountPasswordStrength(password);
  const label = t(`level${score}` as 'level0' | 'level1' | 'level2' | 'level3' | 'level4');
  const valueText = t(
    `valueText${score}` as 'valueText0' | 'valueText1' | 'valueText2' | 'valueText3' | 'valueText4',
  );
  const fillColor = BAR_COLORS[score];

  return (
    <div
      id={id}
      data-testid="password-strength-meter"
      className="mb-4 rounded-md border border-line bg-surface p-3"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-body">{t('label')}</span>
        <span
          className="text-[12px] font-semibold text-body"
          data-meter-label
          aria-live="polite"
        >
          {label}
        </span>
      </div>
      <div
        className="mb-2 grid grid-cols-4 gap-1.5"
        role="meter"
        aria-label={t('label')}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={valueText}
      >
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            data-meter-bar
            data-filled={idx < score ? 'true' : 'false'}
            style={{
              height: '4px',
              borderRadius: 'var(--r-pill)',
              background: idx < score ? fillColor : 'var(--border-strong)',
            }}
          />
        ))}
      </div>
      <p id={noteId} className="m-0 text-[12px] text-muted">
        {t('localNote')}
      </p>
    </div>
  );
}
