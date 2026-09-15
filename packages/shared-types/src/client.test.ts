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

  it('giữ Headers instance và accept do caller truyền vào', async () => {
    const spy = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', spy);
    const inputHeaders = new Headers([
      ['x-request-id', 'test-request'],
      ['Accept', 'text/plain'],
    ]);

    await expect(apiFetch<string>('/metrics', { headers: inputHeaders })).resolves.toBe('ok');

    const [, options] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.headers).toBeInstanceOf(Headers);
    const headers = new Headers(options.headers);
    expect(headers.get('x-request-id')).toBe('test-request');
    expect(headers.get('accept')).toBe('text/plain');
  });

  it('giữ tuple headers và thêm accept mặc định', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);

    await apiFetch('/healthz', { headers: [['x-request-id', 'test-request']] });

    const [, options] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(headers.get('x-request-id')).toBe('test-request');
    expect(headers.get('accept')).toBe('application/json');
  });

  it.each([204, 205])('trả undefined khi response thành công không có body (%i)', async (status) => {
    stubFetch(new Response(null, { status, headers: { 'content-type': 'application/json' } }));

    await expect(apiFetch<void>('/healthz')).resolves.toBeUndefined();
  });

  it('trả undefined khi response 200 có body null', async () => {
    stubFetch(new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(apiFetch<void>('/healthz')).resolves.toBeUndefined();
  });

  it('trả undefined cho request HEAD thành công', async () => {
    stubFetch(new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(apiFetch<void>('/healthz', { method: 'head' })).resolves.toBeUndefined();
  });

  it('đọc body text theo content-type', async () => {
    stubFetch(new Response('engram_metric 1\n', { status: 200, headers: { 'content-type': 'text/plain' } }));

    await expect(apiFetch<string>('/metrics')).resolves.toBe('engram_metric 1\n');
  });

  it('nhận problem+json không phân biệt hoa thường và tham số', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          type: 'https://key.zone17th.click/problems/dependency_unavailable',
          title: 'Phụ thuộc chưa sẵn sàng',
          status: 503,
          code: 'dependency_unavailable',
        }),
        { status: 503, headers: { 'content-type': 'Application/Problem+JSON; charset=utf-8' } },
      ),
    );

    await expect(apiFetch('/readyz')).rejects.toBeInstanceOf(ProblemError);
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
