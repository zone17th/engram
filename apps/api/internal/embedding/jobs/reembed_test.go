package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
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
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
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
	if _, err := e.pool.Exec(context.Background(),
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'true'::jsonb, true) WHERE id = $1`, u.ID); err != nil {
		t.Fatalf("set semantic_suggest=true: %v", err)
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

// TestReembedUserTwoExternalGenerations: with R = {active openai_compat g1,
// pending openai_compat g2} and two semantic_suggest-on users, reembed_user for
// A enqueues A's stale and missing targets in BOTH generation ids and nothing at
// all for B in either (Task 13 cites this test by name).
func TestReembedUserTwoExternalGenerations(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	t.Cleanup(srv.Close)
	c1 := newOpenAIClient(t, srv, 8, "openrouter/qwen/qwen3-embedding-8b", "Retrieve items", embedding.RoleShadow)
	c2 := newOpenAIClient(t, srv, 8, "openrouter/qwen/qwen3-embedding-4b", "Retrieve items", embedding.RoleShadow)
	g1 := seedGenerationForIdentity(t, ctx, pool, 1, c1.Identity, generation.StateActive, nil)
	g2 := seedGenerationForIdentity(t, ctx, pool, 2, c2.Identity, generation.StatePending, nil)
	for _, g := range []generation.Generation{g1, g2} {
		if g.Provider != generation.ProviderOpenAICompat {
			t.Fatalf("generation %d provider = %q, want openai_compat", g.ID, g.Provider)
		}
	}

	mkUser := func(email string) uuid.UUID {
		u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: "vi"})
		if err != nil {
			t.Fatalf("InsertUser: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'true'::jsonb) WHERE id = $1`, u.ID); err != nil {
			t.Fatalf("semantic_suggest on: %v", err)
		}
		return u.ID
	}
	mkItem := func(user uuid.UUID, name string) uuid.UUID {
		row, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: user, Name: name, NameNormalized: strings.ToLower(name)})
		if err != nil {
			t.Fatalf("InsertItem: %v", err)
		}
		return row.ID
	}
	mkTag := func(user uuid.UUID, display string) uuid.UUID {
		row, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: user, Display: display, Normalized: strings.ToLower(display)})
		if err != nil {
			t.Fatalf("InsertTag: %v", err)
		}
		return row.ID
	}
	putStale := func(g generation.Generation, user, item uuid.UUID) {
		h := embedding.InputHashFor(g.Identity(), "outdated input before edit")
		vec := make([]float32, g.Dims)
		vec[0] = 1
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, user, item, vec, h[:]); err != nil {
			t.Fatalf("store.Upsert: %v", err)
		}
	}

	a := mkUser("two-ext-a@example.com")
	b := mkUser("two-ext-b@example.com")
	aMissing, aStale, aTag := mkItem(a, "A missing item"), mkItem(a, "A stale item"), mkTag(a, "a-tag")
	bMissing, bStale, bTag := mkItem(b, "B missing item"), mkItem(b, "B stale item"), mkTag(b, "b-tag")
	for _, g := range []generation.Generation{g1, g2} {
		putStale(g, a, aStale)
		putStale(g, b, bStale)
	}

	// One ClientSet whose primary/shadow identities match BOTH external generations,
	// so the real T11a workers can serve either generation id.
	cs := embedding.NewClientSet(c1, &c2)
	deps := jobs.Dependencies{Pool: pool, ClientSet: cs, Inserter: jobs.RiverClientInserter{Client: newInsertClient(t, pool)}}
	if err := jobs.NewReembedUserWorker(deps).Work(ctx, &river.Job[jobargs.ReembedUserArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1}, Args: jobargs.ReembedUserArgs{UserID: a.String()},
	}); err != nil {
		t.Fatalf("Work(user a): %v", err)
	}

	type queuedJob struct {
		kind, user, target, hash string
		genID                    int
	}
	rows, err := pool.Query(ctx,
		`SELECT kind, (args->>'generation_id')::int, args->>'user_id', args->>'target_id', args->>'input_hash'
		 FROM river_job WHERE kind IN ($1, $2)`, jobargs.KindEmbedItem, jobargs.KindEmbedTag)
	if err != nil {
		t.Fatalf("query jobs: %v", err)
	}
	var queued []queuedJob
	for rows.Next() {
		var j queuedJob
		if err := rows.Scan(&j.kind, &j.genID, &j.user, &j.target, &j.hash); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		queued = append(queued, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	// Exact six jobs: user a's missing item, stale item and tag in each generation,
	// each carrying the input_hash of that generation's identity over the live input.
	inputOf := map[uuid.UUID]string{
		aMissing: embedding.ItemInput("A missing item", ""),
		aStale:   embedding.ItemInput("A stale item", ""),
		aTag:     embedding.TagInput("a-tag"),
	}
	kindOf := map[uuid.UUID]string{aMissing: jobargs.KindEmbedItem, aStale: jobargs.KindEmbedItem, aTag: jobargs.KindEmbedTag}
	hashHex := func(g generation.Generation, input string) string {
		h := embedding.InputHashFor(g.Identity(), input)
		return hex.EncodeToString(h[:])
	}
	byID := map[int]generation.Generation{g1.ID: g1, g2.ID: g2}
	want := map[string]string{} // "kind|generation|target" -> expected input_hash
	for _, g := range []generation.Generation{g1, g2} {
		for target, input := range inputOf {
			want[fmt.Sprintf("%s|%d|%s", kindOf[target], g.ID, target)] = hashHex(g, input)
		}
	}
	got := map[string]int{}
	for _, j := range queued {
		if j.user != a.String() {
			t.Fatalf("a job for user %s was enqueued (kind %s, generation %d); only user a (%s) may have jobs", j.user, j.kind, j.genID, a)
		}
		key := fmt.Sprintf("%s|%d|%s", j.kind, j.genID, j.target)
		got[key]++
		wantHash, ok := want[key]
		if !ok {
			t.Fatalf("unexpected job %s (all jobs %v)", key, got)
		}
		if j.hash != wantHash {
			t.Fatalf("job %s input_hash = %s, want %s", key, j.hash, wantHash)
		}
	}
	if len(queued) != 6 || len(got) != len(want) {
		t.Fatalf("jobs = %v (total %d), want exactly user a's missing+stale items and tag in generations 1 and 2: %v", got, len(queued), want)
	}
	for k := range want {
		if got[k] != 1 {
			t.Fatalf("jobs[%s] = %d, want 1 (all jobs %v)", k, got[k], got)
		}
	}

	// Execute those exact queued args through the real T11a workers.
	for _, j := range queued {
		var err error
		switch j.kind {
		case jobargs.KindEmbedItem:
			err = jobs.NewEmbedItemWorker(deps).Work(ctx, &river.Job[jobargs.EmbedItemArgs]{
				JobRow: &rivertype.JobRow{Attempt: 1},
				Args:   jobargs.EmbedItemArgs{GenerationID: j.genID, UserID: j.user, TargetID: j.target, InputHash: j.hash},
			})
		default:
			err = jobs.NewEmbedTagWorker(deps).Work(ctx, &river.Job[jobargs.EmbedTagArgs]{
				JobRow: &rivertype.JobRow{Attempt: 1},
				Args:   jobargs.EmbedTagArgs{GenerationID: j.genID, UserID: j.user, TargetID: j.target, InputHash: j.hash},
			})
		}
		if err != nil {
			t.Fatalf("worker for %s generation %d target %s: %v", j.kind, j.genID, j.target, err)
		}
	}
	var after int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM river_job WHERE kind IN ($1, $2)`, jobargs.KindEmbedItem, jobargs.KindEmbedTag).Scan(&after); err != nil {
		t.Fatalf("count jobs after workers: %v", err)
	}
	if after != 6 {
		t.Fatalf("embed jobs after workers = %d, want 6 (a worker enqueued a stale replacement)", after)
	}

	meta := func(g generation.Generation, kind generation.Corpus, user, target uuid.UUID) (store.StoredVector, bool) {
		m, ok, err := store.GetTargetMeta(ctx, pool, g, kind, user, target)
		if err != nil {
			t.Fatalf("GetTargetMeta(generation %d, %s): %v", g.ID, kind, err)
		}
		return m, ok
	}
	for _, g := range []generation.Generation{g1, g2} {
		for _, tc := range []struct {
			kind   generation.Corpus
			target uuid.UUID
		}{
			{generation.CorpusItem, aMissing}, {generation.CorpusItem, aStale}, {generation.CorpusTag, aTag},
		} {
			m, ok := meta(g, tc.kind, a, tc.target)
			if !ok {
				t.Fatalf("generation %d: user a's %s %s has no vector after the worker ran", g.ID, tc.kind, tc.target)
			}
			wantHash := embedding.InputHashFor(g.Identity(), inputOf[tc.target])
			if !bytes.Equal(m.InputHash, wantHash[:]) {
				t.Fatalf("generation %d: user a's %s %s input_hash = %x, want %x", g.ID, tc.kind, tc.target, m.InputHash, wantHash[:])
			}
			if m.Model != g.Model || m.ModelVersion != g.ModelVersion {
				t.Fatalf("generation %d: user a's %s %s model/version = %q/%q, want %q/%q", g.ID, tc.kind, tc.target, m.Model, m.ModelVersion, g.Model, g.ModelVersion)
			}
		}

		// User b was never reconciled: its missing item/tag stay absent and its
		// stale vector is byte-for-byte the pre-seeded one.
		if _, ok := meta(g, generation.CorpusItem, b, bMissing); ok {
			t.Fatalf("generation %d: user b's missing item gained a vector", g.ID)
		}
		if _, ok := meta(g, generation.CorpusTag, b, bTag); ok {
			t.Fatalf("generation %d: user b's tag gained a vector", g.ID)
		}
		bm, ok := meta(g, generation.CorpusItem, b, bStale)
		if !ok {
			t.Fatalf("generation %d: user b's stale vector disappeared", g.ID)
		}
		bWant := embedding.InputHashFor(byID[g.ID].Identity(), "outdated input before edit")
		if !bytes.Equal(bm.InputHash, bWant[:]) {
			t.Fatalf("generation %d: user b's stale vector input_hash changed to %x, want %x", g.ID, bm.InputHash, bWant[:])
		}
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
