package jobs

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// JobInserter abstracts inserting a replacement embed job when an existing
// job's input_hash is stale compared to the live target row. When nil on
// Dependencies, the worker falls back to river.ClientFromContextSafely[pgx.Tx].
type JobInserter interface {
	Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// RiverClientInserter adapts a *river.Client[pgx.Tx] to JobInserter.
type RiverClientInserter struct {
	Client *river.Client[pgx.Tx]
}

// Insert delegates to c.Client.Insert.
func (c RiverClientInserter) Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	if c.Client == nil {
		return nil, errors.New("jobs: nil river client")
	}
	return c.Client.Insert(ctx, args, opts)
}

// InsertTx delegates to c.Client.InsertTx.
func (c RiverClientInserter) InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	if c.Client == nil {
		return nil, errors.New("jobs: nil river client")
	}
	return c.Client.InsertTx(ctx, tx, args, opts)
}

// Dependencies bundles the runtime collaborators shared by EmbedItemWorker,
// EmbedTagWorker, and CanaryWorker (plan P05 mục 2.17, Task 11a).
type Dependencies struct {
	Pool       *pgxpool.Pool
	ClientSet  *embedding.ClientSet
	Breakers   map[string]*embedding.Breaker
	Metrics    *obs.EmbeddingMetrics
	Logger     *slog.Logger
	Now        func() time.Time
	Jitter     func() float64
	RandSource embedding.Int63nSource
	Inserter   JobInserter

	// BeforeStep5Tx is an optional test-only hook invoked right after step 4
	// (EmbedDocuments) succeeds and before the step 5 short transaction begins.
	// Used by concurrency barrier tests (e.g. Task 11b rename/delete races) to
	// deterministically interleave mutations without sleeps.
	BeforeStep5Tx func(ctx context.Context, kind string, generationID int, targetID uuid.UUID)

	// BeforeStaleInsert is an optional test-only hook invoked right after a
	// worker detects a stale input_hash (in step 2 when inStep5 is false, or in
	// step 5 when inStep5 is true) and before inserting the replacement job.
	BeforeStaleInsert func(ctx context.Context, kind string, generationID int, targetID uuid.UUID, inStep5 bool)

	// BeforeCanaryPersistTx is an optional test-only hook invoked right after a
	// first-run CheckCanary call succeeds (outside any DB transaction) and before
	// the short FOR UPDATE transaction persists or compares the canary baseline.
	BeforeCanaryPersistTx func(ctx context.Context, generationID int)
}

func (d Dependencies) withDefaults() Dependencies {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Jitter == nil {
		d.Jitter = defaultJitter
	}
	return d
}

// NewWorkerBreakers constructs one worker-mode circuit breaker per supported
// provider ("openai_compat" and "tei") using the supplied clock and metrics
// (plan P05 mục 2.12, Task 11a).
func NewWorkerBreakers(now func() time.Time, metrics *obs.EmbeddingMetrics) map[string]*embedding.Breaker {
	return map[string]*embedding.Breaker{
		embedding.ProviderOpenAICompat: embedding.NewWorkerBreaker(embedding.ProviderOpenAICompat, now, metrics),
		embedding.ProviderTEI:          embedding.NewWorkerBreaker(embedding.ProviderTEI, now, metrics),
	}
}

func (d Dependencies) breakerFor(provider string) *embedding.Breaker {
	if d.Breakers == nil {
		return nil
	}
	return d.Breakers[provider]
}

type embedPayload struct {
	kind         string
	corpus       generation.Corpus
	generationID int
	userIDRaw    string
	targetIDRaw  string
	inputHashHex string
	attempt      int
}

func makeEmbedJobArgs(kind string, genID int, userID, targetID uuid.UUID, hash [32]byte) river.JobArgs {
	hashHex := hex.EncodeToString(hash[:])
	if kind == jobargs.KindEmbedTag {
		return jobargs.EmbedTagArgs{
			GenerationID: genID,
			UserID:       userID.String(),
			TargetID:     targetID.String(),
			InputHash:    hashHex,
		}
	}
	return jobargs.EmbedItemArgs{
		GenerationID: genID,
		UserID:       userID.String(),
		TargetID:     targetID.String(),
		InputHash:    hashHex,
	}
}

// insertStaleReplacement enqueues a replacement job with newHash and reports
// whether the insertion was swallowed by an already-running duplicate job
// (swallowedByRunning == true).
//
// Why a running duplicate is NOT safe to treat as a guaranteed successor
// (EJ2-1):
// River's uniqueness key for EmbedInsertOpts is ByArgs = (generation_id,
// user_id, target_id, input_hash) across ByState = {available, pending,
// retryable, running, scheduled} (River v0.31 requires running in custom
// ByState). Although a duplicate job has the exact same input_hash = newHash,
// if that duplicate is currently in state `running` it may have already read a
// momentarily different target snapshot in its unlocked step 2 (e.g. during an
// A -> B -> A -> B rename cycle across two workers) and be on its way to
// finishing `skipped_stale` itself, or its step 5 may observe another transient
// state. If both running workers deduplicate their replacement inserts against
// each other and both return nil (`skipped_stale`), both jobs transition to
// `completed` and zero jobs remain queued for the final target state.
//
// By contrast, a duplicate in `available`, `pending`, `scheduled`, or
// `retryable` has not yet begun its next execution attempt; when a worker later
// picks it up, its step 2 and step 5 will observe the latest committed target
// row at that future time. Therefore:
//   - Fresh insert (`!UniqueSkippedAsDuplicate`) or duplicate in a non-running
//     state -> successor is guaranteed; caller finishes `skipped_stale`.
//   - Duplicate in state `running` (or missing job metadata when skipped) ->
//     cannot rely on the running peer to embed newHash; caller returns
//     `river.JobSnooze(StaleReplacementSnoozeDuration)` so this job stays alive
//     and re-evaluates after the running peer finishes.
func (d Dependencies) insertStaleReplacement(
	ctx context.Context,
	tx pgx.Tx,
	kind string,
	genID int,
	userID uuid.UUID,
	targetID uuid.UUID,
	newHash [32]byte,
) (swallowedByRunning bool, err error) {
	args := makeEmbedJobArgs(kind, genID, userID, targetID, newHash)
	opts := EmbedInsertOpts(kind)

	res, err := d.rawInsertReplacement(ctx, tx, args, opts)
	if err != nil {
		return false, err
	}
	if res != nil && res.UniqueSkippedAsDuplicate {
		if res.Job == nil || res.Job.State == rivertype.JobStateRunning {
			return true, nil
		}
	}
	return false, nil
}

func (d Dependencies) rawInsertReplacement(
	ctx context.Context,
	tx pgx.Tx,
	args river.JobArgs,
	opts *river.InsertOpts,
) (*rivertype.JobInsertResult, error) {
	if d.Inserter != nil {
		if tx != nil {
			return d.Inserter.InsertTx(ctx, tx, args, opts)
		}
		return d.Inserter.Insert(ctx, args, opts)
	}

	if client, err := river.ClientFromContextSafely[pgx.Tx](ctx); err == nil && client != nil {
		if tx != nil {
			return client.InsertTx(ctx, tx, args, opts)
		}
		return client.Insert(ctx, args, opts)
	}

	if d.Pool == nil {
		return nil, errors.New("jobs: no river client or pool available to insert replacement job")
	}
	fallbackClient, err := river.NewClient(riverpgxv5Driver(d.Pool), &river.Config{
		SkipUnknownJobCheck: true,
	})
	if err != nil {
		return nil, err
	}
	if tx != nil {
		return fallbackClient.InsertTx(ctx, tx, args, opts)
	}
	return fallbackClient.Insert(ctx, args, opts)
}

func executeEmbedJob(ctx context.Context, deps Dependencies, p embedPayload) error {
	deps = deps.withDefaults()
	start := deps.Now()

	finishOutcome := func(outcome, errClass string, retErr error) error {
		recordJobOutcome(deps.Metrics, p.kind, outcome)
		logJobOutcome(ctx, deps.Logger, p.kind, p.generationID, outcome, errClass, p.attempt, deps.Now().Sub(start))
		return retErr
	}

	if deps.Pool == nil {
		return errors.New("jobs: nil database pool")
	}

	userID, err := uuid.Parse(p.userIDRaw)
	if err != nil {
		return errors.New("jobs: invalid user_id UUID")
	}
	targetID, err := uuid.Parse(p.targetIDRaw)
	if err != nil {
		return errors.New("jobs: invalid target_id UUID")
	}
	argsHash, err := hex.DecodeString(p.inputHashHex)
	if err != nil || len(argsHash) != store.InputHashBytes {
		return errors.New("jobs: invalid input_hash hex")
	}

	// Step 1: Resolve generation from args (never from env).
	genRow, err := generation.GetByID(ctx, deps.Pool, p.generationID)
	if err != nil {
		if errors.Is(err, generation.ErrGenerationNotFound) {
			return finishOutcome(OutcomeDiscardedGeneration, "generation_not_receiving", nil)
		}
		return err
	}
	if !isGenerationReceiving(genRow, deps.Now()) {
		return finishOutcome(OutcomeDiscardedGeneration, "generation_not_receiving", nil)
	}

	var client embedding.Client
	var matched bool
	if deps.ClientSet != nil {
		client, matched = deps.ClientSet.Match(genRow.Identity())
	}
	if !matched {
		recordGenerationMismatch(deps.Metrics, MismatchReasonUnconfigured)
		return finishOutcome(
			OutcomeSnoozed,
			"generation_unconfigured",
			river.JobSnooze(UnconfiguredSnoozeDuration),
		)
	}

	// Step 2: Read target without lock.
	targetSnap, ok, err := readTargetUnlocked(ctx, deps.Pool, p.corpus, userID, targetID)
	if err != nil {
		return err
	}
	if !ok || targetSnap.deleted {
		return finishOutcome(OutcomeSkippedDeleted, "", nil)
	}

	currentHash := embedding.InputHashFor(genRow.Identity(), targetSnap.input)
	if !bytes.Equal(currentHash[:], argsHash) {
		recordGenerationMismatch(deps.Metrics, MismatchReasonHash)
		if deps.BeforeStaleInsert != nil {
			deps.BeforeStaleInsert(ctx, p.kind, genRow.ID, targetID, false)
		}
		swallowedByRunning, err := deps.insertStaleReplacement(ctx, nil, p.kind, genRow.ID, userID, targetID, currentHash)
		if err != nil {
			return err
		}
		if swallowedByRunning {
			return finishOutcome(OutcomeSnoozed, "hash_stale", river.JobSnooze(StaleReplacementSnoozeDuration))
		}
		return finishOutcome(OutcomeSkippedStale, "hash_stale", nil)
	}

	storedMeta, hasStored, err := store.GetTargetMeta(ctx, deps.Pool, genRow, p.corpus, userID, targetID)
	if err != nil {
		return err
	}
	if hasStored &&
		bytes.Equal(storedMeta.InputHash, currentHash[:]) &&
		storedMeta.Model == genRow.Model &&
		storedMeta.ModelVersion == genRow.ModelVersion {
		return finishOutcome(OutcomeSkippedFresh, "", nil)
	}

	// Step 3: Check user policy for this generation's provider (BE-3).
	userAlive, semanticSuggest, err := readUserPolicyUnlocked(ctx, deps.Pool, userID)
	if err != nil {
		return err
	}
	if !userAlive {
		return finishOutcome(OutcomeSkippedDeleted, "", nil)
	}
	if genRow.Provider == generation.ProviderOpenAICompat && !semanticSuggest {
		return finishOutcome(OutcomeSkippedUserOff, "", nil)
	}

	// Step 4: Breaker Acquire + EmbedDocuments (no DB locks held during network call).
	breaker := deps.breakerFor(genRow.Provider)
	var finishBreaker func(error)
	if breaker != nil {
		allowed, retryIn, finish := breaker.Acquire()
		if !allowed {
			snoozeDur := embedding.SnoozeFor(nil, retryIn, deps.RandSource)
			return finishOutcome(OutcomeSnoozed, "", river.JobSnooze(snoozeDur))
		}
		finishBreaker = finish
	}

	vecs, embedErr := client.Provider.EmbedDocuments(ctx, []string{targetSnap.input})
	if finishBreaker != nil {
		finishBreaker(embedErr)
	}
	if embedErr != nil {
		errClass := classifyJobError(embedErr)
		if shouldSnoozeOnProviderError(embedErr, breaker) {
			var retryIn time.Duration
			if breaker != nil {
				// Read remaining open window without consuming half-open trial.
				retryIn = embedding.BreakerOpenWindow
			}
			snoozeDur := embedding.SnoozeFor(embedErr, retryIn, deps.RandSource)
			return finishOutcome(OutcomeSnoozed, errClass, river.JobSnooze(snoozeDur))
		}
		logJobOutcome(ctx, deps.Logger, p.kind, p.generationID, "retry", errClass, p.attempt, deps.Now().Sub(start))
		return embedErr
	}
	if len(vecs) != 1 {
		badErr := &embedding.ProviderError{
			Class:  embedding.ClassBadResponse,
			Detail: "unexpected vector count for document",
			Err:    embedding.ErrBadResponse,
		}
		logJobOutcome(ctx, deps.Logger, p.kind, p.generationID, "retry", string(embedding.ClassBadResponse), p.attempt, deps.Now().Sub(start))
		return badErr
	}
	vec := vecs[0]
	if len(vec) != genRow.Dims {
		recordGenerationMismatch(deps.Metrics, MismatchReasonDims)
		dimsErr := fmt.Errorf("%w: got %d, want %d", store.ErrDimsMismatch, len(vec), genRow.Dims)
		logJobOutcome(ctx, deps.Logger, p.kind, p.generationID, "retry", "dims_mismatch", p.attempt, deps.Now().Sub(start))
		return dimsErr
	}

	if deps.BeforeStep5Tx != nil {
		deps.BeforeStep5Tx(ctx, p.kind, genRow.ID, targetID)
	}

	// Step 5: Short transaction with strict lock ordering:
	// target row FOR SHARE -> app_user row FOR SHARE -> re-verify -> store.Upsert.
	// Worker takes NO advisory lock (plan P05 mục 2.15).
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	lockedTarget, ok, err := readTargetForShare(ctx, tx, p.corpus, userID, targetID)
	if err != nil {
		return err
	}
	if !ok || lockedTarget.deleted {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return finishOutcome(OutcomeSkippedDeleted, "", nil)
	}

	lockedUserAlive, lockedSuggest, err := readUserPolicyForShare(ctx, tx, userID)
	if err != nil {
		return err
	}
	if !lockedUserAlive {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return finishOutcome(OutcomeSkippedDeleted, "", nil)
	}

	// Re-check generation still in R inside the tx.
	genLocked, err := generation.GetByID(ctx, tx, p.generationID)
	if err != nil {
		if errors.Is(err, generation.ErrGenerationNotFound) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return commitErr
			}
			return finishOutcome(OutcomeDiscardedGeneration, "generation_not_receiving", nil)
		}
		return err
	}
	if !isGenerationReceiving(genLocked, deps.Now()) {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return finishOutcome(OutcomeDiscardedGeneration, "generation_not_receiving", nil)
	}

	// Re-check user policy for this generation's provider (BE-3).
	if genLocked.Provider == generation.ProviderOpenAICompat && !lockedSuggest {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return finishOutcome(OutcomeSkippedUserOff, "", nil)
	}

	// Recompute input hash under FOR SHARE lock.
	recomputedHash := embedding.InputHashFor(genLocked.Identity(), lockedTarget.input)
	if !bytes.Equal(recomputedHash[:], argsHash) {
		recordGenerationMismatch(deps.Metrics, MismatchReasonHash)
		if deps.BeforeStaleInsert != nil {
			deps.BeforeStaleInsert(ctx, p.kind, genLocked.ID, targetID, true)
		}
		swallowedByRunning, err := deps.insertStaleReplacement(ctx, tx, p.kind, genLocked.ID, userID, targetID, recomputedHash)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if swallowedByRunning {
			return finishOutcome(OutcomeSnoozed, "hash_stale", river.JobSnooze(StaleReplacementSnoozeDuration))
		}
		return finishOutcome(OutcomeSkippedStale, "hash_stale", nil)
	}

	if err := store.Upsert(ctx, tx, genLocked, p.corpus, userID, targetID, vec, argsHash); err != nil {
		if errors.Is(err, store.ErrDimsMismatch) {
			recordGenerationMismatch(deps.Metrics, MismatchReasonDims)
		}
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return finishOutcome(OutcomeUpserted, "", nil)
}

type targetSnapshot struct {
	input   string
	deleted bool
}

func readTargetUnlocked(
	ctx context.Context,
	db gen.DBTX,
	corpus generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
) (targetSnapshot, bool, error) {
	return queryTargetRow(ctx, db, corpus, userID, targetID, false)
}

func readTargetForShare(
	ctx context.Context,
	tx pgx.Tx,
	corpus generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
) (targetSnapshot, bool, error) {
	return queryTargetRow(ctx, tx, corpus, userID, targetID, true)
}

func queryTargetRow(
	ctx context.Context,
	db gen.DBTX,
	corpus generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
	forShare bool,
) (targetSnapshot, bool, error) {
	switch corpus {
	case generation.CorpusItem:
		query := `SELECT name, COALESCE(hint, ''), deleted_at IS NOT NULL FROM item WHERE user_id = $1 AND id = $2`
		if forShare {
			query += ` FOR SHARE`
		}
		var name, hint string
		var deleted bool
		err := db.QueryRow(ctx, query, userID, targetID).Scan(&name, &hint, &deleted)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return targetSnapshot{}, false, nil
			}
			return targetSnapshot{}, false, err
		}
		return targetSnapshot{
			input:   embedding.ItemInput(name, hint),
			deleted: deleted,
		}, true, nil

	case generation.CorpusTag:
		query := `SELECT display, deleted_at IS NOT NULL FROM tag WHERE user_id = $1 AND id = $2`
		if forShare {
			query += ` FOR SHARE`
		}
		var display string
		var deleted bool
		err := db.QueryRow(ctx, query, userID, targetID).Scan(&display, &deleted)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return targetSnapshot{}, false, nil
			}
			return targetSnapshot{}, false, err
		}
		return targetSnapshot{
			input:   embedding.TagInput(display),
			deleted: deleted,
		}, true, nil

	default:
		return targetSnapshot{}, false, generation.ErrInvalidCorpus
	}
}

func readUserPolicyUnlocked(ctx context.Context, db gen.DBTX, userID uuid.UUID) (alive bool, semanticSuggest bool, err error) {
	return queryUserPolicyRow(ctx, db, userID, false)
}

func readUserPolicyForShare(ctx context.Context, tx pgx.Tx, userID uuid.UUID) (alive bool, semanticSuggest bool, err error) {
	return queryUserPolicyRow(ctx, tx, userID, true)
}

func queryUserPolicyRow(ctx context.Context, db gen.DBTX, userID uuid.UUID, forShare bool) (alive bool, semanticSuggest bool, err error) {
	query := `SELECT deleted_at IS NOT NULL, COALESCE((settings->>'semantic_suggest')::boolean, true) FROM app_user WHERE id = $1`
	if forShare {
		query += ` FOR SHARE`
	}
	var deleted bool
	var suggest bool
	if err := db.QueryRow(ctx, query, userID).Scan(&deleted, &suggest); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, false, nil
		}
		return false, false, err
	}
	if deleted {
		return false, false, nil
	}
	return true, suggest, nil
}

// isGenerationReceiving reports whether g is currently in the receiving set
// R = {active} ∪ {pending} ∪ {retired with rollback_until > now} (plan P05
// mục 2.15, ADR 0007 §3).
func isGenerationReceiving(g generation.Generation, now time.Time) bool {
	switch g.State {
	case generation.StateActive, generation.StatePending:
		return true
	case generation.StateRetired:
		return g.RollbackUntil != nil && g.RollbackUntil.After(now)
	default:
		return false
	}
}

func shouldSnoozeOnProviderError(err error, breaker *embedding.Breaker) bool {
	if err == nil {
		return false
	}
	var pe *embedding.ProviderError
	if errors.As(err, &pe) && pe != nil && pe.Class == embedding.Class429 {
		return true
	}
	if breaker != nil && breaker.IsOpen() {
		return true
	}
	return false
}

func classifyJobError(err error) string {
	if err == nil {
		return ""
	}
	var pe *embedding.ProviderError
	if errors.As(err, &pe) && pe != nil {
		return string(pe.Class)
	}
	if errors.Is(err, store.ErrDimsMismatch) {
		return "dims_mismatch"
	}
	if errors.Is(err, embedding.ErrBadResponse) {
		return string(embedding.ClassBadResponse)
	}
	if embedding.IsTimeoutError(err) {
		return string(embedding.ClassTimeout)
	}
	return string(embedding.ClassRefused)
}

func recordJobOutcome(m *obs.EmbeddingMetrics, kind, outcome string) {
	if m == nil || m.JobsTotal == nil {
		return
	}
	switch outcome {
	case OutcomeUpserted,
		OutcomeSkippedStale,
		OutcomeSkippedFresh,
		OutcomeSkippedDeleted,
		OutcomeSkippedUserOff,
		OutcomeDiscardedGeneration,
		OutcomeSnoozed:
		m.JobsTotal.WithLabelValues(kind, outcome).Inc()
	}
}

func recordGenerationMismatch(m *obs.EmbeddingMetrics, reason string) {
	if m == nil || m.GenerationMismatchTotal == nil {
		return
	}
	m.GenerationMismatchTotal.WithLabelValues(reason).Inc()
}

func logJobOutcome(
	ctx context.Context,
	logger *slog.Logger,
	kind string,
	generationID int,
	outcome string,
	errClass string,
	attempt int,
	latency time.Duration,
) {
	if logger == nil {
		return
	}
	if latency < 0 {
		latency = 0
	}
	attrs := []slog.Attr{
		slog.String("kind", kind),
		slog.Int("generation_id", generationID),
		slog.String("outcome", outcome),
		slog.String("error_class", errClass),
		slog.Int("attempt", attempt),
		slog.Float64("latency_ms", float64(latency.Microseconds())/1000.0),
	}
	if errClass != "" && outcome == "retry" {
		logger.LogAttrs(ctx, slog.LevelWarn, "embedding job failed", attrs...)
		return
	}
	logger.LogAttrs(ctx, slog.LevelDebug, "embedding job finished", attrs...)
}
