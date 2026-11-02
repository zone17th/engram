import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_ME_QUERY_KEY_PREFIX,
  readMeFromQueryClient,
} from '@/features/omnibox/suggest/use-semantic-suggest-setting';
import type { Me } from '@/lib/api/auth';
import { getSessionEpoch } from '@/lib/api/auth-fetch';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import { SemanticCard } from './semantic-card';

function makeMe(overrides: {
  readonly id?: string;
  readonly email?: string;
  readonly semantic_suggest?: boolean;
  readonly semantic_available?: boolean;
  readonly semantic_external?: boolean;
} = {}): Me {
  const features: Me['features'] = {
    semantic_available: overrides.semantic_available ?? true,
    email_verification_required: false,
    oauth_providers: [],
    oauth_reauth_providers: [],
    password_enrollment_available: false,
    captcha_site_key: null,
    ...(overrides.semantic_external !== undefined
      ? { semantic_external: overrides.semantic_external }
      : {}),
  };

  return {
    user: {
      id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
      email: overrides.email ?? 'user@example.com',
      email_verified: true,
      created_at: '2026-11-02T00:00:00Z',
    },
    settings: {
      locale: 'vi',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: overrides.semantic_suggest ?? false,
    },
    identities: [],
    vault: {
      status: 'present',
    },
    features,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(code: string, status = 409): Response {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

function renderSemanticCard(options: {
  readonly initialMe?: Me | null;
  readonly locale?: 'vi' | 'en';
} = {}) {
  const locale = options.locale ?? 'vi';
  const messages = locale === 'en' ? enMessages : viMessages;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  if (options.initialMe !== undefined) {
    const meKey = [...AUTH_ME_QUERY_KEY_PREFIX, getSessionEpoch()] as const;
    queryClient.setQueryData(meKey, options.initialMe);
  }

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
  }

  const view = render(<SemanticCard />, { wrapper: Wrapper });
  return { ...view, queryClient, messages };
}

describe('features/settings/search/semantic-card (U16 #timkiem)', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('409 semantic_unavailable reverts switch, no toast', async () => {
    const initialMe = makeMe({
      semantic_suggest: false,
      semantic_available: true,
      semantic_external: true,
    });
    fetchMock.mockResolvedValueOnce(problemResponse('semantic_unavailable', 409));

    const { queryClient, messages, container } = renderSemanticCard({
      initialMe,
      locale: 'vi',
    });

    const sw = screen.getByRole('switch', {
      name: messages.settings.search.semanticTitle,
    });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).not.toBeDisabled();

    // Status node is mounted in DOM and initially empty (not hidden)
    const statusNode = screen.getByRole('status');
    expect(statusNode).toBeInTheDocument();
    expect(statusNode).not.toHaveAttribute('hidden');
    expect(statusNode.textContent).toBe('');

    fireEvent.click(sw);

    await waitFor(() => {
      expect(statusNode).toHaveTextContent(messages.settings.search.semanticEnable409);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, reqInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/me/settings');
    expect(reqInit.method).toBe('PATCH');
    expect(JSON.parse(String(reqInit.body))).toEqual({ semantic_suggest: true });

    // Switch stays/reverts to off, cache is false
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(false);

    // No toast or alert container rendered
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.toast')).toBeNull();
    expect(document.querySelector('.toast')).toBeNull();

    // Next toggle clears the error before sending the new PATCH
    const updatedMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: true,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(updatedMe, 200));

    fireEvent.click(sw);

    await waitFor(() => {
      expect(sw).toHaveAttribute('aria-checked', 'true');
    });
    expect(statusNode.textContent).toBe('');
  });

  it('server-off disables control', () => {
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: false,
      semantic_external: true,
    });

    const { messages } = renderSemanticCard({
      initialMe,
      locale: 'vi',
    });

    const sw = screen.getByRole('switch', {
      name: messages.settings.search.semanticTitle,
    });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    // Reflects stored setting even when server is off
    expect(sw).toHaveAttribute('aria-checked', 'true');

    expect(
      screen.getByText(messages.settings.search.semanticServerOff),
    ).toBeInTheDocument();

    fireEvent.click(sw);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tei copy says index continues when off', () => {
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: false,
    });

    const { messages } = renderSemanticCard({
      initialMe,
      locale: 'en',
    });

    expect(
      screen.getByText(messages.settings.search.semanticSelfHostCopy),
    ).toBeInTheDocument();
    expect(
      screen.getByText(messages.settings.search.semanticEntryNeverSent),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(messages.settings.search.semanticExternalCopy),
    ).toBeNull();
  });

  it('external copy says vectors deleted when off', () => {
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: true,
    });

    const { messages } = renderSemanticCard({
      initialMe,
      locale: 'en',
    });

    expect(
      screen.getByText(messages.settings.search.semanticExternalCopy),
    ).toBeInTheDocument();
    expect(
      screen.getByText(messages.settings.search.semanticEntryNeverSent),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(messages.settings.search.semanticSelfHostCopy),
    ).toBeNull();
  });

  it('no reembed button', () => {
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: false,
    });

    const { container } = renderSemanticCard({
      initialMe,
      locale: 'vi',
    });

    const buttons = screen.getAllByRole('button');
    // Only the single switch control exists inside the card
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('role', 'switch');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Nhúng lại|Re-embed|reembed|bge-m3|qwen3/i);
  });

  it('PATCH waits for 200 before switch flips', async () => {
    const initialMe = makeMe({
      semantic_suggest: false,
      semantic_available: true,
      semantic_external: true,
    });

    const deferred = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(deferred.promise);

    const { queryClient, messages } = renderSemanticCard({
      initialMe,
      locale: 'vi',
    });

    const sw = screen.getByRole('switch', {
      name: messages.settings.search.semanticTitle,
    });
    expect(sw).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sw);

    // Non-optimistic: while in-flight, switch stays false and is disabled against double clicks
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(false);

    // Double click while in-flight does not trigger a second PATCH
    fireEvent.click(sw);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const serverMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: true,
    });
    deferred.resolve(jsonResponse(serverMe, 200));

    await waitFor(() => {
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).not.toBeDisabled();
    });
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(true);
  });

  it('absent semantic_external uses external copy', () => {
    // makeMe without semantic_external leaves features.semantic_external undefined
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
    });
    expect('semantic_external' in initialMe.features).toBe(false);

    const { messages } = renderSemanticCard({
      initialMe,
      locale: 'vi',
    });

    expect(
      screen.getByText(messages.settings.search.semanticExternalCopy),
    ).toBeInTheDocument();
    expect(
      screen.getByText(messages.settings.search.semanticEntryNeverSent),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(messages.settings.search.semanticSelfHostCopy),
    ).toBeNull();
  });

  it('shows save failed message on non-409 PATCH failure and disables when me is null', async () => {
    // 1. When me is null, renders disabled card without fetching
    const nullView = renderSemanticCard({
      initialMe: null,
      locale: 'en',
    });
    const nullSw = screen.getByRole('switch', {
      name: enMessages.settings.search.semanticTitle,
    });
    expect(nullSw).toBeDisabled();
    expect(nullSw).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(nullSw);
    expect(fetchMock).not.toHaveBeenCalled();
    nullView.unmount();

    // 2. When PATCH fails with 500, shows semanticSaveFailed in role="status"
    const initialMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: true,
    });
    fetchMock.mockResolvedValueOnce(
      problemResponse('internal_error', 500),
    );

    const { messages } = renderSemanticCard({
      initialMe,
      locale: 'en',
    });

    const sw = screen.getByRole('switch', {
      name: messages.settings.search.semanticTitle,
    });
    const statusNode = screen.getByRole('status');
    expect(statusNode.textContent).toBe('');

    fireEvent.click(sw);

    await waitFor(() => {
      expect(statusNode).toHaveTextContent(messages.settings.search.semanticSaveFailed);
    });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
