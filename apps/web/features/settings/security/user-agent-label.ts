/**
 * Short, display-only label for a session's user agent ("Chrome · Windows").
 *
 * Pure presentation helper for the sign-in sessions list: it never changes what the API stores or returns, and the
 * raw user agent stays available to the caller (rendered in a `title` attribute). Returns `null` when neither the
 * browser nor the operating system is recognised, so the caller can fall back to its "unknown device" copy.
 */

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Order matters: Chromium-based browsers also carry "Chrome/" and "Safari/" tokens.
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  // iOS before macOS (iPadOS desktop mode still reports "Macintosh"), Android before Linux.
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(ua: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return null;
}

export function formatUserAgent(userAgent: string | null | undefined): string | null {
  const ua = userAgent?.trim();
  if (!ua) return null;
  const parts = [firstMatch(ua, BROWSERS), firstMatch(ua, SYSTEMS)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}
