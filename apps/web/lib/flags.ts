/**
 * Returns whether the P04 content surface is enabled.
 *
 * Reads the literal `process.env.NEXT_PUBLIC_CONTENT_ENABLED` inside the
 * function body on every call so Next.js build-time inlining works in
 * production while `vi.stubEnv` still overrides it in unit tests.
 */
export function contentEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONTENT_ENABLED === 'true';
}
