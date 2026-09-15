import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemError, apiFetch } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

describe('apiFetch', () => {
  it('trả body JSON khi 200', async () => {
    stubFetch(
      new Response(JSON.stringify({ status: 'ready', checks: { database: 'ok' }, semantic_available: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(apiFetch('/readyz')).resolves.toEqual({
      status: 'ready',
      checks: { database: 'ok' },
      semantic_available: false,
    });
  });

  it('ném ProblemError khi nhận problem+json', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          type: 'https://key.zone17th.click/problems/dependency_unavailable',
          title: 'Phụ thuộc chưa sẵn sàng',
          status: 503,
          code: 'dependency_unavailable',
        }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } },
      ),
    );

    await expect(apiFetch('/readyz')).rejects.toBeInstanceOf(ProblemError);
  });

  it('gọi đường tương đối dưới /api/v1 — không bao giờ cross-origin', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);

    await apiFetch('/healthz');

    expect(spy).toHaveBeenCalledWith('/api/v1/healthz', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('không cho caller ghi đè credentials', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);

    await apiFetch('/healthz', { credentials: 'include' });

    expect(spy).toHaveBeenCalledWith('/api/v1/healthz', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('từ chối path không phải đường tương đối', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    for (const bad of ['https://evil.example/steal', '//evil.example/steal', 'healthz', '/\\evil.example']) {
      await expect(apiFetch(bad)).rejects.toThrow(/đường tương đối/);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
