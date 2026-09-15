import { defineRouting } from 'next-intl/routing';

/**
 * `as-needed`: `/` là en, `/vi` là vi (P01 §UI và route).
 * App riêng tư nằm ở segment tĩnh `/app`, KHÔNG có prefix locale.
 */
export const routing = defineRouting({
  locales: ['en', 'vi'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
});
