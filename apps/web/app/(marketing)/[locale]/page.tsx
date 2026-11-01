import Link from 'next/link';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { HeroDemo } from '@/components/landing/hero-demo';
import { JsonTable } from '@/components/landing/json-table';
import { SiteHeader } from '@/components/landing/site-header';
import { SiteFooter } from '@/components/landing/site-footer';
import { LANDING_ROUTER_JSON } from '@/components/landing/landing-fixtures';

// Landing phải là SSG để đạt TTFB < 200 ms (Global Constraints).
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('landing');
  const tNav = await getTranslations('nav');
  const wallTags = t.raw('wallTags') as string[];

  return (
    <>
      <SiteHeader />

      {/* hero — theo mockups/landing.html: tiêu đề hai dòng cùng màu ink, rồi panel demo (UIA-5) */}
      <section className="max-w-container mx-auto px-5 pb-6 pt-16 md:pt-24">
        <div className="max-w-[1000px]">
          <h1 className="t-hero mb-5">
            {t('heroTitle')}
            <br />
            {t('heroTitleSecond')}
          </h1>
          <p className="t-body-lg max-w-[62ch] text-muted">{t('heroSub')}</p>
        </div>
      </section>

      <section className="max-w-container mx-auto px-5 pb-16">
        <HeroDemo />
      </section>

      {/* tường từ khoá */}
      <section className="max-w-container mx-auto px-5 pb-20">
        <h2 className="t-title-md mb-1">{t('wallTitle')}</h2>
        <p className="t-body-lg mb-7 text-muted">{t('wallSub')}</p>
        <div className="flex flex-wrap gap-2">
          {wallTags.map((tag) => (
            // 40px như chip mono của mockup (16px × 1.375 + 2×8px + viền); min-h giữ mốc đó (UIA-5).
            <span key={tag} className="chip chip-lg min-h-10">
              {tag}
            </span>
          ))}
        </div>
      </section>

      {/* JSON như bảng */}
      <section id="cachdung" className="max-w-container mx-auto px-5 pb-20">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div className="lg:pt-6">
            <h2 className="t-title-md mb-3">{t('jsonTitle')}</h2>
            <p className="t-body-lg mb-4 text-muted">{t('jsonBody')}</p>
            <p className="t-body text-muted">{t('jsonNote')}</p>
          </div>
          <JsonTable
            data={LANDING_ROUTER_JSON}
            title={t('jsonCardTitle')}
            labels={{ table: t('jsonViewTable'), raw: t('jsonViewRaw') }}
          />
        </div>
      </section>

      {/* riêng tư */}
      <section id="riengtu" className="max-w-container mx-auto px-5 pb-20">
        <div className="rounded-section bg-deepPanel p-8 text-white md:p-12">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div>
              <h2 className="t-title-md mb-4 text-white">{t('privacyTitle')}</h2>
              <p className="t-body-lg mb-4 text-white/70">{t('privacyBody1')}</p>
              <p className="t-body-lg m-0 text-white/70">{t('privacyBody2')}</p>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-xl bg-white/[.06] p-4">
                <p className="t-label mb-1 text-aiCyan">{t('encLabel')}</p>
                <p className="t-body m-0 text-white/[.86]">{t('encBody')}</p>
              </div>
              <div className="rounded-xl bg-white/[.06] p-4">
                <p className="t-label mb-1 text-warning">{t('plainLabel')}</p>
                <p className="t-body m-0 text-white/[.86]">{t('plainBody')}</p>
              </div>
              <p className="mono m-0 pt-1 text-[12px] text-white/45">{t('cryptoNote')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* khôi phục */}
      <section id="khoiphuc" className="max-w-container mx-auto px-5 pb-20">
        <div className="panel-agent p-8 md:p-12">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <h2 className="t-title-md mb-3">{t('recoveryTitle')}</h2>
              <p className="t-body-lg m-0">{t('recoveryBody')}</p>
            </div>
            <div className="flex flex-col gap-2.5">
              {(
                [
                  ['recoveryKeysTitle', 'recoveryKeysBody'],
                  ['recoveryPasskeyTitle', 'recoveryPasskeyBody'],
                  ['recoveryDeviceTitle', 'recoveryDeviceBody'],
                ] as const
              ).map(([titleKey, bodyKey]) => (
                <div key={titleKey} className="rounded-xl bg-canvas p-4">
                  <p className="m-0 mb-1 text-[15px] font-semibold">{t(titleKey)}</p>
                  <p className="t-body m-0 text-muted">{t(bodyKey)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-container mx-auto px-5 pb-20">
        <div className="py-12 text-center">
          <h2 className="t-headline-md mb-4">{t('cta')}</h2>
          <p className="t-body-lg mx-auto mb-8 max-w-[52ch] text-muted">{t('ctaBody')}</p>
          {/* Nút CTA theo mockups/landing.html: "Tạo tài khoản" mở trang đăng ký thật (audit UIA-6). */}
          <Link
            href="/app/auth/signup"
            className="btn btn-primary no-underline !px-7 !py-4 !text-[16px]"
          >
            {tNav('signUp')}
          </Link>
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
