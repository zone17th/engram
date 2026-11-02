package taghttp_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
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

type spyTagEmbedHook struct {
	onUpsert func(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID, input string) error
	onDelete func(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID) error
}

func (s spyTagEmbedHook) OnUpsert(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID, input string) error {
	if s.onUpsert != nil {
		return s.onUpsert(ctx, tx, userID, kind, id, input)
	}
	return nil
}

func (s spyTagEmbedHook) OnDelete(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID) error {
	if s.onDelete != nil {
		return s.onDelete(ctx, tx, userID, kind, id)
	}
	return nil
}

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
// 2.18, Task 11b on the real HTTP router for tag routes:
//   - R = {g1 bootstrap pending} (no active generation yet) -> POST /tags
//     (201 create branch) enqueues 1 job for g1 (BE-4), and the enqueued hash
//     matches the hash recomputed by T11a's EmbedTagWorker so a fresh job
//     upserts (never skipped_stale).
//   - R = {g1 tei active, g2 openai_compat pending, g3 tei retired within window}
//     (plus g4 retired past window):
//   - POST /tags (`tagUpsert`): 201 create branch enqueues 3 jobs; 200 existing
//     branch enqueues 0 jobs.
//   - PATCH /tags/{id} (`tagRename`) enqueues 3 jobs.
//   - DELETE /tags/{id} then POST /tags/{id}/restore (`tagRestore`) enqueues
//     3 jobs with the current display.
//   - POST/DELETE /items/{id}/tags (`itemTagsAdd` / `itemTagRemove`) enqueues 0 jobs.
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

	const sentinelTag1 = "bootstrap-tag-sentinel-101"
	respCreate1, bodyCreate1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, sentinelTag1))
	if respCreate1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags bootstrap pending status = %d, body = %s", respCreate1.StatusCode, bodyCreate1)
	}
	tag1 := decodeTag(t, bodyCreate1)
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedTag, tag1.ID); !slices.Equal(got, []int{g1.ID}) {
		t.Fatalf("bootstrap pending enqueued gens = %v, want [%d]", got, g1.ID)
	}

	// Verify the enqueued hash equals what T11a's EmbedTagWorker recomputes.
	var enqueuedHashHex string
	if err := h.Pool.QueryRow(
		ctx,
		`SELECT args->>'input_hash' FROM river_job WHERE kind = 'embed_tag' AND args->>'target_id' = $1`,
		tag1.ID.String(),
	).Scan(&enqueuedHashHex); err != nil {
		t.Fatalf("read enqueued hash: %v", err)
	}
	wantHash1 := embedding.InputHashFor(g1.Identity(), embedding.TagInput(sentinelTag1))
	if enqueuedHashHex != hex.EncodeToString(wantHash1[:]) {
		t.Fatalf("enqueued input_hash = %q, want %x", enqueuedHashHex, wantHash1[:])
	}

	_, m := obs.NewRegistry()
	worker := jobs.NewEmbedTagWorker(jobs.Dependencies{
		Pool:      h.Pool,
		ClientSet: embedding.NewClientSet(teiClient, nil),
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
	})
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedTagArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1, State: rivertype.JobStateRunning},
		Args: jobargs.EmbedTagArgs{
			GenerationID: g1.ID,
			UserID:       userA.User.ID.String(),
			TargetID:     tag1.ID.String(),
			InputHash:    enqueuedHashHex,
		},
	}); err != nil {
		t.Fatalf("EmbedTagWorker.Work on mutation-enqueued job: %v", err)
	}
	storedMeta, hasVec, err := store.GetTargetMeta(ctx, h.Pool, g1, generation.CorpusTag, userA.User.ID, tag1.ID)
	if err != nil || !hasVec || !bytes.Equal(storedMeta.InputHash, wantHash1[:]) {
		t.Fatalf("worker failed to upsert mutation-enqueued tag: hasVec=%v meta=%+v err=%v", hasVec, storedMeta, err)
	}
	assertRiverJobArgsNoPlaintext(t, h.Pool, sentinelTag1)
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2. Expand R = {g1 tei active, g2 openai_compat pending, g3 tei retired within window}
	// plus g4 retired past window.
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

	// 2a. POST /tags (`tagUpsert` 201 create branch) -> 3 jobs.
	const (
		sentinelTag2 = "fanout-tag-display-202"
		sentinelTag3 = "renamed-tag-display-303"
	)
	respCreate2, bodyCreate2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, sentinelTag2))
	if respCreate2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags create status = %d, body = %s", respCreate2.StatusCode, bodyCreate2)
	}
	tag2 := decodeTag(t, bodyCreate2)
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedTag, tag2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("POST /tags create enqueued gens = %v, want %v", got, wantAllR)
	}

	// 2b. POST /tags (`tagUpsert` 200 existing branch) -> 0 jobs!
	clearRiverJobs(t, h.Pool)
	respExisting, bodyExisting := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, strings.ToUpper(sentinelTag2)))
	if respExisting.StatusCode != http.StatusOK {
		t.Fatalf("POST /tags existing status = %d, body = %s", respExisting.StatusCode, bodyExisting)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("POST /tags existing 200 branch enqueued %d jobs, want 0", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2c. PATCH /tags/{id} (`tagRename`) -> 3 jobs.
	respRename, bodyRename := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tag2.ID.String(), fmt.Sprintf(`{"display":%q}`, sentinelTag3))
	if respRename.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /tags/{id} status = %d, body = %s", respRename.StatusCode, bodyRename)
	}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedTag, tag2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("PATCH /tags/{id} enqueued gens = %v, want %v", got, wantAllR)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2d. DELETE /tags/{id} -> 0 enqueue jobs; then POST /tags/{id}/restore -> 3 jobs with current display.
	clearRiverJobs(t, h.Pool)
	advanceRateLimitWindow(h)
	respDel, bodyDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tag2.ID.String(), "")
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /tags/{id} status = %d, body = %s", respDel.StatusCode, bodyDel)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("DELETE /tags/{id} enqueued %d jobs, want 0", got)
	}

	respRestore, bodyRestore := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tag2.ID.String()+"/restore", `{}`)
	if respRestore.StatusCode != http.StatusOK {
		t.Fatalf("POST /tags/{id}/restore status = %d, body = %s", respRestore.StatusCode, bodyRestore)
	}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedTag, tag2.ID); !slices.Equal(got, wantAllR) {
		t.Fatalf("POST /tags/{id}/restore enqueued gens = %v, want %v", got, wantAllR)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2e. Assign / unassign tag on item (`itemTagsAdd` / `itemTagRemove`) -> 0 jobs.
	respItem, bodyItem := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item For Tag Assign"}`)
	if respItem.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items status = %d, body = %s", respItem.StatusCode, bodyItem)
	}
	itemSummary := decodeItemSummary(t, bodyItem)
	clearRiverJobs(t, h.Pool)

	respAddTag, bodyAddTag := doWrite(
		h,
		jarA,
		http.MethodPost,
		"/api/v1/items/"+itemSummary.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, tag2.ID.String()),
	)
	if respAddTag.StatusCode != http.StatusOK {
		t.Fatalf("POST /items/{id}/tags status = %d, body = %s", respAddTag.StatusCode, bodyAddTag)
	}
	respRemTag, bodyRemTag := doWrite(
		h,
		jarA,
		http.MethodDelete,
		"/api/v1/items/"+itemSummary.ID.String()+"/tags/"+tag2.ID.String(),
		"",
	)
	if respRemTag.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /items/{id}/tags/{tag_id} status = %d, body = %s", respRemTag.StatusCode, bodyRemTag)
	}
	remTagItemSummary := decodeItemSummary(t, bodyRemTag)
	if len(remTagItemSummary.Tags) != 0 {
		t.Fatalf("DELETE /items/{id}/tags/{tag_id} tags = %+v, want []", remTagItemSummary.Tags)
	}
	if gotItem, gotTag := countRiverJobs(t, h.Pool, jobargs.KindEmbedItem), countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); gotItem != 0 || gotTag != 0 {
		t.Fatalf("assign/unassign tag enqueued embed_item=%d embed_tag=%d, want 0/0", gotItem, gotTag)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 3. Deployment off (`!Enabled` and `noop`) -> 0 jobs.
	advanceRateLimitWindow(h)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, false, embedding.ProviderTEI, h.Content.Logger))
	respOff1, bodyOff1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"deploy-off-tag-1"}`)
	if respOff1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags deploy off status = %d, body = %s", respOff1.StatusCode, bodyOff1)
	}
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderNoop, h.Content.Logger))
	respOff2, bodyOff2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"deploy-off-tag-2"}`)
	if respOff2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags noop status = %d, body = %s", respOff2.StatusCode, bodyOff2)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("deployment off enqueued %d tag jobs, want 0", got)
	}

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
	respUserOff, bodyUserOff := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"user-off-tag"}`)
	if respUserOff.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags user off status = %d, body = %s", respUserOff.StatusCode, bodyUserOff)
	}
	userOffTag := decodeTag(t, bodyUserOff)
	wantTEIOnly := []int{g1.ID, g3.ID}
	if got := queryJobGenerationsForTarget(t, h.Pool, jobargs.KindEmbedTag, userOffTag.ID); !slices.Equal(got, wantTEIOnly) {
		t.Fatalf("user-off enqueued tag gens = %v, want TEI-only %v (BE-3)", got, wantTEIOnly)
	}
	assertRiverJobArgsNoPlaintext(t, h.Pool, sentinelTag2, sentinelTag3, "user-off-tag")
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestMutationRollbackNoJob verifies plan P05 mục 2.17 / Task 11b for tag routes:
// Mutation paths that fail with 409 (`tag_conflict` on rename and restore) roll
// back without enqueuing any jobs.
func TestMutationRollbackNoJob(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-tag-rollback-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger))

	respT1, bodyT1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"alpha-tag"}`)
	if respT1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags 1: %d %s", respT1.StatusCode, bodyT1)
	}
	tagAlpha := decodeTag(t, bodyT1)

	respT2, bodyT2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"beta-tag"}`)
	if respT2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags 2: %d %s", respT2.StatusCode, bodyT2)
	}
	tagBeta := decodeTag(t, bodyT2)
	clearRiverJobs(t, h.Pool)

	// 1. 409 tag_conflict on PATCH /tags/{id} -> 0 jobs.
	respConflictRename, bodyConflictRename := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tagBeta.ID.String(), `{"display":"ALPHA-TAG"}`)
	if respConflictRename.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bodyConflictRename).Code != "tag_conflict" {
		t.Fatalf("conflict PATCH /tags status=%d body=%s, want 409 tag_conflict", respConflictRename.StatusCode, bodyConflictRename)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("409 tag_conflict rename enqueued %d jobs, want 0", got)
	}

	// 2. 409 tag_conflict on POST /tags/{id}/restore -> 0 jobs.
	respDel, bodyDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tagAlpha.ID.String(), "")
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /tags status=%d body=%s", respDel.StatusCode, bodyDel)
	}
	respReclaim, bodyReclaim := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"alpha-tag"}`)
	if respReclaim.StatusCode != http.StatusCreated {
		t.Fatalf("reclaim POST /tags status=%d body=%s", respReclaim.StatusCode, bodyReclaim)
	}
	clearRiverJobs(t, h.Pool)

	respRestore409, bodyRestore409 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tagAlpha.ID.String()+"/restore", `{}`)
	if respRestore409.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bodyRestore409).Code != "tag_conflict" {
		t.Fatalf("conflict restore status=%d body=%s, want 409 tag_conflict", respRestore409.StatusCode, bodyRestore409)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("409 tag_conflict restore enqueued %d jobs, want 0", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestEnqueueFailureRollsBack503 verifies plan P05 mục 2.17 / Task 11b for tag routes:
// When `EmbedHook` returns an error on tag create, rename, delete, or restore:
//   - The handler rolls back the entire transaction (tag row is NOT written /
//     NOT renamed / NOT deleted / NOT restored, and 0 jobs remain in river_job).
//   - The response is 503 `dependency_unavailable`.
//   - The problem detail and logs never contain the tag display string.
func TestEnqueueFailureRollsBack503(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-tag-503-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	realEnqueuer := jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger)

	const (
		secretCreateTag = "secret-rollback-create-tag-801"
		secretRenameTag = "secret-rollback-rename-tag-802"
	)

	// 1. Fault on POST /tags -> 503, tag row not written, 0 jobs.
	h.Content.SetEmbedHook(spyTagEmbedHook{
		onUpsert: func(ctx context.Context, tx pgx.Tx, userID uuid.UUID, kind item.EmbedKind, id uuid.UUID, input string) error {
			if err := realEnqueuer.OnUpsert(ctx, tx, userID, kind, id, input); err != nil {
				return err
			}
			return errors.New("simulated tag create hook failure: " + input)
		},
	})
	respCreate, bodyCreate := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, secretCreateTag))
	if respCreate.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyCreate).Code != "dependency_unavailable" {
		t.Fatalf("fault POST /tags status=%d body=%s, want 503 dependency_unavailable", respCreate.StatusCode, bodyCreate)
	}
	if strings.Contains(bodyCreate, secretCreateTag) {
		t.Fatalf("503 problem leaked tag display: %s", bodyCreate)
	}
	var tagCount int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM tag WHERE user_id = $1`, userA.User.ID).Scan(&tagCount); err != nil {
		t.Fatalf("count tag rows: %v", err)
	}
	if tagCount != 0 {
		t.Fatalf("expected 0 tag rows after rolled-back create, got %d", tagCount)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 0 {
		t.Fatalf("expected 0 jobs after rolled-back create, got %d", got)
	}

	// Create a valid tag for rename/delete/restore checks.
	h.Content.SetEmbedHook(realEnqueuer)
	respOK, bodyOK := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"stable-tag"}`)
	if respOK.StatusCode != http.StatusCreated {
		t.Fatalf("setup POST /tags status=%d body=%s", respOK.StatusCode, bodyOK)
	}
	stableTag := decodeTag(t, bodyOK)
	clearRiverJobs(t, h.Pool)

	// 2. Fault on PATCH /tags/{id} -> 503, display remains "stable-tag".
	h.Content.SetEmbedHook(spyTagEmbedHook{
		onUpsert: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID, input string) error {
			return errors.New("simulated tag rename hook failure: " + input)
		},
	})
	respRename, bodyRename := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+stableTag.ID.String(), fmt.Sprintf(`{"display":%q}`, secretRenameTag))
	if respRename.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyRename).Code != "dependency_unavailable" {
		t.Fatalf("fault PATCH /tags status=%d body=%s, want 503 dependency_unavailable", respRename.StatusCode, bodyRename)
	}
	if strings.Contains(bodyRename, secretRenameTag) {
		t.Fatalf("503 problem leaked rename tag display: %s", bodyRename)
	}
	var curDisplay string
	if err := h.Pool.QueryRow(ctx, `SELECT display FROM tag WHERE id = $1`, stableTag.ID).Scan(&curDisplay); err != nil {
		t.Fatalf("read tag display: %v", err)
	}
	if curDisplay != "stable-tag" {
		t.Fatalf("tag display mutated despite hook failure: %q", curDisplay)
	}

	// 3. Fault on DELETE /tags/{id} -> 503, tag remains live.
	h.Content.SetEmbedHook(spyTagEmbedHook{
		onDelete: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID) error {
			return errors.New("simulated tag delete hook failure")
		},
	})
	respDel, bodyDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+stableTag.ID.String(), "")
	if respDel.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyDel).Code != "dependency_unavailable" {
		t.Fatalf("fault DELETE /tags status=%d body=%s, want 503 dependency_unavailable", respDel.StatusCode, bodyDel)
	}
	var deletedAtValid bool
	if err := h.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM tag WHERE id = $1`, stableTag.ID).Scan(&deletedAtValid); err != nil {
		t.Fatalf("check tag deleted_at: %v", err)
	}
	if deletedAtValid {
		t.Fatal("expected tag to remain live when OnDelete returns error")
	}

	// Soft-delete with working hook, then test fault on restore.
	h.Content.SetEmbedHook(realEnqueuer)
	advanceRateLimitWindow(h)
	respDelOK, bodyDelOK := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+stableTag.ID.String(), "")
	if respDelOK.StatusCode != http.StatusNoContent {
		t.Fatalf("setup DELETE /tags status=%d body=%s", respDelOK.StatusCode, bodyDelOK)
	}
	clearRiverJobs(t, h.Pool)

	// 4. Fault on POST /tags/{id}/restore -> 503, tag remains soft-deleted.
	h.Content.SetEmbedHook(spyTagEmbedHook{
		onUpsert: func(_ context.Context, _ pgx.Tx, _ uuid.UUID, _ item.EmbedKind, _ uuid.UUID, input string) error {
			return errors.New("simulated tag restore hook failure: " + input)
		},
	})
	respRestore, bodyRestore := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+stableTag.ID.String()+"/restore", `{}`)
	if respRestore.StatusCode != http.StatusServiceUnavailable || contenttest.DecodeProblem(t, bodyRestore).Code != "dependency_unavailable" {
		t.Fatalf("fault POST /tags/{id}/restore status=%d body=%s, want 503 dependency_unavailable", respRestore.StatusCode, bodyRestore)
	}
	if err := h.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM tag WHERE id = $1`, stableTag.ID).Scan(&deletedAtValid); err != nil {
		t.Fatalf("check tag deleted_at after failed restore: %v", err)
	}
	if !deletedAtValid {
		t.Fatal("expected tag to remain soft-deleted when restore OnUpsert returns error")
	}

	assertNoPlaintextInLogs(t, h.Logs, secretCreateTag, secretRenameTag)
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestSoftDeleteRemovesVectorsAllGenerations verifies plan P05 mục 2.15, 2.17,
// Task 11b for tag routes:
// Soft-deleting a tag via `DELETE /api/v1/tags/{id}` removes its vectors across
// EVERY existing generation (`state <> 'dropped'`: active, pending, retired
// within window, and retired past window), even when deployment semantic search
// is disabled (`Enabled: false`), while keeping other tags' vectors intact.
func TestSoftDeleteRemovesVectorsAllGenerations(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	baseIdent := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-tag-del-1",
		Dims:          4,
		Preprocessing: "v1",
	}
	ident2 := baseIdent
	ident2.ModelVersion = "rev-tag-del-2"
	ident3 := baseIdent
	ident3.ModelVersion = "rev-tag-del-3"
	ident4 := baseIdent
	ident4.ModelVersion = "rev-tag-del-4"
	ident5 := baseIdent
	ident5.ModelVersion = "rev-tag-del-5"

	futureWindow := time.Now().Add(2 * time.Hour)
	pastWindow := time.Now().Add(-24 * time.Hour)
	gActive := seedTestGeneration(t, ctx, h.Pool, 1, baseIdent, generation.StateActive, nil, true)
	gRetiredWithin := seedTestGeneration(t, ctx, h.Pool, 3, ident3, generation.StateRetired, &futureWindow, false)
	gRetiredExpired := seedTestGeneration(t, ctx, h.Pool, 4, ident4, generation.StateRetired, &pastWindow, false)
	_ = seedTestGeneration(t, ctx, h.Pool, 5, ident5, generation.StateDropped, nil, false)
	gPending := seedTestGeneration(t, ctx, h.Pool, 2, ident2, generation.StatePending, nil, false)

	existingGens := []generation.Generation{gActive, gPending, gRetiredWithin, gRetiredExpired}

	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, false, embedding.ProviderNoop, h.Content.Logger))
	resp1, body1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"delete-target-tag"}`)
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags 1 status=%d body=%s", resp1.StatusCode, body1)
	}
	targetTag := decodeTag(t, body1)

	resp2, body2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"keep-target-tag"}`)
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags 2 status=%d body=%s", resp2.StatusCode, body2)
	}
	keepTag := decodeTag(t, body2)

	vec := []float32{0.5, 0.5, 0.5, 0.5}
	hash := bytes.Repeat([]byte{0x44}, 32)
	for _, g := range existingGens {
		if err := store.Upsert(ctx, h.Pool, g, generation.CorpusTag, userA.User.ID, targetTag.ID, vec, hash); err != nil {
			t.Fatalf("Upsert targetTag g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, h.Pool, g, generation.CorpusTag, userA.User.ID, keepTag.ID, vec, hash); err != nil {
			t.Fatalf("Upsert keepTag g%d: %v", g.ID, err)
		}
	}

	respDel, bodyDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+targetTag.ID.String(), "")
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /tags status=%d body=%s", respDel.StatusCode, bodyDel)
	}

	for _, g := range existingGens {
		if _, hasVec, err := store.GetTargetMeta(ctx, h.Pool, g, generation.CorpusTag, userA.User.ID, targetTag.ID); err != nil || hasVec {
			t.Fatalf("g%d (state=%s) retained deleted tag vector: hasVec=%v err=%v", g.ID, g.State, hasVec, err)
		}
		if _, hasKeep, err := store.GetTargetMeta(ctx, h.Pool, g, generation.CorpusTag, userA.User.ID, keepTag.ID); err != nil || !hasKeep {
			t.Fatalf("g%d (state=%s) lost keepTag vector: hasKeep=%v err=%v", g.ID, g.State, hasKeep, err)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestIdempotentReplayNoSecondJob verifies plan P05 mục 2.17 / Task 11b for tag routes:
// Replaying `POST /api/v1/tags` with the same `Idempotency-Key` and body returns
// the original 201 response from `Idempotency.Lookup` without enqueuing a second
// `embed_tag` job.
func TestIdempotentReplayNoSecondJob(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()
	riverClient := newRiverInsertClient(t, h.Pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-tag-idem-1",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedTestGeneration(t, ctx, h.Pool, 1, ident, generation.StateActive, nil, true)
	h.Content.SetEmbedHook(jobs.NewEnqueuer(riverClient, true, embedding.ProviderTEI, h.Content.Logger))

	idemKey := "idem-tag-no-second-job-" + uuid.NewString()
	body := `{"display":"idempotent-tag"}`

	resp1, raw1 := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", body, contenttest.ReqOptions{IdemKey: idemKey})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST /tags status=%d body=%s", resp1.StatusCode, raw1)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 1 {
		t.Fatalf("river_job count after first request = %d, want 1", got)
	}

	if _, err := h.Pool.Exec(ctx, `UPDATE river_job SET state = 'completed', finalized_at = now()`); err != nil {
		t.Fatalf("mark job completed: %v", err)
	}

	resp2, raw2 := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", body, contenttest.ReqOptions{IdemKey: idemKey})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("replay POST /tags status=%d body=%s, want 201", resp2.StatusCode, raw2)
	}
	var doc1, doc2 map[string]any
	if err := json.Unmarshal([]byte(raw1), &doc1); err != nil {
		t.Fatalf("unmarshal initial response: %v", err)
	}
	if err := json.Unmarshal([]byte(raw2), &doc2); err != nil {
		t.Fatalf("unmarshal replay response: %v", err)
	}
	if !reflect.DeepEqual(doc2, doc1) {
		t.Fatalf("replay POST /tags JSON = %v, want %v", doc2, doc1)
	}
	if got := countRiverJobs(t, h.Pool, jobargs.KindEmbedTag); got != 1 {
		t.Fatalf("river_job count after idempotent replay = %d, want still 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestClientlessDeleteSkipsGenerationSetLock verifies EJB-2 (plan P05 mục 2.17,
// Task 11b) for tag routes:
// When `compose.NewContent` is constructed without `WithEmbedRiver` or
// `WithEmbedHook`, `ContentEmbedHook()` defaults to `item.NoopEmbedHook{}` so
// `DELETE /api/v1/tags/{id}` completes without acquiring the generation-set lock
// even while another transaction holds `generation.LockGenerationSetExclusive`.
func TestClientlessDeleteSkipsGenerationSetLock(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	ctx := context.Background()
	jarA, userA, _, _ := h.SignupTwoUsers()

	if _, ok := h.Content.ContentEmbedHook().(item.NoopEmbedHook); !ok {
		t.Fatalf("default ContentEmbedHook() = %T, want item.NoopEmbedHook", h.Content.ContentEmbedHook())
	}

	respCreate, bodyCreate := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"clientless-delete-tag"}`)
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags status = %d, body = %s", respCreate.StatusCode, bodyCreate)
	}
	created := decodeTag(t, bodyCreate)

	txLock, err := h.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txLock: %v", err)
	}
	defer func() { _ = txLock.Rollback(ctx) }()
	if err := generation.LockGenerationSetExclusive(ctx, txLock); err != nil {
		t.Fatalf("LockGenerationSetExclusive: %v", err)
	}

	respDel, bodyDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+created.ID.String(), "")
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("clientless DELETE /tags while exclusive gen-set lock held: status = %d, body = %s", respDel.StatusCode, bodyDel)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}
