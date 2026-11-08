'use client';

import { OMNIBOX_FILL_EVENT } from '@/components/app-shell/omnibox';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Khớp mockups/states.html — dùng cho cả rỗng, lỗi và offline. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onAction: () => void };
}) {
  return (
    <Card className="flex flex-col items-start gap-3 p-8">
      <h2 className="t-title-md text-ink">{title}</h2>
      <p className="text-muted">{body}</p>
      {action && (
        <Button variant="secondary" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}

/**
 * F-34: the "Try typing" examples are real buttons. Pressing one fills the home Omnibox (nothing is saved or sent
 * until the user presses Enter), so the first-run path is one click plus Enter.
 */
export function EmptyExamples({ examples, fillHint, testId }: { examples: readonly string[]; fillHint: string; testId?: string }) {
  return (
    <ul data-testid={testId} className="m-0 flex max-w-full list-none flex-wrap justify-center gap-2 p-0">
      {examples.map((example) => (
        <li key={example} className="max-w-full">
          <button
            type="button"
            title={fillHint}
            onClick={() => window.dispatchEvent(new CustomEvent(OMNIBOX_FILL_EVENT, { detail: { value: example } }))}
            className="mono min-h-11 max-w-full cursor-pointer break-words rounded-md border border-line bg-surface px-2.5 py-1 text-left text-[12px] text-body [overflow-wrap:anywhere] hover:bg-surfaceAlt"
          >
            {example}
          </button>
        </li>
      ))}
    </ul>
  );
}
