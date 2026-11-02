package jobs_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
)

type reembedEnv struct {
	pool *pgxpool.Pool
	q    *gen.Queries
	deps jobs.Dependencies
	gTEI generation.Generation
	gOA  generation.Generation
}

// newReembedEnv seeds R = {g1 tei active, g2 openai_compat pending}.
func newReembedEnv(t *testing.T, logger *slog.Logger) *reembedEnv {
	t.Helper()
	ctx := context.Background()
	pool := newTestPool(t)

	teiSrv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-re1"})
	t.Cleanup(teiSrv.Close)
	oaSrv := embedtest.NewServer(embedtest.Options{Dims: 8})
	t.Cleanup(oaSrv.Close)
	teiClient := newTEIClient(t, teiSrv, 8, "query: ", "passage: ")
	oaClient := newOpenAIClient(t, oaSrv, 8, "openrouter/qwen/qwen3-embedding-8b", "Retrieve items", embedding.RoleShadow)

	return &reembedEnv{
		pool: pool,
		q:    gen.New(pool),
		gTEI: seedGenerationForIdentity(t, ctx, pool, 1, teiClient.Identity, generation.StateActive, nil),
		gOA:  seedGenerationForIdentity(t, ctx, pool, 2, oaClient.Identity, generation.StatePending, nil),
		deps: jobs.Dependencies{
			Pool:     pool,
			Logger:   logger,
			Inserter: jobs.RiverClientInserter{Client: newInsertClient(t, pool)},
		},
	}
}

func (e *reembedEnv) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	u, err := e.q.InsertUser(context.Background(), gen.InsertUserParams{Email: email, Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	return u.ID
}

func (e *reembedEnv) item(t *testing.T, user uuid.UUID, name string) uuid.UUID {
	t.Helper()
	row, err := e.q.InsertItem(context.Background(), gen.InsertItemParams{
		UserID: user, Name: name, NameNormalized: strings.ToLower(name),
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	return row.ID
}

// queued returns "generation_id/user_id" for every queued embed_item job.
func (e *reembedEnv) queued(t *testing.T) map[string]int {
	t.Helper()
	rows, err := e.pool.Query(context.Background(),
		`SELECT args->>'generation_id', args->>'user_id' FROM river_job WHERE kind = $1`, jobargs.KindEmbedItem)
	if err != nil {
		t.Fatalf("query river_job: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var g, u string
		if err := rows.Scan(&g, &u); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[g+"/"+u]++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func TestReembedInsertOpts(t *testing.T) {
	for _, tc := range []struct {
		name     string
		opts     *river.InsertOpts
		priority int
	}{
		{"reembed_user", jobs.ReembedUserInsertOpts(), 3},
		{"reembed_all", jobs.ReembedAllInsertOpts(), 4},
	} {
		if tc.opts.Queue != jobs.QueueEmbedding || tc.opts.Priority != tc.priority {
			t.Fatalf("%s opts queue=%q priority=%d, want %q / %d", tc.name, tc.opts.Queue, tc.opts.Priority, jobs.QueueEmbedding, tc.priority)
		}
		if !tc.opts.UniqueOpts.ByArgs {
			t.Fatalf("%s UniqueOpts.ByArgs = false, want true", tc.name)
		}
		for _, st := range tc.opts.UniqueOpts.ByState {
			if st == rivertype.JobStateCompleted || st == rivertype.JobStateDiscarded || st == rivertype.JobStateCancelled {
				t.Fatalf("%s ByState includes finalized state %q", tc.name, st)
			}
		}
	}

	args, opts := jobs.ReembedAllPeriodicConstructor()
	if args.Kind() != jobargs.KindReembedAll || opts.Priority != 4 {
		t.Fatalf("periodic constructor = %q priority %d, want reembed_all / 4", args.Kind(), opts.Priority)
	}
	if jobs.ReembedAllInterval.Hours() != 24 {
		t.Fatalf("ReembedAllInterval = %s, want 24h (OQ-15)", jobs.ReembedAllInterval)
	}
	if jobs.ReembedAllPeriodicJob() == nil {
		t.Fatal("ReembedAllPeriodicJob returned nil")
	}
}

func TestInsertReembedAllDeduplicates(t *testing.T) {
	ctx := context.Background()
	e := newReembedEnv(t, nil)

	first, err := jobs.InsertReembedAll(ctx, e.deps.Inserter, 0)
	if err != nil || first.UniqueSkippedAsDuplicate {
		t.Fatalf("first InsertReembedAll: dup=%v err=%v, want a fresh insert", first != nil && first.UniqueSkippedAsDuplicate, err)
	}
	second, err := jobs.InsertReembedAll(ctx, e.deps.Inserter, 0)
	if err != nil || !second.UniqueSkippedAsDuplicate {
		t.Fatalf("second InsertReembedAll: err=%v, want a deduplicated insert", err)
	}
	var n int
	if err := e.pool.QueryRow(ctx, `SELECT count(*)::int FROM river_job WHERE kind = $1`, jobargs.KindReembedAll).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("reembed_all rows = %d, want 1", n)
	}
	// A different generation filter is a different job.
	if r, err := jobs.InsertReembedAll(ctx, e.deps.Inserter, 2); err != nil || r.UniqueSkippedAsDuplicate {
		t.Fatalf("InsertReembedAll(gen 2): err=%v dup=%v, want a fresh insert", err, r != nil && r.UniqueSkippedAsDuplicate)
	}
}

func TestReembedAllWorkerGenerationScope(t *testing.T) {
	ctx := context.Background()
	e := newReembedEnv(t, nil)
	u := e.user(t, "reembed-all@example.com")
	e.item(t, u, "Scope item")
	w := jobs.NewReembedAllWorker(e.deps)

	// generation_id outside R cancels without touching anything.
	err := w.Work(ctx, &river.Job[jobargs.ReembedAllArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1}, Args: jobargs.ReembedAllArgs{GenerationID: 99},
	})
	var cancelErr *river.JobCancelError
	if !errors.As(err, &cancelErr) {
		t.Fatalf("Work(generation 99) err = %v, want *river.JobCancelError", err)
	}
	if got := e.queued(t); len(got) != 0 {
		t.Fatalf("queued after cancelled run = %v, want none", got)
	}

	// One generation only.
	if err := w.Work(ctx, &river.Job[jobargs.ReembedAllArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1}, Args: jobargs.ReembedAllArgs{GenerationID: e.gOA.ID},
	}); err != nil {
		t.Fatalf("Work(generation 2): %v", err)
	}
	got := e.queued(t)
	if len(got) != 1 || got["2/"+u.String()] != 1 {
		t.Fatalf("queued after generation-2 run = %v, want only generation 2", got)
	}

	// Every generation in R.
	if err := w.Work(ctx, &river.Job[jobargs.ReembedAllArgs]{JobRow: &rivertype.JobRow{Attempt: 1}}); err != nil {
		t.Fatalf("Work(all): %v", err)
	}
	got = e.queued(t)
	if len(got) != 2 || got["1/"+u.String()] != 1 || got["2/"+u.String()] != 1 {
		t.Fatalf("queued after all-generations run = %v, want generations 1 and 2", got)
	}
}

func TestReembedUserWorkerOnlyThatUser(t *testing.T) {
	ctx := context.Background()
	e := newReembedEnv(t, nil)
	a := e.user(t, "reembed-user-a@example.com")
	b := e.user(t, "reembed-user-b@example.com")
	e.item(t, a, "User A item")
	e.item(t, b, "User B item")
	w := jobs.NewReembedUserWorker(e.deps)

	if err := w.Work(ctx, &river.Job[jobargs.ReembedUserArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1}, Args: jobargs.ReembedUserArgs{UserID: a.String()},
	}); err != nil {
		t.Fatalf("Work(user a): %v", err)
	}
	got := e.queued(t)
	if len(got) != 2 || got["1/"+a.String()] != 1 || got["2/"+a.String()] != 1 {
		t.Fatalf("queued = %v, want user a in both generations and nobody else", got)
	}

	err := w.Work(ctx, &river.Job[jobargs.ReembedUserArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1}, Args: jobargs.ReembedUserArgs{UserID: "not-a-uuid"},
	})
	var cancelErr *river.JobCancelError
	if !errors.As(err, &cancelErr) {
		t.Fatalf("Work(invalid user_id) err = %v, want *river.JobCancelError", err)
	}
	if strings.Contains(err.Error(), "not-a-uuid") {
		t.Fatalf("error echoes the raw user_id: %v", err)
	}
}

func TestReembedWorkersLogNoPlaintext(t *testing.T) {
	ctx := context.Background()
	var buf bytes.Buffer
	e := newReembedEnv(t, slog.New(slog.NewJSONHandler(&buf, nil)))
	u := e.user(t, "reembed-log@example.com")
	const name = "Distinctive-Log-Name-7731"
	e.item(t, u, name)

	if err := jobs.NewReembedAllWorker(e.deps).Work(ctx, &river.Job[jobargs.ReembedAllArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1},
	}); err != nil {
		t.Fatalf("Work: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `"generation_id"`) || !strings.Contains(out, `"enqueued"`) {
		t.Fatalf("log lacks generation_id/enqueued counts: %s", out)
	}
	for _, secret := range []string{name, "reembed-log@example.com", u.String()} {
		if strings.Contains(out, secret) {
			t.Fatalf("log output contains %q", secret)
		}
	}
}
