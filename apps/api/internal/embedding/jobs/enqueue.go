package jobs

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/item"
)

// ErrInvalidEmbedKind is returned when an EmbedKind is neither item.EmbedKindItem
// nor item.EmbedKindTag.
var ErrInvalidEmbedKind = errors.New("jobs: invalid embed kind")

// Enqueuer implements item.EmbedHook for transactional embedding job enqueue
// on item/tag upserts and vector deletion across existing generations on
// soft-deletes (plan P05 mục 2.15, 2.17, Task 11b; SPEC §6.6; ADR 0007 §3).
//
// Privacy invariant (user-dec-016): Enqueuer never logs or persists item names,
// hints, tag display strings, or raw embedding inputs; River job payloads carry
// only generation_id, user_id, target_id, and hex-encoded input_hash.
type Enqueuer struct {
	Client   *river.Client[pgx.Tx]
	Enabled  bool
	Provider string
	Logger   *slog.Logger
}

// NewEnqueuer constructs a transactional Enqueuer for the given River insert
// client, deployment semantic-enabled flag, and primary provider name.
func NewEnqueuer(client *river.Client[pgx.Tx], enabled bool, provider string, logger *slog.Logger) *Enqueuer {
	return &Enqueuer{
		Client:   client,
		Enabled:  enabled,
		Provider: provider,
		Logger:   logger,
	}
}

func (e *Enqueuer) deploymentActive() bool {
	if e == nil || !e.Enabled || e.Client == nil {
		return false
	}
	prov := strings.TrimSpace(e.Provider)
	return prov != "" && prov != embedding.ProviderNoop
}

// OnUpsert implements item.EmbedHook. When the deployment has semantic search
// enabled (`Enabled && Provider != "noop"` and a non-nil River client), it
// delegates to EnqueueTx inside the caller's transaction; otherwise it is a
// no-op without acquiring the generation-set lock (plan P05 mục 2.17, 2.18).
func (e *Enqueuer) OnUpsert(
	ctx context.Context,
	tx pgx.Tx,
	userID uuid.UUID,
	kind item.EmbedKind,
	id uuid.UUID,
	input string,
) error {
	if !e.deploymentActive() {
		return nil
	}
	return EnqueueTx(ctx, tx, e.Client, userID, kind, id, input)
}

// OnDelete implements item.EmbedHook. It acquires LockGenerationSetShared on tx
// and invokes store.DeleteTarget across every existing generation
// (`state <> 'dropped'`, including retired generations past their rollback
// window). OnDelete runs even when semantic search is disabled at the
// deployment level so soft-deleted item/tag vectors never remain in vector
// tables (plan P05 mục 2.15, 2.17, Task 11b; ADR 0007 §3).
func (e *Enqueuer) OnDelete(
	ctx context.Context,
	tx pgx.Tx,
	userID uuid.UUID,
	kind item.EmbedKind,
	id uuid.UUID,
) error {
	if tx == nil {
		return generation.ErrNilTx
	}
	corpus, _, err := mapEmbedKind(kind)
	if err != nil {
		return err
	}
	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return err
	}
	return store.DeleteTarget(ctx, tx, corpus, userID, id)
}

// EnqueueTx is the single transactional decision point that fans out embed_item
// or embed_tag jobs across the receiving generation set R inside tx (plan P05
// mục 2.15, 2.17, Task 11b; SPEC §6.6; ADR 0007 §3, §8, §9):
//  1. If client == nil, returns nil (deployment off / insert client unconfigured).
//  2. Acquires generation.LockGenerationSetShared(ctx, tx) BEFORE reading R.
//  3. Reads R = generation.ReceivingGenerations(ctx, tx)
//     ({active} ∪ {pending} ∪ {retired with rollback_until > now()}).
//     If R is empty, returns nil. If R contains only g1 bootstrap pending,
//     still enqueues (BE-4).
//  4. Reads the user's settings.semantic_suggest in the same transaction.
//  5. For each generation g in R:
//     - Skips g when g.Provider == "openai_compat" and !semanticSuggest (BE-3;
//     "tei" generations are still enqueued).
//     - Computes input_hash = hex(embedding.InputHashFor(g.Identity(), input))
//     and inserts jobargs.EmbedItemArgs or jobargs.EmbedTagArgs via
//     client.InsertTx with EmbedInsertOpts(jobKind).
func EnqueueTx(
	ctx context.Context,
	tx pgx.Tx,
	client *river.Client[pgx.Tx],
	userID uuid.UUID,
	kind item.EmbedKind,
	id uuid.UUID,
	input string,
) error {
	if client == nil {
		return nil
	}
	if tx == nil {
		return generation.ErrNilTx
	}
	_, jobKind, err := mapEmbedKind(kind)
	if err != nil {
		return err
	}

	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return err
	}

	gens, err := generation.ReceivingGenerations(ctx, tx)
	if err != nil {
		return err
	}
	if len(gens) == 0 {
		return nil
	}

	userAlive, semanticSuggest, err := readUserPolicyUnlocked(ctx, tx, userID)
	if err != nil {
		return err
	}
	if !userAlive {
		return nil
	}

	for _, g := range gens {
		if g.Provider == generation.ProviderOpenAICompat && !semanticSuggest {
			continue
		}
		hash := embedding.InputHashFor(g.Identity(), input)
		args := makeEmbedJobArgs(jobKind, g.ID, userID, id, hash)
		if _, err := client.InsertTx(ctx, tx, args, EmbedInsertOpts(jobKind)); err != nil {
			return err
		}
	}
	return nil
}

func mapEmbedKind(kind item.EmbedKind) (generation.Corpus, string, error) {
	switch kind {
	case item.EmbedKindItem:
		return generation.CorpusItem, jobargs.KindEmbedItem, nil
	case item.EmbedKindTag:
		return generation.CorpusTag, jobargs.KindEmbedTag, nil
	default:
		return "", "", ErrInvalidEmbedKind
	}
}
