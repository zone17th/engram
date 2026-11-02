'use client';

/**
 * U16 Settings `#timkiem` — "Tìm gần nghĩa" (`SemanticCard`)
 * per P05 plan mục 2.10, mục 2.11, mục 2.18, mục 2.24 items 4 & 7, and `mockups/settings.html` (#timkiem).
 *
 * Contract:
 * - Bound to `useSemanticSuggestSetting()` (shared with Omnibox `≈`, Task 9).
 * - Switch is non-optimistic: reflects cache (`semanticSuggest`) only; waits for HTTP 200 before flipping.
 * - Server-off (`me === null` or `semanticAvailable === false`): switch is `disabled` + `aria-disabled="true"`,
 *   `aria-checked` reflects stored setting, shows `semanticServerOff`, clicking does nothing (no PATCH).
 * - While `isPending`: switch is disabled/guarded against double clicks.
 * - Copy block: `semanticExternal` true (or absent, defaulted to `true` by hook per 2.24 item 4) renders
 *   `semanticExternalCopy`; `false` renders `semanticSelfHostCopy`; both followed by `semanticEntryNeverSent`.
 * - 409 `semantic_unavailable`: switch stays/reverts to `false` (by hook), renders `semanticEnable409` in
 *   always-mounted `role="status"` node (`#semantic-enable-409`), NO toast.
 * - Other PATCH failures (`errorCode === 'patch_failed'`): renders `semanticSaveFailed` in the `role="status"` node.
 * - Error clears on the next toggle (`clearError()` + `setSemanticSuggest(...)`).
 * - No re-embed button, no index stats, no model name.
 */

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { useSemanticSuggestSetting } from '@/features/omnibox/suggest/use-semantic-suggest-setting';

export function SemanticCard() {
  const t = useTranslations('settings.search');
  const titleId = useId();
  const {
    me,
    semanticSuggest,
    semanticAvailable,
    semanticExternal,
    isPending,
    errorCode,
    isSemanticUnavailableError,
    setSemanticSuggest,
    clearError,
  } = useSemanticSuggestSetting();

  const isServerOff = me === null || !semanticAvailable;
  const isSwitchDisabled = isServerOff || isPending;

  const statusText = isSemanticUnavailableError
    ? t('semanticEnable409')
    : errorCode === 'patch_failed'
      ? t('semanticSaveFailed')
      : '';

  const handleToggle = () => {
    if (isServerOff || isPending) return;
    clearError();
    void setSemanticSuggest(!semanticSuggest);
  };

  return (
    <div
      className="card mb-3 p-5"
      id="timkiem-semantic-card"
      data-testid="settings-semantic-card"
    >
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span
              id={titleId}
              className="text-[15px] font-semibold text-body"
            >
              {t('semanticTitle')}
            </span>
          </div>
          <p className="m-0 text-[13px] text-muted">
            {t('semanticDesc')}
          </p>
        </div>
        <button
          type="button"
          id="timkiem-sem-switch"
          role="switch"
          aria-checked={semanticSuggest}
          aria-labelledby={titleId}
          aria-label={t('semanticTitle')}
          aria-disabled={isSwitchDisabled ? 'true' : undefined}
          aria-busy={isPending || undefined}
          disabled={isSwitchDisabled}
          onClick={handleToggle}
          className={`switch [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:left-1/2 [@media(pointer:coarse)]:before:top-1/2 [@media(pointer:coarse)]:before:h-[44px] [@media(pointer:coarse)]:before:w-[44px] [@media(pointer:coarse)]:before:-translate-x-1/2 [@media(pointer:coarse)]:before:-translate-y-1/2${
            isSwitchDisabled ? ' cursor-not-allowed opacity-45' : ''
          }`}
          data-testid="settings-semantic-switch"
        />
      </div>

      <div
        className="rounded-md bg-surface p-4"
        id={semanticExternal ? 'timkiem-copy-external' : 'timkiem-copy-selfhost'}
        data-testid={
          semanticExternal
            ? 'settings-semantic-copy-external'
            : 'settings-semantic-copy-selfhost'
        }
      >
        <p className="m-0 mb-2 text-[13px] text-body">
          {semanticExternal ? t('semanticExternalCopy') : t('semanticSelfHostCopy')}
        </p>
        <p className="m-0 text-[13px] text-muted">
          {t('semanticEntryNeverSent')}
        </p>
      </div>

      {isServerOff && me !== null ? (
        <p
          id="timkiem-server-off-note"
          className="m-0 mt-3 text-[13px] text-muted"
          data-testid="settings-semantic-server-off"
        >
          {t('semanticServerOff')}
        </p>
      ) : null}

      <p
        id="semantic-enable-409"
        role="status"
        aria-live="polite"
        className={statusText ? 'm-0 mt-3 text-[13px] text-muted' : 'm-0 text-[13px] text-muted'}
        data-testid="settings-semantic-status"
      >
        {statusText}
      </p>
    </div>
  );
}
