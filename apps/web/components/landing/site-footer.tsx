import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Logo } from '@/components/landing/logo';

/**
 * Footer tối của landing — layout theo mockups/landing.html.
 * Không đặt nhãn cột: mỗi nhãn chỉ lặp lại đúng link bên dưới nó (audit UIA-24).
 */
export function SiteFooter() {
  const locale = useLocale();
  const tNav = useTranslations('nav');
  const tFooter = useTranslations('footer');
  const tBrand = useTranslations('brand');
  const termsHref = locale === 'vi' ? '/vi/terms' : '/terms';
  const privacyHref = locale === 'vi' ? '/vi/privacy' : '/privacy';
  const docsHref = locale === 'vi' ? '/vi/docs' : '/docs';
  const contactHref = `${docsHref}#lien-he`;

  return (
    <footer className="max-w-container mx-auto px-5 pb-8">
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
                <a href="#cachdung" className="no-underline text-white/85">
                  {tNav('how')}
                </a>
                <a href="#riengtu" className="no-underline text-white/85">
                  {tNav('privacy')}
                </a>
                <a href="#khoiphuc" className="no-underline text-white/85">
                  {tNav('recovery')}
                </a>
              </div>
            </div>
            <div>
              <div className="flex flex-col gap-2 text-[15px]">
                <Link href={docsHref} className="no-underline text-white/85">
                  {tNav('help')}
                </Link>
                <Link href={privacyHref} className="no-underline text-white/85">
                  {tFooter('privacyPolicy')}
                </Link>
                <Link href={termsHref} className="no-underline text-white/85">
                  {tFooter('terms')}
                </Link>
                <Link href={contactHref} className="no-underline text-white/85">
                  {tFooter('contact')}
                </Link>
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
  );
}
