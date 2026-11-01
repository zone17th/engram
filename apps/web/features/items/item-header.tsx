'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import { contentQueryKeys } from '@/features/items/query-keys';
import {
  normalizeName,
  normalizeTag,
  normalizeTagQuery,
  validateHint,
} from '@/features/omnibox/normalize';
import {
  classifyContentMutationError,
  createIdempotencyKey,
  itemGet,
  itemTagRemove,
  itemTagsAdd,
  itemUpdate,
  tagsList,
  tagUpsert,
  type ContentErrorI18nKey,
  type ItemSummary,
  type ItemUpdateRequest,
  type Tag,
  type TagRef,
} from '@/lib/api/content';

export const ITEM_MAX_TAGS = 20;

interface QueuedPatchStep {
  readonly kind: 'name' | 'hint' | 'both';
  readonly body: ItemUpdateRequest;
  readonly idempotencyKey: string;
  ifMatch?: number;
}

export interface ItemHeaderProps {
  readonly item: ItemSummary;
  readonly entryCount: number;
  readonly onAnnounce?: (message: string) => void;
}

export function ItemHeader({ item, entryCount, onAnnounce }: ItemHeaderProps) {
  const tItem = useTranslations('content.item');
  const tPrivacy = useTranslations('content.privacy');
  const tErrors = useTranslations('content.errors');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const undoToast = useOptionalUndoToast();

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  // Local editable values
  const [nameInput, setNameInput] = useState(item.name);
  const [hintInput, setHintInput] = useState(item.hint ?? '');
  const [nameDirty, setNameDirty] = useState(false);
  const [hintDirty, setHintDirty] = useState(false);

  const [nameError, setNameError] = useState<string | null>(null);
  const [hintError, setHintError] = useState<string | null>(null);
  const [conflict412, setConflict412] = useState<{
    readonly currentVersion?: number;
  } | null>(null);

  const [uncertainPatchError, setUncertainPatchError] = useState<string | null>(null);
  // Sequential PATCH queue state (P4FE2-4)
  const latestVersionRef = useRef<number>(item.version);
  const latestCommittedNameRef = useRef<string>(item.name);
  const latestCommittedHintRef = useRef<string | null>(item.hint ?? null);
  const patchQueueRef = useRef<QueuedPatchStep[]>([]);
  const drainingRef = useRef<boolean>(false);
  const conflictRef = useRef<boolean>(false);
  const uncertainStepPausedRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync external server updates when not dirty and not in 412 conflict
  useEffect(() => {
    if (item.version > latestVersionRef.current) {
      latestVersionRef.current = item.version;
    }
    latestCommittedNameRef.current = item.name;
    latestCommittedHintRef.current = item.hint ?? null;

    if (
      !conflictRef.current &&
      !uncertainStepPausedRef.current &&
      !drainingRef.current &&
      patchQueueRef.current.length === 0
    ) {
      if (!nameDirty) {
        setNameInput(item.name);
      }
      if (!hintDirty) {
        setHintInput(item.hint ?? '');
      }
    }
  }, [item.id, item.name, item.hint, item.version, nameDirty, hintDirty]);

  const applyItemSummaryToCache = useCallback(
    (updated: ItemSummary) => {
      latestVersionRef.current = updated.version;
      latestCommittedNameRef.current = updated.name;
      latestCommittedHintRef.current = updated.hint ?? null;
      queryClient.setQueryData<ItemSummary>(contentQueryKeys.item(updated.id), updated);
    },
    [queryClient],
  );

  const drainPatchQueue = useCallback(async () => {
    if (drainingRef.current || conflictRef.current || uncertainStepPausedRef.current) return;
    drainingRef.current = true;

    try {
      while (
        patchQueueRef.current.length > 0 &&
        !conflictRef.current &&
        !uncertainStepPausedRef.current
      ) {
        const nextStep = patchQueueRef.current[0];
        if (nextStep.ifMatch === undefined) {
          nextStep.ifMatch = latestVersionRef.current;
        }
        const versionToUse = nextStep.ifMatch;

        try {
          const updated = await itemUpdate(item.id, nextStep.body, {
            idempotencyKey: nextStep.idempotencyKey,
            ifMatch: versionToUse,
          });
          patchQueueRef.current.shift();
          applyItemSummaryToCache(updated);

          if (mountedRef.current) {
            setUncertainPatchError(null);
            if (nextStep.kind === 'name') {
              setNameDirty(false);
              onAnnounce?.(tItem('nameSaved'));
            } else if (nextStep.kind === 'hint') {
              setHintDirty(false);
              onAnnounce?.(tItem('hintSaved'));
            } else {
              setNameDirty(false);
              setHintDirty(false);
              onAnnounce?.(tItem('nameSaved'));
            }
          }
        } catch (err) {
          const classified = classifyContentMutationError(err, {
            hadUncertainSend: true,
          });
          if (classified.kind === 'version_mismatch') {
            // Stop queue on 412 and preserve typed values in the inputs (plan §2.10, P4FE2-4)
            patchQueueRef.current = [];
            conflictRef.current = true;
            uncertainStepPausedRef.current = false;
            if (classified.currentVersion !== undefined) {
              latestVersionRef.current = classified.currentVersion;
            }
            if (mountedRef.current) {
              setUncertainPatchError(null);
              setConflict412({ currentVersion: classified.currentVersion });
              onAnnounce?.(tItem('conflictTitle'));
            }
            break;
          }

          // Uncertain outcome (canRetrySameBytes after shared retries): stop draining, retain exact step
          // (If-Match, body, Idempotency-Key), and offer Retry that replays it (IP15-BE1-4).
          if (classified.canRetrySameBytes) {
            uncertainStepPausedRef.current = true;
            if (mountedRef.current) {
              const msg = translateContentError(classified.i18nKey);
              setUncertainPatchError(msg);
              onAnnounce?.(msg);
            }
            break;
          }

          // Deterministic 4xx: remove failed step and show field error
          patchQueueRef.current.shift();
          if (mountedRef.current) {
            const msg = translateContentError(classified.i18nKey);
            if (nextStep.kind === 'hint') {
              setHintError(msg);
            } else {
              setNameError(msg);
            }
            onAnnounce?.(msg);
          }
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [applyItemSummaryToCache, item.id, onAnnounce, tItem, translateContentError]);

  const handleRetryUncertainPatch = useCallback(() => {
    if (!uncertainStepPausedRef.current || drainingRef.current) return;
    uncertainStepPausedRef.current = false;
    setUncertainPatchError(null);
    void drainPatchQueue();
  }, [drainPatchQueue]);

  const enqueuePatch = useCallback(
    (step: QueuedPatchStep) => {
      patchQueueRef.current.push(step);
      void drainPatchQueue();
    },
    [drainPatchQueue],
  );

  const commitNameIfChanged = useCallback(() => {
    if (conflictRef.current) return;
    setNameError(null);

    const normalized = normalizeName(nameInput);
    if (!normalized.ok) {
      const msg = translateContentError('content.errors.name_invalid');
      setNameError(msg);
      onAnnounce?.(msg);
      return;
    }

    const nextDisplay = normalized.trimmed;
    // Check if there is already a pending name step or if it matches committed
    const pendingNameSteps = patchQueueRef.current.filter(
      (s) => s.kind === 'name' || s.kind === 'both',
    );
    const effectiveBaseName =
      pendingNameSteps.length > 0
        ? (pendingNameSteps[pendingNameSteps.length - 1].body.name ??
          latestCommittedNameRef.current)
        : latestCommittedNameRef.current;

    if (nextDisplay === effectiveBaseName) {
      setNameInput(nextDisplay);
      setNameDirty(false);
      return;
    }

    setNameInput(nextDisplay);
    enqueuePatch({
      kind: 'name',
      body: { name: nextDisplay },
      idempotencyKey: createIdempotencyKey(),
    });
  }, [enqueuePatch, nameInput, onAnnounce, translateContentError]);

  const commitHintIfChanged = useCallback(() => {
    if (conflictRef.current) return;
    setHintError(null);

    const validated = validateHint(hintInput);
    if (!validated.ok) {
      const msg = translateContentError('content.errors.hint_invalid');
      setHintError(msg);
      onAnnounce?.(msg);
      return;
    }

    const nextHint = validated.trimmed === '' ? null : validated.trimmed;
    const pendingHintSteps = patchQueueRef.current.filter(
      (s) => s.kind === 'hint' || s.kind === 'both',
    );
    const effectiveBaseHint =
      pendingHintSteps.length > 0
        ? (pendingHintSteps[pendingHintSteps.length - 1].body.hint ?? null)
        : latestCommittedHintRef.current;

    if (nextHint === effectiveBaseHint) {
      setHintInput(nextHint ?? '');
      setHintDirty(false);
      return;
    }

    setHintInput(nextHint ?? '');
    enqueuePatch({
      kind: 'hint',
      body: { hint: nextHint },
      idempotencyKey: createIdempotencyKey(),
    });
  }, [enqueuePatch, hintInput, onAnnounce, translateContentError]);

  const handleLoadLatestItem = useCallback(async () => {
    try {
      const latest = await itemGet(item.id);
      conflictRef.current = false;
      patchQueueRef.current = [];
      uncertainStepPausedRef.current = false;
      applyItemSummaryToCache(latest);
      if (mountedRef.current) {
        setConflict412(null);
        setUncertainPatchError(null);
        setNameError(null);
        setHintError(null);
        setNameDirty(false);
        setHintDirty(false);
        setNameInput(latest.name);
        setHintInput(latest.hint ?? '');
      }
    } catch (err) {
      const classified = classifyContentMutationError(err);
      if (mountedRef.current) {
        setNameError(translateContentError(classified.i18nKey));
      }
    }
  }, [applyItemSummaryToCache, item.id, translateContentError]);

  const handleKeepMineItem = useCallback(async () => {
    setNameError(null);
    setHintError(null);

    const normName = normalizeName(nameInput);
    if (!normName.ok) {
      setNameError(translateContentError('content.errors.name_invalid'));
      return;
    }
    const validHint = validateHint(hintInput);
    if (!validHint.ok) {
      setHintError(translateContentError('content.errors.hint_invalid'));
      return;
    }

    try {
      // Ensure we have the latest server version if 412 did not include current_version
      let baseVersion = conflict412?.currentVersion;
      if (baseVersion === undefined) {
        const latest = await itemGet(item.id);
        baseVersion = latest.version;
        latestVersionRef.current = latest.version;
      } else {
        latestVersionRef.current = baseVersion;
      }

      conflictRef.current = false;
      uncertainStepPausedRef.current = false;
      setUncertainPatchError(null);
      setConflict412(null);
      const nextHint = validHint.trimmed === '' ? null : validHint.trimmed;
      setNameInput(normName.trimmed);
      setHintInput(nextHint ?? '');

      enqueuePatch({
        kind: 'both',
        body: {
          name: normName.trimmed,
          hint: nextHint,
        },
        idempotencyKey: createIdempotencyKey(),
      });
    } catch (err) {
      const classified = classifyContentMutationError(err);
      if (mountedRef.current) {
        setNameError(translateContentError(classified.i18nKey));
      }
    }
  }, [conflict412, enqueuePatch, hintInput, item.id, nameInput, translateContentError]);

  // Tag popover and suggestions
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [tagQueryInput, setTagQueryInput] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const addTagChipRef = useRef<HTMLButtonElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const activeTags = useMemo(() => item.tags ?? [], [item.tags]);
  const atTagLimit = activeTags.length >= ITEM_MAX_TAGS;

  useEffect(() => {
    if (atTagLimit && tagPopoverOpen) {
      setTagPopoverOpen(false);
    }
  }, [atTagLimit, tagPopoverOpen]);

  useEffect(() => {
    if (tagPopoverOpen) {
      tagInputRef.current?.focus();
    }
  }, [tagPopoverOpen]);

  const normalizedTagPrefix = useMemo(() => {
    const res = normalizeTagQuery(tagQueryInput);
    return res.ok ? res.normalized : '';
  }, [tagQueryInput]);

  const tagsSuggestQuery = useQuery({
    queryKey: contentQueryKeys.tags({ q: normalizedTagPrefix || undefined, sort: 'alpha' }),
    queryFn: ({ signal }) =>
      tagsList({
        q: normalizedTagPrefix || undefined,
        sort: 'alpha',
        limit: 20,
        signal,
      }),
    enabled: tagPopoverOpen,
  });

  const existingTagIds = useMemo(
    () => new Set(activeTags.map((t) => t.id)),
    [activeTags],
  );

  const suggestions = useMemo(() => {
    const items = tagsSuggestQuery.data?.items ?? [];
    return items.filter((candidate) => !existingTagIds.has(candidate.id));
  }, [existingTagIds, tagsSuggestQuery.data]);

  const parsedNewTag = useMemo(() => {
    const res = normalizeTag(tagQueryInput);
    if (!res.ok) return null;
    const exactMatchInAll = (tagsSuggestQuery.data?.items ?? []).find(
      (candidate) => candidate.display.toLowerCase() === res.trimmed.toLowerCase(),
    );
    return {
      display: res.trimmed,
      normalized: res.normalized,
      exactMatchInAll,
    };
  }, [tagQueryInput, tagsSuggestQuery.data]);

  const handleAttachExistingTag = useCallback(
    async (tag: Pick<Tag, 'id' | 'display'>) => {
      if (tagBusy || atTagLimit) return;
      setTagError(null);
      setTagBusy(true);
      try {
        const updated = await itemTagsAdd(
          item.id,
          { tag_ids: [tag.id] },
          { idempotencyKey: createIdempotencyKey() },
        );
        applyItemSummaryToCache(updated);
        void queryClient.invalidateQueries({ queryKey: contentQueryKeys.tagsAll() });
        if (mountedRef.current) {
          setTagQueryInput('');
          setTagPopoverOpen(false);
          onAnnounce?.(tItem('tagAttached', { tag: tag.display }));
          addTagChipRef.current?.focus();
        }
      } catch (err) {
        const classified = classifyContentMutationError(err);
        if (mountedRef.current) {
          setTagError(translateContentError(classified.i18nKey));
        }
      } finally {
        if (mountedRef.current) {
          setTagBusy(false);
        }
      }
    },
    [
      applyItemSummaryToCache,
      atTagLimit,
      item.id,
      onAnnounce,
      queryClient,
      tItem,
      tagBusy,
      translateContentError,
    ],
  );

  const handleCreateAndAttachTag = useCallback(async () => {
    if (tagBusy || atTagLimit) return;
    setTagError(null);

    const validated = normalizeTag(tagQueryInput);
    if (!validated.ok) {
      setTagError(translateContentError('content.errors.tag_display_invalid'));
      return;
    }

    setTagBusy(true);
    try {
      const upserted = await tagUpsert(
        { display: validated.trimmed },
        { idempotencyKey: createIdempotencyKey() },
      );
      const updated = await itemTagsAdd(
        item.id,
        { tag_ids: [upserted.id] },
        { idempotencyKey: createIdempotencyKey() },
      );
      applyItemSummaryToCache(updated);
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.tagsAll() });
      if (mountedRef.current) {
        setTagQueryInput('');
        setTagPopoverOpen(false);
        onAnnounce?.(tItem('tagAttached', { tag: upserted.display }));
        addTagChipRef.current?.focus();
      }
    } catch (err) {
      const classified = classifyContentMutationError(err);
      if (mountedRef.current) {
        setTagError(translateContentError(classified.i18nKey));
      }
    } finally {
      if (mountedRef.current) {
        setTagBusy(false);
      }
    }
  }, [
    applyItemSummaryToCache,
    atTagLimit,
    item.id,
    onAnnounce,
    queryClient,
    tItem,
    tagBusy,
    tagQueryInput,
    translateContentError,
  ]);

  const handleRemoveTag = useCallback(
    async (tag: TagRef) => {
      setTagError(null);
      try {
        const updated = await itemTagRemove(item.id, tag.id, {
          idempotencyKey: createIdempotencyKey(),
        });
        applyItemSummaryToCache(updated);
        void queryClient.invalidateQueries({ queryKey: contentQueryKeys.tagsAll() });
        undoToast?.pushUndoToast({
          message: tItem('tagRemovedToast', { tag: tag.display }),
          actionLabel: tItem('undoAction'),
          returnFocusTo: () => addTagChipRef.current,
          onUndo: async () => {
            const restored = await itemTagsAdd(
              item.id,
              { tag_ids: [tag.id] },
              { idempotencyKey: createIdempotencyKey() },
            );
            applyItemSummaryToCache(restored);
            void queryClient.invalidateQueries({ queryKey: contentQueryKeys.tagsAll() });
          },
        });
      } catch (err) {
        const classified = classifyContentMutationError(err);
        if (mountedRef.current) {
          setTagError(translateContentError(classified.i18nKey));
        }
      }
    },
    [applyItemSummaryToCache, item.id, queryClient, tItem, translateContentError, undoToast],
  );

  const handleNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNameIfChanged();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setNameError(null);
      setNameDirty(false);
      setNameInput(latestCommittedNameRef.current);
    }
  };

  const handleHintKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitHintIfChanged();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setHintError(null);
      setHintDirty(false);
      setHintInput(latestCommittedHintRef.current ?? '');
    }
  };

  const handleTagInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleCreateAndAttachTag();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTagPopoverOpen(false);
      addTagChipRef.current?.focus();
    }
  };

  const formattedCreatedAt = useMemo(() => {
    try {
      return format.dateTime(new Date(item.created_at), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return item.created_at;
    }
  }, [format, item.created_at]);

  return (
    <div data-testid="item-header">
      <nav aria-label={tItem('breadcrumbLabel')} className="mb-5 text-[13px] text-muted">
        <Link href="/app" className="font-medium text-body no-underline hover:underline">
          {tItem('allItems')}
        </Link>
        <span className="mx-1.5">/</span>
        <span id="breadcrumb-item-name" data-testid="breadcrumb-item-name">
          {nameInput || item.name}
        </span>
      </nav>

      <h1 id="item-page-heading" className="sr-only">
        {nameInput || item.name}
      </h1>

      <div
        className={`card mb-5 p-5 ${conflict412 ? 'card-error' : ''}`}
        data-testid="item-header-card"
      >
        {conflict412 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="item-conflict-badge">
            <span className="badge-type badge-conflict">412 version_mismatch</span>
            <span className="text-[14px] font-semibold text-body">{tItem('conflictSubtitle')}</span>
          </div>
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label htmlFor="item-name-input" className="field-label">
              {tItem('nameLabel')}
            </label>
            <input
              id="item-name-input"
              data-testid="item-name-input"
              type="text"
              value={nameInput}
              maxLength={200}
              aria-invalid={Boolean(nameError || conflict412)}
              aria-describedby="item-privacy-note"
              className="field-input font-display text-[24px] font-bold leading-tight text-ink sm:text-[28px]"
              onChange={(e) => {
                setNameInput(e.target.value);
                setNameDirty(true);
                if (nameError) setNameError(null);
              }}
              onBlur={() => {
                if (nameDirty) {
                  commitNameIfChanged();
                }
              }}
              onKeyDown={handleNameKeyDown}
            />
            {nameError ? (
              <p role="alert" className="field-error" data-testid="item-name-error">
                {nameError}
              </p>
            ) : null}
          </div>

          <div className="min-w-0">
            <label htmlFor="item-hint-input" className="field-label flex flex-wrap items-center gap-2">
              <span>{tItem('hintLabel')}</span>
              <span className="badge-type badge-ok" data-testid="item-hint-server-readable">
                {tPrivacy('hintServerReadable')}
              </span>
            </label>
            <input
              id="item-hint-input"
              data-testid="item-hint-input"
              type="text"
              value={hintInput}
              maxLength={120}
              placeholder={tItem('hintPlaceholder')}
              aria-invalid={Boolean(hintError)}
              aria-describedby="item-privacy-note"
              className="field-input"
              onChange={(e) => {
                setHintInput(e.target.value);
                setHintDirty(true);
                if (hintError) setHintError(null);
              }}
              onBlur={() => {
                if (hintDirty) {
                  commitHintIfChanged();
                }
              }}
              onKeyDown={handleHintKeyDown}
            />
            {hintError ? (
              <p role="alert" className="field-error" data-testid="item-hint-error">
                {hintError}
              </p>
            ) : null}
          </div>
        </div>

        {conflict412 ? (
          <div className="mt-4" data-testid="item-header-conflict-412">
            <div role="alert" className="auth-alert mb-3">
              <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                {tItem('conflictTitle')}
              </p>
              <p className="m-0 text-[13px] text-body">{tItem('conflictBody')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="item-conflict-load-latest"
                onClick={() => {
                  void handleLoadLatestItem();
                }}
              >
                {tItem('loadLatest')}
              </button>
              <button
                type="button"
                className="btn btn-tertiary btn-sm"
                data-testid="item-conflict-keep-mine"
                onClick={() => {
                  void handleKeepMineItem();
                }}
              >
                {tItem('keepMine')}
              </button>
            </div>
          </div>
        ) : null}


        {uncertainPatchError ? (
          <div
            role="alert"
            data-testid="item-patch-uncertain-retry-box"
            className="auth-alert mt-4 flex flex-wrap items-center justify-between gap-2"
          >
            <span data-testid="item-patch-uncertain-error">{uncertainPatchError}</span>
            <button
              type="button"
              data-testid="item-patch-retry-btn"
              className="btn btn-secondary btn-sm"
              onClick={handleRetryUncertainPatch}
            >
              {tItem('retry')}
            </button>
          </div>
        ) : null}
        <div
          id="item-privacy-note"
          data-testid="item-privacy-note"
          className="mt-3 border-t border-line pt-3 text-[13px] text-muted"
        >
          <p className="m-0 text-body">{tPrivacy('notice')}</p>
        </div>
      </div>

      {/* Tag chips + add tag popover */}
      <div className="mb-6">
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label={tItem('tagsLabel')}
          data-testid="item-tags"
        >
          {activeTags.map((tag) => (
            <span
              key={tag.id}
              className="chip"
              data-testid={`item-tag-chip-${tag.display}`}
            >
              <Link
                href={`/app?tag=${encodeURIComponent(tag.id)}`}
                className="text-body no-underline"
              >
                #{tag.display}
              </Link>
              <button
                type="button"
                className="chip-x cursor-pointer border-0 bg-transparent p-0"
                aria-label={tItem('removeTagAria', { tag: tag.display })}
                data-testid={`item-tag-remove-${tag.display}`}
                onClick={() => {
                  void handleRemoveTag(tag);
                }}
              >
                ×
              </button>
            </span>
          ))}

          <button
            ref={addTagChipRef}
            type="button"
            id="tag-add-chip"
            data-testid="tag-add-chip"
            className="chip chip-dashed"
            disabled={atTagLimit}
            title={atTagLimit ? tItem('tagLimitTooltip') : undefined}
            aria-describedby={atTagLimit ? 'tag-limit-hint' : undefined}
            aria-expanded={tagPopoverOpen}
            aria-controls={tagPopoverOpen ? 'tag-add-popover' : undefined}
            onClick={() => {
              if (atTagLimit) return;
              setTagError(null);
              setTagPopoverOpen((prev) => !prev);
            }}
          >
            {atTagLimit ? tItem('addTagLimitChip') : tItem('addTagChip')}
          </button>

          <span className="mono ml-auto text-[13px] text-muted" data-testid="item-meta-summary">
            {tItem('entryCount', { count: entryCount })} ·{' '}
            {tItem('createdOn', { date: formattedCreatedAt })}
          </span>
        </div>

        {atTagLimit ? (
          <p
            id="tag-limit-hint"
            data-testid="tag-limit-hint"
            className="m-0 mt-2 text-[12px] text-muted"
          >
            {tItem('tagLimitTooltip')}
          </p>
        ) : null}

        {tagError && !tagPopoverOpen ? (
          <p role="alert" className="field-error mt-2" data-testid="item-tag-error">
            {tagError}
          </p>
        ) : null}

        {tagPopoverOpen && !atTagLimit ? (
          <div
            id="tag-add-popover"
            data-testid="tag-add-popover"
            role="region"
            aria-label={tItem('tagPopoverLabel')}
            className="card mt-3 max-w-[460px] p-4"
          >
            <label htmlFor="tag-suggest-input" className="field-label">
              {tItem('tagInputLabel', { count: activeTags.length })}
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={tagInputRef}
                id="tag-suggest-input"
                data-testid="tag-suggest-input"
                type="text"
                value={tagQueryInput}
                maxLength={50}
                placeholder={tItem('tagInputPlaceholder')}
                aria-describedby="tag-privacy-note"
                aria-controls="tag-suggest-list"
                className="field-input"
                onChange={(e) => {
                  setTagQueryInput(e.target.value);
                  if (tagError) setTagError(null);
                }}
                onKeyDown={handleTagInputKeyDown}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm shrink-0"
                data-testid="tag-attach-submit"
                disabled={tagBusy || !parsedNewTag}
                onClick={() => {
                  void handleCreateAndAttachTag();
                }}
              >
                {tItem('tagAttachCta')}
              </button>
            </div>

            {tagError ? (
              <p role="alert" className="field-error mt-2" data-testid="tag-popover-error">
                {tagError}
              </p>
            ) : null}

            <div
              id="tag-suggest-list"
              data-testid="tag-suggest-list"
              role="listbox"
              aria-label={tItem('tagSuggestLabel')}
              className="mt-2 overflow-hidden rounded-md border border-line"
            >
              {suggestions.map((suggestion, idx) => (
                <button
                  key={suggestion.id}
                  type="button"
                  role="option"
                  aria-selected={idx === 0}
                  data-testid={`tag-suggest-option-${suggestion.display}`}
                  className="sugg-row"
                  disabled={tagBusy}
                  onClick={() => {
                    void handleAttachExistingTag(suggestion);
                  }}
                >
                  <span className="mono text-accent">#</span>
                  <span>{suggestion.display}</span>
                  <span className="sugg-meta">
                    {tItem('tagItemCount', { count: suggestion.item_count })}
                  </span>
                </button>
              ))}

              {parsedNewTag && !parsedNewTag.exactMatchInAll ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={suggestions.length === 0}
                  data-testid="tag-suggest-create-option"
                  className="sugg-row"
                  disabled={tagBusy}
                  onClick={() => {
                    void handleCreateAndAttachTag();
                  }}
                >
                  <span className="mono text-accent">+</span>
                  <span>{tItem('createTagOption', { tag: parsedNewTag.display })}</span>
                  <span className="sugg-meta">
                    <span className="kbd">Enter</span>
                  </span>
                </button>
              ) : null}
            </div>

            <p
              id="tag-privacy-note"
              data-testid="tag-privacy-note"
              className="m-0 mt-2.5 text-[12px] text-muted"
            >
              {tPrivacy('notice')}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
