import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card } from '@/components/ui/card';

/**
 * U18 `#err-not-found` for the public site (F2: unknown `/vi/<x>` used to fall through to the unbranded Next 404).
 * Server component: the title comes from `states.notFoundTitle` in the request locale, so `/vi/<x>` is Vietnamese and `/<x>`
 * English. Uses the `btn` class on a link (no `<button>` wrapper, no client component).
 */
export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'states' });
  // M-1 / R2-M1: visitors of the public site are not signed in and have no "list"; the item copy ("deleted or does not
  // belong to your account") and /app are wrong here. Page-level body (states.pageNotFoundBody) + the site home in the same locale.
  const homeHref = locale === 'vi' ? '/vi' : '/';
  return (
    <main id="main-content" className="mx-auto max-w-container px-5 py-16">
      <Card className="flex flex-col items-start gap-3 p-8" data-testid="err-not-found">
        <h1 className="t-title-md m-0">{t('notFoundTitle')}</h1>
        <p className="m-0 text-body" data-testid="err-not-found-body">
          {t('pageNotFoundBody')}
        </p>
        <Link href={homeHref} className="btn btn-secondary no-underline" data-testid="err-not-found-home">
          {t('backHome')}
        </Link>
      </Card>
    </main>
  );
}
