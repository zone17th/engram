import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import AppCatchAll from '../app/app/[...rest]/page';

// V-2 (advisor-dec-P06-049): unmatched /app/<x> must render app/app/not-found.tsx with a real 404 status.
// The branded vi/en copy of that file is asserted in tests/states.test.tsx ("app not-found is translated ...").
// The real HTTP 404 status, the per-request nonce CSP header and 0 CSP violations on a live /app/<x> need a running
// server, so they belong to the cloud e2e round (never run locally).
const WEB = resolve(__dirname, '..');
const APP_DIR = resolve(WEB, 'app/app');

describe('V-2 app catch-all 404', () => {
  it('calls notFound() (HTTP 404 fallback), renders nothing itself', () => {
    let thrown: unknown;
    try {
      AppCatchAll();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { digest?: string }).digest).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404$|^NEXT_NOT_FOUND$/);
  });

  it('page file only calls notFound(): no data access, no UI, no client code', () => {
    const source = readFileSync(resolve(APP_DIR, '[...rest]/page.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain("import { notFound } from 'next/navigation';");
    expect(code).not.toMatch(/use client/);
    expect(code.match(/import /g)).toHaveLength(1);
    expect(code).toMatch(/export default function \w+\(\) \{\s*notFound\(\);\s*\}/);
  });

  it('is a required catch-all at app/app, so /app and every real route keep their own page (no shadowing)', () => {
    const entries = readdirSync(APP_DIR);
    expect(entries).toContain('[...rest]');
    expect(entries).not.toContain('[[...rest]]');
    // The catch-all adds no layout/loading/error of its own: the app layout, route guard and not-found.tsx apply as-is.
    expect(readdirSync(resolve(APP_DIR, '[...rest]'))).toEqual(['page.tsx']);
    expect(existsSync(resolve(APP_DIR, 'not-found.tsx'))).toBe(true);
    for (const real of [
      'page.tsx',
      'unlock/page.tsx',
      'unlock/forgot/page.tsx',
      'recovery/page.tsx',
      'settings/page.tsx',
      'onboarding/page.tsx',
      'items/[id]/page.tsx',
      'auth/login/page.tsx',
      'auth/signup/page.tsx',
      'auth/reauth/page.tsx',
      'auth/reset-password/page.tsx',
      'auth/callback/[provider]/page.tsx',
    ]) {
      expect(existsSync(resolve(APP_DIR, real)), real).toBe(true);
    }
  });
});
