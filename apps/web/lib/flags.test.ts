import { afterEach, describe, expect, it, vi } from 'vitest';

import { contentEnabled } from './flags';

describe('contentEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when NEXT_PUBLIC_CONTENT_ENABLED is 'true'", () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'true');
    expect(contentEnabled()).toBe(true);
  });

  it("returns false when NEXT_PUBLIC_CONTENT_ENABLED is 'false'", () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', 'false');
    expect(contentEnabled()).toBe(false);
  });

  it('returns false when NEXT_PUBLIC_CONTENT_ENABLED is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', undefined);
    expect(contentEnabled()).toBe(false);
  });

  it('returns false when NEXT_PUBLIC_CONTENT_ENABLED has any other value', () => {
    for (const value of ['', '1', 'TRUE', 'yes', 'on']) {
      vi.stubEnv('NEXT_PUBLIC_CONTENT_ENABLED', value);
      expect(contentEnabled()).toBe(false);
    }
  });
});
