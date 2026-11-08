import { notFound } from 'next/navigation';

/**
 * V-2 (advisor-dec-P06-049): an unmatched `/app/<x>` matched no segment under `app/app`, so Next served its unbranded
 * English default 404. Routing it here (real 404 status) renders `app/app/not-found.tsx` inside the app layout
 * (theme, vi/en copy, nonce CSP, same route guard as every other /app page). Required catch-all: `/app` itself and
 * every real route keep their own pages.
 */
export default function AppCatchAll() {
  notFound();
}
