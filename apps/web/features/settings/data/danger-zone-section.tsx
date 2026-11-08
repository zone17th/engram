'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export interface DangerZoneSectionProps {
  onOpenDeleteDialog?: (opener: HTMLButtonElement | null) => void;
}

export function DangerZoneSection({ onOpenDeleteDialog }: DangerZoneSectionProps = {}) {
  const t = useTranslations('settings.data.dangerZone');

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
          data-testid="delete-account-open-btn"
          onClick={(e) => onOpenDeleteDialog?.(e.currentTarget)}
        >
          {t('deleteOpenButton')}
        </Button>
      </div>
    </section>
  );
}
