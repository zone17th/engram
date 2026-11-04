//go:build searchbench

package searchbench

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// This file seeds a fresh Postgres database for the P05 search benchmark
// (plan mục 2.23, Task 10 W3; advisor-dec-261/272). Everything here touches the
// DB and is therefore tagged `searchbench`; the W1 generators stay untagged.
//
// Privacy: synthetic rows only (W1 lexicon). No entry bodies, no `entry` rows,
// no secrets, no provider calls.

// Constants describing the synthetic generation g1 the benchmark pins. The
// Identity is deliberately the same seven fields the stub provider client
// reports, so ClientSet.Match(pin.Identity) succeeds without any network call.
const (
	BenchGenerationID   = generation.BootstrapGenerationID // g1
	BenchProvider       = generation.ProviderTEI           // CHECK (tei|openai_compat); the stub never dials anything
	BenchModel          = "tei/engram-bench-synthetic"
	BenchModelVersion   = "bench-synthetic-v1;qp=00000000;dp=00000000"
	BenchCalibrationRef = "docs/benchmarks/P05-search/targets.md#3"
	BenchDims           = VectorDims
)

// BenchIdentity returns the full seven-field identity of the synthetic g1.
func BenchIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      BenchProvider,
		Model:         BenchModel,
		ModelVersion:  BenchModelVersion,
		Dims:          BenchDims,
		QueryPrefix:   "",
		DocPrefix:     "",
		Preprocessing: embedding.Preprocessing,
	}
}

// benchBaseTime anchors the synthetic created_at/last_used_at columns.
var benchBaseTime = time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)

// Env holds the environment contract with the CI job (ci.yml, worker B).
type Env struct {
	DatabaseURL  string // SEARCH_BENCH_DATABASE_URL (superuser URL DSN)
	Require      bool   // SEARCH_BENCH_REQUIRE=1
	Profile      ProfileName
	Seed         uint64
	OutDir       string
	HeadSHA      string
	RunURL       string
	StepSummary  string // GITHUB_STEP_SUMMARY
	TargetsSHA   string // SEARCH_BENCH_TARGETS_COMMIT (optional, filled by job / Task 23)
	Runner       string // SEARCH_BENCH_RUNNER (optional label)
	PostgresPin  string // SEARCH_BENCH_POSTGRES_IMAGE (optional digest)
	MaintWorkMem string // SEARCH_BENCH_MAINTENANCE_WORK_MEM (optional, applied only to the HNSW build session)
}

// LoadEnv reads the SEARCH_BENCH_* variables. Invalid values return an error.
func LoadEnv() (Env, error) {
	e := Env{
		DatabaseURL:  strings.TrimSpace(os.Getenv("SEARCH_BENCH_DATABASE_URL")),
		Require:      os.Getenv("SEARCH_BENCH_REQUIRE") == "1",
		Profile:      ProfileSmoke,
		Seed:         DefaultSeed,
		OutDir:       strings.TrimSpace(os.Getenv("SEARCH_BENCH_OUT_DIR")),
		HeadSHA:      strings.TrimSpace(os.Getenv("SEARCH_BENCH_HEAD_SHA")),
		RunURL:       strings.TrimSpace(os.Getenv("SEARCH_BENCH_RUN_URL")),
		StepSummary:  strings.TrimSpace(os.Getenv("GITHUB_STEP_SUMMARY")),
		TargetsSHA:   strings.TrimSpace(os.Getenv("SEARCH_BENCH_TARGETS_COMMIT")),
		Runner:       strings.TrimSpace(os.Getenv("SEARCH_BENCH_RUNNER")),
		PostgresPin:  strings.TrimSpace(os.Getenv("SEARCH_BENCH_POSTGRES_IMAGE")),
		MaintWorkMem: strings.TrimSpace(os.Getenv("SEARCH_BENCH_MAINTENANCE_WORK_MEM")),
	}
	if p := strings.TrimSpace(os.Getenv("SEARCH_BENCH_PROFILE")); p != "" {
		switch ProfileName(p) {
		case ProfileSmoke, ProfileFull:
			e.Profile = ProfileName(p)
		default:
			return Env{}, fmt.Errorf("searchbench: SEARCH_BENCH_PROFILE=%q (want smoke|full)", p)
		}
	}
	if s := strings.TrimSpace(os.Getenv("SEARCH_BENCH_SEED")); s != "" {
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return Env{}, fmt.Errorf("searchbench: SEARCH_BENCH_SEED=%q: %w", s, err)
		}
		e.Seed = v
	}
	if e.OutDir == "" {
		e.OutDir = "search-bench-results"
	}
	return e, nil
}

// CreateFreshDatabase creates a new empty database on the cluster behind
// adminDSN (a postgres:// URL with CREATE DATABASE rights), migrates it with
// the repository migrations and returns its URL DSN plus a drop function.
func CreateFreshDatabase(ctx context.Context, adminDSN string) (string, func(), error) {
	u, err := url.Parse(adminDSN)
	if err != nil || u.Scheme == "" {
		return "", nil, fmt.Errorf("searchbench: SEARCH_BENCH_DATABASE_URL must be a postgres:// URL")
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", nil, err
	}
	name := "engram_bench_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		return "", nil, fmt.Errorf("searchbench: connect admin database: %w", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
		_ = conn.Close(ctx)
		return "", nil, fmt.Errorf("searchbench: CREATE DATABASE: %w", err)
	}
	_ = conn.Close(ctx)

	dropFn := func() {
		dctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		c, err := pgx.Connect(dctx, admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(dctx) }()
		_, _ = c.Exec(dctx, `DROP DATABASE IF EXISTS `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`)
	}

	dbURL := *u
	dbURL.Path = "/" + name
	dsn := dbURL.String()
	if err := db.MigrateUp(dsn); err != nil {
		dropFn()
		return "", nil, fmt.Errorf("searchbench: migrate fresh database: %w", err)
	}
	return dsn, dropFn, nil
}

// SeedOptions controls SeedDatabase. The zero value of the pointer-ish fields
// seeds the whole profile with vectors and HNSW (the benchmark run); the
// self-check tests seed a truncated subset (Tenants + ItemLimit/TagLimit).
type SeedOptions struct {
	Profile    ProfileName
	Seed       uint64
	Partitions int // 0 = DefaultPartitions

	// Self-check knobs (never used by TestSearchBench).
	Tenants     []int       // nil = every tenant of the profile
	ItemLimit   map[int]int // tenant index -> number of items to seed (0/absent = all)
	TagLimit    map[int]int
	SkipVectors bool // lexical-only: no g1 tables are populated and no HNSW is built

	// MaintWorkMem, when non-empty, is applied with SET to the HNSW build session only.
	MaintWorkMem string
	Logf         func(format string, args ...any)
}

// HNSWBuild records one per-partition HNSW build.
type HNSWBuild struct {
	Corpus  string  `json:"corpus"`
	Part    string  `json:"partition"`
	Rows    int64   `json:"rows"`
	Seconds float64 `json:"seconds"`
	Bytes   int64   `json:"index_bytes"`
}

// RelSize is the size breakdown of one relation (or the sum of a partition set).
type RelSize struct {
	Name       string `json:"name"`
	Rows       int64  `json:"rows"`
	HeapBytes  int64  `json:"heap_bytes"`  // pg_relation_size (main fork)
	TableBytes int64  `json:"table_bytes"` // pg_table_size (heap + TOAST + fsm/vm)
	IndexBytes int64  `json:"index_bytes"` // pg_indexes_size (all indexes)
	HNSWBytes  int64  `json:"hnsw_bytes"`  // sum of hnsw indexes only
	TotalBytes int64  `json:"total_bytes"` // pg_total_relation_size
}

// SizeReport is the post-seed table/index size snapshot (sizing table input).
type SizeReport struct {
	ItemVectors RelSize   `json:"item_embedding_g1"`
	TagVectors  RelSize   `json:"tag_embedding_g1"`
	Item        RelSize   `json:"item"`
	Tag         RelSize   `json:"tag"`
	ItemTag     RelSize   `json:"item_tag"`
	Partitions  []RelSize `json:"g1_partitions"`
}

// ColocationReport is the result of the satisfies_hash_partition checks.
type ColocationReport struct {
	Partitions          int      `json:"partitions"`
	TenantsChecked      int      `json:"tenants_checked"`
	WhalePartition      string   `json:"whale0_partition,omitempty"`
	ColocatedTenants    []int    `json:"colocated_tenants,omitempty"`
	ColocatedPartitions []string `json:"colocated_partitions,omitempty"`
	OK                  bool     `json:"ok"`
}

// SeedTimings records the wall-clock seconds of each seed phase.
type SeedTimings struct {
	Hash      float64 `json:"dataset_hash_seconds"`
	Users     float64 `json:"users_seconds"`
	Generate  float64 `json:"create_g1_tables_seconds"`
	CopyTags  float64 `json:"copy_tag_seconds"`
	CopyItems float64 `json:"copy_item_seconds"`
	CopyEmb   float64 `json:"copy_embeddings_seconds"`
	HNSWTotal float64 `json:"hnsw_total_seconds"`
	HNSWItem  float64 `json:"hnsw_item_seconds"`
	HNSWTag   float64 `json:"hnsw_tag_seconds"`
	Analyze   float64 `json:"analyze_seconds"`
	Total     float64 `json:"total_seconds"`
}

// SeedResult describes the seeded database.
type SeedResult struct {
	Gen          *Generator
	Spec         ProfileSpec
	DatasetHash  string // "" for truncated (self-check) seeds
	GenerationID int
	MinCos       float64
	Owner        map[uuid.UUID]int32 // item/tag id -> tenant index (C2-T oracle)
	Tenants      []int
	Users        int
	Items        int
	Tags         int
	ItemTags     int
	ItemVectors  int
	TagVectors   int
	Timings      SeedTimings
	HNSW         []HNSWBuild
	Sizes        SizeReport
	Colocation   ColocationReport
	Truncated    bool
}

type funcSource struct {
	next func() ([]any, bool, error)
	cur  []any
	err  error
}

func (s *funcSource) Next() bool {
	if s.err != nil {
		return false
	}
	row, ok, err := s.next()
	if err != nil {
		s.err = err
		return false
	}
	s.cur = row
	return ok
}
func (s *funcSource) Values() ([]any, error) { return s.cur, nil }
func (s *funcSource) Err() error             { return s.err }

// vectorCodec is a minimal pgx binary codec for the pgvector `vector` type so
// pgx.CopyFrom can load embeddings (pgvector-go v0.4.1 ships no pgx package;
// it does expose Vector.EncodeBinary, which is the vector_recv wire format).
type vectorCodec struct{}

func (vectorCodec) FormatSupported(f int16) bool { return f == pgtype.BinaryFormatCode }
func (vectorCodec) PreferredFormat() int16       { return pgtype.BinaryFormatCode }
func (vectorCodec) PlanEncode(_ *pgtype.Map, _ uint32, format int16, value any) pgtype.EncodePlan {
	if format != pgtype.BinaryFormatCode {
		return nil
	}
	if _, ok := value.(pgvector.Vector); ok {
		return vectorEncodePlan{}
	}
	return nil
}
func (vectorCodec) PlanScan(*pgtype.Map, uint32, int16, any) pgtype.ScanPlan { return nil }
func (vectorCodec) DecodeDatabaseSQLValue(*pgtype.Map, uint32, int16, []byte) (driver.Value, error) {
	return nil, errors.New("searchbench: vector decode is not supported by the seed codec")
}
func (vectorCodec) DecodeValue(*pgtype.Map, uint32, int16, []byte) (any, error) {
	return nil, errors.New("searchbench: vector decode is not supported by the seed codec")
}

type vectorEncodePlan struct{}

func (vectorEncodePlan) Encode(value any, buf []byte) ([]byte, error) {
	return value.(pgvector.Vector).EncodeBinary(buf)
}

func registerVectorType(ctx context.Context, conn *pgx.Conn) error {
	var oid uint32
	if err := conn.QueryRow(ctx, `SELECT oid FROM pg_type WHERE typname = 'vector' LIMIT 1`).Scan(&oid); err != nil {
		return fmt.Errorf("searchbench: find vector type: %w", err)
	}
	conn.TypeMap().RegisterType(&pgtype.Type{Name: "vector", OID: oid, Codec: vectorCodec{}})
	return nil
}

func pgUUID(id uuid.UUID) pgtype.UUID { return pgtype.UUID{Bytes: id, Valid: true} }

func (o SeedOptions) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

// SeedDatabase loads the synthetic dataset into the (already migrated) database
// behind dsn, creates g1 through the Task 6 DDL function
// (embedding_generation_create_tables, via the sqlc wrapper), builds HNSW per
// partition AFTER the load, ANALYZEs, activates g1 the way the app reads it
// (embedding_active) and verifies hash-partition colocation on the real g1
// parent. It never logs query text, names or vectors.
func SeedDatabase(ctx context.Context, dsn string, opts SeedOptions) (*SeedResult, error) {
	t0 := time.Now()
	lex, err := LoadDefaultLexicon()
	if err != nil {
		return nil, err
	}
	gen1, err := NewGenerator(opts.Profile, opts.Seed, opts.Partitions, lex)
	if err != nil {
		return nil, err
	}
	spec := gen1.Profile()
	res := &SeedResult{
		Gen:          gen1,
		Spec:         spec,
		GenerationID: BenchGenerationID,
		MinCos:       float64(MinCos),
		Owner:        make(map[uuid.UUID]int32),
		Truncated:    len(opts.Tenants) > 0 || len(opts.ItemLimit) > 0 || len(opts.TagLimit) > 0,
	}

	tenants := opts.Tenants
	if len(tenants) == 0 {
		tenants = make([]int, len(spec.Tenants))
		for i := range tenants {
			tenants[i] = i
		}
	}
	res.Tenants = tenants
	itemCount := func(t int) int {
		n := spec.Tenants[t].ItemCount
		if l := opts.ItemLimit[t]; l > 0 && l < n {
			n = l
		}
		return n
	}
	tagCount := func(t int) int {
		n := spec.Tenants[t].TagCount
		if l := opts.TagLimit[t]; l > 0 && l < n {
			n = l
		}
		return n
	}

	// Dataset hash first (pure, streamed): printed by the caller. Truncated
	// self-check seeds are not the canonical dataset, so no hash for them.
	if !res.Truncated {
		th := time.Now()
		res.DatasetHash = gen1.ComputeHash()
		res.Timings.Hash = time.Since(th).Seconds()
		opts.logf("dataset hash computed in %.1fs", res.Timings.Hash)
	}

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("searchbench: connect seed conn: %w", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if err := registerVectorType(ctx, conn); err != nil {
		return nil, err
	}

	// 1. app_user rows (FK target of item/tag/session).
	tu := time.Now()
	for _, t := range tenants {
		id := spec.Tenants[t].UserID
		email := fmt.Sprintf("bench-%d@bench.invalid", t)
		if _, err := conn.Exec(ctx,
			`INSERT INTO app_user (id, email, email_verified_at) VALUES ($1, $2, now())`, id, email); err != nil {
			return nil, fmt.Errorf("searchbench: insert app_user %d: %w", t, err)
		}
		res.Users++
	}
	res.Timings.Users = time.Since(tu).Seconds()

	// 2. generation g1 row + tables through the Task 6 DDL function.
	tg := time.Now()
	q := gen.New(conn)
	ident := BenchIdentity()
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 BenchGenerationID,
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         int32(spec.Partitions),
		HnswM:              generation.DefaultHnswM,
		HnswEfConstruction: generation.DefaultHnswEfConstruction,
		SemanticMinCos:     float32(MinCos),
		CalibrationRef:     BenchCalibrationRef,
		Bootstrap:          false,
	}); err != nil {
		return nil, fmt.Errorf("searchbench: insert generation g1: %w", err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 BenchGenerationID,
		Dims:               int32(ident.Dims),
		Partitions:         int32(spec.Partitions),
		WithHnsw:           false, // HNSW is built per partition AFTER the load
		HnswM:              generation.DefaultHnswM,
		HnswEfConstruction: generation.DefaultHnswEfConstruction,
	}); err != nil {
		return nil, fmt.Errorf("searchbench: create g1 tables: %w", err)
	}
	res.Timings.Generate = time.Since(tg).Seconds()

	itemTbl, err := generation.TableIdent(BenchGenerationID, generation.CorpusItem)
	if err != nil {
		return nil, err
	}
	tagTbl, err := generation.TableIdent(BenchGenerationID, generation.CorpusTag)
	if err != nil {
		return nil, err
	}

	// Shared topic table (4096 x 1024 float32 = 16 MiB) so vectors are not
	// recomputed per row.
	var topics [][VectorDims]float32
	if !opts.SkipVectors {
		topics = make([][VectorDims]float32, TopicCount)
		for tpc := range TopicCount {
			gen1.TopicVector(tpc, topics[tpc][:])
		}
	}

	// 3. tags.
	tt := time.Now()
	ti := 0
	tenantIdx := 0
	tagSrc := &funcSource{}
	tagSrc.next = func() ([]any, bool, error) {
		for tenantIdx < len(tenants) {
			t := tenants[tenantIdx]
			if ti < tagCount(t) {
				tag := gen1.TagAt(t, ti)
				idx := ti
				ti++
				res.Owner[tag.ID] = int32(t)
				res.Tags++
				ts := benchBaseTime.Add(-time.Duration(idx) * time.Minute)
				return []any{pgUUID(tag.ID), pgUUID(tag.UserID), tag.Display, tag.Normalized,
					int32(idx % 11), ts, ts, ts}, true, nil
			}
			tenantIdx++
			ti = 0
		}
		return nil, false, nil
	}
	if _, err := conn.CopyFrom(ctx, pgx.Identifier{"tag"},
		[]string{"id", "user_id", "display", "normalized", "item_count", "last_used_at", "created_at", "updated_at"},
		tagSrc); err != nil {
		return nil, fmt.Errorf("searchbench: copy tag: %w", err)
	}
	res.Timings.CopyTags = time.Since(tt).Seconds()
	opts.logf("copied %d tags in %.1fs", res.Tags, res.Timings.CopyTags)

	// 4. items (+ collect item_tag pairs).
	tIt := time.Now()
	ii := 0
	tenantIdx = 0
	var pairs []ItemTagRow
	// tag ids of the current tenant, resolved lazily so item_tag needs no second pass.
	curTagIDs := map[int][]uuid.UUID{}
	tagIDsOf := func(t int) []uuid.UUID {
		if ids, ok := curTagIDs[t]; ok {
			return ids
		}
		n := tagCount(t)
		ids := make([]uuid.UUID, n)
		for i := range n {
			ids[i] = gen1.TagAt(t, i).ID
		}
		curTagIDs[t] = ids
		return ids
	}
	itemSrc := &funcSource{}
	itemSrc.next = func() ([]any, bool, error) {
		for tenantIdx < len(tenants) {
			t := tenants[tenantIdx]
			if ii < itemCount(t) {
				it := gen1.ItemAt(t, ii)
				idx := ii
				ii++
				res.Owner[it.ID] = int32(t)
				res.Items++
				if len(it.TagIndices) > 0 {
					ids := tagIDsOf(t)
					for _, ix := range it.TagIndices {
						if ix < len(ids) {
							pairs = append(pairs, ItemTagRow{ItemID: it.ID, TagID: ids[ix]})
						}
					}
				}
				ts := benchBaseTime.Add(-time.Duration(idx) * time.Minute)
				var hint any
				if it.Hint != nil {
					hint = *it.Hint
				}
				return []any{pgUUID(it.ID), pgUUID(it.UserID), it.Name, it.NameNormalized,
					hint, int32(idx % 7), ts, ts, ts}, true, nil
			}
			delete(curTagIDs, t)
			tenantIdx++
			ii = 0
		}
		return nil, false, nil
	}
	if _, err := conn.CopyFrom(ctx, pgx.Identifier{"item"},
		[]string{"id", "user_id", "name", "name_normalized", "hint", "entry_count", "last_used_at", "created_at", "updated_at"},
		itemSrc); err != nil {
		return nil, fmt.Errorf("searchbench: copy item: %w", err)
	}
	res.Timings.CopyItems = time.Since(tIt).Seconds()
	opts.logf("copied %d items in %.1fs", res.Items, res.Timings.CopyItems)

	pi := 0
	pairSrc := &funcSource{next: func() ([]any, bool, error) {
		if pi >= len(pairs) {
			return nil, false, nil
		}
		p := pairs[pi]
		pi++
		return []any{pgUUID(p.ItemID), pgUUID(p.TagID), benchBaseTime}, true, nil
	}}
	if _, err := conn.CopyFrom(ctx, pgx.Identifier{"item_tag"}, []string{"item_id", "tag_id", "created_at"}, pairSrc); err != nil {
		return nil, fmt.Errorf("searchbench: copy item_tag: %w", err)
	}
	res.ItemTags = len(pairs)
	pairs = nil

	// 5. embeddings into the g1 parents.
	if !opts.SkipVectors {
		te := time.Now()
		if err := copyEmbeddings(ctx, conn, itemTbl, gen1, spec, tenants, itemCount, topics, true, &res.ItemVectors); err != nil {
			return nil, err
		}
		if err := copyEmbeddings(ctx, conn, tagTbl, gen1, spec, tenants, tagCount, topics, false, &res.TagVectors); err != nil {
			return nil, err
		}
		res.Timings.CopyEmb = time.Since(te).Seconds()
		opts.logf("copied %d item + %d tag vectors in %.1fs", res.ItemVectors, res.TagVectors, res.Timings.CopyEmb)

		// 6. HNSW per partition AFTER loading, timed per partition.
		th := time.Now()
		if err := buildHNSW(ctx, conn, res, opts, spec.Partitions); err != nil {
			return nil, err
		}
		res.Timings.HNSWTotal = time.Since(th).Seconds()
	}

	// 7. ANALYZE so the planner sees the loaded statistics.
	ta := time.Now()
	for _, tbl := range []string{"app_user", "item", "tag", "item_tag", itemTbl.Sanitize(), tagTbl.Sanitize()} {
		if _, err := conn.Exec(ctx, `ANALYZE `+tbl); err != nil {
			return nil, fmt.Errorf("searchbench: analyze %s: %w", tbl, err)
		}
	}
	res.Timings.Analyze = time.Since(ta).Seconds()

	// 8. Activate g1 the way the app reads it (embedding_active) so
	// semantic.Runtime's Pinner pins g1.
	if _, err := q.ActivateEmbeddingGeneration(ctx, BenchGenerationID); err != nil {
		return nil, fmt.Errorf("searchbench: activate g1: %w", err)
	}
	reason := "searchbench seed"
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{GenerationID: BenchGenerationID, FlippedReason: &reason}); err != nil {
		return nil, fmt.Errorf("searchbench: set embedding_active: %w", err)
	}

	// 9. Colocation on the real g1 parent, sizes.
	if !opts.SkipVectors {
		col, err := checkColocation(ctx, conn, res, itemTbl.Sanitize(), spec.Partitions)
		res.Colocation = col
		if err != nil {
			return res, err
		}
	}
	sz, err := collectSizes(ctx, conn, res, itemTbl, tagTbl)
	if err != nil {
		return res, err
	}
	res.Sizes = sz

	res.Timings.Total = time.Since(t0).Seconds()
	return res, nil
}

func copyEmbeddings(ctx context.Context, conn *pgx.Conn, tbl pgx.Identifier, g *Generator, spec ProfileSpec, tenants []int,
	count func(int) int, topics [][VectorDims]float32, items bool, counter *int) error {
	ident := BenchIdentity()
	var buf [VectorDims]float32
	ti, tenantIdx := 0, 0
	src := &funcSource{}
	src.next = func() ([]any, bool, error) {
		for tenantIdx < len(tenants) {
			t := tenants[tenantIdx]
			if ti < count(t) {
				idx := ti
				ti++
				var id uuid.UUID
				if items {
					row := g.ItemAt(t, idx)
					id = row.ID
					g.ItemVectorWithTopic(t, idx, topics[row.TopicID][:], buf[:])
				} else {
					row := g.TagAt(t, idx)
					id = row.ID
					g.TagVectorWithTopic(t, idx, topics[row.TopicID][:], buf[:])
				}
				uid := spec.Tenants[t].UserID
				h := sha256.Sum256(append(id[:], []byte("engram-searchbench-input")...))
				*counter++
				// buf is encoded by pgx before the next Next() call, so reusing it is safe.
				return []any{pgUUID(uid), pgUUID(id), pgvector.NewVector(buf[:]), ident.Model, ident.ModelVersion,
					h[:], benchBaseTime}, true, nil
			}
			tenantIdx++
			ti = 0
		}
		return nil, false, nil
	}
	if _, err := conn.CopyFrom(ctx, tbl,
		[]string{"user_id", "target_id", "embedding", "model", "model_version", "input_hash", "embedded_at"}, src); err != nil {
		return fmt.Errorf("searchbench: copy %s: %w", tbl.Sanitize(), err)
	}
	return nil
}

func buildHNSW(ctx context.Context, conn *pgx.Conn, res *SeedResult, opts SeedOptions, partitions int) error {
	if opts.MaintWorkMem != "" {
		if _, err := conn.Exec(ctx, `SELECT set_config('maintenance_work_mem', $1, false)`, opts.MaintWorkMem); err != nil {
			return fmt.Errorf("searchbench: set maintenance_work_mem: %w", err)
		}
	}
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		parent, err := generation.DerivedTableName(BenchGenerationID, corpus)
		if err != nil {
			return err
		}
		tc := time.Now()
		for p := range partitions {
			part := fmt.Sprintf("%s_p%d", parent, p)
			var rows int64
			if err := conn.QueryRow(ctx, `SELECT count(*) FROM `+pgx.Identifier{part}.Sanitize()).Scan(&rows); err != nil {
				return fmt.Errorf("searchbench: count %s: %w", part, err)
			}
			ts := time.Now()
			ddl := fmt.Sprintf(`CREATE INDEX %s ON %s USING hnsw (embedding vector_cosine_ops) WITH (m = %d, ef_construction = %d)`,
				pgx.Identifier{part + "_hnsw"}.Sanitize(), pgx.Identifier{part}.Sanitize(),
				generation.DefaultHnswM, generation.DefaultHnswEfConstruction)
			if _, err := conn.Exec(ctx, ddl); err != nil {
				return fmt.Errorf("searchbench: build hnsw %s: %w", part, err)
			}
			sec := time.Since(ts).Seconds()
			var bytes int64
			if err := conn.QueryRow(ctx, `SELECT pg_relation_size(($1::text)::regclass)`, part+"_hnsw").Scan(&bytes); err != nil {
				return fmt.Errorf("searchbench: size hnsw %s: %w", part, err)
			}
			res.HNSW = append(res.HNSW, HNSWBuild{Corpus: string(corpus), Part: part, Rows: rows, Seconds: sec, Bytes: bytes})
		}
		sec := time.Since(tc).Seconds()
		if corpus == generation.CorpusItem {
			res.Timings.HNSWItem = sec
		} else {
			res.Timings.HNSWTag = sec
		}
		opts.logf("hnsw %s built in %.1fs", corpus, sec)
	}
	return nil
}

// checkColocation verifies, on the real g1 parent, that every seeded tenant's
// Go-computed remainder agrees with Postgres satisfies_hash_partition and that
// the colocated tenants really share the whale's physical partition.
func checkColocation(ctx context.Context, conn *pgx.Conn, res *SeedResult, itemParent string, partitions int) (ColocationReport, error) {
	rep := ColocationReport{Partitions: partitions, OK: true}
	var failures []string
	partOf := func(userID uuid.UUID) (string, error) {
		var name string
		err := conn.QueryRow(ctx, `SELECT tableoid::regclass::text FROM `+itemParent+` WHERE user_id = $1 LIMIT 1`, userID).Scan(&name)
		return name, err
	}
	whalePart := ""
	for _, t := range res.Tenants {
		ts := res.Spec.Tenants[t]
		var okRight bool
		if err := conn.QueryRow(ctx, `SELECT satisfies_hash_partition(($1::text)::regclass, $2, $3, $4::uuid)`,
			itemParent, partitions, ts.PartitionRemainder, ts.UserID).Scan(&okRight); err != nil {
			return rep, fmt.Errorf("searchbench: satisfies_hash_partition: %w", err)
		}
		rep.TenantsChecked++
		if !okRight {
			failures = append(failures, fmt.Sprintf("tenant %d: Go remainder %d rejected by Postgres", t, ts.PartitionRemainder))
		}
		if t == 0 && ts.Tier == TierWhale {
			if p, err := partOf(ts.UserID); err == nil {
				whalePart = p
				rep.WhalePartition = p
			}
		}
	}
	for _, t := range res.Tenants {
		ts := res.Spec.Tenants[t]
		if !ts.ColocatedWithWhale {
			continue
		}
		rep.ColocatedTenants = append(rep.ColocatedTenants, t)
		wp := res.Spec.Tenants[ts.ColocatedWhaleIdx].PartitionRemainder
		if ts.PartitionRemainder != wp {
			failures = append(failures, fmt.Sprintf("tenant %d remainder %d != whale %d remainder %d", t, ts.PartitionRemainder, ts.ColocatedWhaleIdx, wp))
			continue
		}
		p, err := partOf(ts.UserID)
		if err != nil {
			failures = append(failures, fmt.Sprintf("tenant %d has no rows in g1 item partition", t))
			continue
		}
		rep.ColocatedPartitions = append(rep.ColocatedPartitions, p)
		if whalePart != "" && p != whalePart {
			failures = append(failures, fmt.Sprintf("tenant %d physically in %s, whale in %s", t, p, whalePart))
		}
	}
	if len(failures) > 0 {
		rep.OK = false
		return rep, fmt.Errorf("searchbench: colocation check failed: %s", strings.Join(failures, "; "))
	}
	return rep, nil
}

const partitionSizeSQL = `
SELECT c.relname,
       pg_relation_size(c.oid), pg_table_size(c.oid), pg_indexes_size(c.oid), pg_total_relation_size(c.oid),
       COALESCE((SELECT sum(pg_relation_size(i.indexrelid))
                   FROM pg_index i
                   JOIN pg_class ic ON ic.oid = i.indexrelid
                   JOIN pg_am am ON am.oid = ic.relam
                  WHERE i.indrelid = c.oid AND am.amname = 'hnsw'), 0)::bigint
  FROM pg_inherits h
  JOIN pg_class c ON c.oid = h.inhrelid
 WHERE h.inhparent = ($1::text)::regclass
 ORDER BY c.relname`

func collectSizes(ctx context.Context, conn *pgx.Conn, res *SeedResult, itemTbl, tagTbl pgx.Identifier) (SizeReport, error) {
	var out SizeReport
	sumParent := func(parent pgx.Identifier, rows int, keepParts bool) (RelSize, error) {
		sum := RelSize{Name: parent[0], Rows: int64(rows)}
		r, err := conn.Query(ctx, partitionSizeSQL, parent[0])
		if err != nil {
			return sum, fmt.Errorf("searchbench: size query %s: %w", parent[0], err)
		}
		defer r.Close()
		for r.Next() {
			var p RelSize
			if err := r.Scan(&p.Name, &p.HeapBytes, &p.TableBytes, &p.IndexBytes, &p.TotalBytes, &p.HNSWBytes); err != nil {
				return sum, err
			}
			sum.HeapBytes += p.HeapBytes
			sum.TableBytes += p.TableBytes
			sum.IndexBytes += p.IndexBytes
			sum.HNSWBytes += p.HNSWBytes
			sum.TotalBytes += p.TotalBytes
			if keepParts {
				for _, b := range res.HNSW {
					if b.Part == p.Name {
						p.Rows = b.Rows
					}
				}
				out.Partitions = append(out.Partitions, p)
			}
		}
		return sum, r.Err()
	}
	var err error
	if out.ItemVectors, err = sumParent(itemTbl, res.ItemVectors, true); err != nil {
		return out, err
	}
	if out.TagVectors, err = sumParent(tagTbl, res.TagVectors, true); err != nil {
		return out, err
	}
	plain := func(name string, rows int) (RelSize, error) {
		s := RelSize{Name: name, Rows: int64(rows)}
		err := conn.QueryRow(ctx, `SELECT pg_relation_size(($1::text)::regclass), pg_table_size(($1::text)::regclass),
			pg_indexes_size(($1::text)::regclass), pg_total_relation_size(($1::text)::regclass)`, name).
			Scan(&s.HeapBytes, &s.TableBytes, &s.IndexBytes, &s.TotalBytes)
		return s, err
	}
	if out.Item, err = plain("item", res.Items); err != nil {
		return out, err
	}
	if out.Tag, err = plain("tag", res.Tags); err != nil {
		return out, err
	}
	if out.ItemTag, err = plain("item_tag", res.ItemTags); err != nil {
		return out, err
	}
	return out, nil
}

// PGInfo is the Postgres-side part of the hardware note.
type PGInfo struct {
	Version   string            `json:"version"`
	Vector    string            `json:"pgvector_extversion"`
	Settings  map[string]string `json:"settings"`
	Collected bool              `json:"collected"`
}

var pgInfoSettings = []string{
	"shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size",
	"max_parallel_workers_per_gather", "max_parallel_maintenance_workers",
	"wal_level", "max_wal_size", "synchronous_commit", "random_page_cost",
	"pg_trgm.similarity_threshold", "pg_trgm.word_similarity_threshold",
}

// CollectPGInfo reads version()/pgvector/settings. Unknown values are "unknown".
func CollectPGInfo(ctx context.Context, conn interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) PGInfo {
	info := PGInfo{Version: "unknown", Vector: "unknown", Settings: map[string]string{}, Collected: true}
	if err := conn.QueryRow(ctx, `SELECT version()`).Scan(&info.Version); err != nil {
		info.Version, info.Collected = "unknown", false
	}
	if err := conn.QueryRow(ctx, `SELECT extversion FROM pg_extension WHERE extname = 'vector'`).Scan(&info.Vector); err != nil {
		info.Vector = "unknown"
	}
	for _, name := range pgInfoSettings {
		var v *string
		if err := conn.QueryRow(ctx, `SELECT current_setting($1, true)`, name).Scan(&v); err != nil || v == nil {
			info.Settings[name] = "unknown"
			continue
		}
		info.Settings[name] = *v
	}
	return info
}
