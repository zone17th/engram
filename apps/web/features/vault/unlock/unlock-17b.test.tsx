import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider } from '@/features/auth/session-provider';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import type { LockEpochEnvironment } from '@/features/vault/lock-epoch';
import {
  CRED_A,
  PRF_OUTPUT,
  domError,
  fakeCredential,
  unlockOptionsResponse,
} from '@/features/vault/passkey/test-helpers';
import { ForgotPassphraseView, VaultUnlockFlow } from '@/features/vault/unlock';
import { VaultProvider } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import type { VaultState } from '@/lib/api/vault';
import type { CryptoWorkerPort } from '@/lib/crypto/client';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const routerMocks = vi.hoisted(() => ({
  pathname: '/app/unlock',
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => ({ replace: routerMocks.replace, push: routerMocks.push }),
  useSearchParams: () => routerMocks.searchParams,
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeMeFixture(email = 'minh@zone17th.click'): Me {
  return {
    user: {
      id: 'user-unlock-17b-test-1',
      email,
      email_verified: true,
      created_at: '2026-10-30T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: true,
    },
    identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
    features: {
      semantic_available: true,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'present' },
  };
}

function makeVaultMetaFixture(passkeysCount = 1): VaultState {
  return {
    version: 1,
    vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
    kdf: {
      alg: 'argon2id13',
      ops: 3,
      mem: 67_108_864,
      parallelism: 1,
      salt: 'oKGio6SlpqeoqaqrrK2urw',
    },
    vault_key_wrapped_by_kek:
      'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA',
    x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
    ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    private_keys_wrapped:
      'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-',
    recovery_keys_remaining: 10,
    passkeys: Array.from({ length: passkeysCount }, (_, i) => ({
      id: `pk-${i + 1}`,
      name: `Key ${i + 1}`,
      aaguid: null,
      created_at: '2026-10-30T00:00:00Z',
    })),
  };
}

function makeSimpleLockEpochEnv(): LockEpochEnvironment {
  let marker = { epochIncarnation: 'inc-unlock-17b-test-1', lockEpoch: 1 };
  const fakeIdb = {
    open() {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction() {
            let pending = 0;
            const tx: Record<string, unknown> = {
              objectStore() {
                const scheduleComplete = () => {
                  if (pending === 0) {
                    queueMicrotask(() => {
                      if (pending === 0 && typeof tx.oncomplete === 'function') {
                        tx.oncomplete();
                      }
                    });
                  }
                };
                return {
                  get() {
                    pending += 1;
                    const getReq: Record<string, unknown> = { result: marker };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof getReq.onsuccess === 'function') getReq.onsuccess();
                      scheduleComplete();
                    });
                    return getReq;
                  },
                  put(val: typeof marker) {
                    pending += 1;
                    marker = val;
                    const putReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof putReq.onsuccess === 'function') putReq.onsuccess();
                      scheduleComplete();
                    });
                    return putReq;
                  },
                  delete() {
                    pending += 1;
                    const delReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof delReq.onsuccess === 'function') delReq.onsuccess();
                      scheduleComplete();
                    });
                    return delReq;
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        },
      };
      queueMicrotask(() => {
        if (typeof req.onsuccess === 'function') req.onsuccess();
      });
      return req;
    },
  } as unknown as IDBFactory;

  return {
    idbFactory: fakeIdb,
    locksManager: {
      request: async (_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb(),
    } as unknown as LockManager,
  };
}

function makeUnlock17BWorkerFactory(): () => CryptoWorkerPort {
  return () => {
    let generation = 0;
    let epoch = 0;
    let mode: 'locked' | 'unlocked' | 'recovering' = 'locked';
    let onMessage: ((event: MessageEvent) => void) | null = null;

    return {
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
      },
      onerror: null,
      postMessage(message) {
        if ('pwkBuffer' in message && message.pwkBuffer) {
          new Uint8Array(message.pwkBuffer).fill(0);
        }
        queueMicrotask(() => {
          if (message.type === 'lock') {
            generation = Math.max(generation, message.generation);
            mode = 'locked';
            epoch += 1;
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { generation },
              },
            } as MessageEvent);
            return;
          }

          if (message.type === 'unlockPrf') {
            generation = message.generation;
            mode = 'unlocked';
            epoch += 1;
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { unlocked: true },
              },
            } as MessageEvent);
            return;
          }
        });
      },
      terminate() {
        onMessage = null;
      },
    };
  };
}

describe('P03-T17B — Unlock U4 Passkey, Forgot Passphrase 17B Paths & CF Email Wrap', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.pathname = '/app/unlock';
    routerMocks.searchParams = new URLSearchParams();
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    resetVaultBroadcastForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: class {},
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'PublicKeyCredential');
    vi.restoreAllMocks();
  });

  function renderView(view: 'unlock' | 'forgot', locale: 'en' | 'vi' = 'en') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'vi' ? viMessages : enMessages}
      >
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeUnlock17BWorkerFactory()}
                lockEpochEnv={makeSimpleLockEpochEnv()}
              >
                {view === 'forgot' ? <ForgotPassphraseView /> : <VaultUnlockFlow />}
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
  }

  it('17B: PasskeyUnlockButton on VaultUnlockFlow is hidden when no passkeys exist, unlocks and navigates on assertion, and surfaces §5.10 cancel message', async () => {
    let passkeysCount = 0;
    const credentialsGet = vi.fn();
    Object.defineProperty(navigator, 'credentials', {
      value: { get: credentialsGet },
      configurable: true,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture());
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture(passkeysCount));
      if (url.endsWith('/vault/unlock/passkey/options') && init?.method === 'POST') {
        return jsonResponse(unlockOptionsResponse());
      }
      return jsonResponse({});
    });

    // 1. 0 passkeys -> passkey button hidden
    renderView('unlock', 'en');
    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-section')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('unlock-passkey-section')).not.toBeInTheDocument();

    // 2. 1 passkey -> passkey button visible; cancel shows §5.10 passkey.unlock_cancelled; success navigates to /app
    cleanup();
    passkeysCount = 1;
    renderView('unlock', 'en');
    const passkeyBtn = await screen.findByTestId('unlock-passkey-button');
    expect(passkeyBtn).toBeEnabled();

    credentialsGet.mockRejectedValueOnce(domError('NotAllowedError'));
    fireEvent.click(passkeyBtn);
    expect(await screen.findByTestId('unlock-passkey-error')).toHaveTextContent(
      enMessages.vault.passkey.unlock_cancelled,
    );

    credentialsGet.mockResolvedValueOnce(
      fakeCredential({ rawId: CRED_A.id, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );
    fireEvent.click(passkeyBtn);
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
  });

  it('17B: ForgotPassphraseView lists passkey, remembered-device, unlocked-tab -> Settings change passphrase (rewrap), plus recovery key and reset (en + vi)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture());
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture(1));
      return jsonResponse({});
    });

    renderView('forgot', 'en');
    await waitFor(() => {
      expect(screen.getByTestId('forgot-passphrase-page')).toBeInTheDocument();
    });

    expect(screen.getByTestId('forgot-path-passkey')).toHaveTextContent(
      enMessages.vault.b.forgot.passkeyTitle,
    );
    expect(screen.getByTestId('forgot-path-remembered-device')).toHaveTextContent(
      enMessages.vault.b.forgot.deviceTitle,
    );
    expect(screen.getByTestId('forgot-path-unlocked-tab')).toHaveTextContent(
      enMessages.vault.b.forgot.unlockedTabTitle,
    );
    expect(screen.getByTestId('forgot-path-unlocked-tab')).toHaveTextContent(
      enMessages.vault.b.forgot.unlockedTabBody,
    );
    expect(screen.getByTestId('forgot-unlocked-tab-settings-cta')).toHaveTextContent(
      enMessages.vault.b.forgot.unlockedTabCta,
    );
    expect(screen.getByTestId('forgot-unlocked-tab-settings-cta')).toHaveAttribute(
      'href',
      '/app/settings#baomat',
    );
    expect(screen.getByTestId('forgot-path-recovery-key')).toBeInTheDocument();
    expect(screen.getByTestId('forgot-reset-vault-link')).toHaveAttribute(
      'href',
      '/app/settings#baomat',
    );

    cleanup();
    renderView('forgot', 'vi');
    await waitFor(() => {
      expect(screen.getByTestId('forgot-passphrase-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('forgot-path-passkey')).toHaveTextContent(
      viMessages.vault.b.forgot.passkeyTitle,
    );
    expect(screen.getByTestId('forgot-path-remembered-device')).toHaveTextContent(
      viMessages.vault.b.forgot.deviceTitle,
    );
    expect(screen.getByTestId('forgot-path-unlocked-tab')).toHaveTextContent(
      viMessages.vault.b.forgot.unlockedTabTitle,
    );
    expect(screen.getByTestId('forgot-unlocked-tab-settings-cta')).toHaveTextContent(
      viMessages.vault.b.forgot.unlockedTabCta,
    );
  });

  it('CF-T17B-UNLOCK-EMAIL-WRAP: Signed in · {email} line carries overflow-wrap:anywhere and break-words', async () => {
    const longEmail =
      'extremely-long-enterprise-identity-recipient-address-for-mobile-390px-viewport-check@subdomain.engram-security-test.zone17th.click';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture(longEmail));
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture(0));
      return jsonResponse({});
    });

    renderView('unlock', 'en');
    const signedInLine = await screen.findByTestId('unlock-signed-in-line');
    await waitFor(() => {
      expect(signedInLine).toHaveTextContent(`Signed in · ${longEmail}`);
    });
    expect(signedInLine).toHaveClass('min-w-0');
    expect(signedInLine).toHaveClass('break-words');
    expect(signedInLine).toHaveStyle({ overflowWrap: 'anywhere' });
  });
});
