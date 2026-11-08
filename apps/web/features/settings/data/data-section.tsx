'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/features/auth/session-provider';
import { EncryptedBackupCard, type EncryptedBackupCardProps } from './encrypted-backup-card';
import {
  READABLE_EXPORT_ACTION,
  ReadableExportDialog,
  type ReadableExportDialogProps,
} from './readable-export-dialog';

export interface DataSectionProps {
  backupCardProps?: Omit<EncryptedBackupCardProps, 'onOpenReadableExport'>;
  readableDialogProps?: Omit<ReadableExportDialogProps, 'open' | 'onOpenChange' | 'returnFocusRef'>;
}

export function DataSection({ backupCardProps, readableDialogProps }: DataSectionProps = {}) {
  const t = useTranslations('settings.data');
  const { reauth } = useSession();
  const [readableOpen, setReadableOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const autoOpenedResumeRef = useRef(false);

  // OAuth re-auth resume (FE-R1-14 / advisor-dec-P06-019):
  // Returning from Google OAuth to `/app/settings?reauth=export.decrypted#dulieu` or holding
  // an active `export.decrypted` grant automatically opens `#plainDlg`.
  useEffect(() => {
    if (autoOpenedResumeRef.current) return;
    const hasQueryResume =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('reauth') === READABLE_EXPORT_ACTION;
    const hasGrantResume = reauth.grant?.action === READABLE_EXPORT_ACTION;

    if (hasQueryResume || hasGrantResume) {
      autoOpenedResumeRef.current = true;
      const defaultTrigger =
        typeof document !== 'undefined'
          ? document.querySelector<HTMLElement>('[data-testid="export-readable-open-btn"]')
          : null;
      if (defaultTrigger) {
        openerRef.current = defaultTrigger;
      }
      setReadableOpen(true);

      if (hasQueryResume && typeof window !== 'undefined' && window.history?.replaceState) {
        const params = new URLSearchParams(window.location.search);
        params.delete('reauth');
        const qs = params.toString();
        window.history.replaceState(
          null,
          '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
        );
      }
    }
  }, [reauth.grant?.action]);

  return (
    <section id="dulieu" aria-labelledby="dulieuTitle">
      <h2 id="dulieuTitle" className="t-title-md mb-1 text-ink">
        {t('heading')}
      </h2>
      <p className="t-body mb-6 text-muted">{t('subtitle')}</p>

      <EncryptedBackupCard
        {...backupCardProps}
        onOpenReadableExport={(opener) => {
          openerRef.current = opener;
          setReadableOpen(true);
        }}
      />

      <ReadableExportDialog
        {...readableDialogProps}
        open={readableOpen}
        onOpenChange={setReadableOpen}
        returnFocusRef={openerRef}
      />
    </section>
  );
}
