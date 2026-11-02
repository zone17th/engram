// Package reconcile implements keyset corpus reconciliation and orphan/user-off
// vector cleanup for embedding generations (plan P05 mục 2.15, 2.17, Task 15;
// SPEC §6.6; ADR 0007 §3, §9).
//
// Import direction (M2/FS-24): reconcile imports embedding, generation, store,
// jobargs, db/gen, pgx/pgxpool,river, and stdlib; it never imports
// internal/embedding/jobs or internal/embedding/lifecycle.
//
// Privacy invariant (user-dec-016): Reconcile never reads entry bodies or
// ciphertexts, never calls any embedding provider directly, and returns only
// aggregate counts in Result (never item names, hints, tag displays, or user
// emails).
//
// Deployment gate (SPEC 6.6/6.10): Reconcile itself never reads configuration.
// A caller that applies changes (ModeEnqueue) must first confirm the deployment
// enqueues embeddings at all (semantic search enabled and a non-noop provider);
// the worker boot/periodic wiring only registers the reembed workers when that
// holds, and the `worker reembed` CLI refuses to apply otherwise. ModeDryRun
// writes nothing and is always safe.
package reconcile

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// BatchSize is the keyset scan page size used by Reconcile (plan P05 mục 2.17:
// batches of 500).
const BatchSize = store.DefaultScanLimit

// Mode selects whether Reconcile applies changes (enqueuing jobs and deleting
// orphan/user-off vectors) or runs read-only as a dry-run (BE-11).
type Mode int

const (
	// ModeEnqueue enqueues embed_item/embed_tag jobs for missing or stale targets
	// and deletes orphan and user-off vectors.
	ModeEnqueue Mode = iota
	// ModeDryRun performs zero INSERT, UPDATE, or DELETE statements, enqueues no
	// jobs, and reports proposed actions in Result.Would* fields (BE-11).
	ModeDryRun
)

// String returns the canonical name of m ("enqueue" or "dry_run").
func (m Mode) String() string {
	if m == ModeDryRun {
		return "dry_run"
	}
	return "enqueue"
}

// Scope selects whether Reconcile scans all users or a single user.
type Scope struct {
	userID *uuid.UUID
}

// All returns a Scope that reconciles all users in the target generation.
func All() Scope {
	return Scope{}
}

// User returns a Scope that reconciles only the specified user UUID.
func User(id uuid.UUID) Scope {
	uid := id
	return Scope{userID: &uid}
}

// IsUser reports whether s is scoped to a single user.
func (s Scope) IsUser() bool {
	return s.userID != nil
}

// UserID returns the target user UUID when IsUser() is true, or uuid.Nil.
func (s Scope) UserID() uuid.UUID {
	if s.userID == nil {
		return uuid.Nil
	}
	return *s.userID
}

// EnqueueFunc is injected by callers (such as internal/embedding/jobs) to
// insert an embed_item or embed_tag River job inside tx without reconcile
// importing internal/embedding/jobs (M2/FS-24).
type EnqueueFunc func(ctx context.Context, tx pgx.Tx, args river.JobArgs) error

// StopReason constants when Reconcile stops early without error.
const (
	StopReasonNone                   = ""
	StopReasonGenerationNotReceiving = "generation_not_receiving"
	StopReasonGenerationDropped      = "generation_dropped"
)

// Result holds the privacy-safe aggregate counts produced by Reconcile (plan
// P05 mục 2.17, BE-11, Task 15). It never contains user IDs, target IDs, or
// plaintext names/hints/tags.
type Result struct {
	Scanned        int `json:"scanned"`
	Missing        int `json:"missing"`
	Stale          int `json:"stale"`
	OrphanDeleted  int `json:"orphan_deleted"`
	UserOffDeleted int `json:"user_off_deleted"`
	Enqueued       int `json:"enqueued"`
	SkippedUserOff int `json:"skipped_user_off"`

	// OrphanSkippedRestored counts orphan candidates whose target was restored
	// (deleted_at back to NULL) between the unlocked orphan scan and the locked
	// delete; their vectors are kept.
	OrphanSkippedRestored int `json:"orphan_skipped_restored"`

	WouldEnqueue       int `json:"would_enqueue"`
	WouldDeleteOrphan  int `json:"would_delete_orphan"`
	WouldDeleteUserOff int `json:"would_delete_user_off"`

	StoppedNotReceiving int    `json:"stopped_not_receiving,omitempty"`
	StopReason          string `json:"stop_reason,omitempty"`
}

var (
	// ErrNilPool is returned when Reconcile receives a nil database pool.
	ErrNilPool = errors.New("reconcile: nil database pool")

	// ErrNilEnqueueFunc is returned when ModeEnqueue is requested with a nil EnqueueFunc.
	ErrNilEnqueueFunc = errors.New("reconcile: nil enqueue function in enqueue mode")

	// ErrInvalidUserScope is returned when User(uuid.Nil) is passed.
	ErrInvalidUserScope = errors.New("reconcile: invalid empty user UUID in scope")

	// ErrInvalidMode is returned when an unknown Mode is passed.
	ErrInvalidMode = errors.New("reconcile: invalid reconcile mode")
)

// Reconcile scans item and tag corpora in keyset order (user_id, id) in pages
// of 500 against generation g, enqueuing jobs for missing or stale vectors and
// cleaning up vectors of soft-deleted targets and user-off users in
// openai_compat generations (plan P05 mục 2.15, 2.17, Task 15; SPEC §6.6;
// BE-3, BE-11; ADR 0007 §3, §9).
//
// In ModeDryRun:
//   - Zero INSERT, UPDATE, or DELETE statements are executed.
//   - enq is never called.
//   - Proposed changes are counted in WouldEnqueue, WouldDeleteOrphan, and
//     WouldDeleteUserOff while Enqueued, OrphanDeleted, and UserOffDeleted
//     remain 0.
func Reconcile(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	scope Scope,
	mode Mode,
	enq EnqueueFunc,
) (Result, error) {
	if pool == nil {
		return Result{}, ErrNilPool
	}
	if mode != ModeEnqueue && mode != ModeDryRun {
		return Result{}, ErrInvalidMode
	}
	if mode == ModeEnqueue && enq == nil {
		return Result{}, ErrNilEnqueueFunc
	}
	if scope.IsUser() && scope.UserID() == uuid.Nil {
		return Result{}, ErrInvalidUserScope
	}
	if _, err := g.TableIdent(generation.CorpusItem); err != nil {
		return Result{}, err
	}
	if _, err := g.TableIdent(generation.CorpusTag); err != nil {
		return Result{}, err
	}

	var res Result

	// 1. Scan eligible live targets (item corpus then tag corpus) in batches of 500.
	for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		stopped, err := reconcileCorpusStale(ctx, pool, g, kind, scope, mode, enq, &res)
		if err != nil {
			return res, err
		}
		if stopped {
			return res, nil
		}
	}

	// 2. Scan and remove vectors of soft-deleted or missing targets (orphans).
	for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		stopped, err := reconcileCorpusOrphans(ctx, pool, g, kind, scope, mode, &res)
		if err != nil {
			return res, err
		}
		if stopped {
			return res, nil
		}
	}

	// 3. Per-generation user-off policy (BE-3):
	// For openai_compat generations, users with semantic_suggest=false are
	// skipped during ScanStale and any vectors they hold in this generation are
	// deleted; their live targets are counted in SkippedUserOff.
	// For tei generations, ScanStale already includes user-off users.
	if g.Provider == generation.ProviderOpenAICompat {
		if err := reconcileOpenAICompatUserOff(ctx, pool, g, scope, mode, &res); err != nil {
			return res, err
		}
	}

	return res, nil
}

func reconcileCorpusStale(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	kind generation.Corpus,
	scope Scope,
	mode Mode,
	enq EnqueueFunc,
	res *Result,
) (stopped bool, err error) {
	var cursor *store.ScanCursor
	ident := g.Identity()

	for {
		page, err := store.ScanStale(ctx, pool, g, kind, cursor, scope.userID, BatchSize)
		if err != nil {
			return false, err
		}
		if len(page) == 0 {
			return false, nil
		}

		var toEnqueue []river.JobArgs
		for _, row := range page {
			res.Scanned++

			var input string
			if kind == generation.CorpusItem {
				var hint string
				if row.Hint != nil {
					hint = *row.Hint
				}
				input = embedding.ItemInput(row.Name, hint)
			} else {
				input = embedding.TagInput(row.Display)
			}

			expectedHash := embedding.InputHashFor(ident, input)
			isMissing := !row.HasVector()
			isStale := !isMissing && (!bytes.Equal(row.InputHash, expectedHash[:]) ||
				row.Model != g.Model ||
				row.ModelVersion != g.ModelVersion)

			if !isMissing && !isStale {
				continue
			}
			if isMissing {
				res.Missing++
			} else {
				res.Stale++
			}

			if mode == ModeDryRun {
				res.WouldEnqueue++
				continue
			}

			hashHex := hex.EncodeToString(expectedHash[:])
			if kind == generation.CorpusItem {
				toEnqueue = append(toEnqueue, jobargs.EmbedItemArgs{
					GenerationID: g.ID,
					UserID:       row.UserID.String(),
					TargetID:     row.TargetID.String(),
					InputHash:    hashHex,
				})
			} else {
				toEnqueue = append(toEnqueue, jobargs.EmbedTagArgs{
					GenerationID: g.ID,
					UserID:       row.UserID.String(),
					TargetID:     row.TargetID.String(),
					InputHash:    hashHex,
				})
			}
		}

		if mode == ModeEnqueue && len(toEnqueue) > 0 {
			enqueuedCount, stillReceiving, err := enqueueBatchInTx(ctx, pool, g.ID, toEnqueue, enq)
			if err != nil {
				return false, err
			}
			if !stillReceiving {
				res.StoppedNotReceiving++
				res.StopReason = StopReasonGenerationNotReceiving
				return true, nil
			}
			res.Enqueued += enqueuedCount
		}

		last := page[len(page)-1]
		cursor = &store.ScanCursor{
			UserID:   last.UserID,
			TargetID: last.TargetID,
		}
		if len(page) < BatchSize {
			return false, nil
		}
	}
}

func enqueueBatchInTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	genID int,
	batch []river.JobArgs,
	enq EnqueueFunc,
) (enqueued int, stillReceiving bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return 0, false, err
	}

	receiving, err := generation.ReceivingGenerations(ctx, tx)
	if err != nil {
		return 0, false, err
	}
	if !containsGeneration(receiving, genID) {
		if err := tx.Commit(ctx); err != nil {
			return 0, false, err
		}
		return 0, false, nil
	}

	for _, args := range batch {
		if err := enq(ctx, tx, args); err != nil {
			return 0, true, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, true, err
	}
	return len(batch), true, nil
}

// afterOrphanScanHook is a test-only barrier: when set it runs right after an
// unlocked ScanOrphans page (non-empty, ModeEnqueue) and before the locked
// delete transaction, so a test can restore a target deterministically in that
// window. It is nil in production.
var afterOrphanScanHook atomic.Pointer[func(ctx context.Context, kind generation.Corpus)]

func reconcileCorpusOrphans(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	kind generation.Corpus,
	scope Scope,
	mode Mode,
	res *Result,
) (stopped bool, err error) {
	var cursor *store.ScanCursor

	for {
		orphans, err := store.ScanOrphans(ctx, pool, g, kind, cursor, scope.userID, BatchSize)
		if err != nil {
			return false, err
		}
		if len(orphans) == 0 {
			return false, nil
		}

		if mode == ModeDryRun {
			res.WouldDeleteOrphan += len(orphans)
		} else {
			if hook := afterOrphanScanHook.Load(); hook != nil {
				(*hook)(ctx, kind)
			}
			deleted, skipped, stillExists, err := deleteOrphansInTx(ctx, pool, g, kind, orphans)
			if err != nil {
				return false, err
			}
			if !stillExists {
				res.StopReason = StopReasonGenerationDropped
				return true, nil
			}
			res.OrphanDeleted += deleted
			res.OrphanSkippedRestored += skipped
		}

		last := orphans[len(orphans)-1]
		cursor = &store.ScanCursor{
			UserID:   last.UserID,
			TargetID: last.TargetID,
		}
		if len(orphans) < BatchSize {
			return false, nil
		}
	}
}

// deleteOrphansInTx deletes g's vectors for the scanned orphan candidates that
// are still orphans. The scan was unlocked, so before touching any vector the
// transaction row-locks every candidate target (FOR SHARE, (user_id, id) order)
// and re-reads deleted_at: a target restored since the scan is skipped and
// counted. Lock order follows T11a step 5 (target row first) and then the
// generation-set shared lock, so a concurrent restore either commits before the
// lock (and is skipped) or waits until this transaction ends, after which its
// embed job re-creates the vector. A missing target row is still an orphan.
func deleteOrphansInTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	kind generation.Corpus,
	orphans []store.OrphanVectorRow,
) (deleted, skippedRestored int, stillExists bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	restored, err := lockRestoredTargets(ctx, tx, kind, orphans)
	if err != nil {
		return 0, 0, false, err
	}

	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return 0, 0, false, err
	}

	existing, err := generation.ExistingGenerations(ctx, tx)
	if err != nil {
		return 0, 0, false, err
	}
	if !containsGeneration(existing, g.ID) {
		if err := tx.Commit(ctx); err != nil {
			return 0, 0, false, err
		}
		return 0, 0, false, nil
	}

	for _, o := range orphans {
		if _, live := restored[o]; live {
			skippedRestored++
			continue
		}
		if err := store.DeleteTargetInGeneration(ctx, tx, g, kind, o.UserID, o.TargetID); err != nil {
			return 0, 0, true, err
		}
		deleted++
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, true, err
	}
	return deleted, skippedRestored, true, nil
}

// lockRestoredTargets row-locks (FOR SHARE, (user_id, id) order) every existing
// target row among the orphan candidates, matching both user_id and id, and
// returns the candidates that are live again (deleted_at IS NULL). Soft-deleted
// rows are locked too, so a restore cannot commit between this check and the
// vector delete.
func lockRestoredTargets(
	ctx context.Context,
	tx pgx.Tx,
	kind generation.Corpus,
	orphans []store.OrphanVectorRow,
) (map[store.OrphanVectorRow]struct{}, error) {
	table := "item"
	if kind == generation.CorpusTag {
		table = "tag"
	}
	userIDs := make([]string, 0, len(orphans))
	targetIDs := make([]string, 0, len(orphans))
	for _, o := range orphans {
		userIDs = append(userIDs, o.UserID.String())
		targetIDs = append(targetIDs, o.TargetID.String())
	}
	rows, err := tx.Query(ctx, `SELECT t.user_id, t.id, t.deleted_at IS NULL
		FROM `+table+` t
		JOIN unnest($1::text[]::uuid[], $2::text[]::uuid[]) AS o(user_id, id)
		  ON t.user_id = o.user_id AND t.id = o.id
		ORDER BY t.user_id ASC, t.id ASC
		FOR SHARE OF t`, userIDs, targetIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	live := map[store.OrphanVectorRow]struct{}{}
	for rows.Next() {
		var r store.OrphanVectorRow
		var isLive bool
		if err := rows.Scan(&r.UserID, &r.TargetID, &isLive); err != nil {
			return nil, err
		}
		if isLive {
			live[r] = struct{}{}
		}
	}
	return live, rows.Err()
}

type userOffRow struct {
	userID      uuid.UUID
	liveTargets int
}

func reconcileOpenAICompatUserOff(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	scope Scope,
	mode Mode,
	res *Result,
) error {
	var cursorUser uuid.UUID
	var hasCursor bool

	for {
		users, err := scanUserOffPage(ctx, pool, scope.userID, hasCursor, cursorUser, BatchSize)
		if err != nil {
			return err
		}
		if len(users) == 0 {
			return nil
		}

		for _, u := range users {
			res.SkippedUserOff += u.liveTargets
		}

		if mode == ModeDryRun {
			for _, u := range users {
				cnt, err := countUserVectorsInGeneration(ctx, pool, g, u.userID)
				if err != nil {
					return err
				}
				res.WouldDeleteUserOff += cnt
			}
		} else {
			deleted, stillExists, err := deleteUserOffBatchInTx(ctx, pool, g, users)
			if err != nil {
				return err
			}
			if !stillExists {
				res.StopReason = StopReasonGenerationDropped
				return nil
			}
			res.UserOffDeleted += deleted
		}

		cursorUser = users[len(users)-1].userID
		hasCursor = true
		if len(users) < BatchSize {
			return nil
		}
	}
}

func scanUserOffPage(
	ctx context.Context,
	db gen.DBTX,
	userFilter *uuid.UUID,
	hasCursor bool,
	cursorUser uuid.UUID,
	limit int,
) ([]userOffRow, error) {
	hasUserFilter := userFilter != nil && *userFilter != uuid.Nil
	var filterUID uuid.UUID
	if hasUserFilter {
		filterUID = *userFilter
	}

	const query = `SELECT
			u.id,
			(SELECT count(*)::int FROM item i WHERE i.user_id = u.id AND i.deleted_at IS NULL) +
			(SELECT count(*)::int FROM tag t WHERE t.user_id = u.id AND t.deleted_at IS NULL) AS live_targets
		FROM app_user u
		WHERE u.deleted_at IS NULL
		  AND COALESCE((u.settings->>'semantic_suggest')::boolean, true) = false
		  AND (NOT $1::boolean OR u.id = $2::uuid)
		  AND (NOT $3::boolean OR u.id > $4::uuid)
		ORDER BY u.id ASC
		LIMIT $5`

	rows, err := db.Query(ctx, query, hasUserFilter, filterUID, hasCursor, cursorUser, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []userOffRow
	for rows.Next() {
		var r userOffRow
		if err := rows.Scan(&r.userID, &r.liveTargets); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func countUserVectorsInGeneration(
	ctx context.Context,
	db gen.DBTX,
	g generation.Generation,
	userID uuid.UUID,
) (int, error) {
	total := 0
	for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		tbl, err := store.SanitizedTable(g, kind)
		if err != nil {
			return 0, err
		}
		var cnt int
		if err := db.QueryRow(ctx, `SELECT count(*)::int FROM `+tbl+` WHERE user_id = $1`, userID).Scan(&cnt); err != nil {
			return 0, err
		}
		total += cnt
	}
	return total, nil
}

// deleteUserOffBatchInTx deletes g's vectors of the users in the batch who are
// still user-off. Lock order matches PATCH /me/settings: the app_user rows
// first (FOR SHARE, re-checking the policy after any concurrent writer), then
// the generation-set shared lock (OQ-16), so no lock-order cycle with
// lifecycle's exclusive lock can form.
func deleteUserOffBatchInTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	users []userOffRow,
) (deleted int, stillExists bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	ids := make([]string, 0, len(users))
	for _, u := range users {
		ids = append(ids, u.userID.String())
	}
	locked, err := lockStillUserOff(ctx, tx, ids)
	if err != nil {
		return 0, false, err
	}

	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return 0, false, err
	}

	existing, err := generation.ExistingGenerations(ctx, tx)
	if err != nil {
		return 0, false, err
	}
	if !containsGeneration(existing, g.ID) {
		if err := tx.Commit(ctx); err != nil {
			return 0, false, err
		}
		return 0, false, nil
	}

	for _, uid := range locked {
		before, err := countUserVectorsInGeneration(ctx, tx, g, uid)
		if err != nil {
			return 0, true, err
		}
		if err := store.DeleteUserInGeneration(ctx, tx, g, uid); err != nil {
			return 0, true, err
		}
		deleted += before
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, true, err
	}
	return deleted, true, nil
}

// lockStillUserOff row-locks (FOR SHARE, id order) the live users among ids
// whose semantic_suggest is still false and returns their ids.
func lockStillUserOff(ctx context.Context, tx pgx.Tx, ids []string) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM app_user
		WHERE id = ANY($1::text[]::uuid[])
		  AND deleted_at IS NULL
		  AND COALESCE((settings->>'semantic_suggest')::boolean, true) = false
		ORDER BY id ASC
		FOR SHARE`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func containsGeneration(gens []generation.Generation, id int) bool {
	for _, g := range gens {
		if g.ID == id {
			return true
		}
	}
	return false
}
