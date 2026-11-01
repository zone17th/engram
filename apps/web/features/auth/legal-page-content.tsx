import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';

export async function LegalPageContent({
  locale,
  activeSection,
}: {
  locale: string;
  activeSection: 'terms' | 'privacy';
}) {
  const t = await getTranslations('legal');
  const homeHref = locale === 'vi' ? '/vi' : '/';
  const termsHref = locale === 'vi' ? '/vi/terms' : '/terms';
  const privacyHref = locale === 'vi' ? '/vi/privacy' : '/privacy';

  return (
    <>
      <header className="mx-auto flex max-w-container flex-wrap items-center gap-3 px-5 pt-6">
        <Link href={homeHref} className="flex items-center gap-2.5 text-ink no-underline" aria-label="engram">
          <Logo />
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/app/auth/login" className="btn btn-tertiary !text-body no-underline">
            {t('backToLogin')}
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-container px-5 pb-24 pt-10">
        <div className="mb-10 max-w-[780px]">
          <p className="t-label mb-2 text-muted">{t('updatedLabel')}</p>
          <h1 className="t-headline-md mb-3">{t('title')}</h1>
          <p className="t-body-lg m-0 text-muted">{t('lead')}</p>
        </div>

        <div className="grid items-start gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t('navAriaLabel')} className="lg:sticky lg:top-6">
            <p className="t-label mb-2.5 text-muted">{t('onThisPage')}</p>
            <div className="flex flex-wrap gap-1 text-[14px] lg:flex-col">
              <a
                href="#terms"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('navTerms')}
              </a>
              <a
                href="#privacy"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('navPrivacy')}
              </a>
              <a
                href="#deletion"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('navDeletion')}
              </a>
              <a
                href="#contact"
                className="rounded-md px-3 py-2 !text-body no-underline hover:bg-surface"
              >
                {t('navContact')}
              </a>
            </div>
          </nav>

          <div className="flex min-w-0 max-w-[820px] flex-col gap-8">
            <section
              id="terms"
              className={`panel p-6 md:p-8 ${activeSection === 'privacy' ? 'order-2' : 'order-1'}`}
            >
              <p className="t-label mb-2 text-accent">{t('terms.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('terms.heading')}</h2>

              <div className="flex flex-col gap-4">
                <div className="card p-5">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('terms.s1Title')}</p>
                  <p className="t-body m-0 text-body">{t('terms.s1Body')}</p>
                </div>

                <div className="card p-5">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('terms.s2Title')}</p>
                  <p className="t-body m-0 text-body">{t('terms.s2Body')}</p>
                </div>

                <div className="card p-5">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('terms.s3Title')}</p>
                  <p className="t-body m-0 text-body">{t('terms.s3Body')}</p>
                </div>
              </div>
            </section>

            <section
              id="privacy"
              className={`panel p-6 md:p-8 ${activeSection === 'privacy' ? 'order-1' : 'order-2'}`}
            >
              <p className="t-label mb-2 text-accent">{t('privacy.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('privacy.heading')}</h2>
              <p className="t-body mb-5 text-body">{t('privacy.intro')}</p>

              <div className="mb-6 grid gap-3 md:grid-cols-2">
                <div className="card border-success p-5">
                  <p className="t-label mb-1.5" style={{ color: 'var(--success-ink)' }}>{t('privacy.encBadge')}</p>
                  <p className="m-0 mb-1.5 text-[14px] font-semibold">{t('privacy.encTitle')}</p>
                  <p className="m-0 text-[13px] text-body">{t('privacy.encBody')}</p>
                </div>

                <div className="card border-warning p-5">
                  <p className="t-label mb-1.5 text-body">{t('privacy.plainBadge')}</p>
                  <p className="m-0 mb-1.5 text-[14px] font-semibold">{t('privacy.plainTitle')}</p>
                  <p className="m-0 text-[13px] text-body">{t('privacy.plainBody')}</p>
                </div>
              </div>

              <div className="card mb-6 overflow-x-auto p-0">
                <table className="w-full min-w-[540px] border-collapse text-[13.5px]">
                  <thead>
                    <tr className="bg-surface">
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('privacy.tableColData')}
                      </th>
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('privacy.tableColServer')}
                      </th>
                      <th scope="col" className="t-label p-3 text-left text-muted">
                        {t('privacy.tableColPurpose')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('privacy.row1Data')}</td>
                      <td className="p-3">
                        <span className="badge-type bg-paleAccent text-accent">{t('privacy.row1Server')}</span>
                      </td>
                      <td className="p-3 text-muted">{t('privacy.row1Purpose')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('privacy.row2Data')}</td>
                      <td className="p-3">
                        <span className="badge-type badge-json">{t('privacy.row2Server')}</span>
                      </td>
                      <td className="p-3 text-muted">{t('privacy.row2Purpose')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('privacy.row3Data')}</td>
                      <td className="p-3">
                        <span className="badge-type badge-json">{t('privacy.row3Server')}</span>
                      </td>
                      <td className="p-3 text-muted">{t('privacy.row3Purpose')}</td>
                    </tr>
                    <tr className="border-t border-line">
                      <td className="p-3 font-semibold">{t('privacy.row4Data')}</td>
                      <td className="p-3">
                        <span className="badge-type badge-text">{t('privacy.row4Server')}</span>
                      </td>
                      <td className="p-3 text-muted">{t('privacy.row4Purpose')}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="card p-5">
                <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('privacy.s21Title')}</p>
                <p className="t-body m-0 text-body">{t('privacy.s21Body')}</p>
              </div>
            </section>

            <section id="deletion" className="panel order-3 p-6 md:p-8">
              <p className="t-label mb-2 text-accent">{t('deletion.sectionLabel')}</p>
              <h2 className="t-title-md mb-4">{t('deletion.heading')}</h2>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="card p-5">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('deletion.noSellTitle')}</p>
                  <p className="t-body m-0 text-body">{t('deletion.noSellBody')}</p>
                </div>

                <div className="card p-5">
                  <p className="m-0 mb-1.5 text-[15px] font-semibold">{t('deletion.exportDeleteTitle')}</p>
                  <p className="t-body m-0 text-body">{t('deletion.exportDeleteBody')}</p>
                </div>
              </div>
            </section>

            <section id="contact" className="panel order-4 p-6 md:p-8">
              <p className="t-label mb-2 text-accent">{t('contact.sectionLabel')}</p>
              <h2 className="t-title-md mb-3">{t('contact.heading')}</h2>
              <p className="t-body mb-3 text-body">
                {t('contact.generalPrefix')}
                <a
                  href="https://github.com/zone17th/engram/issues"
                  className="mono break-all text-[14px] underline"
                  style={{ color: 'var(--link-ink)', overflowWrap: 'anywhere' }}
                >
                  https://github.com/zone17th/engram/issues
                </a>
                {t('contact.generalWarning')}
              </p>
              <p className="t-body mb-5 text-body">
                {t('contact.securityPrefix')}
                <a
                  href="https://github.com/zone17th/engram/security/advisories/new"
                  className="mono break-all text-[14px] underline"
                  style={{ color: 'var(--link-ink)', overflowWrap: 'anywhere' }}
                >
                  https://github.com/zone17th/engram/security/advisories/new
                </a>
                {t('contact.securitySuffix')}
              </p>

              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <a
                  href="https://github.com/zone17th/engram/issues"
                  className="btn btn-secondary !whitespace-normal text-center text-[14px] no-underline"
                >
                  <span>{t('contact.issuesCta')}</span>
                </a>
                <a
                  href="https://github.com/zone17th/engram/security/advisories/new"
                  className="btn btn-secondary !whitespace-normal text-center text-[14px] no-underline"
                >
                  <span>{t('contact.advisoriesCta')}</span>
                </a>
                <Link
                  href={activeSection === 'terms' ? privacyHref : termsHref}
                  className="btn btn-tertiary !whitespace-normal text-center no-underline"
                >
                  <span>
                    {activeSection === 'terms' ? t('contact.switchPagePrivacy') : t('contact.switchPageTerms')}
                  </span>
                </Link>
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
