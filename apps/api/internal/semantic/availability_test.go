package semantic_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/semantic/semantictest"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

var (
	sharedBaseDSNOnce sync.Once
	sharedBaseDSN     string
	sharedBaseErr     error
	sharedContainer   testcontainers.Container
)

// TestMain manages the single shared Postgres container for package semantic_test
// (plan P05 gate 10: one container per package).
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
	dbName := "engram_sem_" + hex.EncodeToString(nonce[:])

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

func testTEIIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      embedding.ProviderTEI,
		Model:         embedding.FakeEmbedModel,
		ModelVersion:  embedding.FakeEmbedModelSHA + ";qp=00000000;dp=00000000",
		Dims:          8,
		QueryPrefix:   "",
		DocPrefix:     "",
		Preprocessing: embedding.Preprocessing,
	}
}

func testOpenAIIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      embedding.ProviderOpenAICompat,
		Model:         "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "dims=8;instr=12345678",
		Dims:          8,
		QueryPrefix:   "Instruct: Given a short search query, retrieve matching item names or tags\nQuery:",
		DocPrefix:     "",
		Preprocessing: embedding.Preprocessing,
	}
}

func testPinForIdentity(genID int, id embedid.Identity) generation.Pin {
	return generation.Pin{
		GenID:     genID,
		Identity:  id,
		MinCos:    0.62,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
}

func matchingCalibration(want embedid.Identity) embedid.CalibrationLookup {
	return func(id embedid.Identity) (float64, string, bool) {
		if id.Provider == want.Provider && id.Model == want.Model && id.ModelVersion == want.ModelVersion {
			return 0.62, "docs/benchmarks/semantic-eval/report-fakeembed-1024-20261102.json", true
		}
		return 0, "", false
	}
}

// TestAvailabilityRows1To3b verifies plan P05 mục 2.18 rows 1–3b at package
// level with zero network calls:
//   - Row 1: SEARCH_SEMANTIC_ENABLED=false -> Availability=false
//   - Row 2: enabled=true, provider="noop" -> Availability=false
//   - Row 3a: enabled=true, real provider, calibrated, no active generation yet
//     (e.g. g1 bootstrap is still pending) -> Availability=false
//   - Row 3b (empty R / no active): Availability=false
//   - Row 3b (active != configured client): Availability=false
//   - Row 3b (missing calibration): Availability=false
//   - Row 4/6 baseline: when all conditions hold -> Availability=true, External
//     matches active generation provider ("tei" -> false, "openai_compat" -> true),
//     cached for 30 s, and opening the circuit breaker never flips Availability
//     to false (row 8).
func TestAvailabilityRows1To3b(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))

	teiID := testTEIIdentity()
	teiPin := testPinForIdentity(1, teiID)
	teiSpy := semantictest.NewSpyProvider(teiID)
	teiClient := embedding.NewClient(teiSpy, teiID.QueryPrefix, teiID.DocPrefix)
	teiCS := embedding.NewClientSet(teiClient, nil)

	t.Run("row1_disabled_deployment", func(t *testing.T) {
		pinner := semantictest.NewSpyPinner(teiPin, true)
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     false,
			Provider:    embedding.ProviderTEI,
			ClientSet:   teiCS,
			Pinner:      pinner,
			Calibration: matchingCalibration(teiID),
			Clock:       clk,
		})
		if rt.Availability(ctx) {
			t.Fatal("row 1: expected Availability() == false when SEARCH_SEMANTIC_ENABLED=false")
		}
		if pinner.Calls() != 0 {
			t.Fatalf("row 1: expected 0 pinner calls when deployment disabled, got %d", pinner.Calls())
		}
		if teiSpy.QueryCalls() != 0 {
			t.Fatalf("row 1: expected 0 provider calls, got %d", teiSpy.QueryCalls())
		}
	})

	t.Run("row2_enabled_noop_provider", func(t *testing.T) {
		pinner := semantictest.NewSpyPinner(teiPin, true)
		noopCS := embedding.NewClientSet(embedding.NewClient(embedding.NewNoop(), "", ""), nil)
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     true,
			Provider:    embedding.ProviderNoop,
			ClientSet:   noopCS,
			Pinner:      pinner,
			Calibration: matchingCalibration(teiID),
			Clock:       clk,
		})
		if rt.Availability(ctx) {
			t.Fatal("row 2: expected Availability() == false when provider=noop")
		}
		if pinner.Calls() != 0 {
			t.Fatalf("row 2: expected 0 pinner calls when provider=noop, got %d", pinner.Calls())
		}
	})

	t.Run("row3a_bootstrap_pending_no_active_generation", func(t *testing.T) {
		pinner := semantictest.NewSpyPinner(generation.Pin{}, false)
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     true,
			Provider:    embedding.ProviderTEI,
			ClientSet:   teiCS,
			Pinner:      pinner,
			Calibration: matchingCalibration(teiID),
			Clock:       clk,
		})
		if rt.Availability(ctx) {
			t.Fatal("row 3a: expected Availability() == false when g1 is pending (no active generation)")
		}
		if pinner.Calls() != 1 {
			t.Fatalf("row 3a: expected 1 ActivePin call, got %d", pinner.Calls())
		}
		// Second call within 30 s must hit the RAM cache (0 extra ActivePin calls).
		if rt.Availability(ctx) {
			t.Fatal("row 3a cached: expected Availability() == false")
		}
		if pinner.Calls() != 1 {
			t.Fatalf("row 3a cached: expected 1 ActivePin call within 30s TTL, got %d", pinner.Calls())
		}
	})

	t.Run("row3b_active_identity_mismatch_client", func(t *testing.T) {
		otherID := teiID
		otherID.ModelVersion = "different-sha;qp=00000000;dp=00000000"
		pinner := semantictest.NewSpyPinner(testPinForIdentity(1, otherID), true)
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     true,
			Provider:    embedding.ProviderTEI,
			ClientSet:   teiCS,
			Pinner:      pinner,
			Calibration: matchingCalibration(otherID),
			Clock:       clk,
		})
		if rt.Availability(ctx) {
			t.Fatal("row 3b (active != client): expected Availability() == false")
		}
	})

	t.Run("row3b_missing_calibration", func(t *testing.T) {
		pinner := semantictest.NewSpyPinner(teiPin, true)
		emptyCal := func(embedid.Identity) (float64, string, bool) {
			return 0, "", false
		}
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     true,
			Provider:    embedding.ProviderTEI,
			ClientSet:   teiCS,
			Pinner:      pinner,
			Calibration: emptyCal,
			Clock:       clk,
		})
		if rt.Availability(ctx) {
			t.Fatal("row 3b (missing calibration): expected Availability() == false")
		}
	})

	t.Run("row4_6_8_available_cached_30s_and_breaker_never_flips", func(t *testing.T) {
		openAIID := testOpenAIIdentity()
		openAIPin := testPinForIdentity(1, openAIID)
		openAISpy := semantictest.NewSpyProvider(openAIID)
		openAIClient := embedding.NewClient(openAISpy, openAIID.QueryPrefix, openAIID.DocPrefix)
		openAICS := embedding.NewClientSet(openAIClient, nil)

		pinner := semantictest.NewSpyPinner(openAIPin, true)
		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:     true,
			Provider:    embedding.ProviderOpenAICompat,
			ClientSet:   openAICS,
			Pinner:      pinner,
			Calibration: matchingCalibration(openAIID),
			Clock:       clk,
		})
		if !rt.Availability(ctx) {
			t.Fatal("expected Availability() == true when all conditions hold")
		}
		if !rt.External(ctx) {
			t.Fatal("expected External() == true when active generation is openai_compat")
		}
		if pinner.Calls() != 1 {
			t.Fatalf("expected 1 ActivePin call, got %d", pinner.Calls())
		}

		// Advance clock 29 s (< 30 s TTL): still cached even if underlying pinner changes.
		pinner.SetPin(generation.Pin{}, false)
		clk.Advance(29 * time.Second)
		if !rt.Availability(ctx) {
			t.Fatal("expected cached Availability() == true at 29 s")
		}
		if pinner.Calls() != 1 {
			t.Fatalf("expected 0 new ActivePin calls before 30 s expiry, got %d", pinner.Calls())
		}

		// Restore pin and trip the circuit breaker (row 8): static Availability() MUST stay true.
		pinner.SetPin(openAIPin, true)
		clk.Advance(2 * time.Second) // past 30 s TTL
		_, _, finish := rt.Breaker().Acquire()
		finish(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503})
		if !rt.IsBreakerOpen() {
			t.Fatal("expected IsBreakerOpen() == true after provider 503")
		}
		if !rt.Availability(ctx) {
			t.Fatal("row 8: breaker open must NEVER flip static Availability() to false")
		}
		if openAISpy.QueryCalls() != 0 {
			t.Fatalf("Availability() must never call provider network, got %d calls", openAISpy.QueryCalls())
		}
	})
}

// TestAvailabilityInvalidatedByNotify verifies plan P05 mục 2.15, 2.18, Task 12
// (M3, FS-25) against real PostgreSQL LISTEN/NOTIFY:
//   - Initially g1 is `pending` (bootstrap=true, no active generation) ->
//     `rt.Availability(ctx)` is false and cached for 30 s.
//   - Flip g1 to `active` in PostgreSQL and send `NOTIFY embedding_generation_changed`.
//   - Without advancing the fake clock by 30 s, `rt.Availability(ctx)` becomes
//     true as soon as the notification is delivered through `generation.Pinner`.
func TestAvailabilityInvalidatedByNotify(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	teiID := testTEIIdentity()
	teiSpy := semantictest.NewSpyProvider(teiID)
	teiClient := embedding.NewClient(teiSpy, teiID.QueryPrefix, teiID.DocPrefix)
	teiCS := embedding.NewClientSet(teiClient, nil)
	cal := matchingCalibration(teiID)

	// 1. Bootstrap g1 as pending (no active generation yet).
	res, err := generation.Bootstrap(ctx, pool, teiID, cal)
	if err != nil {
		t.Fatalf("generation.Bootstrap: %v", err)
	}
	if !res.Created || res.Generation.State != generation.StatePending {
		t.Fatalf("Bootstrap result = %+v, want Created=true State=pending", res)
	}

	pinner := generation.NewPinner(pool, generation.WithPinNowFunc(clk.Now))
	defer pinner.Close()
	if err := pinner.StartListener(ctx); err != nil {
		t.Fatalf("pinner.StartListener: %v", err)
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:     true,
		Provider:    embedding.ProviderTEI,
		ClientSet:   teiCS,
		Pinner:      pinner,
		Calibration: cal,
		Clock:       clk,
	})

	// Register the test observer AFTER NewRuntime so Pinner.Invalidate invokes
	// rt.InvalidateAvailability first and signals notifyDelivered only after
	// the runtime cache has been cleared (RV-T12-BE-3).
	notifyDelivered := make(chan struct{}, 1)
	pinner.Subscribe(func() {
		select {
		case notifyDelivered <- struct{}{}:
		default:
		}
	})

	// 2. While g1 is still pending, Availability() is false and populates the 30 s cache.
	if rt.Availability(ctx) {
		t.Fatal("expected Availability() == false while g1 is pending")
	}

	// 3. Flip g1 -> active in a transaction and fire NOTIFY embedding_generation_changed.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("pool.Begin: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	q := gen.New(tx)
	if _, err := q.ActivateEmbeddingGeneration(ctx, int32(res.Generation.ID)); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration: %v", err)
	}
	reason := "bootstrap_autoflip"
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  int32(res.Generation.ID),
		FlippedReason: &reason,
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive: %v", err)
	}
	if _, err := tx.Exec(ctx, "NOTIFY "+generation.NotifyChannel); err != nil {
		t.Fatalf("NOTIFY %s: %v", generation.NotifyChannel, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("tx.Commit: %v", err)
	}

	// 4. Wait for the dedicated listener connection to receive the notification
	// (deterministic channel barrier, no time.Sleep). Fake clock is NOT advanced.
	select {
	case <-notifyDelivered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for NOTIFY embedding_generation_changed delivery")
	}

	// 5. Fake clock has NOT advanced (still at t=0, well within the 30 s cache TTL),
	// yet Availability() is immediately true and External() is false (provider=tei).
	if !rt.Availability(ctx) {
		t.Fatal("expected Availability() == true immediately after NOTIFY without advancing clock 30 s")
	}
	if rt.External(ctx) {
		t.Fatal("expected External() == false for TEI generation")
	}
}

// TestRuntimeSingleInstance verifies plan P05 Task 12 (FS-6, L8):
//   - Query execution (Candidates / NearSource) and availability/PATCH checks
//     (IsBreakerOpen / Availability) share the exact same circuit breaker instance
//     inside semantic.Runtime.
//   - When a query embed call fails on the provider, the shared breaker opens:
//     `rt.IsBreakerOpen()` immediately reports true (so Task 13 PATCH returns 409),
//     static `rt.Availability(ctx)` remains true, and subsequent query calls
//     short-circuit to `degraded` before hitting the provider.
func TestRuntimeSingleInstance(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	_, metrics := obs.NewRegistry()

	openAIID := testOpenAIIdentity()
	openAIPin := testPinForIdentity(1, openAIID)

	spyProv := semantictest.NewSpyProvider(openAIID)
	spyProv.EmbedQueryFn = func(context.Context, string) ([]float32, error) {
		return nil, &embedding.ProviderError{
			Class:      embedding.Class5xx,
			HTTPStatus: 502,
			Detail:     "upstream bad gateway",
		}
	}
	client := embedding.NewClient(spyProv, openAIID.QueryPrefix, openAIID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)
	pinner := semantictest.NewSpyPinner(openAIPin, true)
	searcher := &semantictest.SpyVectorSearcher{}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderOpenAICompat,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(openAIID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Metrics:        metrics,
		Clock:          clk,
	})

	if !rt.Availability(ctx) {
		t.Fatal("expected initial Availability() == true")
	}
	if rt.IsBreakerOpen() {
		t.Fatal("expected initial IsBreakerOpen() == false")
	}

	// 1. Trigger a query via NearSource -> provider returns 502 -> trips shared breaker.
	nearSrc := rt.NearSource()
	res1, err := nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        uuid.MustParse("11111111-1111-4000-8000-000000000001"),
		QN:            "router",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("Near call 1 unexpected error: %v", err)
	}
	if res1.Semantic || res1.SemanticReason == nil || *res1.SemanticReason != suggest.ReasonDegraded {
		t.Fatalf("Near call 1 = %+v, want Semantic=false Reason=degraded", res1)
	}
	if spyProv.QueryCalls() != 1 {
		t.Fatalf("expected 1 provider call on first request, got %d", spyProv.QueryCalls())
	}

	// 2. Shared breaker is now open on the same Runtime instance, while static Availability stays true.
	if !rt.IsBreakerOpen() {
		t.Fatal("expected rt.IsBreakerOpen() == true after query failure")
	}
	if !rt.Availability(ctx) {
		t.Fatal("expected static rt.Availability() == true even when breaker is open")
	}

	// 3. Second query sees the open breaker in Decide and makes 0 additional provider calls.
	res2, err := nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        uuid.MustParse("11111111-1111-4000-8000-000000000001"),
		QN:            "another query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("Near call 2 unexpected error: %v", err)
	}
	if res2.Semantic || res2.SemanticReason == nil || *res2.SemanticReason != suggest.ReasonDegraded {
		t.Fatalf("Near call 2 = %+v, want Semantic=false Reason=degraded", res2)
	}
	if spyProv.QueryCalls() != 1 {
		t.Fatalf("expected 0 additional provider calls while breaker open, total=%d", spyProv.QueryCalls())
	}
	if searcher.TotalCalls() != 0 {
		t.Fatalf("expected 0 VectorSearch calls when provider failed / breaker open, got %d", searcher.TotalCalls())
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected context canceled")
	}
}

// TestIsBreakerOpenActiveProviderCutover verifies RV-T12-BE-4:
//   - When two providers are configured (primary "openai_compat", shadow "tei"),
//     `rt.IsBreakerOpen()` inspects ONLY the breaker for the active generation's
//     provider (from the cached availability/pin snapshot, invalidated on NOTIFY),
//     falling back to the primary breaker only when no active snapshot exists.
//   - Before any active generation is cached, IsBreakerOpen() reflects the primary
//     breaker and ignores an open shadow breaker.
//   - While g1 ("openai_compat") is active and its breaker trips, IsBreakerOpen()
//     is true.
//   - When a NOTIFY cutover flips the active generation to g2 ("tei") while the
//     old "openai_compat" breaker is still open, Availability() / NearSource()
//     updates the snapshot and IsBreakerOpen() immediately reports false (so
//     PATCH /me/settings is not blocked by the inactive provider's open breaker),
//     with only 1 ActivePin read per request.
//   - If the new active generation's breaker ("tei") subsequently trips,
//     IsBreakerOpen() reports true.
func TestIsBreakerOpenActiveProviderCutover(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	_, metrics := obs.NewRegistry()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")

	openAIID := testOpenAIIdentity()
	teiID := testTEIIdentity()
	g1Pin := testPinForIdentity(1, openAIID)
	g2Pin := generation.Pin{
		GenID:     2,
		Identity:  teiID,
		MinCos:    0.62,
		ItemTable: "item_embedding_g2",
		TagTable:  "tag_embedding_g2",
	}

	openAISpy := semantictest.NewSpyProvider(openAIID)
	teiSpy := semantictest.NewSpyProvider(teiID)
	openAIClient := embedding.NewClient(openAISpy, openAIID.QueryPrefix, openAIID.DocPrefix)
	teiClient := embedding.NewClient(teiSpy, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(openAIClient, &teiClient)

	pinner := semantictest.NewSpyPinner(g1Pin, true)
	searcher := &semantictest.SpyVectorSearcher{}

	bothCal := func(id embedid.Identity) (float64, string, bool) {
		if id.Provider == openAIID.Provider || id.Provider == teiID.Provider {
			return 0.62, "docs/benchmarks/semantic-eval/report.json", true
		}
		return 0, "", false
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderOpenAICompat,
		ShadowProvider: embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    bothCal,
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Metrics:        metrics,
		Clock:          clk,
	})

	// 1. Before any availability/pin snapshot is populated, IsBreakerOpen() uses
	// the primary breaker fallback: tripping the inactive shadow ("tei") breaker
	// must NOT cause IsBreakerOpen() to return true.
	teiBreaker := rt.BreakerForProvider(embedding.ProviderTEI)
	openAIBreaker := rt.BreakerForProvider(embedding.ProviderOpenAICompat)
	if teiBreaker == nil || openAIBreaker == nil || teiBreaker == openAIBreaker {
		t.Fatal("expected distinct breakers for openai_compat and tei")
	}
	_, _, finishTEI := teiBreaker.Acquire()
	finishTEI(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503})
	if !teiBreaker.IsOpen() {
		t.Fatal("expected teiBreaker to be open")
	}
	if rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == false when only inactive shadow breaker is open and no snapshot exists")
	}

	// Populate snapshot with g1 (openai_compat): IsBreakerOpen() still false because
	// active provider is openai_compat and its breaker is closed.
	if !rt.Availability(ctx) {
		t.Fatal("expected Availability() == true for g1")
	}
	if rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == false when active g1 (openai_compat) breaker is closed")
	}

	// Recover teiBreaker (advance 60 s and complete trial) so g2 is healthy for cutover.
	clk.Advance(embedding.BreakerOpenWindow)
	ok, _, finishTEIRecover := teiBreaker.Acquire()
	if !ok {
		t.Fatal("expected teiBreaker half-open probe to be admitted")
	}
	finishTEIRecover(nil)

	// 2. Trip the active g1 ("openai_compat") breaker via a failing query ->
	// IsBreakerOpen() must now report true.
	openAISpy.EmbedQueryFn = func(context.Context, string) ([]float32, error) {
		return nil, &embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 502}
	}
	res1, err := rt.NearSource().Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "fail g1 query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil || res1.Semantic {
		t.Fatalf("expected g1 query failure to degrade, got %+v (err=%v)", res1, err)
	}
	if !rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == true when active provider (openai_compat) breaker is open")
	}

	// 3. Cut over active generation to g2 ("tei") and fire NOTIFY while g1's
	// "openai_compat" breaker is still within its 60 s open window.
	pinner.SetPin(g2Pin, true)
	pinner.Notify()
	pinner.ResetCalls()

	// Query on g2 succeeds with 1 ActivePin read and updates the active provider snapshot.
	res2, err := rt.NearSource().Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "healthy g2 query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil || !res2.Semantic || res2.Generation == nil || *res2.Generation != 2 {
		t.Fatalf("Near on g2 after cutover = %+v (err=%v), want Semantic=true Generation=2", res2, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("expected exactly 1 ActivePin read during g2 query, got %d", pinner.Calls())
	}
	// Even though openAIBreaker is still open, IsBreakerOpen() must be false because
	// the active generation is now g2 ("tei") whose breaker is closed.
	if !openAIBreaker.IsOpen() {
		t.Fatal("precondition: expected inactive openAIBreaker to still be open")
	}
	if rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == false after cutover to healthy g2 (inactive openAIBreaker must not block)")
	}
	if !rt.Availability(ctx) {
		t.Fatal("expected Availability() == true for g2")
	}
	if rt.External(ctx) {
		t.Fatal("expected External() == false after cutover to tei g2")
	}

	// 4. Trip the now-active "tei" breaker -> IsBreakerOpen() must report true.
	_, _, finishTEITrip := teiBreaker.Acquire()
	finishTEITrip(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503})
	if !rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == true when the active g2 (tei) breaker is open")
	}
}
