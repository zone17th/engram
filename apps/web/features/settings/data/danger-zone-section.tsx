'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DELETE_ACCOUNT_ACTION,
  DeleteAccountDialog,
  type DeleteAccountDialogProps,
} from './delete-account-dialog';

export interface DangerZoneSectionProps {
  onOpenDeleteDialog?: (opener: HTMLButtonElement | null) => void;
  deleteDialogProps?: Omit<DeleteAccountDialogProps, 'open' | 'onOpenChange' | 'returnFocusRef'>;
}

export function DangerZoneSection({
  onOpenDeleteDialog,
  deleteDialogProps,
}: DangerZoneSectionProps = {}) {
  const t = useTranslations('settings.data.dangerZone');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [openedViaResume, setOpenedViaResume] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const autoOpenedResumeRef = useRef(false);

  // OAuth re-auth resume (Task 13):
  // Returning from Google OAuth to `/app/settings?reauth=account.delete#xoataikhoan`
  // automatically opens `#deleteDlg` at `del-s2` once and strips the query parameter.
  useEffect(() => {
    if (autoOpenedResumeRef.current) return;
    const hasQueryResume =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('reauth') === DELETE_ACCOUNT_ACTION;

    if (hasQueryResume) {
      autoOpenedResumeRef.current = true;
      const defaultTrigger =
        typeof document !== 'undefined'
          ? document.querySelector<HTMLElement>('[data-testid="delete-account-open-btn"]')
          : null;
      if (defaultTrigger) {
        openerRef.current = defaultTrigger;
      }
      setOpenedViaResume(true);
      setDeleteOpen(true);

      if (typeof window !== 'undefined' && window.history?.replaceState) {
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
  }, []);

  return (
    <section id="xoataikhoan" aria-labelledby="xoaTitle">
      <h2 id="xoaTitle" className="t-title-md mb-4 text-error-ink">
        {t('heading')}
      </h2>
      <div className="card card-error p-5">
        <div className="mb-1 text-[15px] font-semibold text-body">{t('deleteTitle')}</div>
        <p className="m-0 mb-4 text-[13px] text-body">{t('deleteBody')}</p>
        <Button
          type="button"
          variant="danger"
          data-open-dialog="deleteDlg"
          data-testid="delete-account-open-btn"
          onClick={(e) => {
            openerRef.current = e.currentTarget;
            setOpenedViaResume(false);
            setDeleteOpen(true);
            onOpenDeleteDialog?.(e.currentTarget);
          }}
        >
          {t('deleteOpenButton')}
        </Button>
      </div>

      <DeleteAccountDialog
        {...deleteDialogProps}
        open={deleteOpen}
        onOpenChange={(nextOpen) => {
          setDeleteOpen(nextOpen);
          if (!nextOpen) {
            setOpenedViaResume(false);
          }
        }}
        returnFocusRef={openerRef}
        resume={deleteDialogProps?.resume ?? openedViaResume}
      />
    </section>
  );
}
