import { type QueryClient } from '@tanstack/react-query';
import {
  applyCommittedEntryMetaToCache,
  mutateSealedEntryCreate,
  toEntryCreateVariables,
} from '@/features/entries/mutations';
import {
  sealNewEntry,
  type EntryOpHandle,
  type EntrySealVaultContext,
  type SealedNewEntryPayload,
} from '@/features/entries/seal';
import { normalizeTag } from '@/features/omnibox/normalize';
import {
  classifyContentMutationError,
  createIdempotencyKey,
  entryCreate,
  itemCreate,
  itemTagsAdd,
  tagUpsert,
  type ClassifiedContentMutationError,
  type EntryMeta,
  type ItemSummary,
  type Tag,
  type TagRef,
} from '@/lib/api/content';

export const QUICK_ADD_TARGET_TAG_CAP = 20;

export type SavePlanStepKey = 'item' | 'tags' | 'assign' | 'entry';
export type SavePlanStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SavePlanStepState {
  readonly key: SavePlanStepKey;
  readonly apiLabel: string;
  status: SavePlanStepStatus;
}

export interface SavePlanTagUpsertTask {
  readonly display: string;
  readonly idempotencyKey: string;
  upsertedTag?: Tag;
  uncertainSend: boolean;
}

/**
 * In-memory quick-add save plan (SPEC §3.4, plan §2.11):
 * - NEVER persisted to storage or QueryCache.
 * - NEVER holds plaintext entry body; holds ONLY `sealedEntry` from `sealNewEntry`
 *   (which contains `{ requestBody, serializedBody, idempotencyKey, op }` without plaintext).
 * - Pre-generates `itemId`, `entryId`, and one `Idempotency-Key` per write step up front so
 *   retrying from any failed step replays the exact same keys and bytes without duplicates (A3).
 */
export interface QuickAddSavePlan {
  readonly itemId: string;
  readonly itemName: string;
  readonly isNewItem: boolean;
  readonly itemCreateIdempotencyKey?: string;
  itemCreateUncertainSend: boolean;
  itemCreated?: ItemSummary;

  readonly tagTasks: readonly SavePlanTagUpsertTask[];
  readonly assignTagsIdempotencyKey?: string;
  assignTagsUncertainSend: boolean;

  readonly entryId: string;
  readonly sealedEntry: SealedNewEntryPayload;
  entryCreateUncertainSend: boolean;
  committedEntryMeta?: EntryMeta;

  readonly steps: readonly SavePlanStepState[];
  readonly op: EntryOpHandle;
  running: boolean;
  failedStepKey: SavePlanStepKey | null;
  lastError: ClassifiedContentMutationError | null;
}

/**
 * Checks whether assigning `parsedTags` (already deduplicated by `parseQuickAdd`) to `targetItem`
 * would exceed the 20-tag cap per item (SPEC §3.4, plan §2.11 step 2).
 * Returns `{ allowed: true }` or `{ allowed: false, existingTagCount }`.
 */
export function checkTargetTagCap(
  existingTags: readonly TagRef[],
  parsedTags: readonly string[],
):
  | { readonly allowed: true; readonly existingTagCount: number; readonly newUnassignedCount: number }
  | { readonly allowed: false; readonly existingTagCount: number; readonly newUnassignedCount: number } {
  const existingNormSet = new Set<string>();
  for (const tag of existingTags) {
    const norm = normalizeTag(tag.display);
    if (norm.ok) {
      existingNormSet.add(norm.normalized);
    } else {
      existingNormSet.add(tag.display.toLowerCase());
    }
  }

  let newUnassignedCount = 0;
  for (const rawDisplay of parsedTags) {
    const norm = normalizeTag(rawDisplay);
    const key = norm.ok ? norm.normalized : rawDisplay.toLowerCase();
    if (!existingNormSet.has(key)) {
      newUnassignedCount += 1;
    }
  }

  const existingTagCount = existingTags.length;
  const allowed = existingTagCount + newUnassignedCount <= QUICK_ADD_TARGET_TAG_CAP;
  return {
    allowed,
    existingTagCount,
    newUnassignedCount,
  };
}

export interface CreateQuickAddSavePlanInput {
  readonly name: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly targetItem: ItemSummary | null;
  readonly isNewItem: boolean;
  readonly vault: EntrySealVaultContext;
}

/**
 * Builds an in-memory `QuickAddSavePlan` and seals the entry body ONCE via `sealNewEntry`
 * BEFORE any network mutation runs (plan §2.10, §2.11 step 2).
 */
export async function createQuickAddSavePlan(
  input: CreateQuickAddSavePlanInput,
): Promise<QuickAddSavePlan> {
  const isNewItem = input.isNewItem || input.targetItem === null;
  const itemId = isNewItem ? crypto.randomUUID().toLowerCase() : input.targetItem.id;
  const itemName = !isNewItem && input.targetItem ? input.targetItem.name : input.name;
  const entryId = crypto.randomUUID().toLowerCase();
  const entryIdempotencyKey = createIdempotencyKey();

  // Seal ONCE before any mutation; `sealedEntry` does NOT retain `input.body`.
  const sealedEntry = await sealNewEntry({
    text: input.body,
    itemId,
    entryId,
    idempotencyKey: entryIdempotencyKey,
    type: 'text',
    vault: input.vault,
  });

  const steps: SavePlanStepState[] = [];
  let itemCreateIdempotencyKey: string | undefined;

  if (isNewItem) {
    itemCreateIdempotencyKey = createIdempotencyKey();
    steps.push({
      key: 'item',
      apiLabel: 'POST /items',
      status: 'pending',
    });
  }

  const tagTasks: SavePlanTagUpsertTask[] = input.tags.map((display) => ({
    display,
    idempotencyKey: createIdempotencyKey(),
    uncertainSend: false,
  }));

  let assignTagsIdempotencyKey: string | undefined;
  if (tagTasks.length > 0) {
    assignTagsIdempotencyKey = createIdempotencyKey();
    steps.push({
      key: 'tags',
      apiLabel: `POST /tags (×${tagTasks.length})`,
      status: 'pending',
    });
    steps.push({
      key: 'assign',
      apiLabel: 'POST /items/{id}/tags',
      status: 'pending',
    });
  }

  steps.push({
    key: 'entry',
    apiLabel: 'POST /items/{id}/entries',
    status: 'pending',
  });

  return {
    itemId,
    itemName,
    isNewItem,
    ...(itemCreateIdempotencyKey ? { itemCreateIdempotencyKey } : {}),
    itemCreateUncertainSend: false,
    tagTasks,
    ...(assignTagsIdempotencyKey ? { assignTagsIdempotencyKey } : {}),
    assignTagsUncertainSend: false,
    entryId: sealedEntry.entryId,
    sealedEntry,
    entryCreateUncertainSend: false,
    steps,
    op: sealedEntry.op,
    running: false,
    failedStepKey: null,
    lastError: null,
  };
}

export function hasPlanCommittedMetadata(plan: QuickAddSavePlan | null): boolean {
  if (!plan) return false;
  return (
    plan.steps.some((s) => s.key !== 'entry' && s.status === 'done') ||
    plan.tagTasks.some((t) => t.upsertedTag !== undefined)
  );
}

export type ExecuteSavePlanOutcome =
  | {
      readonly status: 'completed';
      readonly entryMeta: EntryMeta;
      readonly itemId: string;
      readonly itemName: string;
    }
  | {
      readonly status: 'aborted_or_stale';
    }
  | {
      readonly status: 'failed';
      readonly stepKey: SavePlanStepKey;
      readonly classifiedError: ClassifiedContentMutationError;
      readonly rawError: unknown;
      readonly hadUncertainSend: boolean;
    };

export interface ExecuteQuickAddSavePlanParams {
  readonly plan: QuickAddSavePlan;
  readonly queryClient: QueryClient | null | undefined;
  readonly signal: AbortSignal;
  readonly onStepUpdate?: () => void;
}

function isAbortOrStale(error: unknown, signal: AbortSignal, op: EntryOpHandle): boolean {
  if (signal.aborted || !op.isCurrent()) {
    return true;
  }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'STALE_GENERATION'))) {
    return true;
  }
  return false;
}

/**
 * Executes (or resumes) a `QuickAddSavePlan` from its first non-`done` step using the
 * pre-generated `Idempotency-Key`s and sealed entry bytes (SPEC §3.4, plan §2.11 step 3, A3).
 *
 * Before every state/cache transition after an `await`, checks `plan.op.isCurrent()` and `signal.aborted`.
 */
export async function executeQuickAddSavePlan(
  params: ExecuteQuickAddSavePlanParams,
): Promise<ExecuteSavePlanOutcome> {
  const { plan, queryClient, signal, onStepUpdate } = params;
  const { op } = plan;

  if (!op.isCurrent() || signal.aborted) {
    return { status: 'aborted_or_stale' };
  }

  plan.running = true;
  plan.failedStepKey = null;
  plan.lastError = null;
  onStepUpdate?.();

  for (const step of plan.steps) {
    if (step.status === 'done') {
      continue;
    }
    if (!op.isCurrent() || signal.aborted) {
      plan.running = false;
      return { status: 'aborted_or_stale' };
    }

    step.status = 'running';
    onStepUpdate?.();

    if (step.key === 'item') {
      const priorUncertain = plan.itemCreateUncertainSend;
      plan.itemCreateUncertainSend = true;
      try {
        const created = await itemCreate(
          { id: plan.itemId, name: plan.itemName },
          {
            idempotencyKey: plan.itemCreateIdempotencyKey ?? createIdempotencyKey(),
            signal,
            uncertainPriorSend: priorUncertain,
          },
        );
        if (!op.isCurrent() || signal.aborted) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        plan.itemCreated = created;
        plan.itemCreateUncertainSend = false;
        step.status = 'done';
        onStepUpdate?.();
      } catch (error) {
        if (isAbortOrStale(error, signal, op)) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        const classified = classifyContentMutationError(error, { hadUncertainSend: true });
        if (!classified.canRetrySameBytes && classified.preLookupRecovery === 'not_pre_lookup') {
          plan.itemCreateUncertainSend = false;
        }
        step.status = 'failed';
        plan.running = false;
        plan.failedStepKey = 'item';
        plan.lastError = classified;
        onStepUpdate?.();
        return {
          status: 'failed',
          stepKey: 'item',
          classifiedError: classified,
          rawError: error,
          hadUncertainSend: true,
        };
      }
      continue;
    }

    if (step.key === 'tags') {
      for (const tagTask of plan.tagTasks) {
        if (tagTask.upsertedTag) {
          continue;
        }
        if (!op.isCurrent() || signal.aborted) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        const priorUncertain = tagTask.uncertainSend;
        tagTask.uncertainSend = true;
        try {
          const tag = await tagUpsert(
            { display: tagTask.display },
            {
              idempotencyKey: tagTask.idempotencyKey,
              signal,
              uncertainPriorSend: priorUncertain,
            },
          );
          if (!op.isCurrent() || signal.aborted) {
            plan.running = false;
            return { status: 'aborted_or_stale' };
          }
          tagTask.upsertedTag = tag;
          tagTask.uncertainSend = false;
        } catch (error) {
          if (isAbortOrStale(error, signal, op)) {
            plan.running = false;
            return { status: 'aborted_or_stale' };
          }
          const classified = classifyContentMutationError(error, { hadUncertainSend: true });
          if (!classified.canRetrySameBytes && classified.preLookupRecovery === 'not_pre_lookup') {
            tagTask.uncertainSend = false;
          }
          step.status = 'failed';
          plan.running = false;
          plan.failedStepKey = 'tags';
          plan.lastError = classified;
          onStepUpdate?.();
          return {
            status: 'failed',
            stepKey: 'tags',
            classifiedError: classified,
            rawError: error,
            hadUncertainSend: true,
          };
        }
      }
      step.status = 'done';
      onStepUpdate?.();
      continue;
    }

    if (step.key === 'assign') {
      const tagIds = plan.tagTasks
        .map((t) => t.upsertedTag?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const priorUncertain = plan.assignTagsUncertainSend;
      plan.assignTagsUncertainSend = true;
      try {
        await itemTagsAdd(
          plan.itemId,
          { tag_ids: tagIds },
          {
            idempotencyKey: plan.assignTagsIdempotencyKey ?? createIdempotencyKey(),
            signal,
            uncertainPriorSend: priorUncertain,
          },
        );
        if (!op.isCurrent() || signal.aborted) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        plan.assignTagsUncertainSend = false;
        step.status = 'done';
        onStepUpdate?.();
      } catch (error) {
        if (isAbortOrStale(error, signal, op)) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        const classified = classifyContentMutationError(error, { hadUncertainSend: true });
        if (!classified.canRetrySameBytes && classified.preLookupRecovery === 'not_pre_lookup') {
          plan.assignTagsUncertainSend = false;
        }
        step.status = 'failed';
        plan.running = false;
        plan.failedStepKey = 'assign';
        plan.lastError = classified;
        onStepUpdate?.();
        return {
          status: 'failed',
          stepKey: 'assign',
          classifiedError: classified,
          rawError: error,
          hadUncertainSend: true,
        };
      }
      continue;
    }

    if (step.key === 'entry') {
      const priorUncertain = plan.entryCreateUncertainSend;
      plan.entryCreateUncertainSend = true;
      try {
        let meta: EntryMeta;
        if (queryClient) {
          const res = await mutateSealedEntryCreate(
            queryClient,
            toEntryCreateVariables(plan.sealedEntry, {
              signal,
              uncertainPriorSend: priorUncertain,
            }),
          );
          meta = res.meta;
        } else {
          meta = await entryCreate(plan.itemId, plan.sealedEntry.requestBody, {
            idempotencyKey: plan.sealedEntry.idempotencyKey,
            signal,
            uncertainPriorSend: priorUncertain,
          });
        }

        if (!op.isCurrent() || signal.aborted) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }

        if (queryClient) {
          applyCommittedEntryMetaToCache({
            queryClient,
            entryId: plan.entryId,
            itemId: plan.itemId,
            meta,
            op,
          });
        }

        plan.committedEntryMeta = meta;
        plan.entryCreateUncertainSend = false;
        step.status = 'done';
        plan.running = false;
        onStepUpdate?.();
        return {
          status: 'completed',
          entryMeta: meta,
          itemId: plan.itemId,
          itemName: plan.itemName,
        };
      } catch (error) {
        if (isAbortOrStale(error, signal, op)) {
          plan.running = false;
          return { status: 'aborted_or_stale' };
        }
        const classified = classifyContentMutationError(error, { hadUncertainSend: true });
        if (!classified.canRetrySameBytes && classified.preLookupRecovery === 'not_pre_lookup') {
          plan.entryCreateUncertainSend = false;
        }
        step.status = 'failed';
        plan.running = false;
        plan.failedStepKey = 'entry';
        plan.lastError = classified;
        onStepUpdate?.();
        return {
          status: 'failed',
          stepKey: 'entry',
          classifiedError: classified,
          rawError: error,
          hadUncertainSend: true,
        };
      }
    }
  }

  plan.running = false;
  if (plan.committedEntryMeta) {
    return {
      status: 'completed',
      entryMeta: plan.committedEntryMeta,
      itemId: plan.itemId,
      itemName: plan.itemName,
    };
  }
  return { status: 'aborted_or_stale' };
}
