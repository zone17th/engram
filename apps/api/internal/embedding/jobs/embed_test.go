package jobs_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

var (
	sharedBaseDSNOnce sync.Once
	sharedBaseDSN     string
	sharedBaseErr     error
	sharedContainer   testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedContainer != nil {
		_ = testcontainers.TerminateContainer(sharedContainer)
	}
	os.Exit(code)
}

func basePostgresDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		return envDSN
	}
	sharedBaseDSNOnce.Do(func() {
		ctx := context.Background()
		c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
			tcpostgres.WithDatabase("engram"),
			tcpostgres.WithUsername("engram"),
			tcpostgres.WithPassword("engram"),
			testcontainers.WithWaitStrategy(
				wait.ForLog("database system is ready to accept connections").
					WithOccurrence(2).WithStartupTimeout(90*time.Second)),
		)
		if err != nil {
			sharedBaseErr = err
			return
		}
		sharedContainer = c
		sharedBaseDSN, sharedBaseErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if sharedBaseErr != nil {
		t.Fatalf("start shared Postgres container: %v", sharedBaseErr)
	}
	return sharedBaseDSN
}

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := basePostgresDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_jobs_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+dbName+`"`); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE %s: %v", dbName, err)
	}
	_ = conn.Close(ctx)

	u.Path = "/" + dbName
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+dbName+`" WITH (FORCE)`)
	})

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	return dbtest.Pool(t, dsn)
}

func counterValue(t *testing.T, reg *prometheus.Registry, name string, wantLabels map[string]string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			matched := 0
			for _, lp := range m.GetLabel() {
				if v, ok := wantLabels[lp.GetName()]; ok && v == lp.GetValue() {
					matched++
				}
			}
			if matched == len(wantLabels) && m.GetCounter() != nil {
				return m.GetCounter().GetValue()
			}
		}
	}
	return 0
}

func seedGenerationForIdentity(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	id int,
	ident embedid.Identity,
	state string,
	rollbackUntil *time.Time,
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
		Bootstrap:          id == 1,
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

func newTEIClient(t *testing.T, srv *embedtest.Server, dims int, queryPrefix, docPrefix string) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:    embedding.ProviderTEI,
			BaseURL:     embedding.NewEndpoint(srv.URL()),
			Dims:        dims,
			QueryPrefix: queryPrefix,
			DocPrefix:   docPrefix,
		},
		embedding.RolePrimary,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("newTEIClient: %v", err)
	}
	return c
}

func newOpenAIClient(t *testing.T, srv *embedtest.Server, dims int, model, instr string, role embedding.ClientRole) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:         embedding.ProviderOpenAICompat,
			BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
			APIKey:           embedding.NewSecret("sk-test-embed-worker-key"),
			Model:            model,
			Dims:             dims,
			QueryInstruction: instr,
		},
		role,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("newOpenAIClient: %v", err)
	}
	return c
}

func newInsertClient(t *testing.T, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		SkipUnknownJobCheck: true,
	})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	return client
}

// TestDeadLetterAfter24h verifies plan P05 mục 2.17 / BE-9 and SPEC §6.6:
//   - NextRetry(attempt, now, j) = now + min(1m * 2^(attempt-1), 1h) * (1 + j)
//   - Jitter j is strictly non-negative in [0, 0.20].
//   - For MaxAttempts = 30 (29 retry intervals from attempt 1..29), the minimum
//     total wait at j = 0 is >= 24h (24h03m = 86,580s), and the maximum total
//     wait at j = 0.20 is ~28h51m36s.
func TestDeadLetterAfter24h(t *testing.T) {
	baseTime := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

	opts := jobs.EmbedInsertOpts(jobargs.KindEmbedItem)
	if opts.MaxAttempts != 30 {
		t.Fatalf("EmbedInsertOpts MaxAttempts = %d, want 30", opts.MaxAttempts)
	}
	if opts.Queue != jobs.QueueEmbedding || opts.Priority != 1 {
		t.Fatalf("EmbedInsertOpts Queue=%q Priority=%d, want %q / 1", opts.Queue, opts.Priority, jobs.QueueEmbedding)
	}
	if !opts.UniqueOpts.ByArgs {
		t.Fatal("EmbedInsertOpts UniqueOpts.ByArgs = false, want true")
	}
	for _, st := range opts.UniqueOpts.ByState {
		if st == rivertype.JobStateCompleted || st == rivertype.JobStateDiscarded || st == rivertype.JobStateCancelled {
			t.Fatalf("EmbedInsertOpts ByState unexpectedly includes finalized state %q", st)
		}
	}

	var sumMin time.Duration
	var sumMax time.Duration
	curMin := baseTime
	curMax := baseTime

	for attempt := 1; attempt < jobs.MaxEmbedAttempts; attempt++ {
		nextMin := jobs.NextRetry(attempt, curMin, 0.0)
		waitMin := nextMin.Sub(curMin)
		if waitMin <= 0 {
			t.Fatalf("attempt %d waitMin = %s, want > 0", attempt, waitMin)
		}
		sumMin += waitMin
		curMin = nextMin

		nextMax := jobs.NextRetry(attempt, curMax, 0.20)
		waitMax := nextMax.Sub(curMax)
		if waitMax < waitMin {
			t.Fatalf("attempt %d waitMax (%s) < waitMin (%s)", attempt, waitMax, waitMin)
		}
		sumMax += waitMax
		curMax = nextMax

		// Negative jitter must clamp to 0 (never shorten below base schedule).
		if gotNeg := jobs.NextRetry(attempt, baseTime, -0.50).Sub(baseTime); gotNeg != waitMin {
			t.Fatalf("attempt %d negative jitter wait = %s, want clamped %s", attempt, gotNeg, waitMin)
		}
		// Jitter > 0.20 must clamp to +20%.
		if gotOver := jobs.NextRetry(attempt, baseTime, 0.99).Sub(baseTime); gotOver != waitMax {
			t.Fatalf("attempt %d over-max jitter wait = %s, want clamped %s", attempt, gotOver, waitMax)
		}
	}

	wantMinTotal := 24*time.Hour + 3*time.Minute
	if sumMin != wantMinTotal {
		t.Fatalf("sum of 29 waits at j=0 = %s, want %s (>= 24h)", sumMin, wantMinTotal)
	}
	if sumMin < 24*time.Hour {
		t.Fatalf("dead-letter minimum schedule = %s, must be >= 24h", sumMin)
	}
	t.Logf("BE-9 retry schedule verified: 29 waits min(j=0)=%s, max(j=0.20)=%s", sumMin, sumMax)

	// Verify worker NextRetry method uses injected clock + jitter source.
	fixedNow := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	itemWorker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Now:    func() time.Time { return fixedNow },
		Jitter: func() float64 { return 0.10 },
	})
	gotItemRetry := itemWorker.NextRetry(&river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 3},
	})
	wantAttempt3 := fixedNow.Add(jobs.RetryWait(3, 0.10))
	if !gotItemRetry.Equal(wantAttempt3) {
		t.Fatalf("EmbedItemWorker.NextRetry(attempt=3, j=0.10) = %s, want %s", gotItemRetry, wantAttempt3)
	}
}

// TestEmbedCreateWritesHash verifies that working an embed_item and embed_tag
// job inserted directly writes the vector row into the generation's table with
// the exact 32-byte input_hash from the job arguments and increments
// embedding_jobs_total{kind,outcome="upserted"}.
func TestEmbedCreateWritesHash(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()

	client := newTEIClient(t, srv, 8, "query: ", "passage: ")
	cs := embedding.NewClientSet(client, nil)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "create-hash@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	hint := "mạng wifi tầng 2"
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Bộ phát WiFi",
		NameNormalized: "bộ phát wifi",
		Hint:           &hint,
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	tagRow, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     user.ID,
		Display:    "mạng-nhà",
		Normalized: "mạng-nhà",
	})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}

	itemInput := embedding.ItemInput(itemRow.Name, hint)
	itemHash := embedding.InputHashFor(g1.Identity(), itemInput)
	tagInput := embedding.TagInput(tagRow.Display)
	tagHash := embedding.InputHashFor(g1.Identity(), tagInput)

	reg, m := obs.NewRegistry()
	deps := jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: newInsertClient(t, pool)},
	}

	itemWorker := jobs.NewEmbedItemWorker(deps)
	err = itemWorker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g1.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(itemHash[:]),
		},
	})
	if err != nil {
		t.Fatalf("EmbedItemWorker.Work: %v", err)
	}

	storedItem, ok, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusItem, user.ID, itemRow.ID)
	if err != nil || !ok {
		t.Fatalf("GetTargetMeta(item): ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(storedItem.InputHash, itemHash[:]) {
		t.Fatalf("stored item input_hash = %x, want %x", storedItem.InputHash, itemHash[:])
	}
	if storedItem.Model != g1.Model || storedItem.ModelVersion != g1.ModelVersion {
		t.Fatalf("stored item model/version = %q/%q, want %q/%q", storedItem.Model, storedItem.ModelVersion, g1.Model, g1.ModelVersion)
	}

	tagWorker := jobs.NewEmbedTagWorker(deps)
	err = tagWorker.Work(ctx, &river.Job[jobargs.EmbedTagArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedTagArgs{
			GenerationID: g1.ID,
			UserID:       user.ID.String(),
			TargetID:     tagRow.ID.String(),
			InputHash:    hex.EncodeToString(tagHash[:]),
		},
	})
	if err != nil {
		t.Fatalf("EmbedTagWorker.Work: %v", err)
	}

	storedTag, ok, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusTag, user.ID, tagRow.ID)
	if err != nil || !ok {
		t.Fatalf("GetTargetMeta(tag): ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(storedTag.InputHash, tagHash[:]) {
		t.Fatalf("stored tag input_hash = %x, want %x", storedTag.InputHash, tagHash[:])
	}

	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeUpserted}); got != 1 {
		t.Fatalf("embedding_jobs_total{embed_item,upserted} = %v, want 1", got)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedTag, "outcome": jobs.OutcomeUpserted}); got != 1 {
		t.Fatalf("embedding_jobs_total{embed_tag,upserted} = %v, want 1", got)
	}
}

// TestGenerationMismatchSnoozes verifies BE-1 / M1 (plan P05 mục 2.12, 2.17):
//   - Same model ID with a different model_version, doc_prefix, or preprocessing
//     fails ClientSet.Match(gen.Identity()) -> returns river.JobSnooze(5m),
//     increments embedding_jobs_total{outcome="snoozed"} and
//     embedding_generation_mismatch_total{reason="unconfigured"}, makes 0
//     provider calls, and writes 0 vectors.
//   - Matching full 7-field identity with a non-empty doc_prefix succeeds,
//     applies the doc_prefix once (inside TEI provider, never doubled), and
//     upserts the vector.
func TestGenerationMismatchSnoozes(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{
		Dims:     8,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "rev-0001",
	})
	defer srv.Close()

	// Configured client has non-empty doc_prefix = "passage: ".
	configuredClient := newTEIClient(t, srv, 8, "query: ", "passage: ")
	cs := embedding.NewClientSet(configuredClient, nil)
	baseIdent := configuredClient.Identity

	// g1: different model_version (same model ID "tei/BAAI/bge-m3").
	diffVersionIdent := baseIdent
	diffVersionIdent.ModelVersion = "rev-9999;qp=00000000;dp=11111111"
	gDiffVersion := seedGenerationForIdentity(t, ctx, pool, 1, diffVersionIdent, generation.StateActive, nil)

	// g2: different doc_prefix (same model ID and version string).
	diffDocPrefixIdent := baseIdent
	diffDocPrefixIdent.DocPrefix = "document: "
	gDiffDocPrefix := seedGenerationForIdentity(t, ctx, pool, 2, diffDocPrefixIdent, generation.StatePending, nil)

	// g3: different preprocessing (same model ID, version, prefixes).
	diffPreprocIdent := baseIdent
	diffPreprocIdent.Preprocessing = "v2"
	rollUntil := time.Now().Add(time.Hour)
	gDiffPreproc := seedGenerationForIdentity(t, ctx, pool, 3, diffPreprocIdent, generation.StateRetired, &rollUntil)

	// g4: exact 7-field match with non-empty doc_prefix = "passage: ".
	gMatch := seedGenerationForIdentity(t, ctx, pool, 4, baseIdent, generation.StateRetired, &rollUntil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "mismatch-snooze@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Router Admin",
		NameNormalized: "router admin",
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	input := embedding.ItemInput(itemRow.Name, "")

	reg, m := obs.NewRegistry()
	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
	})

	srv.ResetCalls()
	mismatchGens := []struct {
		name string
		gen  generation.Generation
	}{
		{name: "different_model_version", gen: gDiffVersion},
		{name: "different_doc_prefix", gen: gDiffDocPrefix},
		{name: "different_preprocessing", gen: gDiffPreproc},
	}

	for _, tc := range mismatchGens {
		h := embedding.InputHashFor(tc.gen.Identity(), input)
		err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{Attempt: 1},
			Args: jobargs.EmbedItemArgs{
				GenerationID: tc.gen.ID,
				UserID:       user.ID.String(),
				TargetID:     itemRow.ID.String(),
				InputHash:    hex.EncodeToString(h[:]),
			},
		})
		var snoozeErr *river.JobSnoozeError
		if !errors.As(err, &snoozeErr) {
			t.Fatalf("[%s] Work err = %v, want *river.JobSnoozeError", tc.name, err)
		}
		if snoozeErr.Duration != jobs.UnconfiguredSnoozeDuration {
			t.Fatalf("[%s] snooze duration = %s, want %s", tc.name, snoozeErr.Duration, jobs.UnconfiguredSnoozeDuration)
		}
		if _, hasVec, err := store.GetTargetMeta(ctx, pool, tc.gen, generation.CorpusItem, user.ID, itemRow.ID); err != nil || hasVec {
			t.Fatalf("[%s] expected 0 vectors written, got hasVec=%v err=%v", tc.name, hasVec, err)
		}
	}

	if stats := srv.Stats(); stats.DocumentRequests != 0 || stats.TotalRequests != 0 {
		t.Fatalf("provider calls during mismatch snoozes = %+v, want 0", stats)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSnoozed}); got != 3 {
		t.Fatalf("embedding_jobs_total{embed_item,snoozed} = %v, want 3", got)
	}
	if got := counterValue(t, reg, "embedding_generation_mismatch_total", map[string]string{"reason": jobs.MismatchReasonUnconfigured}); got != 3 {
		t.Fatalf("embedding_generation_mismatch_total{unconfigured} = %v, want 3", got)
	}

	// Now work the matching generation g4 (non-empty doc_prefix = "passage: ").
	matchHash := embedding.InputHashFor(gMatch.Identity(), input)
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gMatch.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(matchHash[:]),
		},
	}); err != nil {
		t.Fatalf("matching generation Work: %v", err)
	}

	if stats := srv.Stats(); stats.DocumentRequests != 1 {
		t.Fatalf("DocumentRequests after matching job = %d, want 1", stats.DocumentRequests)
	}
	lastCall, ok := srv.LastCall()
	if !ok || len(lastCall.Inputs) != 1 {
		t.Fatalf("LastCall = %+v, want 1 input", lastCall)
	}
	// Verify doc_prefix was applied exactly once (by TEI provider, not doubled).
	wantSent := "passage: " + input
	if lastCall.Inputs[0] != wantSent {
		t.Fatalf("provider received input %q, want %q (doc_prefix applied once)", lastCall.Inputs[0], wantSent)
	}
	if _, hasVec, err := store.GetTargetMeta(ctx, pool, gMatch, generation.CorpusItem, user.ID, itemRow.ID); err != nil || !hasVec {
		t.Fatalf("matching generation vector missing: hasVec=%v err=%v", hasVec, err)
	}
}

// TestUserOffSkipsOnlyOpenAICompatGeneration verifies BE-3 (plan P05 mục 2.15,
// 2.17, 2.18; SPEC §6.10):
// When R = {tei active, openai_compat pending} and the user has
// settings.semantic_suggest = false:
//   - The tei job embeds and upserts normally (self-hosted index stays warm).
//   - The openai_compat job finishes with outcome skipped_user_off, makes 0
//     calls to the external provider, and writes 0 vectors into the
//     openai_compat generation table.
func TestUserOffSkipsOnlyOpenAICompatGeneration(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	teiSrv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "tei-sha-1"})
	defer teiSrv.Close()
	openAISrv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer openAISrv.Close()

	teiClient := newTEIClient(t, teiSrv, 8, "", "")
	openAIClient := newOpenAIClient(t, openAISrv, 8, "openrouter/qwen/qwen3-embedding-8b", "Retrieve items", embedding.RoleShadow)
	cs := embedding.NewClientSet(teiClient, &openAIClient)

	// R = g1 (tei active) + g2 (openai_compat pending).
	gTEI := seedGenerationForIdentity(t, ctx, pool, 1, teiClient.Identity, generation.StateActive, nil)
	gOpenAI := seedGenerationForIdentity(t, ctx, pool, 2, openAIClient.Identity, generation.StatePending, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "user-off-be3@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'false'::jsonb) WHERE id = $1`,
		user.ID,
	); err != nil {
		t.Fatalf("set semantic_suggest=false: %v", err)
	}

	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Tài khoản ngân hàng",
		NameNormalized: "tài khoản ngân hàng",
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	input := embedding.ItemInput(itemRow.Name, "")

	reg, m := obs.NewRegistry()
	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
	})

	teiSrv.ResetCalls()
	openAISrv.ResetCalls()

	// 1. Run job for g1 (tei active) -> must upsert.
	hashTEI := embedding.InputHashFor(gTEI.Identity(), input)
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gTEI.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(hashTEI[:]),
		},
	}); err != nil {
		t.Fatalf("TEI generation Work: %v", err)
	}

	// 2. Run job for g2 (openai_compat pending) -> must skip with skipped_user_off and 0 provider calls.
	hashOpenAI := embedding.InputHashFor(gOpenAI.Identity(), input)
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gOpenAI.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(hashOpenAI[:]),
		},
	}); err != nil {
		t.Fatalf("OpenAI generation Work: %v", err)
	}

	if teiSrv.Stats().DocumentRequests != 1 {
		t.Fatalf("TEI DocumentRequests = %d, want 1", teiSrv.Stats().DocumentRequests)
	}
	if openAISrv.Stats().DocumentRequests != 0 || openAISrv.Stats().TotalRequests != 0 {
		t.Fatalf("OpenAI provider calls when user off = %+v, want 0", openAISrv.Stats())
	}

	if _, hasTEI, err := store.GetTargetMeta(ctx, pool, gTEI, generation.CorpusItem, user.ID, itemRow.ID); err != nil || !hasTEI {
		t.Fatalf("expected vector in TEI generation, got hasTEI=%v err=%v", hasTEI, err)
	}
	if _, hasOpenAI, err := store.GetTargetMeta(ctx, pool, gOpenAI, generation.CorpusItem, user.ID, itemRow.ID); err != nil || hasOpenAI {
		t.Fatalf("expected NO vector in OpenAI generation, got hasOpenAI=%v err=%v", hasOpenAI, err)
	}

	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeUpserted}); got != 1 {
		t.Fatalf("embedding_jobs_total{embed_item,upserted} = %v, want 1", got)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSkippedUserOff}); got != 1 {
		t.Fatalf("embedding_jobs_total{embed_item,skipped_user_off} = %v, want 1", got)
	}
}

// TestJobArgsHaveNoPlaintext verifies user-dec-016 and plan P05 mục 1, 2.17:
// Raw river_job.args JSON stored in Postgres for embed_item and embed_tag jobs
// contains ONLY the four keys {generation_id, user_id, target_id, input_hash}
// and never contains item names, hints, tag display strings, or entry bodies,
// including when a stale job inserts a replacement job with the new hash.
func TestJobArgsHaveNoPlaintext(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "no-plaintext-args@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}

	const (
		sentinelItemName = "Secret-Item-Name-Sentinel-9911"
		sentinelItemHint = "Secret-Item-Hint-Sentinel-8822"
		sentinelTagDisp  = "secret-tag-display-sentinel-7733"
	)

	hint := sentinelItemHint
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           sentinelItemName,
		NameNormalized: strings.ToLower(sentinelItemName),
		Hint:           &hint,
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	tagRow, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     user.ID,
		Display:    sentinelTagDisp,
		Normalized: sentinelTagDisp,
	})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}

	riverClient := newInsertClient(t, pool)
	staleHash := bytes.Repeat([]byte{0xab}, 32)
	tagHash := embedding.InputHashFor(g1.Identity(), embedding.TagInput(tagRow.Display))

	if _, err := riverClient.Insert(ctx, jobargs.EmbedItemArgs{
		GenerationID: g1.ID,
		UserID:       user.ID.String(),
		TargetID:     itemRow.ID.String(),
		InputHash:    hex.EncodeToString(staleHash),
	}, jobs.EmbedInsertOpts(jobargs.KindEmbedItem)); err != nil {
		t.Fatalf("Insert stale embed_item: %v", err)
	}
	if _, err := riverClient.Insert(ctx, jobargs.EmbedTagArgs{
		GenerationID: g1.ID,
		UserID:       user.ID.String(),
		TargetID:     tagRow.ID.String(),
		InputHash:    hex.EncodeToString(tagHash[:]),
	}, jobs.EmbedInsertOpts(jobargs.KindEmbedTag)); err != nil {
		t.Fatalf("Insert embed_tag: %v", err)
	}

	// Working the stale embed_item job must also enqueue a replacement job in river_job.
	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
	})
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g1.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(staleHash),
		},
	}); err != nil {
		t.Fatalf("Work stale embed_item: %v", err)
	}

	rows, err := pool.Query(ctx, `SELECT kind, args::text FROM river_job WHERE kind IN ('embed_item', 'embed_tag') ORDER BY id ASC`)
	if err != nil {
		t.Fatalf("query river_job: %v", err)
	}
	defer rows.Close()

	var jobCount int
	allowedKeys := map[string]bool{
		"generation_id": true,
		"user_id":       true,
		"target_id":     true,
		"input_hash":    true,
	}

	for rows.Next() {
		jobCount++
		var kind, rawArgs string
		if err := rows.Scan(&kind, &rawArgs); err != nil {
			t.Fatalf("Scan river_job: %v", err)
		}
		for _, sentinel := range []string{sentinelItemName, sentinelItemHint, sentinelTagDisp} {
			if strings.Contains(rawArgs, sentinel) {
				t.Fatalf("river_job (%s) args leaked plaintext sentinel %q: %s", kind, sentinel, rawArgs)
			}
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(rawArgs), &parsed); err != nil {
			t.Fatalf("Unmarshal river_job.args: %v", err)
		}
		if len(parsed) != 4 {
			t.Fatalf("river_job.args key count = %d, want 4 (%v)", len(parsed), parsed)
		}
		for k := range parsed {
			if !allowedKeys[k] {
				t.Fatalf("river_job.args has unexpected key %q", k)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	if jobCount < 3 {
		t.Fatalf("expected at least 3 river_job rows (initial item + replacement item + tag), got %d", jobCount)
	}
}

// TestEmbedWorkerNilMetrics verifies that EmbedItemWorker, EmbedTagWorker, and
// CanaryWorker never panic across outcomes when Metrics (and Logger) are nil.
func TestEmbedWorkerNilMetrics(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "nil-metrics@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Nil Metrics Item",
		NameNormalized: "nil metrics item",
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}

	deps := jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, nil),
		Metrics:   nil,
		Logger:    nil,
		Inserter:  jobs.RiverClientInserter{Client: newInsertClient(t, pool)},
	}
	itemWorker := jobs.NewEmbedItemWorker(deps)

	// 1. Upserted with nil metrics.
	h := embedding.InputHashFor(g1.Identity(), embedding.ItemInput(itemRow.Name, ""))
	if err := itemWorker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g1.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(h[:]),
		},
	}); err != nil {
		t.Fatalf("nil metrics upserted: %v", err)
	}

	// 2. Skipped fresh with nil metrics.
	if err := itemWorker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g1.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(h[:]),
		},
	}); err != nil {
		t.Fatalf("nil metrics skipped_fresh: %v", err)
	}

	// 3. Discarded generation with nil metrics.
	if err := itemWorker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: 999,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(h[:]),
		},
	}); err != nil {
		t.Fatalf("nil metrics discarded_generation: %v", err)
	}

	// 4. CanaryWorker with nil metrics.
	canaryWorker := jobs.NewCanaryWorker(deps)
	if err := canaryWorker.Work(ctx, &river.Job[jobargs.CanaryArgs]{}); err != nil {
		t.Fatalf("nil metrics CanaryWorker: %v", err)
	}
}

// TestEmbedWorkerOutcomesAndLogs verifies all remaining worker outcomes from
// plan P05 mục 2.17 / 2.21:
//   - discarded_generation (missing generation or retired past rollback_until)
//   - skipped_deleted (missing or soft-deleted target)
//   - skipped_stale (enqueues replacement job with current hash)
//   - skipped_fresh (already upserted with matching hash + model + model_version)
//   - snoozed when circuit breaker is open or provider returns 429 Retry-After
//   - provider 5xx returns error for River retry WITHOUT incrementing retry/dead
//     in embedding_jobs_total (FS-28: Task 20a owns retry/dead)
//   - worker logs never contain user IDs, item/tag names, hints, or secrets.
func TestEmbedWorkerOutcomesAndLogs(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)

	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	curNow := now

	gActive := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)
	expiredRollback := now.Add(-time.Hour)
	gExpiredRetired := seedGenerationForIdentity(t, ctx, pool, 2, client.Identity, generation.StateRetired, &expiredRollback)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "outcomes-test@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}

	const (
		secretName = "Outcome-Secret-Item-Name-5511"
		secretHint = "Outcome-Secret-Item-Hint-6622"
	)
	hint := secretHint
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           secretName,
		NameNormalized: strings.ToLower(secretName),
		Hint:           &hint,
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	deletedItemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Deleted Item",
		NameNormalized: "deleted item",
	})
	if err != nil {
		t.Fatalf("InsertItem deleted: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE item SET deleted_at = now() WHERE id = $1`, deletedItemRow.ID); err != nil {
		t.Fatalf("soft-delete item: %v", err)
	}

	reg, m := obs.NewRegistry()
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	riverClient := newInsertClient(t, pool)
	breakers := jobs.NewWorkerBreakers(func() time.Time { return curNow }, m.Embedding)

	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  breakers,
		Metrics:   m.Embedding,
		Logger:    logger,
		Now:       func() time.Time { return curNow },
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
	})

	curInput := embedding.ItemInput(secretName, secretHint)
	curHash := embedding.InputHashFor(gActive.Identity(), curInput)

	// 1. Retired generation past rollback_until -> discarded_generation.
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gExpiredRetired.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(curHash[:]),
		},
	}); err != nil {
		t.Fatalf("expired retired generation Work: %v", err)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeDiscardedGeneration}); got != 1 {
		t.Fatalf("discarded_generation count = %v, want 1", got)
	}

	// 2. Soft-deleted target -> skipped_deleted.
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     deletedItemRow.ID.String(),
			InputHash:    hex.EncodeToString(curHash[:]),
		},
	}); err != nil {
		t.Fatalf("soft-deleted target Work: %v", err)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSkippedDeleted}); got != 1 {
		t.Fatalf("skipped_deleted count = %v, want 1", got)
	}

	// 3. Stale input_hash -> enqueues replacement job with curHash and finishes skipped_stale.
	staleHash := bytes.Repeat([]byte{0x42}, 32)
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(staleHash),
		},
	}); err != nil {
		t.Fatalf("stale hash Work: %v", err)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSkippedStale}); got != 1 {
		t.Fatalf("skipped_stale count = %v, want 1", got)
	}
	var replacementHash string
	if err := pool.QueryRow(ctx,
		`SELECT args->>'input_hash' FROM river_job WHERE kind = 'embed_item' ORDER BY id DESC LIMIT 1`,
	).Scan(&replacementHash); err != nil {
		t.Fatalf("query replacement job: %v", err)
	}
	if replacementHash != hex.EncodeToString(curHash[:]) {
		t.Fatalf("replacement job input_hash = %q, want %x", replacementHash, curHash[:])
	}

	// 4. Work with current hash -> upserted; then work again -> skipped_fresh (0 extra provider calls).
	srv.ResetCalls()
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(curHash[:]),
		},
	}); err != nil {
		t.Fatalf("upserted Work: %v", err)
	}
	if err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     itemRow.ID.String(),
			InputHash:    hex.EncodeToString(curHash[:]),
		},
	}); err != nil {
		t.Fatalf("skipped_fresh Work: %v", err)
	}
	if srv.Stats().DocumentRequests != 1 {
		t.Fatalf("DocumentRequests across upserted + skipped_fresh = %d, want 1", srv.Stats().DocumentRequests)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSkippedFresh}); got != 1 {
		t.Fatalf("skipped_fresh count = %v, want 1", got)
	}

	// 5. Breaker open snooze + provider 5xx retry (3 consecutive 5xx open the worker breaker).
	item2, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Second Item",
		NameNormalized: "second item",
	})
	if err != nil {
		t.Fatalf("InsertItem 2: %v", err)
	}
	hash2 := embedding.InputHashFor(gActive.Identity(), embedding.ItemInput(item2.Name, ""))

	srv.Set5xx(503)
	// First two 5xx failures return non-snooze error (River retry) and do NOT increment retry/dead.
	for i := 1; i <= 2; i++ {
		err := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{Attempt: i},
			Args: jobargs.EmbedItemArgs{
				GenerationID: gActive.ID,
				UserID:       user.ID.String(),
				TargetID:     item2.ID.String(),
				InputHash:    hex.EncodeToString(hash2[:]),
			},
		})
		if err == nil {
			t.Fatalf("attempt %d on 503 expected error, got nil", i)
		}
		var snoozeErr *river.JobSnoozeError
		if errors.As(err, &snoozeErr) {
			t.Fatalf("attempt %d before breaker trips should return retry error, not snooze: %v", i, err)
		}
	}
	// Third consecutive 5xx trips the worker breaker -> returns JobSnooze.
	err3 := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 3},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     item2.ID.String(),
			InputHash:    hex.EncodeToString(hash2[:]),
		},
	})
	var snoozeErr *river.JobSnoozeError
	if !errors.As(err3, &snoozeErr) {
		t.Fatalf("3rd failure (breaker trip) err = %v, want *river.JobSnoozeError", err3)
	}

	// Fourth call while breaker is open -> Acquire() is false -> snoozes immediately without calling provider.
	srv.ResetCalls()
	err4 := worker.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 3},
		Args: jobargs.EmbedItemArgs{
			GenerationID: gActive.ID,
			UserID:       user.ID.String(),
			TargetID:     item2.ID.String(),
			InputHash:    hex.EncodeToString(hash2[:]),
		},
	})
	if !errors.As(err4, &snoozeErr) {
		t.Fatalf("breaker-open call err = %v, want *river.JobSnoozeError", err4)
	}
	if srv.Stats().DocumentRequests != 0 {
		t.Fatalf("provider calls while breaker open = %d, want 0", srv.Stats().DocumentRequests)
	}

	// FS-28: retry and dead outcomes mustremain 0 (owned by Task 20a).
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": "retry"}); got != 0 {
		t.Fatalf("embedding_jobs_total{retry} = %v, want 0 (FS-28)", got)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": "dead"}); got != 0 {
		t.Fatalf("embedding_jobs_total{dead} = %v, want 0 (FS-28)", got)
	}

	// Verify logs never contain user ID, item name, or hint.
	logs := logBuf.String()
	for _, forbidden := range []string{user.ID.String(), secretName, secretHint} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("worker logs leaked forbidden string %q: %s", forbidden, logs)
		}
	}
}

// TestCanaryWorkerFirstRunPersistsAndSubsequentRunsCheckDrift verifies
// Deliverable 3 (canary.go):
//   - On the first run for a generation in R with a matching client, CanaryWorker
//     persists the 8 reference vectors into embedding_generation.canary JSONB.
//   - On the second run, it reads the stored canary vectors and sets
//     embedding_canary_min_cos{generation="1"} ~ 1.0.
//   - Generations in R without a matching client or with an open breaker are
//     skipped without failing the job.
func TestCanaryWorkerFirstRunPersistsAndSubsequentRunsCheckDrift(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()

	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)

	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	// g2 has no matching client in ClientSet -> must be skipped cleanly.
	unmatchedIdent := client.Identity
	unmatchedIdent.ModelVersion = "unmatched-rev"
	_ = seedGenerationForIdentity(t, ctx, pool, 2, unmatchedIdent, generation.StatePending, nil)

	reg, m := obs.NewRegistry()
	canaryWorker := jobs.NewCanaryWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
	})

	// 1. First run -> persists 8 vectors on g1.
	if err := canaryWorker.Work(ctx, &river.Job[jobargs.CanaryArgs]{}); err != nil {
		t.Fatalf("CanaryWorker first run: %v", err)
	}

	g1After, err := generation.GetByID(ctx, pool, g1.ID)
	if err != nil {
		t.Fatalf("GetByID g1: %v", err)
	}
	var storedVecs [][]float32
	if err := json.Unmarshal(g1After.Canary, &storedVecs); err != nil {
		t.Fatalf("Unmarshal persisted g1.Canary: %v", err)
	}
	if len(storedVecs) != embedding.CanaryCount || len(storedVecs[0]) != 8 {
		t.Fatalf("persisted canary shape = %d x %d, want 8 x 8", len(storedVecs), len(storedVecs[0]))
	}

	// 2. Second run -> compares against persisted vectors and sets embedding_canary_min_cos ~ 1.0.
	if err := canaryWorker.Work(ctx, &river.Job[jobargs.CanaryArgs]{}); err != nil {
		t.Fatalf("CanaryWorker second run: %v", err)
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	var foundMinCos bool
	for _, f := range families {
		if f.GetName() != "embedding_canary_min_cos" {
			continue
		}
		for _, metric := range f.GetMetric() {
			for _, lp := range metric.GetLabel() {
				if lp.GetName() == "generation" && lp.GetValue() == "1" && metric.GetGauge() != nil {
					foundMinCos = true
					if diff := math.Abs(metric.GetGauge().GetValue() - 1.0); diff > 1e-5 {
						t.Fatalf("embedding_canary_min_cos{generation=1} = %v, want ~1.0", metric.GetGauge().GetValue())
					}
				}
			}
		}
	}
	if !foundMinCos {
		t.Fatal("expected embedding_canary_min_cos{generation=1} to be recorded on second run")
	}
}

// TestTwoWorkerRenameCycleGuaranteesSuccessor verifies the EJ2-1 fix:
// During an A -> B -> A -> B rename cycle across two concurrently running
// workers (Job A for hash_A, Job B for hash_B):
//  1. Job A embeds input A and pauses at BeforeStep5Tx.
//  2. Item is renamed to B; Job B starts in state 'running', but before its
//     step 2 read, item is renamed back to A (insert of A deduplicates against
//     running Job A). Job B reads input A in step 2, detects stale hash_B !=
//     hash_A, and pauses at BeforeStaleInsert.
//  3. Item is renamed to final state B (insert of B deduplicates against
//     running Job B).
//  4. Both Job A (in step 5) and Job B (in step 2) attempt to insert their
//     stale-hash replacements:
//     - Job A's replacement (hash_B) collides with running Job B -> Job A
//     returns river.JobSnooze(StaleReplacementSnoozeDuration) instead of
//     finishing skipped_stale.
//     - Job B's replacement (hash_A) collides with running Job A -> Job B
//     returns river.JobSnooze(StaleReplacementSnoozeDuration) instead of
//     finishing skipped_stale.
//  5. When the snoozed Job B re-runs after settling, its args (hash_B) match
//     the final item state B and it upserts the vector for B.
func TestTwoWorkerRenameCycleGuaranteesSuccessor(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "rename-cycle-ej21@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}

	const (
		nameA = "Name Alpha"
		nameB = "Name Beta"
	)
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           nameA,
		NameNormalized: strings.ToLower(nameA),
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}

	hashA := embedding.InputHashFor(g1.Identity(), embedding.ItemInput(nameA, ""))
	hashB := embedding.InputHashFor(g1.Identity(), embedding.ItemInput(nameB, ""))
	hashAHex := hex.EncodeToString(hashA[:])
	hashBHex := hex.EncodeToString(hashB[:])

	riverClient := newInsertClient(t, pool)
	argsA := jobargs.EmbedItemArgs{
		GenerationID: g1.ID,
		UserID:       user.ID.String(),
		TargetID:     itemRow.ID.String(),
		InputHash:    hashAHex,
	}
	argsB := jobargs.EmbedItemArgs{
		GenerationID: g1.ID,
		UserID:       user.ID.String(),
		TargetID:     itemRow.ID.String(),
		InputHash:    hashBHex,
	}

	insA, err := riverClient.Insert(ctx, argsA, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("Insert job A: %v", err)
	}
	insB, err := riverClient.Insert(ctx, argsB, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("Insert job B: %v", err)
	}
	// Transition both jobs to 'running' in river_job to mirror River's two
	// embedding workers executing Job A and Job B concurrently.
	if _, err := pool.Exec(ctx,
		`UPDATE river_job SET state = 'running', attempted_at = now(), attempt = 1 WHERE id IN ($1, $2)`,
		insA.Job.ID, insB.Job.ID,
	); err != nil {
		t.Fatalf("mark jobs A and B running: %v", err)
	}

	aAtStep5 := make(chan struct{})
	releaseA := make(chan struct{})
	bAtStaleInsert := make(chan struct{})
	releaseB := make(chan struct{})

	reg, m := obs.NewRegistry()
	workerA := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
		BeforeStep5Tx: func(_ context.Context, _ string, _ int, _ uuid.UUID) {
			close(aAtStep5)
			<-releaseA
		},
	})
	workerB := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
		BeforeStaleInsert: func(_ context.Context, _ string, _ int, _ uuid.UUID, inStep5 bool) {
			if !inStep5 {
				close(bAtStaleInsert)
				<-releaseB
			}
		},
	})

	errChA := make(chan error, 1)
	go func() {
		errChA <- workerA.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{ID: insA.Job.ID, Attempt: 1, State: rivertype.JobStateRunning},
			Args:   argsA,
		})
	}()

	// Wait for Worker A to finish step 4 (embedding nameA) and pause before step 5.
	<-aAtStep5

	// Rename item A -> B -> A while Job A is still running.
	// The mutation enqueue for A deduplicates against running Job A.
	if _, err := pool.Exec(ctx,
		`UPDATE item SET name = $1, name_normalized = $2 WHERE id = $3`,
		nameA, strings.ToLower(nameA), itemRow.ID,
	); err != nil {
		t.Fatalf("rename item to A: %v", err)
	}
	dupA, err := riverClient.Insert(ctx, argsA, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("Insert duplicate A: %v", err)
	}
	if !dupA.UniqueSkippedAsDuplicate || dupA.Job.State != rivertype.JobStateRunning {
		t.Fatalf("dupA = %+v, want UniqueSkippedAsDuplicate=true State=running", dupA)
	}

	// Start Worker B (with argsB). Its unlocked step 2 sees nameA != hashB and
	// pauses at BeforeStaleInsert before inserting replacement A.
	errChB := make(chan error, 1)
	go func() {
		errChB <- workerB.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{ID: insB.Job.ID, Attempt: 1, State: rivertype.JobStateRunning},
			Args:   argsB,
		})
	}()
	<-bAtStaleInsert

	// Final rename to B while Job B is still running.
	// The mutation enqueue for B deduplicates against running Job B.
	if _, err := pool.Exec(ctx,
		`UPDATE item SET name = $1, name_normalized = $2 WHERE id = $3`,
		nameB, strings.ToLower(nameB), itemRow.ID,
	); err != nil {
		t.Fatalf("final rename item to B: %v", err)
	}
	dupB, err := riverClient.Insert(ctx, argsB, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("Insert duplicate B: %v", err)
	}
	if !dupB.UniqueSkippedAsDuplicate || dupB.Job.State != rivertype.JobStateRunning {
		t.Fatalf("dupB = %+v, want UniqueSkippedAsDuplicate=true State=running", dupB)
	}

	// Release both workers while both Job A and Job B are in state 'running'.
	// Note: Worker A's step 5 transaction inserts replacement B (touching Job B's
	// row) while Worker B's step 2 inserts replacement A (touching Job A's row).
	close(releaseA)
	close(releaseB)

	errA := <-errChA
	errB := <-errChB

	var snoozeA *river.JobSnoozeError
	if !errors.As(errA, &snoozeA) {
		t.Fatalf("Worker A err = %v, want *river.JobSnoozeError when replacement B collided with running Job B", errA)
	}
	var snoozeB *river.JobSnoozeError
	if !errors.As(errB, &snoozeB) {
		t.Fatalf("Worker B err = %v, want *river.JobSnoozeError when replacement A collided with running Job A", errB)
	}
	if snoozeA.Duration != jobs.StaleReplacementSnoozeDuration || snoozeB.Duration != jobs.StaleReplacementSnoozeDuration {
		t.Fatalf("snooze durations = (%s, %s), want %s", snoozeA.Duration, snoozeB.Duration, jobs.StaleReplacementSnoozeDuration)
	}
	if got := counterValue(t, reg, "embedding_jobs_total", map[string]string{"kind": jobargs.KindEmbedItem, "outcome": jobs.OutcomeSnoozed}); got != 2 {
		t.Fatalf("embedding_jobs_total{embed_item,snoozed} = %v, want 2", got)
	}

	// Simulate River transitioning both snoozed jobs to 'scheduled' and then
	// re-running them. Job B now sees final item nameB == argsB.InputHash and
	// upserts the vector for B.
	if _, err := pool.Exec(ctx,
		`UPDATE river_job SET state = 'scheduled' WHERE id IN ($1, $2)`,
		insA.Job.ID, insB.Job.ID,
	); err != nil {
		t.Fatalf("transition snoozed jobs to scheduled: %v", err)
	}

	workerRetry := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: riverClient},
	})
	if err := workerRetry.Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{ID: insB.Job.ID, Attempt: 1, State: rivertype.JobStateRunning},
		Args:   argsB,
	}); err != nil {
		t.Fatalf("re-run of snoozed Job B: %v", err)
	}

	stored, hasVec, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusItem, user.ID, itemRow.ID)
	if err != nil || !hasVec {
		t.Fatalf("expected vector for final input B after snoozed job re-ran, got hasVec=%v err=%v", hasVec, err)
	}
	if !bytes.Equal(stored.InputHash, hashB[:]) {
		t.Fatalf("stored vector input_hash = %x, want final hashB %x", stored.InputHash, hashB[:])
	}
}

// TestCanaryWorkerConcurrentFirstRunWriteOnce verifies the EJ2-4 fix:
// When two first-run CanaryWorker executions concurrently observe an empty
// canary baseline (holding no DB lock during the network call) and embed
// responses that straddle provider drift:
//   - Both workers finish embedding and synchronize at BeforeCanaryPersistTx.
//   - Worker 1 enters the short FOR UPDATE tx first and persists its baseline.
//   - Worker 2 enters the short FOR UPDATE tx second, re-reads the now-populated
//     canary column, retains Worker 1's baseline (write-once), and evaluates
//     drift against Worker 1's baseline (incrementing embedding_canary_drift_total
//     and setting embedding_canary_min_cos < 0.99).
func TestCanaryWorkerConcurrentFirstRunWriteOnce(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()

	client := newTEIClient(t, srv, 8, "", "")
	cs := embedding.NewClientSet(client, nil)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, client.Identity, generation.StateActive, nil)

	reg, m := obs.NewRegistry()
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	w1Embedded := make(chan struct{})
	releaseW1 := make(chan struct{})
	w2Embedded := make(chan struct{})
	releaseW2 := make(chan struct{})

	worker1 := jobs.NewCanaryWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Logger:    logger,
		BeforeCanaryPersistTx: func(_ context.Context, _ int) {
			close(w1Embedded)
			<-releaseW1
		},
	})
	worker2 := jobs.NewCanaryWorker(jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Logger:    logger,
		BeforeCanaryPersistTx: func(_ context.Context, _ int) {
			close(w2Embedded)
			<-releaseW2
		},
	})

	errCh1 := make(chan error, 1)
	go func() {
		errCh1 <- worker1.Work(ctx, &river.Job[jobargs.CanaryArgs]{})
	}()
	// Wait until Worker 1 has embedded the normal baseline (with no DB lock held).
	<-w1Embedded

	// Simulate provider drift before Worker 2 embeds, while g1.canary in DB is
	// still NULL so Worker 2 also takes the FirstRun path.
	canaryStrings := embedding.CanaryStrings()
	srv.SetAliases(map[string]string{
		canaryStrings[0]: "drifted-canary-vector-orthogonality-target-9999",
	})

	errCh2 := make(chan error, 1)
	go func() {
		errCh2 <- worker2.Work(ctx, &river.Job[jobargs.CanaryArgs]{})
	}()
	// Wait until Worker 2 has also finished its network call and observed FirstRun=true.
	<-w2Embedded

	// Release Worker 1 first so it wins the FOR UPDATE write-once persistence.
	close(releaseW1)
	if err := <-errCh1; err != nil {
		t.Fatalf("CanaryWorker 1: %v", err)
	}

	// Capture Worker 1's persisted baseline before releasing Worker 2.
	g1AfterW1, err := generation.GetByID(ctx, pool, g1.ID)
	if err != nil {
		t.Fatalf("GetByID after Worker 1: %v", err)
	}
	var w1Baseline [][]float32
	if err := json.Unmarshal(g1AfterW1.Canary, &w1Baseline); err != nil {
		t.Fatalf("Unmarshal Worker 1 baseline: %v", err)
	}
	if len(w1Baseline) != embedding.CanaryCount {
		t.Fatalf("Worker 1 baseline count = %d, want %d", len(w1Baseline), embedding.CanaryCount)
	}

	// Now release Worker 2. It locks g1 FOR UPDATE, sees Worker 1's baseline is
	// already set, does NOT overwrite it, and checks drift against it.
	close(releaseW2)
	if err := <-errCh2; err != nil {
		t.Fatalf("CanaryWorker 2: %v", err)
	}

	g1AfterW2, err := generation.GetByID(ctx, pool, g1.ID)
	if err != nil {
		t.Fatalf("GetByID after Worker 2: %v", err)
	}
	if !bytes.Equal(g1AfterW1.Canary, g1AfterW2.Canary) {
		t.Fatalf("Worker 2 overwrote Worker 1's canary baseline:\nafter W1: %s\nafter W2: %s", g1AfterW1.Canary, g1AfterW2.Canary)
	}

	if got := counterValue(t, reg, "embedding_canary_drift_total", map[string]string{"generation": "1"}); got != 1 {
		t.Fatalf("embedding_canary_drift_total{generation=1} = %v, want 1 (drift detected by losing first-run initializer)", got)
	}
	if !strings.Contains(logBuf.String(), "embedding canary drift detected") {
		t.Fatalf("expected drift warning log from losing initializer, got: %s", logBuf.String())
	}
}
