import type { ReactNode } from 'react';

// Dev-only root for /dev/*: the pages below render their own <html>/<body>, so this layout only exists
// so `next dev` stops generating an untracked root layout here (T-r4-6). It adds no UI.
export default function DevLayout({ children }: { children: ReactNode }) {
  return children;
}
