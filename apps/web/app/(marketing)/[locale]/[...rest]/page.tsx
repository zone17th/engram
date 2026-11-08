import { notFound } from 'next/navigation';

/**
 * F2: without a catch-all, `/vi/<unknown>` matched no segment under `[locale]` and Next served its unbranded default
 * 404 outside the locale layout. Routing it here renders `[locale]/not-found.tsx` inside the layout (brand, theme, lang).
 */
export default function MarketingCatchAll() {
  notFound();
}
