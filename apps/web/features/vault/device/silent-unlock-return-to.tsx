'use client';

/**
 * Preserves the sanitized `returnTo` query destination on `/app/unlock` when an automatic `silentUnlockOnLoad`
 * attempt succeeds (R1-4 / R1-23).
 *
 * Rendered only when `VaultProvider` has `silentUnlockOnLoad` enabled (wrapped in `<Suspense fallback={null}>`),
 * so `VaultProvider` itself never calls `useRouter()` / `useSearchParams()` directly and `route-guard.tsx`,
 * `guard-redirect.ts` and `unlock-flow.tsx` stay untouched.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { useVault } from '@/features/vault/vault-provider';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

const UNLOCK_PATH = '/app/unlock';

function resolveUnlockDestination(rawReturnTo: string | null): string {
  const safe = sanitizeReturnTo(rawReturnTo, '/app');
  const base = safe.split(/[?#]/, 1)[0] ?? safe;
  if (
    base === UNLOCK_PATH ||
    base === '/app/unlock/forgot' ||
    base === '/app/recovery' ||
    base === '/app/onboarding' ||
    base === '/app/auth' ||
    base.startsWith('/app/auth/')
  ) {
    return '/app';
  }
  return safe;
}

class NavigationSafeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SilentUnlockReturnToInner({ unlockedCount }: { unlockedCount: number }) {
  const pathname = usePathname() ?? '/app';
  const router = useRouter();
  const searchParams = useSearchParams();
  const vault = useVault();

  const capturedDestinationRef = useRef<string | null>(null);
  const pendingRedirectRef = useRef<{ count: number; destination: string } | null>(null);
  const handledCountRef = useRef<number>(0);

  // While on `/app/unlock` before unlock completes, remember the sanitized destination from `returnTo`.
  const returnToParam = searchParams.get('returnTo');
  if (pathname === UNLOCK_PATH) {
    capturedDestinationRef.current = resolveUnlockDestination(returnToParam);
  }

  useEffect(() => {
    if (vault.state !== 'unlocked') {
      pendingRedirectRef.current = null;
      return;
    }
    if (unlockedCount > handledCountRef.current) {
      const destination =
        pathname === UNLOCK_PATH
          ? resolveUnlockDestination(returnToParam)
          : capturedDestinationRef.current;
      handledCountRef.current = unlockedCount;
      capturedDestinationRef.current = null;
      if (!destination || destination === '/app') {
        if (pathname === UNLOCK_PATH) {
          router.replace('/app');
        }
        return;
      }
      pendingRedirectRef.current = { count: unlockedCount, destination };
      router.replace(destination);
      return;
    }
    const pending = pendingRedirectRef.current;
    if (pending && pending.count === handledCountRef.current) {
      const targetBase = pending.destination.split(/[?#]/, 1)[0] ?? pending.destination;
      if (pathname === targetBase) {
        pendingRedirectRef.current = null;
      } else if (pathname === '/app' || pathname === UNLOCK_PATH) {
        pendingRedirectRef.current = null;
        router.replace(pending.destination);
      }
    }
  }, [pathname, returnToParam, router, unlockedCount, vault.state]);

  return null;
}

export function SilentUnlockReturnTo({ unlockedCount }: { unlockedCount: number }) {
  return (
    <NavigationSafeBoundary>
      <Suspense fallback={null}>
        <SilentUnlockReturnToInner unlockedCount={unlockedCount} />
      </Suspense>
    </NavigationSafeBoundary>
  );
}
