import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/landing/logo';

/** Footer tối của landing — layout theo mockups/landing.html. */
export async function SiteFooter() {
  const tNav = await getTranslations('nav');
  const tFooter = await getTranslations('footer');
  const tBrand = await getTranslations('brand');

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
              <p className="t-label mb-3 text-white/50">{tNav('how')}</p>
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
              <p className="t-label mb-3 text-white/50">{tNav('openApp')}</p>
              <div className="flex flex-col gap-2 text-[15px]">
                <Link href="/app" className="no-underline text-white/85">
                  {tNav('openApp')}
                </Link>
              </div>
            </div>
          </div>
        </div>
        <hr className="my-8 mb-5 h-px border-0 bg-white/12" />
        <p className="t-legal m-0 text-white/45">{tFooter('legal')}</p>
      </div>
    </footer>
  );
}
