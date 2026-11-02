package itemhttp_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

func newRiverInsertClient(t testing.TB, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		SkipUnknownJobCheck: true,
	})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	return client
}

func seedTestGeneration(
	t testing.TB,
	ctx context.Context,
	pool *pgxpool.Pool,
	id int,
	ident embedid.Identity,
	state string,
	rollbackUntil *time.Time,
	bootstrap bool,
) generation.Generation {
	t.Helper()
	q := gen.New(pool)

	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(id),
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          bootstrap,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g%d: %v", id, err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 int32(id),
		Dims:               int32(ident.Dims),
		Partitions:         4,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables g%d: %v", id, err)
	}

	switch state {
	case generation.StateActive:
		row, err = q.ActivateEmbeddingGeneration(ctx, int32(id))
		if err != nil {
			t.Fatalf("ActivateEmbeddingGeneration g%d: %v", id, err)
		}
		reason := "test"
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
			GenerationID:  int32(id),
			FlippedReason: &reason,
		}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
		}
	case generation.StateRetired:
		var ts pgtype.Timestamptz
		if rollbackUntil != nil {
			ts = pgtype.Timestamptz{Time: *rollbackUntil, Valid: true}
		}
		row, err = q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
			ID:            int32(id),
			RollbackUntil: ts,
		})
		if err != nil {
			t.Fatalf("RetireEmbeddingGeneration g%d: %v", id, err)
		}
	case generation.StateDropped:
		if _, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
			ID: int32(id),
		}); err != nil {
			t.Fatalf("RetireEmbeddingGeneration before drop g%d: %v", id, err)
		}
		if err := q.DropEmbeddingGenerationTables(ctx, int32(id)); err != nil {
			t.Fatalf("DropEmbeddingGenerationTables g%d: %v", id, err)
		}
		row, err = q.MarkEmbeddingGenerationDropped(ctx, int32(id))
		if err != nil {
			t.Fatalf("MarkEmbeddingGenerationDropped g%d: %v", id, err)
		}
	}

	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	return g
}

func countRiverJobs(t testing.TB, pool *pgxpool.Pool, kind string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM river_job WHERE kind = $1`, kind).Scan(&n); err != nil {
		t.Fatalf("count river_job(%s): %v", kind, err)
	}
	return n
}

func clearRiverJobs(t testing.TB, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `DELETE FROM river_job`); err != nil {
		t.Fatalf("clear river_job: %v", err)
	}
}

func queryJobGenerationsForTarget(t testing.TB, pool *pgxpool.Pool, kind string, targetID uuid.UUID) []int {
	t.Helper()
	rows, err := pool.Query(
		context.Background(),
		`SELECT (args->>'generation_id')::int FROM river_job WHERE kind = $1 AND args->>'target_id' = $2 ORDER BY (args->>'generation_id')::int ASC`,
		kind,
		targetID.String(),
	)
	if err != nil {
		t.Fatalf("queryJobGenerationsForTarget(%s, %s): %v", kind, targetID, err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan generation_id: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

func assertRiverJobArgsNoPlaintext(t testing.TB, pool *pgxpool.Pool, forbidden ...string) {
	t.Helper()
	rows, err := pool.Query(
		context.Background(),
		`SELECT kind, args::text FROM river_job WHERE kind IN ('embed_item', 'embed_tag') ORDER BY id ASC`,
	)
	if err != nil {
		t.Fatalf("query river_job args: %v", err)
	}
	defer rows.Close()

	allowedKeys := map[string]bool{
		"generation_id": true,
		"user_id":       true,
		"target_id":     true,
		"input_hash":    true,
	}
	for rows.Next() {
		var kind, raw string
		if err := rows.Scan(&kind, &raw); err != nil {
			t.Fatalf("scan river_job args: %v", err)
		}
		for _, f := range forbidden {
			if f != "" && strings.Contains(raw, f) {
				t.Fatalf("river_job (%s) args leaked plaintext %q: %s", kind, f, raw)
			}
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			t.Fatalf("unmarshal river_job args: %v", err)
		}
		if len(parsed) != 4 {
			t.Fatalf("river_job (%s) key count = %d, want 4 (%v)", kind, len(parsed), parsed)
		}
		for k := range parsed {
			if !allowedKeys[k] {
				t.Fatalf("river_job (%s) unexpected key %q in %s", kind, k, raw)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
}

// TestMutationEnqueuesPerReceivingGeneration verifies plan P05 mục 2.15, 2.17,
// 2.18, Task 11b on the real HTTP router for item routes:
//   - R = {g1 bootstrap pending} (no active generation yet) -> POST /items
//     enqueues 1 job for g1 (BE-4), and the enqueued hash matches the hash
//     recomputed by T11a's EmbedItemWorker so a fresh job upserts (never
//     skipped_stale).
//   - R = {g1 tei active, g2 openai_compat pending, g3 tei retired within window}
//     (plus g4 retired past window):
//   - POST /items (`itemCreate`) enqueues 3 jobs (g1, g2, g3).
//   - PATCH /items/{id} (`itemUpdate`) when name/hint changed enqueues 3 jobs;
//     no-op PATCH (name/hint unchanged) enqueues 0 jobs.
//   - DELETE /items/{id} then POST /items/{id}/restore (`itemRestore`) enqueues
//     3 jobs with the current name/hint.
//   - POST/DELETE /items/{id}/tags (assign/unassign tag) enqueues 0 jobs.
//   - Deployment off (`!Enabled` or `noop`) -> 0 jobs.
//   - User-off (`settings.semantic_suggest = false`) -> skips `openai_compat`
//     (g2 = 0) and still enqueues all `tei` generations in R (g1, g3 = 2) (BE-3).
//   - Job args in river_job contain only the 4 ID/hash keys and no plaintext.
func TestMutationEnqueuesPerReceivingGeneration(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	teiClient, err := embedding.NewClientFromConfig(
		ctx,
		embedding.ClientConfig{
			Provider:    embedding.ProviderTEI,
			BaseURL:     embedding.NewEndpoint(srv.URL()),
			Dims:        8,
			QueryPrefix: "query: ",
			DocPrefix:   "passage: ",
		},
		embedding.RolePrimary,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig TEI: %v", err)
	}

	// 1. R = {g1 bootstrap pending} only (BE-4).
	g1 := seedTestGeneration(t, ctx, h.Pool, 1, teiClient.Identity, generation.StatePending, nil, true)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger))

	const (
		sentinelName1 = "Bootstrap-Item-Sentinel-101"
		sentinelHint1 = "Bootstrap-Hint-Sentinel-202"
	)
	respCreate1, bodyCreate1 := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		fmt.Sprintf(`{"name":%q,"hint":%q}`, sentinelName1, sentinelHint1),
		contenttest.ReqOptions{},
	)
	if respCreate1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items bootstrap pending status = %d, body = %s", respCreate1.StatusCode, bodyCreate1)
	}
	created1 := decodeSummary(t, bodyCreate1)
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedItem, created1.ID); !slices.Equal(got, []int{g1.ID}) {
		t.Fatalf("bootstrap pending enqueued gens = %v, want [%d]", got, g1.ID)
	}

	// Verify the enqueued hash equals what T11a's EmbedItemWorker recomputes so
	// working the job finishes with OutcomeUpserted (not skipped_stale).
	var enqueuedHashHex string
	if err := h.Pool.QueryRow(
		ctx,
		`SELECT args->>'input_hash' FROM river_job WHERE kind = 'embed_item' AND args->>'target_id' = $1`,
		created1.ID.String(),
	).Scan(&enqueuedHashHex); err != nil {
		t.Fatalf("read enqueued hash: %v", err)
	}
	wantHash1 := embedding.InputHashFor(g1.Identity(), embedding.ItemInput(sentinelName1, sentinelHint1))
	if enqueuedHashHex != hex.EncodeToString(wantHash1[:]) {
		t.Fatalf("enqueued input_hash = %q, want %x", enqueuedHashHex, wantHash1[:])
	}

	_, m := obs.NewRegistry()
	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      h.Pool,
		ClientSet: embedding.NewClientSet(teiClient, nil),
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
	})
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1, State: rivertype.JobStateRunning},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g1.ID,
			UserID:       userA.User.ID.String(),
			TargetID:     created1.ID.String(),
			InputHash:    enqueuedHashHex,
		},
	}); err != nil {
		t.Fatalf("EmbedItemWorker.Work on mutation-enqueued job: %v", err)
	}
	storedMeta, hasVec, err := store.GetTargetMeta(ctx, h.Pool, g1, generation.CorpusItem, userA.User.ID, created1.ID)
	if err != nil || !hasVec || !bytes.Equal(storedMeta.InputHash, wantHash1[:]) {
		t.Fatalf("worker failed to upsert mutation-enqueued item: hasVec=%v meta=%+v err=%v", hasVec, storedMeta, err)
	}
	assertRiverJobArgsNoPlaintext(t, h.Pool, sentinelName1, sentinelHint1)
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2. Expand R = {g1 tei active, g2 openai_compat pending, g3 tei retired within window}
	// plus g4 retired past window (not in R).
	clearRiverJobs(t, h.Pool)
	q := gen.New(h.Pool)
	if _, err := q.ActivateEmbeddingGeneration(ctx, int32(g1.ID)); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration g1: %v", err)
	}
	futureWindow := time.Now().Add(2 * time.Hour)
	pastWindow := time.Now().Add(-2 * time.Hour)
	teiIdent3 := teiClient.Identity
	teiIdent3.ModelVersion = "rev-3;qp=00000000;dp=11111111"
	g3 := seedTestGeneration(t, ctx, h.Pool, 3, teiIdent3, generation.StateRetired, &futureWindow, false)
	teiIdent4 := teiClient.Identity
	teiIdent4.ModelVersion = "rev-4;qp=00000000;dp=11111111"
	_ = seedTestGeneration(t, ctx, h.Pool, 4, teiIdent4, generation.StateRetired, &pastWindow, false)

	openAIIdent := embedid.Identity{
		Provider:      generation.ProviderOpenAICompat,
		Model:         "openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "openrouter/qwen/qwen3-embedding-8b@dims=8;qi=12345678",
		Dims:          8,
		Preprocessing: "v1",
	}
	g2 := seedTestGeneration(t, ctx, h.Pool, 2, openAIIdent, generation.StatePending, nil, false)
	wantAllR := []int{g1.ID, g2.ID, g3.ID}

	// 2a. POST /items (`itemCreate`) -> 3 jobs.
	const (
		sentinelName2 = "Fanout-Item-Name-303"
		sentinelHint2 = "Fanout-Item-Hint-404"
		sentinelName3 = "Renamed-Item-Name-505"
	)
	respCreate2, bodyCreate2 := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		fmt.Sprintf(`{"name":%q,"hint":%q}`, sentinelName2, sentinelHint2),
		contenttest.ReqOptions{},
	)
	if respCreate2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items status = %d, body = %s", respCreate2.StatusCode, bodyCreate2)
	}
	item2 := decodeSummary(t, bodyCreate2)
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedItem, item2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("POST /items enqueued gens = %v, want %v", got, wantAllR)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2b. PATCH /items/{id} with unchanged name/hint -> 0 new jobs.
	clearRiverJobs(t, h.Pool)
	respNoopPatch, bodyNoopPatch := doReq(
		h,
		jarA,
		http.MethodPatch,
		"/api/v1/items/"+item2.ID.String(),
		fmt.Sprintf(`{"name":%q,"hint":%q}`, sentinelName2, sentinelHint2),
		contenttest.ReqOptions{IfMatch: `"1"`},
	)
	if respNoopPatch.StatusCode != http.StatusOK {
		t.Fatalf("noop PATCH /items status = %d, body = %s", respNoopPatch.StatusCode, bodyNoopPatch)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("noop PATCH /items enqueued %d jobs, want 0", got)
	}

	// 2c. PATCH /items/{id} with changed name -> 3 jobs.
	respPatch, bodyPatch := doReq(
		h,
		jarA,
		http.MethodPatch,
		"/api/v1/items/"+item2.ID.String(),
		fmt.Sprintf(`{"name":%q}`, sentinelName3),
		contenttest.ReqOptions{IfMatch: `"1"`},
	)
	if respPatch.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /items status = %d, body = %s", respPatch.StatusCode, bodyPatch)
	}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedItem, item2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("PATCH /items enqueued gens = %v, want %v", got, wantAllR)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2d. DELETE /items/{id} -> 0 enqueue jobs; then POST /items/{id}/restore -> 3 jobs with current name/hint.
	clearRiverJobs(t, h.Pool)
	advanceRateLimitWindow(h)
	respDel, bodyDel := doReq(
		h,
		jarA,
		http.MethodDelete,
		"/api/v1/items/"+item2.ID.String(),
		"",
		contenttest.ReqOptions{},
	)
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items status = %d, body = %s", respDel.StatusCode, bodyDel)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("DELETE /items enqueued %d jobs, want 0", got)
	}

	respRestore, bodyRestore := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items/"+item2.ID.String()+"/restore",
		`{}`,
		contenttest.ReqOptions{},
	)
	if respRestore.StatusCode != http.StatusOK {
		t.Fatalf("POST /items/{id}/restore status = %d, body = %s", respRestore.StatusCode, bodyRestore)
	}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedItem, item2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("POST /items/{id}/restore enqueued gens = %v, want %v", got, wantAllR)
	}
	var restoreHashG1 string
	if err := h.Pool.QueryRow(
		ctx,
		`SELECT args->>'input_hash' FROM river_job WHERE kind = 'embed_item' AND (args->>'generation_id')::int = $1 AND args->>'target_id' = $2`,
		g1.ID,
		item2.ID.String(),
	).Scan(&restoreHashG1); err != nil {
		t.Fatalf("read restore job hash: %v", err)
	}
	wantRestoreHash := embedding.InputHashFor(g1.Identity(), embedding.ItemInput(sentinelName3, sentinelHint2))
	if restoreHashG1 != hex.EncodeToString(wantRestoreHash[:]) {
		t.Fatalf("restore job hash = %q, want current input hash %x", restoreHashG1, wantRestoreHash[:])
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2e. Assign / unassign tag on item -> 0 embed_item and 0 embed_tag jobs.
	respTagCreate, bodyTagCreate := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/tags",
		`{"display":"assign-check"}`,
		contenttest.ReqOptions{},
	)
	if respTagCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags status = %d, body = %s", respTagCreate.StatusCode, bodyTagCreate)
	}
	var createdTag struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal([]byte(bodyTagCreate), &createdTag); err != nil {
		t.Fatalf("decode created tag: %v", err)
	}
	clearRiverJobs(t, h.Pool)

	respAssign, bodyAssign := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items/"+item2.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, createdTag.ID.String()),
		contenttest.ReqOptions{},
	)
	if respAssign.StatusCode != http.StatusOK {
		t.Fatalf("POST /items/{id}/tags status = %d, body = %s", respAssign.StatusCode, bodyAssign)
	}
	respUnassign, bodyUnassign := doReq(
		h,
		jarA,
		http.MethodDelete,
		"/api/v1/items/"+item2.ID.String()+"/tags/"+createdTag.ID.String(),
		"",
		contenttest.ReqOptions{},
	)
	if respUnassign.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items/{id}/tags/{tag_id} status = %d, body = %s", respUnassign.StatusCode, bodyUnassign)
	}
	if gotItem, gotTag := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem), countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); gotItem != 0 || gotTag != 0 {
		t.Fatalf("assign/unassign tag enqueued embed_item=%d embed_tag=%d, want 0/0", gotItem, gotTag)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 3. Deployment off (`!Enabled` and `noop`) -> 0 jobs.
	advanceRateLimitWindow(h)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, false, embedding.ProviderTEI, h.Content.Logger))
	respOff1, bodyOff1 := doReq(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Deploy Off 1"}`, contenttest.ReqOptions{})
	if respOff1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items deploy off status = %d, body = %s", respOff1.StatusCode, bodyOff1)
	}
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderNoop, h.Content.Logger))
	respOff2, bodyOff2 := doReq(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Deploy Off 2"}`, contenttest.ReqOptions{})
	if respOff2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items noop provider status = %d, body = %s", respOff2.StatusCode, bodyOff2)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("deployment off enqueued %d jobs, want 0", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 4. User-off (`settings.semantic_suggest = false`) -> skips openai_compat (g2),
	// enqueues all tei generations in R (g1, g3) (BE-3).
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderOpenAICompat, h.Content.Logger))
	if _, err := h.Pool.Exec(
		ctx,
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'false'::jsonb) WHERE id = $1`,
		userA.User.ID,
	); err != nil {
		t.Fatalf("set semantic_suggest=false: %v", err)
	}
	respUserOff, bodyUserOff := doReq(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"User Off Item"}`, contenttest.ReqOptions{})
	if respUserOff.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items user off status = %d, body = %s", respUserOff.StatusCode, bodyUserOff)
	}
	userOffItem := decodeSummary(t, bodyUserOff)
	wantTEIOnly := []int{g1.ID, g3.ID}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedItem, userOffItem.ID); !slices.Equal(got, wantTEIOnly) {
		t.Fatalf("user-off enqueued gens = %v, want TEI-only %v (BE-3)", got, wantTEIOnly)
	}
	assertRiverJobArgsNoPlaintext(t, h.Pool, sentinelName2, sentinelHint2, sentinelName3, "User Off Item")
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestMutationRollbackNoJob verifies plan P05 mục 2.17 / Task 11b (evidence P05-B2):
// Mutation paths that fail and roll back (409 item_id_conflict on create,
// 412 version_mismatch on update, 409 item_entry_limit on restore) enqueue 0 jobs.
func TestMutationRollbackNoJob(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-rollback-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger))

	itemID := uuid.New()
	respCreate, bodyCreate := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		fmt.Sprintf(`{"id":%q,"name":"Initial Item"}`, itemID.String()),
		contenttest.ReqOptions{},
	)
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items status = %d, body = %s", respCreate.StatusCode, bodyCreate)
	}
	clearRiverJobs(t, h.Pool)

	// 1. 409 item_id_conflict on POST /items with duplicate ID -> 0 jobs.
	respConflict, bodyConflict := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		fmt.Sprintf(`{"id":%q,"name":"Duplicate ID Item"}`, itemID.String()),
		contenttest.ReqOptions{},
	)
	if respConflict.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bodyConflict).Code != "item_id_conflict" {
		t.Fatalf("duplicate ID POST /items status = %d body = %s, want 409 item_id_conflict", respConflict.StatusCode, bodyConflict)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("409 item_id_conflict enqueued %d jobs, want 0", got)
	}

	// 2. 412 version_mismatch on PATCH /items/{id} -> 0 jobs.
	resp412, body412 := doReq(
		h,
		jarA,
		http.MethodPatch,
		"/api/v1/items/"+itemID.String(),
		`{"name":"Stale Version Update"}`,
		contenttest.ReqOptions{IfMatch: `"99"`},
	)
	if resp412.StatusCode != http.StatusPreconditionFailed || contenttest.DecodeProblem(t, body412).Code != "version_mismatch" {
		t.Fatalf("stale PATCH /items status = %d body = %s, want 412 version_mismatch", resp412.StatusCode, body412)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("412 version_mismatch enqueued %d jobs, want 0", got)
	}

	// 3. 409 item_entry_limit on POST /items/{id}/restore -> 0 jobs.
	respDel, bodyDel := doReq(h, jarA, http.MethodDelete, "/api/v1/items/"+itemID.String(), "", contenttest.ReqOptions{})
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items status = %d, body = %s", respDel.StatusCode, bodyDel)
	}
	// Seed 201 entries via gen.InsertEntry + valid envelope and mark them
	// soft-deleted under the item's delete_batch so restore hits 409 item_entry_limit.
	var batchID uuid.UUID
	if err := h.Pool.QueryRow(ctx, `SELECT delete_batch FROM item WHERE id = $1`, itemID).Scan(&batchID); err != nil {
		t.Fatalf("read delete_batch: %v", err)
	}
	q := gen.New(h.Pool)
	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:1111111111111111111111","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)
	for i := range item.MaxLiveEntriesPerItem + 1 {
		if _, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             userA.User.ID,
			ItemID:             itemID,
			Type:               "text",
			Envelope:           validEnv,
			Ciphertext:         bytes.Repeat([]byte{0x01}, 32),
			PlaintextLenBucket: 256,
		}); err != nil {
			t.Fatalf("InsertEntry %d: %v", i, err)
		}
	}
	if _, err := q.SoftDeleteLiveEntriesByItem(ctx, gen.SoftDeleteLiveEntriesByItemParams{
		DeleteBatch: &batchID,
		UserID:      userA.User.ID,
		ItemID:      itemID,
	}); err != nil {
		t.Fatalf("SoftDeleteLiveEntriesByItem: %v", err)
	}
	clearRiverJobs(t, h.Pool)

	respRestore409, bodyRestore409 := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items/"+itemID.String()+"/restore",
		`{}`,
		contenttest.ReqOptions{},
	)
	if respRestore409.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bodyRestore409).Code != "item_entry_limit" {
		t.Fatalf("restore over limit status = %d body = %s, want 409 item_entry_limit", respRestore409.StatusCode, bodyRestore409)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("409 item_entry_limit restore enqueued %d jobs, want 0", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestEnqueueFailureRollsBack503 verifies plan P05 mục 2.17 / Task 11b:
// When `EmbedHook` returns an error on create, update, delete, or restore:
//   - The handler rolls back the entire transaction (item row is NOT written /
//     NOT updated / NOT deleted / NOT restored, and 0 jobs remain in river_job).
//   - The response is 503 `dependency_unavailable`.
//   - The problem detail and logs never contain the item name, hint, or input.
func TestEnqueueFailureRollsBack503(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-503-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	realEnqueuer := jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger)

	const (
		secretCreateName = "Secret-Rollback-Create-Name-701"
		secretCreateHint = "Secret-Rollback-Create-Hint-702"
		secretUpdateName = "Secret-Rollback-Update-Name-703"
	)

	// 1. Fault on POST /items (even after realEnqueuer inserted a job in tx) -> rolls back both item and job!
	h.Content.SetEmbedHook(spyEmbedHook{
		onUpsert: func(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID, input string) error {
			if err := realEnqueuer.OnUpsert(ctx, tx, userID, kind, id, input); err != nil {
				return err
			}
			return errors.New("simulated enqueue failure: " + input)
		},
	})

	failedCreateID := uuid.New()
	respCreate, bodyCreate := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		fmt.Sprintf(`{"id":%q,"name":%q,"hint":%q}`, failedCreateID.String(), secretCreateName, secretCreateHint),
		contenttest.ReqOptions{},
	)
	if respCreate.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("fault POST /items status = %d, want 503 (body=%s)", respCreate.StatusCode, bodyCreate)
	}
	probCreate := contenttest.DecodeProblem(t, bodyCreate)
	if probCreate.Code != "dependency_unavailable" {
		t.Fatalf("fault POST /items code = %q, want dependency_unavailable", probCreate.Code)
	}
	if strings.Contains(bodyCreate, secretCreateName) || strings.Contains(bodyCreate, secretCreateHint) {
		t.Fatalf("503 problem leaked plaintext: %s", bodyCreate)
	}
	var itemExists bool
	if err := h.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM item WHERE id = $1)`, failedCreateID).Scan(&itemExists); err != nil {
		t.Fatalf("check rolled back item: %v", err)
	}
	if itemExists {
		t.Fatal("expected item row NOT to be written when OnUpsert returns error")
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("expected 0 jobs after tx rollback, got %d", got)
	}

	// Create a valid item with working hook for update/delete/restore rollback checks.
	h.Content.SetEmbedHook(realEnqueuer)
	respOK, bodyOK := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items",
		`{"name":"Stable Name","hint":"Stable Hint"}`,
		contenttest.ReqOptions{},
	)
	if respOK.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items setup status = %d, body = %s", respOK.StatusCode, bodyOK)
	}
	stableItem := decodeSummary(t, bodyOK)
	clearRiverJobs(t, h.Pool)

	// 2. Fault on PATCH /items/{id} -> 503, name not updated, 0 jobs.
	h.Content.SetEmbedHook(spyEmbedHook{
		onUpsert: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID, input string) error {
			return errors.New("simulated update hook failure: " + input)
		},
	})
	respPatch, bodyPatch := doReq(
		h,
		jarA,
		http.MethodPatch,
		"/api/v1/items/"+stableItem.ID.String(),
		fmt.Sprintf(`{"name":%q}`, secretUpdateName),
		contenttest.ReqOptions{IfMatch: `"1"`},
	)
	if respPatch.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyPatch).Code != "dependency_unavailable" {
		t.Fatalf("fault PATCH /items status = %d body = %s, want 503 dependency_unavailable", respPatch.StatusCode, bodyPatch)
	}
	if strings.Contains(bodyPatch, secretUpdateName) {
		t.Fatalf("503 problem leaked update plaintext: %s", bodyPatch)
	}
	var currentName string
	var currentVersion int32
	if err := h.Pool.QueryRow(ctx, `SELECT name, version FROM item WHERE id = $1`, stableItem.ID).Scan(&currentName, &currentVersion); err != nil {
		t.Fatalf("read item after failed PATCH: %v", err)
	}
	if currentName != "Stable Name" || currentVersion != 1 {
		t.Fatalf("item mutated despite hook failure: name=%q version=%d", currentName, currentVersion)
	}

	// 3. Fault on DELETE /items/{id} -> 503, item remains live.
	h.Content.SetEmbedHook(spyEmbedHook{
		onDelete: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID) error {
			return errors.New("simulated delete hook failure")
		},
	})
	respDel, bodyDel := doReq(
		h,
		jarA,
		http.MethodDelete,
		"/api/v1/items/"+stableItem.ID.String(),
		"",
		contenttest.ReqOptions{},
	)
	if respDel.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyDel).Code != "dependency_unavailable" {
		t.Fatalf("fault DELETE /items status = %d body = %s, want 503 dependency_unavailable", respDel.StatusCode, bodyDel)
	}
	var deletedAtValid bool
	if err := h.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM item WHERE id = $1`, stableItem.ID).Scan(&deletedAtValid); err != nil {
		t.Fatalf("check deleted_at after failed DELETE: %v", err)
	}
	if deletedAtValid {
		t.Fatal("expected item NOT to be soft-deleted when OnDelete returns error")
	}

	// Soft-delete with working hook, then test fault on POST /items/{id}/restore.
	h.Content.SetEmbedHook(realEnqueuer)
	advanceRateLimitWindow(h)
	respDelOK, bodyDelOK := doReq(h, jarA, http.MethodDelete, "/api/v1/items/"+stableItem.ID.String(), "", contenttest.ReqOptions{})
	if respDelOK.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items setup status = %d, body = %s", respDelOK.StatusCode, bodyDelOK)
	}
	clearRiverJobs(t, h.Pool)

	// 4. Fault on POST /items/{id}/restore -> 503, item remains soft-deleted, 0 jobs.
	h.Content.SetEmbedHook(spyEmbedHook{
		onUpsert: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID, input string) error {
			return errors.New("simulated restore hook failure: " + input)
		},
	})
	respRestore, bodyRestore := doReq(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items/"+stableItem.ID.String()+"/restore",
		`{}`,
		contenttest.ReqOptions{},
	)
	if respRestore.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyRestore).Code != "dependency_unavailable" {
		t.Fatalf("fault POST /items/{id}/restore status = %d body = %s, want 503 dependency_unavailable", respRestore.StatusCode, bodyRestore)
	}
	if err := h.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM item WHERE id = $1`, stableItem.ID).Scan(&deletedAtValid); err != nil {
		t.Fatalf("check deleted_at after failed restore: %v", err)
	}
	if !deletedAtValid {
		t.Fatal("expected item to remain soft-deleted when restore OnUpsert returns error")
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 0 {
		t.Fatalf("expected 0 jobs after failed restore, got %d", got)
	}

	assertNoPlaintextInLogs(t, h.Logs, secretCreateName, secretCreateHint, secretUpdateName)
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestSoftDeleteRemovesVectorsAllGenerations verifies plan P05 mục 2.15, 2.17,
// Task 11b:
// Soft-deleting an item via `DELETE /api/v1/items/{id}` removes its vectors
// across EVERY existing generation (`state <> 'dropped'`: active, pending,
// retired within rollback window, and retired past rollback window), even when
// deployment semantic search is off (`Enabled: false`), while keeping other
// items' vectors intact.
func TestSoftDeleteRemovesVectorsAllGenerations(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	baseIdent := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-del-1",
		Dims:          4,
		Preprocessing: "v1",
	}
	ident2 := baseIdent
	ident2.ModelVersion = "rev-del-2"
	ident3 := baseIdent
	ident3.ModelVersion = "rev-del-3"
	ident4 := baseIdent
	ident4.ModelVersion = "rev-del-4"
	ident5 := baseIdent
	ident5.ModelVersion = "rev-del-5"

	futureWindow := time.Now().Add(2 * time.Hour)
	pastWindow := time.Now().Add(-24 * time.Hour)
	gActive := seedTestGeneration(t, ctx, h.Pool, 1, baseIdent, generation.StateActive, nil, true)
	gRetiredWithin := seedTestGeneration(t, ctx, h.Pool, 3, ident3, generation.StateRetired, &futureWindow, false)
	gRetiredExpired := seedTestGeneration(t, ctx, h.Pool, 4, ident4, generation.StateRetired, &pastWindow, false)
	_ = seedTestGeneration(t, ctx, h.Pool, 5, ident5, generation.StateDropped, nil, false)
	gPending := seedTestGeneration(t, ctx, h.Pool, 2, ident2, generation.StatePending, nil, false)

	existingGens := []generation.Generation{gActive, gPending, gRetiredWithin, gRetiredExpired}

	// Create two items while deployment is off (still testing OnDelete when deployment is off!).
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, false, embedding.ProviderNoop, h.Content.Logger))
	resp1, body1 := doReq(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Delete Target Item"}`, contenttest.ReqOptions{})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items 1 status = %d, body = %s", resp1.StatusCode, body1)
	}
	targetItem := decodeSummary(t, body1)

	resp2, body2 := doReq(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Keep Target Item"}`, contenttest.ReqOptions{})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items 2 status = %d, body = %s", resp2.StatusCode, body2)
	}
	keepItem := decodeSummary(t, body2)

	vec := []float32{0.5, 0.5, 0.5, 0.5}
	hash := bytes.Repeat([]byte{0x33}, 32)
	for _, g := range existingGens {
		if err := store.Upsert(ctx, h.Pool, g, generation.CorpusItem, userA.User.ID, targetItem.ID, vec, hash); err != nil {
			t.Fatalf("Upsert targetItem g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, h.Pool, g, generation.CorpusItem, userA.User.ID, keepItem.ID, vec, hash); err != nil {
			t.Fatalf("Upsert keepItem g%d: %v", g.ID, err)
		}
	}

	// DELETE /items/{id} while deployment is off -> must remove targetItem vectors from all 4 existing generations.
	respDel, bodyDel := doReq(h, jarA, http.MethodDelete, "/api/v1/items/"+targetItem.ID.String(), "", contenttest.ReqOptions{})
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items status = %d, body = %s", respDel.StatusCode, bodyDel)
	}

	for _, g := range existingGens {
		if _, hasVec, err := store.GetTargetMeta(ctx, h.Pool, g, generation.CorpusItem, userA.User.ID, targetItem.ID); err != nil || hasVec {
			t.Fatalf("g%d (state=%s) retained deleted item vector: hasVec=%v err=%v", g.ID, g.State, hasVec, err)
		}
		if _, hasKeep, err := store.GetTargetMeta(ctx, h.Pool, g, generation.CorpusItem, userA.User.ID, keepItem.ID); err != nil || !hasKeep {
			t.Fatalf("g%d (state=%s) lost keepItem vector: hasKeep=%v err=%v", g.ID, g.State, hasKeep, err)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestIdempotentReplayNoSecondJob verifies plan P05 mục 2.17 / Task 11b:
// Replaying a mutation with the same `Idempotency-Key` and body returns the
// stored response from `Idempotency.Lookup` without invoking the handler or
// enqueuing a second job, even if the first job has already completed.
func TestIdempotentReplayNoSecondJob(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-idem-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger))

	idemKey := "idem-no-second-job-" + uuid.NewString()
	body := `{"name":"Idempotent Item","hint":"once only"}`

	resp1, raw1 := doReq(h, jarA, http.MethodPost, "/api/v1/items", body, contenttest.ReqOptions{IdemKey: idemKey})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST /items status = %d, body = %s", resp1.StatusCode, raw1)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 1 {
		t.Fatalf("river_job count after first request = %d, want 1", got)
	}

	// Mark the first job completed in river_job (so UniqueOpts wouldn't hide a second insert).
	if _, err := h.Pool.Exec(ctx, `UPDATE river_job SET state = 'completed', finalized_at = now()`); err != nil {
		t.Fatalf("mark job completed: %v", err)
	}

	// Replay with the same Idempotency-Key and body -> returns 201 and does NOT insert a second job.
	resp2, raw2 := doReq(h, jarA, http.MethodPost, "/api/v1/items", body, contenttest.ReqOptions{IdemKey: idemKey})
	if resp2.StatusCode != http.StatusCreated || raw2 != raw1 {
		t.Fatalf("replay POST /items status=%d body=%s, want 201 %s", resp2.StatusCode, raw2, raw1)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem); got != 1 {
		t.Fatalf("river_job count after idempotent replay = %d, want still 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}
