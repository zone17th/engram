import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MarketingThemeButton } from '@/app/(marketing)/[locale]/docs/docs-client-actions';
import { Logo } from '@/components/landing/logo';
import { LocaleSwitch } from '@/components/locale-switch';

export async function DocsPageContent({ locale }: { locale: string }) {
  const t = await getTranslations('docs');
  const tNav = await getTranslations('nav');
  const tBrand = await getTranslations('brand');
  const tFooter = await getTranslations('footer');
  const homeHref = locale === 'vi' ? '/vi' : '/';
  const termsHref = locale === 'vi' ? '/vi/terms' : '/terms';
  const privacyHref = locale === 'vi' ? '/vi/privacy' : '/privacy';

  return (
    <>
      <div className="mx-auto max-w-container px-5 pt-5">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-line focus:bg-canvas focus:px-4 focus:py-2 focus:font-semibold focus:!text-body"
        >
          {tNav('skipToContent')}
        </a>
        <nav
          className="flex items-center gap-1.5 sm:gap-4 rounded-pill border border-line bg-canvas px-3 sm:px-5 py-2 sm:py-3"
          aria-label="Primary"
        >
          <Link
            href={homeHref}
            aria-label="engram"
            className="touch-target inline-flex min-h-11 min-w-11 shrink-0 items-center no-underline"
          >
            <Logo wordmarkClassName="hidden min-[420px]:inline" />
          </Link>
          <div className="ml-4 hidden items-center gap-1 lg:flex">
            <a
              href="#batdau"
              className="rounded-md px-3 py-2 text-[15px] !text-body no-underline hover:bg-surface"
            >
              {t('topNav.start')}
            </a>
            <a
              href="#rieng-tu"
              className="rounded-md px-3 py-2 text-[15px] !text-body no-underline hover:bg-surface"
            >
              {t('topNav.privacy')}
            </a>
            <a
              href="#khoi-phuc"
              className="rounded-md px-3 py-2 text-[15px] !text-body no-underline hover:bg-surface"
            >
              {t('topNav.recovery')}
            </a>
            <a
              href="#du-lieu"
              className="rounded-md px-3 py-2 text-[15px] !text-body no-underline hover:bg-surface"
            >
              {t('topNav.data')}
            </a>
          </div>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <LocaleSwitch mode="landing" />
            <MarketingThemeButton />
            <Link
              href="/app"
              className="btn btn-primary touch-target min-h-11 min-w-11 !px-3 !text-[14px] no-underline sm:!px-[18px] sm:!text-[15px]"
            >
              {tNav('openApp')}
            </Link>
          </div>
        </nav>
      </div>

      <header className="mx-auto max-w-container px-5 pb-8 pt-14 md:pt-20">
        <div className="max-w-[820px]">
          <p className="t-label mb-3 text-muted">{t('updatedLabel')}</p>
          <h1 className="t-headline-lg mb-5">{t('title')}</h1>
          <p className="t-body-lg m-0 max-w-[65ch] text-muted">{t('lead')}</p>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-container px-5">
        <div className="grid items-start gap-10 pb-20 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t('tocAriaLabel')} className="lg:sticky lg:top-6">
            <p className="t-label mb-3 text-muted">{t('onThisPage')}</p>
            <div className="flex flex-wrap gap-1 text-[14px] lg:flex-col">
              <a
                href="#batdau"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s1')}
              </a>
              <a
                href="#rieng-tu"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s2')}
              </a>
              <a
                href="#tim-kiem"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s3')}
              </a>
              <a
                href="#khoi-phuc"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s4')}
              </a>
              <a
                href="#du-lieu"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s5')}
              </a>
              <a
                href="#gioi-han"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s6')}
              </a>
              <a
                href="#lien-he"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('toc.s7')}
              </a>
            </div>
          </nav>

          <div className="flex min-w-0 flex-col gap-8">
            {/* ===== 1. bắt đầu ===== */}
            <section id="batdau" className="panel p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s1.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('s1.heading')}</h2>
              <div className="flex flex-col gap-4">
                <div className="flex gap-4">
                  <span className="mono pt-0.5 text-[13px] text-muted">01</span>
                  <div className="min-w-0">
                    <p className="m-0 mb-1 text-[15px] font-semibold">{t('s1.step1Title')}</p>
                    <p className="t-body m-0 text-muted">{t('s1.step1Body')}</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <span className="mono pt-0.5 text-[13px] text-muted">02</span>
                  <div className="min-w-0">
                    <p className="m-0 mb-1 text-[15px] font-semibold">{t('s1.step2Title')}</p>
                    <p className="t-body m-0 text-muted">{t('s1.step2Body')}</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <span className="mono pt-0.5 text-[13px] text-muted">03</span>
                  <div className="min-w-0">
                    <p className="m-0 mb-1 text-[15px] font-semibold">{t('s1.step3Title')}</p>
                    <p className="t-body m-0 text-muted">{t('s1.step3Body')}</p>
                  </div>
                </div>
              </div>
            </section>

            {/* ===== 2. riêng tư ===== */}
            <section id="rieng-tu" className="rounded-section bg-deepPanel p-8 text-white md:p-12">
              <p className="t-label mb-2 text-aiCyan">{t('s2.sectionLabel')}</p>
              <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <div>
                  <h2 className="t-title-md mb-4 text-white">{t('s2.heading')}</h2>
                  <p className="t-body-lg mb-4 text-white/[.82]">{t('s2.body1')}</p>
                  <p className="t-body-lg m-0 text-white/[.82]">{t('s2.body2')}</p>
                </div>
                <div className="flex flex-col gap-3">
                  <div className="rounded-xl bg-white/[.07] p-4">
                    <p className="t-label mb-1 text-aiCyan">{t('s2.encLabel')}</p>
                    <p className="t-body m-0 text-white/[.92]">{t('s2.encBody')}</p>
                  </div>
                  <div className="rounded-xl bg-white/[.07] p-4">
                    <p className="t-label mb-1 text-warning">{t('s2.plainLabel')}</p>
                    <p className="t-body m-0 text-white/[.92]">{t('s2.plainBody')}</p>
                  </div>
                  <div className="rounded-xl bg-white/[.07] p-4">
                    <p className="t-label mb-1 text-white">{t('s2.neverLabel')}</p>
                    <p className="m-0 text-[14px] text-white/[.88]">{t('s2.neverBody')}</p>
                  </div>
                  <p className="mono m-0 pt-1 text-[12px] text-white/[.65]">{t('s2.cryptoNote')}</p>
                </div>
              </div>
            </section>

            {/* ===== 3. tìm kiếm & ≈ ===== */}
            <section id="tim-kiem" className="panel p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s3.sectionLabel')}</p>
              <h2 className="t-title-md mb-3">{t('s3.heading')}</h2>
              <p className="t-body-lg mb-5 text-muted">{t('s3.lead')}</p>

              <div className="flex flex-col gap-3">
                <div className="card p-4">
                  <p className="m-0 mb-1 text-[15px] font-semibold">{t('s3.lexicalTitle')}</p>
                  <p className="t-body m-0 text-muted">{t('s3.lexicalBody')}</p>
                </div>

                <div className="card p-4">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">
                    {t('s3.semanticTitle')}{' '}
                    <span className="badge-type ml-1 bg-paleAccent text-accent">
                      {t('s3.semanticBadge')}
                    </span>
                  </p>
                  <p className="t-body m-0 mb-2 text-body">{t('s3.semanticBody1')}</p>
                  <p className="t-body m-0 text-muted">{t('s3.semanticBody2')}</p>
                </div>
              </div>
            </section>

            {/* ===== 4. khôi phục & giới hạn bản sao lưu ===== */}
            <section id="khoi-phuc" className="panel-agent p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s4.sectionLabel')}</p>
              <h2 className="t-title-md mb-3">{t('s4.heading')}</h2>
              <p className="t-body-lg mb-5 text-body">{t('s4.lead')}</p>

              <div className="mb-5 flex flex-col gap-3">
                <div className="rounded-xl bg-canvas p-4">
                  <p className="m-0 mb-1 text-[15px] font-semibold">{t('s4.passkeyTitle')}</p>
                  <p className="t-body m-0 text-muted">{t('s4.passkeyBody')}</p>
                </div>

                <div className="rounded-xl bg-canvas p-4">
                  <p className="m-0 mb-1 text-[15px] font-semibold">{t('s4.deviceTitle')}</p>
                  <p className="t-body m-0 text-muted">{t('s4.deviceBody')}</p>
                </div>

                <div className="rounded-xl bg-canvas p-4">
                  <p className="m-0 mb-1 text-[15px] font-semibold">{t('s4.keysTitle')}</p>
                  <p className="t-body m-0 text-muted">{t('s4.keysBody')}</p>
                </div>
              </div>

              <div className="mb-5 rounded-xl border border-line bg-canvas p-4">
                <p className="m-0 mb-1 text-[15px] font-semibold text-ink">{t('s4.backupLimitTitle')}</p>
                <p className="t-body m-0 text-body">{t('s4.backupLimitBody')}</p>
              </div>

              <div className="rounded-md bg-paleOrange p-4">
                <p className="t-body m-0 text-body">{t('s4.resetNote')}</p>
              </div>
            </section>

            {/* ===== 5. dữ liệu, xuất và xoá tài khoản ===== */}
            <section id="du-lieu" className="panel p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s5.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('s5.heading')}</h2>

              <div className="relative mb-6">
                <div
                  className="card overflow-x-auto p-0"
                  tabIndex={0}
                  role="region"
                  aria-label={t('s5.heading')}
                >
                <table className="w-full min-w-[560px] border-collapse text-[13.5px]">
                  <thead>
                    <tr className="bg-surface">
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('s5.tableColData')}
                      </th>
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('s5.tableColStoredAs')}
                      </th>
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('s5.tableColRetainedUntil')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row1Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row1StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row1RetainedUntil')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row2Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row2StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row2RetainedUntil')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row3Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row3StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row3RetainedUntil')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row4Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row4StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row4RetainedUntil')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row5Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row5StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row5RetainedUntil')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('s5.row6Data')}</td>
                      <td className="p-3 text-muted">{t('s5.row6StoredAs')}</td>
                      <td className="p-3 text-muted">{t('s5.row6RetainedUntil')}</td>
                    </tr>
                  </tbody>
                </table>
                </div>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-px right-px w-8 rounded-r-[inherit] sm:hidden"
                  style={{ background: 'linear-gradient(to left, var(--surface-elevated), transparent)' }}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="card p-5">
                  <p className="m-0 mb-2 text-[15px] font-semibold">{t('s5.exportTitle')}</p>
                  <p className="t-body m-0 mb-2 text-muted">{t('s5.exportEncryptedBody')}</p>
                  <p className="t-body m-0 mb-2 text-muted">{t('s5.exportReadableBody')}</p>
                  <p className="m-0 text-[13px] text-muted">{t('s5.exportQuotaNote')}</p>
                </div>

                <div className="card p-5">
                  <p className="m-0 mb-2 text-[15px] font-semibold">{t('s5.deleteTitle')}</p>
                  <p className="t-body m-0 mb-2 text-muted">{t('s5.resetBody')}</p>
                  <p className="t-body m-0 mb-2 text-muted">{t('s5.deleteBody')}</p>
                  <p className="m-0 text-[13px] text-muted">{t('s5.retentionNote')}</p>
                </div>
              </div>
            </section>

            {/* ===== 6. giới hạn ===== */}
            <section id="gioi-han" className="panel p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s6.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('s6.heading')}</h2>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                <li className="t-body text-body">{t('s6.limitSize')}</li>
                <li className="t-body text-body">
                  {t('s6.limitPlatform')}{' '}
                  <span className="text-[13px] text-muted">{t('s6.limitPlatformDetail')}</span>
                </li>
                <li className="t-body text-body">{t('s6.limitNoSell')}</li>
                <li className="t-body text-body">{t('s6.limitExportQuota')}</li>
              </ul>
            </section>

            {/* ===== 7. liên hệ ===== */}
            <section id="lien-he" className="panel p-6 md:p-10">
              <p className="t-label mb-2 text-accent">{t('s7.sectionLabel')}</p>
              <h2 className="t-title-md mb-3">{t('s7.heading')}</h2>
              <p className="t-body-lg mb-5 text-muted">{t('s7.body')}</p>
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <a
                  href="https://github.com/zone17th/engram/issues"
                  className="btn btn-secondary !whitespace-normal text-center text-[14px] no-underline"
                >
                  <span>{t('s7.issuesCta')}</span>
                </a>
                <a
                  href="https://github.com/zone17th/engram/security/advisories/new"
                  className="btn btn-secondary !whitespace-normal text-center text-[14px] no-underline"
                >
                  <span>{t('s7.advisoriesCta')}</span>
                </a>
                <Link
                  href={privacyHref}
                  className="btn btn-tertiary !whitespace-normal text-center no-underline"
                >
                  <span>{t('s7.privacyCta')}</span>
                </Link>
                <Link
                  href={termsHref}
                  className="btn btn-tertiary !whitespace-normal text-center no-underline"
                >
                  <span>{t('s7.termsCta')}</span>
                </Link>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="mx-auto max-w-container px-5 pb-8">
        <div className="rounded-section bg-darkFooter p-8 text-white md:p-10">
          <div className="flex flex-wrap items-start justify-between gap-8">
            <div className="max-w-[280px]">
              <div className="mb-3">
                <Logo className="text-white" />
              </div>
              <p className="t-caption m-0 text-white/55">{tBrand('tagline')}</p>
            </div>

            <div className="flex flex-wrap gap-12">
              <div>
                <div className="flex flex-col gap-2 text-[15px]">
                  <a href="#rieng-tu" className="no-underline text-white/85">
                    {t('topNav.privacy')}
                  </a>
                  <a href="#tim-kiem" className="no-underline text-white/85">
                    {t('topNav.search')}
                  </a>
                  <a href="#khoi-phuc" className="no-underline text-white/85">
                    {t('topNav.recovery')}
                  </a>
                  <a href="#du-lieu" className="no-underline text-white/85">
                    {t('topNav.data')}
                  </a>
                </div>
              </div>
              <div>
                <div className="flex flex-col gap-2 text-[15px]">
                  <Link href={privacyHref} className="no-underline text-white/85">
                    {tFooter('privacyPolicy')}
                  </Link>
                  <Link href={termsHref} className="no-underline text-white/85">
                    {tFooter('terms')}
                  </Link>
                  <a href="#lien-he" className="no-underline text-white/85">
                    {tFooter('contact')}
                  </a>
                  <Link href="/app" className="no-underline text-white/85">
                    {tNav('openApp')}
                  </Link>
                </div>
              </div>
            </div>
          </div>
          <hr className="my-8 mb-5 h-px border-0 bg-white/12" />
          <p className="t-legal m-0 text-white/55">{tFooter('legal')}</p>
        </div>
      </footer>
    </>
  );
}
