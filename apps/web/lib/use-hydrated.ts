import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False in the server HTML and during the hydration render, true once React has
 * attached handlers. SSR'd auth forms are interactive-looking before that point:
 * a value typed (or filled by a test) into a controlled input is reset to the
 * empty React state when hydration commits, and a pre-hydration submit is a native
 * GET that never reaches onSubmit. Gate inputs and the submit button on this.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
