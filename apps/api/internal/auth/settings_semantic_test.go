package auth_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
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
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/semantic/semantictest"
)

// One shared Postgres container per package run (plan P05 gate 10): TestMain
// owns it and every DB-backed test in this package (settings_semantic_test.go,
// session_test.go, mail_failure_acceptance_test.go) gets its own migrated
// database inside it via semNewPool. Nothing in this package calls
// dbtest.StartPostgres.
var (
	semSharedOnce      sync.Once
	semSharedDSN       string
	semSharedErr       error
	semSharedContainer testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if semSharedContainer != nil {
		_ = testcontainers.TerminateContainer(semSharedContainer)
	}
	os.Exit(code)
}

func semBaseDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		return envDSN
	}
	semSharedOnce.Do(func() {
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
			semSharedErr = err
			return
		}
		semSharedContainer = c
		semSharedDSN, semSharedErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if semSharedErr != nil {
		t.Fatalf("start shared Postgres container: %v", semSharedErr)
	}
	return semSharedDSN
}

func semNewPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := semBaseDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_authsem_" + hex.EncodeToString(nonce[:])

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
	if err := conn.Close(ctx); err != nil {
		t.Fatalf("close admin conn: %v", err)
	}

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

// ---- identities, runtimes -------------------------------------------------

func semTEIIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      embedding.ProviderTEI,
		Model:         embedding.FakeEmbedModel,
		ModelVersion:  embedding.FakeEmbedModelSHA + ";qp=00000000;dp=00000000",
		Dims:          8,
		Preprocessing: embedding.Preprocessing,
	}
}

func semOpenAIIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      embedding.ProviderOpenAICompat,
		Model:         "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "dims=8;instr=12345678",
		Dims:          8,
		QueryPrefix:   "Instruct: Given a short search query, retrieve matching item names or tags\nQuery:",
		Preprocessing: embedding.Preprocessing,
	}
}

func semPin(genID int, id embedid.Identity) generation.Pin {
	return generation.Pin{
		GenID:     genID,
		Identity:  id,
		MinCos:    0.62,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
}

func semCalibration(want embedid.Identity) embedid.CalibrationLookup {
	return func(id embedid.Identity) (float64, string, bool) {
		if id.Provider == want.Provider && id.Model == want.Model && id.ModelVersion == want.ModelVersion {
			return 0.62, "docs/benchmarks/semantic-eval/report-test.json", true
		}
		return 0, "", false
	}
}

func semClientSet(id embedid.Identity) *embedding.ClientSet {
	spy := semantictest.NewSpyProvider(id)
	return embedding.NewClientSet(embedding.NewClient(spy, id.QueryPrefix, id.DocPrefix), nil)
}

var semFixedNow = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

type semRuntimeCase struct {
	name string
	// build returns a real semantic.Runtime wired with spies (no network).
	build         func() *semantic.Runtime
	wantAvailable bool
	wantExternal  bool
}

// semRuntimeCases covers plan P05 mục 2.18 rows 1, 2, 3a, 3b (x3), 4, 6, 8.
func semRuntimeCases() []semRuntimeCase {
	ctx := context.Background()
	tei := semTEIIdentity()
	openAI := semOpenAIIdentity()
	clk := func() clock.Clock { return clock.NewFixed(semFixedNow) }

	return []semRuntimeCase{
		{
			name: "row1_disabled_deployment",
			build: func() *semantic.Runtime {
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: false, Provider: embedding.ProviderTEI, ClientSet: semClientSet(tei),
					Pinner: semantictest.NewSpyPinner(semPin(1, tei), true), Calibration: semCalibration(tei), Clock: clk(),
				})
			},
		},
		{
			name: "row2_noop_provider",
			build: func() *semantic.Runtime {
				noopCS := embedding.NewClientSet(embedding.NewClient(embedding.NewNoop(), "", ""), nil)
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderNoop, ClientSet: noopCS,
					Pinner: semantictest.NewSpyPinner(semPin(1, tei), true), Calibration: semCalibration(tei), Clock: clk(),
				})
			},
		},
		{
			name: "row3a_bootstrap_pending_no_active",
			build: func() *semantic.Runtime {
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderTEI, ClientSet: semClientSet(tei),
					Pinner: semantictest.NewSpyPinner(generation.Pin{}, false), Calibration: semCalibration(tei), Clock: clk(),
				})
			},
		},
		{
			name: "row3b_active_not_matching_client",
			build: func() *semantic.Runtime {
				other := tei
				other.ModelVersion = "different-sha;qp=00000000;dp=00000000"
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderTEI, ClientSet: semClientSet(tei),
					Pinner: semantictest.NewSpyPinner(semPin(1, other), true), Calibration: semCalibration(other), Clock: clk(),
				})
			},
		},
		{
			name: "row3b_missing_calibration",
			build: func() *semantic.Runtime {
				none := func(embedid.Identity) (float64, string, bool) { return 0, "", false }
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderTEI, ClientSet: semClientSet(tei),
					Pinner: semantictest.NewSpyPinner(semPin(1, tei), true), Calibration: none, Clock: clk(),
				})
			},
		},
		{
			name: "row4_tei_available",
			build: func() *semantic.Runtime {
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderTEI, ClientSet: semClientSet(tei),
					Pinner: semantictest.NewSpyPinner(semPin(1, tei), true), Calibration: semCalibration(tei), Clock: clk(),
				})
			},
			wantAvailable: true,
		},
		{
			name: "row6_openai_available_external",
			build: func() *semantic.Runtime {
				return semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderOpenAICompat, ClientSet: semClientSet(openAI),
					Pinner: semantictest.NewSpyPinner(semPin(1, openAI), true), Calibration: semCalibration(openAI), Clock: clk(),
				})
			},
			wantAvailable: true,
			wantExternal:  true,
		},
		{
			name: "row8_breaker_open_static_available",
			build: func() *semantic.Runtime {
				rt := semantic.NewRuntime(semantic.RuntimeConfig{
					Enabled: true, Provider: embedding.ProviderOpenAICompat, ClientSet: semClientSet(openAI),
					Pinner: semantictest.NewSpyPinner(semPin(1, openAI), true), Calibration: semCalibration(openAI), Clock: clk(),
				})
				// Cache the active provider first so IsBreakerOpen reads its breaker.
				rt.Availability(ctx)
				_, _, finish := rt.Breaker().Acquire()
				finish(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503})
				return rt
			},
			wantAvailable: true,
			wantExternal:  true,
		},
	}
}

func semRuntimeNamed(t *testing.T, name string) *semantic.Runtime {
	t.Helper()
	for _, tc := range semRuntimeCases() {
		if tc.name == name {
			return tc.build()
		}
	}
	t.Fatalf("unknown runtime case %q", name)
	return nil
}

// ---- service, user, generations ------------------------------------------

func semNewService(t *testing.T, pool *pgxpool.Pool, sem auth.SemanticRuntime) *auth.Service {
	t.Helper()
	return semNewServiceClock(t, pool, sem, clock.NewFixed(semFixedNow))
}

// semNewServiceClock is semNewService with a caller-owned clock so a test can
// advance time (token bucket refill).
func semNewServiceClock(t *testing.T, pool *pgxpool.Pool, sem auth.SemanticRuntime, clk clock.Clock) *auth.Service {
	t.Helper()
	cfg := &config.Config{
		AppOrigin:        "http://localhost:3000",
		AuthJWTSecret:    bytes32(1),
		AuthCSRFSecret:   bytes32(2),
		AuthReauthSecret: bytes32(3),
		AuthIPPepper:     bytes32(4),
		AuthEmailPepper:  bytes32(5),
	}
	riverc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	var opts []compose.AuthOption
	if sem != nil {
		opts = append(opts, compose.WithSemantic(sem))
	}
	svc, _, _, err := compose.NewAuth(cfg, pool, riverc, clk, mail, nil, opts...)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	t.Cleanup(svc.Close)
	return svc
}

type semUser struct {
	id        uuid.UUID
	principal authctx.Principal
}

func semNewUser(t *testing.T, pool *pgxpool.Pool, svc *auth.Service, email string, semanticSuggest bool) semUser {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	if !semanticSuggest {
		if _, err := q.UpdateUserSemanticSuggest(ctx, gen.UpdateUserSemanticSuggestParams{ID: u.ID, SemanticSuggest: false}); err != nil {
			t.Fatalf("UpdateUserSemanticSuggest: %v", err)
		}
	}
	issued, err := svc.Sessions().Issue(ctx, nil, auth.IssueParams{UserID: u.ID})
	if err != nil {
		t.Fatalf("Sessions().Issue: %v", err)
	}
	return semUser{id: u.ID, principal: issued.Principal}
}

func semPatch(svc *auth.Service, u semUser, semanticSuggest bool) (auth.Me, error) {
	return svc.PatchSettings(context.Background(), u.principal, auth.SettingsPatch{SemanticSuggest: &semanticSuggest})
}

func semIsUnavailable(err error) bool {
	return errors.Is(err, auth.ErrSemanticUnavailable)
}

// semSeedGeneration creates a generation row + vector tables (dims 3, 4
// partitions) in the requested state.
func semSeedGeneration(t *testing.T, pool *pgxpool.Pool, id int, provider, state string, rollbackUntil *time.Time) generation.Generation {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(id),
		Provider:           provider,
		Model:              provider + "/model-g" + string(rune('0'+id)),
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		Dims:               3,
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
		ID: int32(id), Dims: 3, Partitions: 4, WithHnsw: false, HnswM: 16, HnswEfConstruction: 64,
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
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{GenerationID: int32(id), FlippedReason: &reason}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
		}
	case generation.StateRetired:
		var ts pgtype.Timestamptz
		if rollbackUntil != nil {
			ts = pgtype.Timestamptz{Time: *rollbackUntil, Valid: true}
		}
		row, err = q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{ID: int32(id), RollbackUntil: ts})
		if err != nil {
			t.Fatalf("RetireEmbeddingGeneration g%d: %v", id, err)
		}
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	return g
}

// semSeedTargets inserts one item and one tag for the user (names are
// synthetic) and stores a vector for each in every given generation.
func semSeedTargets(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, tag string, gens ...generation.Generation) {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	it, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: userID, Name: "Item " + tag, NameNormalized: "item " + tag})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	tg, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: userID, Display: "Tag" + tag, Normalized: "tag" + tag})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}
	hash := make([]byte, 32)
	vec := []float32{1, 0, 0}
	for _, g := range gens {
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, userID, it.ID, vec, hash); err != nil {
			t.Fatalf("Upsert item g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusTag, userID, tg.ID, vec, hash); err != nil {
			t.Fatalf("Upsert tag g%d: %v", g.ID, err)
		}
	}
}

// semVectorCount returns the number of vectors (item + tag) of userID in g.
func semVectorCount(t *testing.T, pool *pgxpool.Pool, g generation.Generation, userID uuid.UUID) int {
	t.Helper()
	ctx := context.Background()
	total := 0
	for _, tbl := range []string{g.ItemTable, g.TagTable} {
		var n int
		// Table names come from the validated generation row (item|tag_embedding_g<N>).
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+pgx.Identifier{tbl}.Sanitize()+` WHERE user_id = $1`, userID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tbl, err)
		}
		total += n
	}
	return total
}

func semReembedJobs(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM river_job WHERE kind = 'reembed_user' AND args->>'user_id' = $1`, userID.String(),
	).Scan(&n); err != nil {
		t.Fatalf("count reembed_user jobs: %v", err)
	}
	return n
}

func semStoredSemanticSuggest(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) bool {
	t.Helper()
	var v bool
	if err := pool.QueryRow(context.Background(),
		`SELECT COALESCE((settings->>'semantic_suggest')::boolean, true) FROM app_user WHERE id = $1`, userID).Scan(&v); err != nil {
		t.Fatalf("read semantic_suggest: %v", err)
	}
	return v
}

func semReadyz(t *testing.T, availability func(context.Context) bool) (int, bool) {
	t.Helper()
	router := httpx.NewRouter(httpx.Deps{
		Config:               &config.Config{Env: "test"},
		Logger:               obs.NewLogger("error", "test"),
		Ready:                func(context.Context) error { return nil },
		Metrics:              http.NotFoundHandler(),
		SemanticAvailability: availability,
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))
	var body struct {
		Status            string `json:"status"`
		SemanticAvailable bool   `json:"semantic_available"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("readyz body: %v", err)
	}
	return rec.Code, body.SemanticAvailable
}

// ---- tests ----------------------------------------------------------------

// TestSettingsSemanticMatrix covers plan P05 mục 2.18 rows 1–3b, 4, 6, 8 and 11
// for features (/auth/me), PATCH and /readyz.
func TestSettingsSemanticMatrix(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)

	for i, tc := range semRuntimeCases() {
		t.Run(tc.name, func(t *testing.T) {
			rt := tc.build()
			svc := semNewService(t, pool, rt)
			u := semNewUser(t, pool, svc, "matrix-"+string(rune('a'+i))+"@example.com", true)

			// features: static availability and semantic_external, always present.
			me, err := svc.BuildMe(ctx, u.id)
			if err != nil {
				t.Fatalf("BuildMe: %v", err)
			}
			if me.Features.SemanticAvailable != tc.wantAvailable {
				t.Errorf("features.semantic_available = %v, want %v", me.Features.SemanticAvailable, tc.wantAvailable)
			}
			if me.Features.SemanticExternal != tc.wantExternal {
				t.Errorf("features.semantic_external = %v, want %v", me.Features.SemanticExternal, tc.wantExternal)
			}
			raw, err := json.Marshal(me)
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Features map[string]json.RawMessage `json:"features"`
			}
			if err := json.Unmarshal(raw, &wire); err != nil {
				t.Fatal(err)
			}
			if _, ok := wire.Features["semantic_external"]; !ok {
				t.Error("features.semantic_external missing from /auth/me JSON")
			}

			// readyz: same function, never 503 for semantic.
			code, ready := semReadyz(t, rt.Availability)
			if code != http.StatusOK {
				t.Errorf("readyz status = %d, want 200", code)
			}
			if ready != tc.wantAvailable {
				t.Errorf("readyz semantic_available = %v, want %v", ready, tc.wantAvailable)
			}

			// PATCH true: 409 unless available with a closed breaker (also when
			// the stored value is already true).
			_, err = semPatch(svc, u, true)
			if tc.wantAvailable && tc.name != "row8_breaker_open_static_available" {
				if err != nil {
					t.Fatalf("PATCH true: %v, want success", err)
				}
			} else if !semIsUnavailable(err) {
				t.Fatalf("PATCH true: %v, want semantic_unavailable", err)
			}

			// Row 11: PATCH false is always 200 and stores false.
			me, err = semPatch(svc, u, false)
			if err != nil {
				t.Fatalf("PATCH false: %v, want 200", err)
			}
			if me.Settings.SemanticSuggest {
				t.Error("PATCH false returned semantic_suggest=true")
			}
			if semStoredSemanticSuggest(t, pool, u.id) {
				t.Error("stored semantic_suggest still true after PATCH false")
			}
		})
	}
}

// TestSettingsSemanticWithoutRuntime: no compose.WithSemantic option means
// unavailable and semantic_external=false (no active provider).
func TestSettingsSemanticWithoutRuntime(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := semNewService(t, pool, nil)
	u := semNewUser(t, pool, svc, "noruntime@example.com", true)

	me, err := svc.BuildMe(ctx, u.id)
	if err != nil {
		t.Fatal(err)
	}
	if me.Features.SemanticAvailable || me.Features.SemanticExternal {
		t.Errorf("features = available:%v external:%v, want both false", me.Features.SemanticAvailable, me.Features.SemanticExternal)
	}
	if _, err := semPatch(svc, u, true); !semIsUnavailable(err) {
		t.Fatalf("PATCH true without runtime: %v, want semantic_unavailable", err)
	}
	if code, ready := semReadyz(t, nil); code != http.StatusOK || ready {
		t.Errorf("readyz without availability func = %d/%v, want 200/false", code, ready)
	}
}

// TestAuthMeNoNetworkCall: a real Runtime backed by a real provider client
// pointed at a counting server; /auth/me, PATCH (both directions) and /readyz
// never send it a request.
func TestAuthMeNoNetworkCall(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)

	var hits atomic.Int64
	emb := embedtest.NewHandler(embedtest.Options{Dims: 8})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		emb.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	client, err := embedding.NewClientFromConfig(ctx, embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(srv.URL + "/v1"),
		APIKey:           embedding.NewSecret("sk-test-auth-no-network"),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             8,
		QueryInstruction: "Retrieve items",
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}
	cs := embedding.NewClientSet(client, nil)
	id := cs.Primary().Identity
	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:     true,
		Provider:    embedding.ProviderOpenAICompat,
		ClientSet:   cs,
		Pinner:      semantictest.NewSpyPinner(semPin(1, id), true),
		Calibration: semCalibration(id),
		Clock:       clock.NewFixed(semFixedNow),
	})

	svc := semNewService(t, pool, rt)
	u := semNewUser(t, pool, svc, "nonet@example.com", true)
	base := hits.Load() // anything the client did while being constructed

	me, err := svc.BuildMe(ctx, u.id)
	if err != nil {
		t.Fatal(err)
	}
	if !me.Features.SemanticAvailable || !me.Features.SemanticExternal {
		t.Fatalf("features = available:%v external:%v, want both true (test would be vacuous)", me.Features.SemanticAvailable, me.Features.SemanticExternal)
	}
	if _, err := semPatch(svc, u, false); err != nil {
		t.Fatalf("PATCH false: %v", err)
	}
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true: %v", err)
	}
	if code, ready := semReadyz(t, rt.Availability); code != http.StatusOK || !ready {
		t.Fatalf("readyz = %d/%v, want 200/true", code, ready)
	}
	if _, err := svc.BuildMe(ctx, u.id); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load() - base; got != 0 {
		t.Fatalf("provider received %d requests from /auth/me, PATCH and /readyz, want 0", got)
	}
}

// TestPatchOffOpenAICompatDeletesOnlyThatUser: user A turns semantic off; A's
// item and tag vectors in the openai_compat generation are gone, B's remain.
func TestPatchOffOpenAICompatDeletesOnlyThatUser(t *testing.T) {
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row4_tei_available"))
	g1 := semSeedGeneration(t, pool, 1, generation.ProviderOpenAICompat, generation.StateActive, nil)

	a := semNewUser(t, pool, svc, "off-a@example.com", true)
	b := semNewUser(t, pool, svc, "off-b@example.com", true)
	semSeedTargets(t, pool, a.id, "a", g1)
	semSeedTargets(t, pool, b.id, "b", g1)

	if got := semVectorCount(t, pool, g1, a.id); got != 2 {
		t.Fatalf("seed: user A vectors = %d, want 2", got)
	}
	me, err := semPatch(svc, a, false)
	if err != nil {
		t.Fatalf("PATCH false: %v", err)
	}
	if me.Settings.SemanticSuggest {
		t.Error("returned semantic_suggest = true after PATCH false")
	}
	if got := semVectorCount(t, pool, g1, a.id); got != 0 {
		t.Errorf("user A vectors after PATCH false = %d, want 0", got)
	}
	if got := semVectorCount(t, pool, g1, b.id); got != 2 {
		t.Errorf("user B vectors after A's PATCH false = %d, want 2 (untouched)", got)
	}
	if !semStoredSemanticSuggest(t, pool, b.id) {
		t.Error("user B semantic_suggest changed")
	}
}

// TestPatchOffMixedProvidersDeletesOnlyExternal (BE-3): tei active +
// openai_compat pending + openai_compat retired past its window: both
// openai_compat generations lose the user's vectors, tei keeps them.
func TestPatchOffMixedProvidersDeletesOnlyExternal(t *testing.T) {
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row4_tei_available"))

	expired := time.Now().Add(-48 * time.Hour)
	g3 := semSeedGeneration(t, pool, 3, generation.ProviderOpenAICompat, generation.StateRetired, &expired)
	g1 := semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	g2 := semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	a := semNewUser(t, pool, svc, "mixed-a@example.com", true)
	b := semNewUser(t, pool, svc, "mixed-b@example.com", true)
	semSeedTargets(t, pool, a.id, "a", g1, g2, g3)
	semSeedTargets(t, pool, b.id, "b", g1, g2, g3)

	if _, err := semPatch(svc, a, false); err != nil {
		t.Fatalf("PATCH false: %v", err)
	}
	if got := semVectorCount(t, pool, g1, a.id); got != 2 {
		t.Errorf("tei g1 vectors of A = %d, want 2 (kept)", got)
	}
	for _, g := range []generation.Generation{g2, g3} {
		if got := semVectorCount(t, pool, g, a.id); got != 0 {
			t.Errorf("openai_compat g%d vectors of A = %d, want 0", g.ID, got)
		}
	}
	for _, g := range []generation.Generation{g1, g2, g3} {
		if got := semVectorCount(t, pool, g, b.id); got != 2 {
			t.Errorf("user B g%d vectors = %d, want 2 (untouched)", g.ID, got)
		}
	}
}

// TestPatchOnEnqueuesReembedUser: off -> on enqueues reembed_user (queue
// embedding, priority 3) when R holds openai_compat generations; on -> on
// enqueues nothing; a tei-only R enqueues nothing.
func TestPatchOnEnqueuesReembedUser(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row6_openai_available_external"))

	// R = {g1 tei active, g2 openai pending, g3 openai retired inside its window}.
	inWindow := time.Now().Add(48 * time.Hour)
	semSeedGeneration(t, pool, 3, generation.ProviderOpenAICompat, generation.StateRetired, &inWindow)
	semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	u := semNewUser(t, pool, svc, "on-a@example.com", false)
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true from false: %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 1 {
		t.Fatalf("reembed_user jobs after off->on = %d, want 1 (one job covers every openai_compat generation in R)", got)
	}
	var queue string
	var priority int
	if err := pool.QueryRow(ctx,
		`SELECT queue, priority FROM river_job WHERE kind = 'reembed_user' AND args->>'user_id' = $1`, u.id.String(),
	).Scan(&queue, &priority); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if queue != jobs.QueueEmbedding || priority != 3 {
		t.Errorf("reembed_user queue/priority = %q/%d, want %q/3", queue, priority, jobs.QueueEmbedding)
	}

	// on -> on: idempotent, no second job.
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true when already true: %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 1 {
		t.Errorf("reembed_user jobs after on->on = %d, want 1", got)
	}

	// Stored value is on after the toggle.
	if !semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("stored semantic_suggest = false after PATCH true")
	}
}

// semMarkReembedRunning flips every reembed_user job of the user to running,
// as a worker would while its pass is in flight (no worker is started).
func semMarkReembedRunning(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) {
	t.Helper()
	tag, err := pool.Exec(context.Background(),
		`UPDATE river_job SET state = 'running', attempt = 1, attempted_at = now()
		 WHERE kind = 'reembed_user' AND args->>'user_id' = $1`, userID.String())
	if err != nil {
		t.Fatalf("mark reembed_user running: %v", err)
	}
	if tag.RowsAffected() == 0 {
		t.Fatal("mark reembed_user running: no job row")
	}
}

// TestPatchOnOffOnWhileFirstJobRunning (RV-T13-BE-1): an off->on whose
// reembed_user is still running must not swallow the next off->on. The insert
// has no uniqueness, so the second toggle gets its own job; true->true adds none.
func TestPatchOnOffOnWhileFirstJobRunning(t *testing.T) {
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row6_openai_available_external"))
	semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	u := semNewUser(t, pool, svc, "onoffon@example.com", true)
	if _, err := semPatch(svc, u, false); err != nil {
		t.Fatalf("PATCH false (1): %v", err)
	}
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true (1): %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 1 {
		t.Fatalf("reembed_user jobs after first off->on = %d, want 1", got)
	}
	semMarkReembedRunning(t, pool, u.id)

	if _, err := semPatch(svc, u, false); err != nil {
		t.Fatalf("PATCH false (2): %v", err)
	}
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true (2): %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 2 {
		t.Errorf("reembed_user jobs after on/off/on with the first running = %d, want 2 (no dedupe against running)", got)
	}

	// true -> true inserts nothing.
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true when already true: %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 2 {
		t.Errorf("reembed_user jobs after true->true = %d, want 2", got)
	}
	if !semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("stored semantic_suggest = false after PATCH true")
	}
}

// TestPatchOnReembedRateLimited (advisor-dec-301 addendum): at most 5 off->on
// reembed_user inserts per user per 600 s. The 6th toggle still succeeds and
// stores true but enqueues nothing; advancing the clock refills the bucket.
func TestPatchOnReembedRateLimited(t *testing.T) {
	pool := semNewPool(t)
	clk := clock.NewFixed(semFixedNow)
	svc := semNewServiceClock(t, pool, semRuntimeNamed(t, "row6_openai_available_external"), clk)
	semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	u := semNewUser(t, pool, svc, "ratelimit@example.com", true)
	toggle := func(step string) {
		t.Helper()
		if _, err := semPatch(svc, u, false); err != nil {
			t.Fatalf("%s: PATCH false: %v", step, err)
		}
		if _, err := semPatch(svc, u, true); err != nil {
			t.Fatalf("%s: PATCH true: %v, want 200 even when rate limited", step, err)
		}
		if !semStoredSemanticSuggest(t, pool, u.id) {
			t.Fatalf("%s: stored semantic_suggest = false after PATCH true", step)
		}
	}

	for i := 1; i <= 5; i++ {
		toggle("toggle " + strconv.Itoa(i))
		if got := semReembedJobs(t, pool, u.id); got != i {
			t.Fatalf("reembed_user jobs after toggle %d = %d, want %d", i, got, i)
		}
	}
	toggle("toggle 6 (over the limit)")
	if got := semReembedJobs(t, pool, u.id); got != 5 {
		t.Errorf("reembed_user jobs after the 6th toggle = %d, want 5 (rate limited, setting still stored)", got)
	}

	// 130 s refills 130*5/600 = 1.08 tokens: exactly one more insert.
	clk.Advance(130 * time.Second)
	toggle("toggle 7 (after refill)")
	if got := semReembedJobs(t, pool, u.id); got != 6 {
		t.Errorf("reembed_user jobs after refill = %d, want 6", got)
	}
	toggle("toggle 8 (bucket empty again)")
	if got := semReembedJobs(t, pool, u.id); got != 6 {
		t.Errorf("reembed_user jobs right after the refilled token was spent = %d, want 6", got)
	}
}

// TestPatchOnTEIOnlyEnqueuesNothing: deployment with only tei generations in R:
// turning semantic back on stores the value and enqueues no job (tei is
// already up to date).
func TestPatchOnTEIOnlyEnqueuesNothing(t *testing.T) {
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row4_tei_available"))
	semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)

	u := semNewUser(t, pool, svc, "on-tei@example.com", false)
	if _, err := semPatch(svc, u, true); err != nil {
		t.Fatalf("PATCH true: %v", err)
	}
	if got := semReembedJobs(t, pool, u.id); got != 0 {
		t.Errorf("reembed_user jobs with tei-only R = %d, want 0", got)
	}
	if !semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("stored semantic_suggest = false after PATCH true")
	}
}

// TestPatchOffTEIOnlyDeletesNothing: deployment with only tei: off keeps the
// user's vectors.
func TestPatchOffTEIOnlyDeletesNothing(t *testing.T) {
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row4_tei_available"))
	g1 := semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)

	u := semNewUser(t, pool, svc, "off-tei@example.com", true)
	semSeedTargets(t, pool, u.id, "t", g1)
	if _, err := semPatch(svc, u, false); err != nil {
		t.Fatalf("PATCH false: %v", err)
	}
	if got := semVectorCount(t, pool, g1, u.id); got != 2 {
		t.Errorf("tei vectors after PATCH false = %d, want 2 (kept)", got)
	}
}

// TestPatchOnWhileBreakerOpen409: breaker open -> true is refused (409
// semantic_unavailable), nothing is stored or enqueued, while false still
// succeeds.
func TestPatchOnWhileBreakerOpen409(t *testing.T) {
	pool := semNewPool(t)
	rt := semRuntimeNamed(t, "row8_breaker_open_static_available")
	if !rt.IsBreakerOpen() {
		t.Fatal("setup: breaker must be open")
	}
	svc := semNewService(t, pool, rt)
	semSeedGeneration(t, pool, 1, generation.ProviderOpenAICompat, generation.StateActive, nil)

	u := semNewUser(t, pool, svc, "breaker@example.com", false)
	_, err := semPatch(svc, u, true)
	if !semIsUnavailable(err) {
		t.Fatalf("PATCH true with open breaker: %v, want semantic_unavailable", err)
	}
	if semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("semantic_suggest stored as true despite 409")
	}
	if got := semReembedJobs(t, pool, u.id); got != 0 {
		t.Errorf("reembed_user jobs after 409 = %d, want 0", got)
	}
	if _, err := semPatch(svc, u, false); err != nil {
		t.Errorf("PATCH false with open breaker: %v, want 200", err)
	}
}

// TestPatchLocaleDoesNotTouchSemantic: a PATCH without semantic_suggest keeps
// vectors and enqueues nothing (unchanged fields behave as before).
func TestPatchLocaleDoesNotTouchSemantic(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row6_openai_available_external"))
	g1 := semSeedGeneration(t, pool, 1, generation.ProviderOpenAICompat, generation.StateActive, nil)

	u := semNewUser(t, pool, svc, "locale@example.com", true)
	semSeedTargets(t, pool, u.id, "l", g1)
	locale := "vi"
	me, err := svc.PatchSettings(ctx, u.principal, auth.SettingsPatch{Locale: &locale})
	if err != nil {
		t.Fatalf("PATCH locale: %v", err)
	}
	if me.Settings.Locale != "vi" {
		t.Errorf("locale = %q, want vi", me.Settings.Locale)
	}
	if got := semVectorCount(t, pool, g1, u.id); got != 2 {
		t.Errorf("vectors after locale PATCH = %d, want 2", got)
	}
	if got := semReembedJobs(t, pool, u.id); got != 0 {
		t.Errorf("reembed_user jobs after locale PATCH = %d, want 0", got)
	}
}

// semWaitBlockedOn polls (dedicated connection, no sleeps, bounded by ctx)
// until some backend is waiting on a lock held by backend pid, proving a
// transaction is genuinely blocked on that holder. It fails the test early if
// done yields (the blocked operation finished instead of blocking).
func semWaitBlockedOn(ctx context.Context, t *testing.T, pool *pgxpool.Pool, pid int32, done <-chan error) {
	t.Helper()
	conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatalf("connect poller: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	for {
		var n int
		if err := conn.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`, pid,
		).Scan(&n); err != nil {
			t.Fatalf("poll pg_blocking_pids: %v", err)
		}
		if n > 0 {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("operation finished (err=%v) before blocking on backend %d", err, pid)
		case <-ctx.Done():
			t.Fatalf("no backend ever blocked on backend %d: %v", pid, ctx.Err())
		default:
		}
	}
}

// TestPatchOffRacesUpsertNoVectorLeft: an embed worker is mid step-5 (holds
// target FOR SHARE and app_user FOR SHARE, policy read as "on") when the user
// turns semantic off. The test first observes, via pg_blocking_pids, that the
// PATCH transaction is blocked on the worker's user row, and only then lets the
// worker upsert into a pending openai_compat generation and commit; the PATCH
// then deletes afterwards, so no vector is left. No sleeps; every wait is
// bounded by a context deadline, so a hang or deadlock fails the test.
func TestPatchOffRacesUpsertNoVectorLeft(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row4_tei_available"))

	g1 := semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	g2 := semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	u := semNewUser(t, pool, svc, "race@example.com", true)
	q := gen.New(pool)
	it, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u.id, Name: "Race item", NameNormalized: "race item"})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}

	ready := make(chan int32, 1) // worker backend pid once its locks are held; 0 on setup failure
	proceed := make(chan struct{})
	workerDone := make(chan error, 1)
	patchDone := make(chan error, 1)

	go func() {
		workerDone <- func() error {
			tx, err := pool.Begin(ctx)
			if err != nil {
				ready <- 0
				return err
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			var pid int32
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				ready <- 0
				return err
			}
			// Plan P05 mục 2.15 lock order: target FOR SHARE -> app_user FOR SHARE.
			if _, err := tx.Exec(ctx, `SELECT 1 FROM item WHERE id = $1 AND user_id = $2 FOR SHARE`, it.ID, u.id); err != nil {
				ready <- 0
				return err
			}
			var on bool
			if err := tx.QueryRow(ctx,
				`SELECT COALESCE((settings->>'semantic_suggest')::boolean, true) FROM app_user WHERE id = $1 FOR SHARE`, u.id,
			).Scan(&on); err != nil {
				ready <- 0
				return err
			}
			ready <- pid
			select {
			case <-proceed:
			case <-ctx.Done():
				return ctx.Err()
			}
			if !on {
				return errors.New("worker read policy off before the PATCH; test setup broken")
			}
			hash := make([]byte, 32)
			vec := []float32{0, 1, 0}
			for _, g := range []generation.Generation{g1, g2} {
				if err := store.Upsert(ctx, tx, g, generation.CorpusItem, u.id, it.ID, vec, hash); err != nil {
					return err
				}
			}
			return tx.Commit(ctx)
		}()
	}()

	var workerPID int32
	select {
	case workerPID = <-ready:
	case <-ctx.Done():
		t.Fatalf("worker never took its locks: %v", ctx.Err())
	}
	if workerPID == 0 {
		t.Fatalf("worker setup failed: %v", <-workerDone)
	}

	go func() {
		off := false
		_, err := svc.PatchSettings(ctx, u.principal, auth.SettingsPatch{SemanticSuggest: &off})
		patchDone <- err
	}()
	// The PATCH must be blocked on the worker's held app_user row before the
	// worker is released; otherwise this would only be a sequential run.
	semWaitBlockedOn(ctx, t, pool, workerPID, patchDone)
	close(proceed)

	for _, ch := range []struct {
		name string
		c    chan error
	}{{"worker", workerDone}, {"patch", patchDone}} {
		select {
		case err := <-ch.c:
			if err != nil {
				t.Fatalf("%s: %v", ch.name, err)
			}
		case <-ctx.Done():
			t.Fatalf("%s did not finish: deadlock or hang", ch.name)
		}
	}

	if got := semVectorCount(t, pool, g2, u.id); got != 0 {
		t.Errorf("openai_compat pending g2 vectors left after PATCH false = %d, want 0", got)
	}
	if got := semVectorCount(t, pool, g1, u.id); got != 1 {
		t.Errorf("tei g1 vectors = %d, want 1 (kept)", got)
	}
	if semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("semantic_suggest still true after PATCH false")
	}
}

// TestPatchOffAfterProviderBeforeUpsertSkipsExternal: reverse ordering with the
// real jobs.EmbedItemWorker. The provider result for a pending openai_compat
// generation is in flight (fake provider, no network) when BeforeStep5Tx runs;
// inside that hook the user's PATCH off commits completely. The worker then
// resumes, re-reads the policy under app_user FOR SHARE, sees off and skips the
// external upsert. No external vector remains, tei is untouched, and both
// operations terminate (the worker holds no lock while the hook runs).
func TestPatchOffAfterProviderBeforeUpsertSkipsExternal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := semNewPool(t)
	svc := semNewService(t, pool, semRuntimeNamed(t, "row6_openai_available_external"))

	g1 := semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	g2 := semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	u := semNewUser(t, pool, svc, "race-worker@example.com", true)
	q := gen.New(pool)
	const itemName = "Reverse race item"
	it, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u.id, Name: itemName, NameNormalized: "reverse race item"})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	// tei already holds the item's vector; PATCH off must keep it.
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.id, it.ID, []float32{1, 0, 0}, make([]byte, 32)); err != nil {
		t.Fatalf("seed tei vector: %v", err)
	}

	var providerCalls atomic.Int32
	spy := semantictest.NewSpyProvider(g2.Identity())
	spy.EmbedDocsFn = func(_ context.Context, inputs []string) ([][]float32, error) {
		providerCalls.Add(1)
		out := make([][]float32, len(inputs))
		for i := range inputs {
			out[i] = []float32{0, 1, 0}
		}
		return out, nil
	}
	cs := embedding.NewClientSet(embedding.Client{Provider: spy, Identity: g2.Identity(), Role: embedding.RolePrimary}, nil)

	// The hook runs on the worker goroutine (this one) between step 4 and step 5.
	hookCalls := 0
	var patchErr error
	deps := jobs.Dependencies{
		Pool:      pool,
		ClientSet: cs,
		BeforeStep5Tx: func(hctx context.Context, kind string, generationID int, targetID uuid.UUID) {
			hookCalls++
			if kind != jobargs.KindEmbedItem || generationID != g2.ID || targetID != it.ID {
				t.Errorf("hook for kind=%q gen=%d target=%s, want embed_item g%d %s", kind, generationID, targetID, g2.ID, it.ID)
			}
			if got := semVectorCount(t, pool, g2, u.id); got != 0 {
				t.Errorf("g2 vectors before PATCH off = %d, want 0 (upsert not started)", got)
			}
			off := false
			_, patchErr = svc.PatchSettings(hctx, u.principal, auth.SettingsPatch{SemanticSuggest: &off})
		},
	}

	hash := embedding.InputHashFor(g2.Identity(), embedding.ItemInput(itemName, ""))
	err = jobs.NewEmbedItemWorker(deps).Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
		Args: jobargs.EmbedItemArgs{
			GenerationID: g2.ID,
			UserID:       u.id.String(),
			TargetID:     it.ID.String(),
			InputHash:    hex.EncodeToString(hash[:]),
		},
	})
	if err != nil {
		t.Fatalf("EmbedItemWorker.Work: %v", err)
	}
	if patchErr != nil {
		t.Fatalf("PATCH off inside the hook: %v", patchErr)
	}
	if hookCalls != 1 {
		t.Fatalf("BeforeStep5Tx calls = %d, want 1 (worker must reach step 4 with the provider result in flight)", hookCalls)
	}
	if got := providerCalls.Load(); got != 1 {
		t.Errorf("provider EmbedDocuments calls = %d, want 1", got)
	}
	if got := semVectorCount(t, pool, g2, u.id); got != 0 {
		t.Errorf("openai_compat pending g2 vectors after skipped upsert = %d, want 0", got)
	}
	if got := semVectorCount(t, pool, g1, u.id); got != 1 {
		t.Errorf("tei g1 vectors = %d, want 1 (kept)", got)
	}
	if semStoredSemanticSuggest(t, pool, u.id) {
		t.Error("semantic_suggest still true after PATCH false")
	}
}
