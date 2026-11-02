package suggest_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
	"github.com/zone17th/engram/apps/api/migrations"
)

// Shared package-level Postgres container (Gate 10: at most one container per package).
var (
	sharedBaseOnce sync.Once
	sharedBaseDSN  string
	sharedBaseErr  error
	sharedCleanup  func()
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedCleanup != nil {
		sharedCleanup()
	}
	os.Exit(code)
}

// startTestDB returns an isolated ephemeral database DSN backed by the single
// package-level Postgres instance (or TEST_DATABASE_URL when set).
// Skips when -short is active, matching dbtest.StartPostgres.
func startTestDB(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	if dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); dsn != "" {
		return dbtest.StartPostgres(t)
	}
	sharedBaseOnce.Do(func() {
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
		sharedCleanup = func() {
			_ = testcontainers.TerminateContainer(c)
		}
		sharedBaseDSN, sharedBaseErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if sharedBaseErr != nil {
		t.Fatalf("khởi động Postgres dùng chung: %v", sharedBaseErr)
	}
	return createEphemeralDBFromBase(t, sharedBaseDSN)
}

func createEphemeralDBFromBase(t *testing.T, baseDSN string) string {
	t.Helper()
	u, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatalf("parse baseDSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	name := "engram_s_" + hex.EncodeToString(nonce[:])
	admin := *u
	admin.Path = "/postgres"

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE %s: %v", name, err)
	}
	_ = conn.Close(ctx)

	u.Path = "/" + name
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
	})
	return dsn
}

func fixturePath(t *testing.T, filename string) string {
	t.Helper()
	return filepath.Join("..", "..", "..", "..", "packages", "search-fixtures", filename)
}

type queryNormalizeFixture struct {
	Version int                  `json:"version"`
	Schema  string               `json:"schema"`
	Cases   []queryNormalizeCase `json:"cases"`
}

type queryNormalizeCase struct {
	Name               string `json:"name"`
	Input              string `json:"input"`
	Normalized         string `json:"normalized"`
	Unaccent           string `json:"unaccent"`
	Error              string `json:"error"`
	EquivNFCInput      string `json:"equiv_nfc_input"`
	DoesNotMatchASCII  string `json:"does_not_match_ascii"`
	FuzzyMatchesTarget string `json:"fuzzy_matches_target"`
}

func TestImmutableUnaccentVietnamese(t *testing.T) {
	raw, err := os.ReadFile(fixturePath(t, "query-normalize.json"))
	if err != nil {
		t.Fatalf("read query-normalize.json: %v", err)
	}
	var fx queryNormalizeFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("unmarshal query-normalize.json: %v", err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("query-normalize.json must contain cases")
	}

	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	for _, tc := range fx.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			qn, err := textnorm.NormalizeQuery(tc.Input)
			if tc.Error != "" {
				if err == nil {
					t.Fatalf("NormalizeQuery(%q) = %q, want error %q", tc.Input, qn, tc.Error)
				}
				if err.Error() != tc.Error {
					t.Fatalf("NormalizeQuery(%q) err = %q, want %q", tc.Input, err.Error(), tc.Error)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeQuery(%q) unexpected err: %v", tc.Input, err)
			}
			if qn != tc.Normalized {
				t.Fatalf("NormalizeQuery(%q) = %q, want %q", tc.Input, qn, tc.Normalized)
			}

			var qa string
			if err := pool.QueryRow(ctx, `SELECT immutable_unaccent($1::text)`, qn).Scan(&qa); err != nil {
				t.Fatalf("immutable_unaccent(%q): %v", qn, err)
			}
			if qa != tc.Unaccent {
				t.Fatalf("immutable_unaccent(%q) = %q, want %q", qn, qa, tc.Unaccent)
			}

			if tc.EquivNFCInput != "" {
				nfcNorm, err := textnorm.NormalizeQuery(tc.EquivNFCInput)
				if err != nil {
					t.Fatalf("NormalizeQuery(equiv %q): %v", tc.EquivNFCInput, err)
				}
				if qn != nfcNorm {
					t.Fatalf("NFD vs NFC normalized mismatch: %q != %q", qn, nfcNorm)
				}
				var nfcUnaccent string
				if err := pool.QueryRow(ctx, `SELECT immutable_unaccent($1::text)`, nfcNorm).Scan(&nfcUnaccent); err != nil {
					t.Fatalf("immutable_unaccent(equiv %q): %v", nfcNorm, err)
				}
				if qa != nfcUnaccent {
					t.Fatalf("NFD vs NFC unaccent mismatch: %q != %q", qa, nfcUnaccent)
				}
			}

			if tc.DoesNotMatchASCII != "" {
				if qa == tc.DoesNotMatchASCII {
					t.Fatalf("full-width %q should not fold to ASCII %q without NFKC", qa, tc.DoesNotMatchASCII)
				}
			}

			if tc.FuzzyMatchesTarget != "" {
				var matched bool
				if err := pool.QueryRow(ctx, `
					SELECT (
						similarity(immutable_unaccent($1::text), $2::text) >= 0.35
						OR word_similarity($2::text, immutable_unaccent($1::text)) >= 0.5
					)
				`, tc.FuzzyMatchesTarget, qa).Scan(&matched); err != nil {
					t.Fatalf("fuzzy check(%q, %q): %v", tc.FuzzyMatchesTarget, qa, err)
				}
				if !matched {
					t.Fatalf("expected %q (qa=%q) to fuzzy-match target %q", tc.Input, qa, tc.FuzzyMatchesTarget)
				}
			}
		})
	}
}

type quotaFixture struct {
	Version int    `json:"version"`
	Schema  string `json:"schema"`
	Suggest struct {
		Limits       []int `json:"limits"`
		DefaultLimit int   `json:"default_limit"`
		MobileLimit  int   `json:"mobile_limit"`
		Table        []struct {
			Scope      string `json:"scope"`
			Limit      int    `json:"limit"`
			TagMax     int    `json:"tag_max"`
			LexMax     int    `json:"lex_max"`
			NearBase   int    `json:"near_base"`
			NearMaxCap int    `json:"near_max_cap"`
			RecentTag  int    `json:"recent_tag"`
			RecentItem int    `json:"recent_item"`
		} `json:"table"`
	} `json:"suggest"`
	Search struct {
		Limits                  []int `json:"limits"`
		DefaultLimit            int   `json:"default_limit"`
		AllScopeFirstPageTagMax int   `json:"all_scope_first_page_tags_max"`
		FirstPageNearMax        int   `json:"first_page_near_max"`
	} `json:"search"`
}

type corpusLexicalFixture struct {
	Version int               `json:"version"`
	Schema  string            `json:"schema"`
	Users   map[string]string `json:"users"`
	Items   []corpusItemSeed  `json:"items"`
	Tags    []corpusTagSeed   `json:"tags"`
	Queries []corpusQueryCase `json:"queries"`
}

type corpusItemSeed struct {
	ID         string `json:"id"`
	User       string `json:"user"`
	Name       string `json:"name"`
	EntryCount int32  `json:"entry_count"`
	LastUsedAt string `json:"last_used_at"`
	CreatedAt  string `json:"created_at"`
}

type corpusTagSeed struct {
	ID         string `json:"id"`
	User       string `json:"user"`
	Display    string `json:"display"`
	ItemCount  int32  `json:"item_count"`
	LastUsedAt string `json:"last_used_at"`
}

type corpusQueryCase struct {
	Name        string            `json:"name"`
	Q           string            `json:"q"`
	Scope       string            `json:"scope"`
	User        string            `json:"user"`
	ExpectEmpty bool              `json:"expect_empty"`
	ExpectTop   []corpusExpectHit `json:"expect_top"`
}

type corpusExpectHit struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Display string `json:"display"`
	Tier    int32  `json:"tier"`
	Match   string `json:"match"`
}

func tierToMatch(tier int32) string {
	switch tier {
	case 3:
		return "prefix"
	case 2:
		return "prefix_folded"
	default:
		return "fuzzy"
	}
}

func loadAndSeedCorpus(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (corpusLexicalFixture, map[string]uuid.UUID) {
	t.Helper()
	raw, err := os.ReadFile(fixturePath(t, "corpus-lexical.json"))
	if err != nil {
		t.Fatalf("read corpus-lexical.json: %v", err)
	}
	var fx corpusLexicalFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("unmarshal corpus-lexical.json: %v", err)
	}
	if len(fx.Items) < 140 || len(fx.Tags) < 35 {
		t.Fatalf("corpus size too small: items=%d tags=%d", len(fx.Items), len(fx.Tags))
	}

	users := make(map[string]uuid.UUID, len(fx.Users))
	for alias, idStr := range fx.Users {
		uid := uuid.MustParse(idStr)
		users[alias] = uid
		if _, err := pool.Exec(ctx,
			`INSERT INTO app_user (id, email, locale) VALUES ($1, $2, 'vi')`,
			uid, alias+"@example.com",
		); err != nil {
			t.Fatalf("insert user %s: %v", alias, err)
		}
	}

	for _, it := range fx.Items {
		uid, ok := users[it.User]
		if !ok {
			t.Fatalf("unknown user alias %q on item %s", it.User, it.ID)
		}
		_, normName, err := textnorm.NormalizeName(it.Name)
		if err != nil {
			t.Fatalf("NormalizeName(%q): %v", it.Name, err)
		}
		lu, err := time.Parse(time.RFC3339, it.LastUsedAt)
		if err != nil {
			t.Fatalf("parse last_used_at %q: %v", it.LastUsedAt, err)
		}
		ca, err := time.Parse(time.RFC3339, it.CreatedAt)
		if err != nil {
			t.Fatalf("parse created_at %q: %v", it.CreatedAt, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		`, uuid.MustParse(it.ID), uid, it.Name, normName, it.EntryCount, lu, ca); err != nil {
			t.Fatalf("insert item %s (%q): %v", it.ID, it.Name, err)
		}
	}

	for _, tg := range fx.Tags {
		uid, ok := users[tg.User]
		if !ok {
			t.Fatalf("unknown user alias %q on tag %s", tg.User, tg.ID)
		}
		_, normTag, err := textnorm.NormalizeTag(tg.Display)
		if err != nil {
			t.Fatalf("NormalizeTag(%q): %v", tg.Display, err)
		}
		lu, err := time.Parse(time.RFC3339, tg.LastUsedAt)
		if err != nil {
			t.Fatalf("parse tag last_used_at %q: %v", tg.LastUsedAt, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, uuid.MustParse(tg.ID), uid, tg.Display, normTag, tg.ItemCount, lu); err != nil {
			t.Fatalf("insert tag %s (%q): %v", tg.ID, tg.Display, err)
		}
	}

	return fx, users
}

func withLexicalTx(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fn func(q *gen.Queries)) {
	t.Helper()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold = 0.35`); err != nil {
		t.Fatalf("SET LOCAL similarity_threshold: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.word_similarity_threshold = 0.5`); err != nil {
		t.Fatalf("SET LOCAL word_similarity_threshold: %v", err)
	}

	fn(gen.New(tx))
}

func TestLexicalCorpusOrder(t *testing.T) {
	// Parse quota.json by relative path to prove the shared contract path works (Task 2 brief).
	quotaRaw, err := os.ReadFile(fixturePath(t, "quota.json"))
	if err != nil {
		t.Fatalf("read quota.json: %v", err)
	}
	var qf quotaFixture
	if err := json.Unmarshal(quotaRaw, &qf); err != nil {
		t.Fatalf("unmarshal quota.json: %v", err)
	}
	if qf.Schema != "engram-search-quota-v1" || len(qf.Suggest.Table) != 9 {
		t.Fatalf("unexpected quota.json content: schema=%q rows=%d", qf.Schema, len(qf.Suggest.Table))
	}

	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	fx, users := loadAndSeedCorpus(t, ctx, pool)

	for _, qc := range fx.Queries {
		t.Run(qc.Name, func(t *testing.T) {
			uid, ok := users[qc.User]
			if !ok {
				t.Fatalf("unknown user alias %q", qc.User)
			}

			var qn string
			var err error
			if qc.Scope == "tag" {
				qn, err = textnorm.NormalizeTagQuery(qc.Q)
			} else {
				qn, err = textnorm.NormalizeQuery(qc.Q)
			}
			if err != nil {
				t.Fatalf("normalize query %q: %v", qc.Q, err)
			}
			qPrefix := item.EscapeLikePrefix(qn)
			fuzzy := len([]rune(qn)) >= 2

			withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
				switch qc.Scope {
				case "item":
					rows, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
						UserID:    uid,
						Qn:        qn,
						QPrefix:   qPrefix,
						Fuzzy:     fuzzy,
						PageLimit: 20,
					})
					if err != nil {
						t.Fatalf("SearchItemsLexical(%q): %v", qc.Q, err)
					}
					if qc.ExpectEmpty {
						if len(rows) != 0 {
							t.Fatalf("SearchItemsLexical(%q) returned %d rows, want 0", qc.Q, len(rows))
						}
						return
					}
					if len(rows) < len(qc.ExpectTop) {
						t.Fatalf("SearchItemsLexical(%q) returned %d rows, want at least %d", qc.Q, len(rows), len(qc.ExpectTop))
					}
					for i, exp := range qc.ExpectTop {
						got := rows[i]
						if got.ID.String() != exp.ID {
							t.Fatalf("hit[%d] ID = %s (%q), want %s (%q)", i, got.ID, got.Name, exp.ID, exp.Name)
						}
						if exp.Name != "" && got.Name != exp.Name {
							t.Fatalf("hit[%d] Name = %q, want %q", i, got.Name, exp.Name)
						}
						if got.Tier != exp.Tier {
							t.Fatalf("hit[%d] Tier = %d, want %d", i, got.Tier, exp.Tier)
						}
						if gotMatch := tierToMatch(got.Tier); gotMatch != exp.Match {
							t.Fatalf("hit[%d] Match = %q, want %q", i, gotMatch, exp.Match)
						}
					}
				case "tag":
					rows, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
						UserID:    uid,
						Qn:        qn,
						QPrefix:   qPrefix,
						Fuzzy:     fuzzy,
						PageLimit: 20,
					})
					if err != nil {
						t.Fatalf("SearchTagsLexical(%q): %v", qc.Q, err)
					}
					if qc.ExpectEmpty {
						if len(rows) != 0 {
							t.Fatalf("SearchTagsLexical(%q) returned %d rows, want 0", qc.Q, len(rows))
						}
						return
					}
					if len(rows) < len(qc.ExpectTop) {
						t.Fatalf("SearchTagsLexical(%q) returned %d rows, want at least %d", qc.Q, len(rows), len(qc.ExpectTop))
					}
					for i, exp := range qc.ExpectTop {
						got := rows[i]
						if got.ID.String() != exp.ID {
							t.Fatalf("tag hit[%d] ID = %s (%q), want %s (%q)", i, got.ID, got.Display, exp.ID, exp.Display)
						}
						if exp.Display != "" && got.Display != exp.Display {
							t.Fatalf("tag hit[%d] Display = %q, want %q", i, got.Display, exp.Display)
						}
						if got.Tier != exp.Tier {
							t.Fatalf("tag hit[%d] Tier = %d, want %d", i, got.Tier, exp.Tier)
						}
						if gotMatch := tierToMatch(got.Tier); gotMatch != exp.Match {
							t.Fatalf("tag hit[%d] Match = %q, want %q", i, gotMatch, exp.Match)
						}
					}
				default:
					t.Fatalf("unsupported scope %q", qc.Scope)
				}
			})
		})
	}

	// Verify RecentItemsForSuggest, RecentTagsForSuggest, and ListTagRefsForItems (<= 3 tags ordered by display + tag_total).
	t.Run("recent-and-list-tag-refs-for-items", func(t *testing.T) {
		u1 := users["u1"]
		q := gen.New(pool)

		recItems, err := q.RecentItemsForSuggest(ctx, gen.RecentItemsForSuggestParams{
			UserID:    u1,
			PageLimit: 5,
		})
		if err != nil {
			t.Fatalf("RecentItemsForSuggest: %v", err)
		}
		if len(recItems) != 5 {
			t.Fatalf("RecentItemsForSuggest len = %d, want 5", len(recItems))
		}
		for i := 1; i < len(recItems); i++ {
			prev := recItems[i-1]
			curr := recItems[i]
			if prev.LastUsedAt.Time.Before(curr.LastUsedAt.Time) {
				t.Fatalf("RecentItemsForSuggest not sorted DESC at %d: %v < %v", i, prev.LastUsedAt.Time, curr.LastUsedAt.Time)
			}
		}

		recTags, err := q.RecentTagsForSuggest(ctx, gen.RecentTagsForSuggestParams{
			UserID:    u1,
			PageLimit: 5,
		})
		if err != nil {
			t.Fatalf("RecentTagsForSuggest: %v", err)
		}
		if len(recTags) != 5 {
			t.Fatalf("RecentTagsForSuggest len = %d, want 5", len(recTags))
		}

		// Attach 5 tags (4 live + 1 soft-deleted) to item #1 and verify ListTagRefsForItems returns <= 3 live tags ordered by display ASC + tag_total = 4.
		item1ID := uuid.MustParse("00000000-0001-4000-8000-000000000001")
		tagIDs := []uuid.UUID{
			uuid.MustParse("00000000-0011-4000-8000-000000000001"), // wifi-khách
			uuid.MustParse("00000000-0011-4000-8000-000000000002"), // wifi-nhà
			uuid.MustParse("00000000-0011-4000-8000-000000000010"), // gia-đình
			uuid.MustParse("00000000-0011-4000-8000-000000000011"), // công-việc
		}
		for _, tid := range tagIDs {
			if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item1ID, tid); err != nil {
				t.Fatalf("attach tag %s: %v", tid, err)
			}
		}
		deletedTagID := uuid.MustParse("00000000-0011-4000-8000-000000000012")
		if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = now() WHERE id = $1`, deletedTagID); err != nil {
			t.Fatalf("soft-delete tag: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item1ID, deletedTagID); err != nil {
			t.Fatalf("attach deleted tag: %v", err)
		}

		refRows, err := q.ListTagRefsForItems(ctx, gen.ListTagRefsForItemsParams{
			UserID:  u1,
			ItemIds: []uuid.UUID{item1ID},
		})
		if err != nil {
			t.Fatalf("ListTagRefsForItems: %v", err)
		}
		if len(refRows) != 3 {
			t.Fatalf("ListTagRefsForItems len = %d, want 3 (capped at 3)", len(refRows))
		}
		for i, r := range refRows {
			if r.ItemID != item1ID {
				t.Fatalf("refRows[%d].ItemID = %s, want %s", i, r.ItemID, item1ID)
			}
			if r.TagTotal != 4 {
				t.Fatalf("refRows[%d].TagTotal = %d, want 4 (live tags only)", i, r.TagTotal)
			}
			if i > 0 && refRows[i-1].Display > r.Display {
				t.Fatalf("ListTagRefsForItems not ordered by display ASC: %q > %q", refRows[i-1].Display, r.Display)
			}
		}
	})
}

func TestLexicalIndexesUsed(t *testing.T) {
	// NOTE: No t.Parallel() — DROP INDEX inside the transaction takes ACCESS EXCLUSIVE locks (plan Task 2 / FS-29).
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	_, users := loadAndSeedCorpus(t, ctx, pool)
	u1 := users["u1"]

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Drop global trigram indexes inside the transaction and disable seqscan so the planner must use per-user indexes (FS-18, FS-29).
	if _, err := tx.Exec(ctx, `DROP INDEX item_name_trgm, tag_norm_trgm`); err != nil {
		t.Fatalf("DROP INDEX global trgm in tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("SET LOCAL enable_seqscan = off: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold = 0.35`); err != nil {
		t.Fatalf("SET LOCAL similarity_threshold: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.word_similarity_threshold = 0.5`); err != nil {
		t.Fatalf("SET LOCAL word_similarity_threshold: %v", err)
	}

	qn := "duong"
	qPrefix := item.EscapeLikePrefix(qn)

	// 1. Item lexical query (fuzzy = true): must use item_user_unaccent_prefix / item_user_name_trgm (and/or item_user_name_prefix) with no Seq Scan on item.
	var itemPlanJSON string
	if err := tx.QueryRow(ctx, `
		EXPLAIN (FORMAT JSON)
		WITH q AS (
		  SELECT $2::text AS qn, immutable_unaccent($2::text) AS qa
		)
		SELECT i.id, i.name, i.entry_count, i.last_used_at, i.created_at,
		       (CASE WHEN i.name_normalized LIKE $3::text ESCAPE '\' THEN 3
		             WHEN i.name_unaccent LIKE immutable_unaccent($3::text) ESCAPE '\' THEN 2
		             ELSE 1 END)::int AS tier,
		       round(GREATEST(similarity(i.name_unaccent, q.qa),
		                      word_similarity(q.qa, i.name_unaccent))::numeric, 2)::float8 AS score
		FROM item AS i, q
		WHERE i.user_id = $1 AND i.deleted_at IS NULL
		  AND (i.name_normalized LIKE $3::text ESCAPE '\'
		       OR i.name_unaccent LIKE immutable_unaccent($3::text) ESCAPE '\'
		       OR ($4::bool AND (i.name_unaccent % q.qa OR q.qa <% i.name_unaccent)))
		ORDER BY tier DESC, score DESC, i.last_used_at DESC, i.entry_count DESC, i.id ASC
		LIMIT $5
	`, u1, qn, qPrefix, true, 10).Scan(&itemPlanJSON); err != nil {
		t.Fatalf("EXPLAIN item lexical: %v", err)
	}
	assertPlanUsesPerUserIndexes(t, itemPlanJSON, "item",
		[]string{"item_user_unaccent_prefix", "item_user_name_trgm"},
	)

	// Also verify prefix-only item query (fuzzy = false) uses item_user_unaccent_prefix.
	var itemPrefixPlanJSON string
	if err := tx.QueryRow(ctx, `
		EXPLAIN (FORMAT JSON)
		SELECT i.id
		FROM item AS i
		WHERE i.user_id = $1 AND i.deleted_at IS NULL
		  AND (i.name_normalized LIKE $2::text ESCAPE '\'
		       OR i.name_unaccent LIKE immutable_unaccent($2::text) ESCAPE '\')
	`, u1, qPrefix).Scan(&itemPrefixPlanJSON); err != nil {
		t.Fatalf("EXPLAIN item prefix: %v", err)
	}
	assertPlanUsesPerUserIndexes(t, itemPrefixPlanJSON, "item",
		[]string{"item_user_unaccent_prefix"},
	)

	// 2. Tag lexical query (fuzzy = true): must use tag_user_unaccent_prefix / tag_user_tag_trgm with no Seq Scan on tag.
	var tagPlanJSON string
	if err := tx.QueryRow(ctx, `
		EXPLAIN (FORMAT JSON)
		WITH q AS (
		  SELECT $2::text AS qn, immutable_unaccent($2::text) AS qa
		)
		SELECT t.id, t.display, t.item_count, t.last_used_at,
		       (CASE WHEN t.normalized LIKE $3::text ESCAPE '\' THEN 3
		             WHEN t.tag_unaccent LIKE immutable_unaccent($3::text) ESCAPE '\' THEN 2
		             ELSE 1 END)::int AS tier,
		       round(GREATEST(similarity(t.tag_unaccent, q.qa),
		                      word_similarity(q.qa, t.tag_unaccent))::numeric, 2)::float8 AS score
		FROM tag AS t, q
		WHERE t.user_id = $1 AND t.deleted_at IS NULL
		  AND (t.normalized LIKE $3::text ESCAPE '\'
		       OR t.tag_unaccent LIKE immutable_unaccent($3::text) ESCAPE '\'
		       OR ($4::bool AND (t.tag_unaccent % q.qa OR q.qa <% t.tag_unaccent)))
		ORDER BY tier DESC, score DESC, t.last_used_at DESC, t.item_count DESC, t.id ASC
		LIMIT $5
	`, u1, qn, qPrefix, true, 10).Scan(&tagPlanJSON); err != nil {
		t.Fatalf("EXPLAIN tag lexical: %v", err)
	}
	assertPlanUsesPerUserIndexes(t, tagPlanJSON, "tag",
		[]string{"tag_user_unaccent_prefix", "tag_user_tag_trgm"},
	)

	// Verify prefix-only tag query uses tag_user_unaccent_prefix.
	var tagPrefixPlanJSON string
	if err := tx.QueryRow(ctx, `
		EXPLAIN (FORMAT JSON)
		SELECT t.id
		FROM tag AS t
		WHERE t.user_id = $1 AND t.deleted_at IS NULL
		  AND (t.normalized LIKE $2::text ESCAPE '\'
		       OR t.tag_unaccent LIKE immutable_unaccent($2::text) ESCAPE '\')
	`, u1, qPrefix).Scan(&tagPrefixPlanJSON); err != nil {
		t.Fatalf("EXPLAIN tag prefix: %v", err)
	}
	assertPlanUsesPerUserIndexes(t, tagPrefixPlanJSON, "tag",
		[]string{"tag_user_unaccent_prefix"},
	)
}

func assertPlanUsesPerUserIndexes(t *testing.T, planJSON string, tableName string, expectedAny []string) {
	t.Helper()
	var plans []map[string]any
	if err := json.Unmarshal([]byte(planJSON), &plans); err != nil {
		t.Fatalf("unmarshal EXPLAIN JSON: %v", err)
	}
	var indexNames []string
	var seqScansOnTable []string
	var walk func(node any)
	walk = func(node any) {
		switch v := node.(type) {
		case map[string]any:
			nodeType, _ := v["Node Type"].(string)
			relName, _ := v["Relation Name"].(string)
			idxName, _ := v["Index Name"].(string)
			if idxName != "" {
				indexNames = append(indexNames, idxName)
			}
			if nodeType == "Seq Scan" && relName == tableName {
				seqScansOnTable = append(seqScansOnTable, relName)
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, elem := range v {
				walk(elem)
			}
		}
	}
	for _, p := range plans {
		walk(p)
	}
	if len(seqScansOnTable) > 0 {
		t.Fatalf("unexpected Seq Scan on %s in plan:\n%s", tableName, planJSON)
	}
	idxSet := make(map[string]bool, len(indexNames))
	for _, name := range indexNames {
		idxSet[name] = true
	}
	matched := false
	for _, want := range expectedAny {
		if idxSet[want] {
			matched = true
		}
	}
	if !matched {
		t.Fatalf("plan on %s did not use any of %v (used indexes=%v):\n%s", tableName, expectedAny, indexNames, planJSON)
	}
}

func TestTagsLexicalPageKeyset(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("33333333-3333-4000-8000-000000000003")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'keyset@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	t1 := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

	// Seed tags covering mixed tiers (3, 2, 1), different scores, tie on score broken by last_used_at,
	// tie on last_used_at broken by item_count, tie on item_count broken by id ASC.
	tagSeeds := []struct {
		id         string
		display    string
		normalized string
		count      int32
		lastUsed   time.Time
	}{
		// Tier 3 exact prefix "duong..."
		{"00000000-0033-4000-8000-000000000001", "duong", "duong", 10, t1},
		{"00000000-0033-4000-8000-000000000002", "duong-alpha", "duong-alpha", 8, t1},
		{"00000000-0033-4000-8000-000000000003", "duong-beta", "duong-beta", 8, t1},   // tie on tier=3, score, last_used_at, item_count -> broken by id ASC
		{"00000000-0033-4000-8000-000000000004", "duong-gamma", "duong-gamma", 2, t1}, // tie on tier=3, score, last_used_at -> broken by item_count DESC
		{"00000000-0033-4000-8000-000000000005", "duong-delta", "duong-delta", 9, t2}, // tie on tier=3, score -> broken by last_used_at DESC
		// Tier 2 folded prefix "đường..."
		{"00000000-0033-4000-8000-000000000006", "đường-một", "đường-một", 6, t1},
		{"00000000-0033-4000-8000-000000000007", "đường-hai", "đường-hai", 6, t1}, // tie on tier=2, score, last_used_at, item_count -> broken by id ASC
		{"00000000-0033-4000-8000-000000000008", "đường-ba", "đường-ba", 1, t1},
		{"00000000-0033-4000-8000-000000000009", "đường-bốn", "đường-bốn", 5, t2},
		// Tier 1 fuzzy (contains word "duong" not at prefix)
		{"00000000-0033-4000-8000-000000000010", "con-đường-nhỏ", "con-đường-nhỏ", 7, t1},
		{"00000000-0033-4000-8000-000000000011", "tuyến-đường-lớn", "tuyến-đường-lớn", 4, t2},
	}

	for _, s := range tagSeeds {
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, uuid.MustParse(s.id), uid, s.display, s.normalized, s.count, s.lastUsed); err != nil {
			t.Fatalf("insert tag seed %s: %v", s.id, err)
		}
	}

	// Also seed items covering mixed tiers (3, 2, 1) and exact ties on (tier, score, last_used_at, entry_count) broken by id ASC.
	itemSeeds := []struct {
		id       string
		name     string
		norm     string
		count    int32
		lastUsed time.Time
	}{
		{"00000000-0044-4000-8000-000000000001", "duong", "duong", 9, t1},
		{"00000000-0044-4000-8000-000000000002", "duong hồ sơ", "duong hồ sơ", 5, t1},
		{"00000000-0044-4000-8000-000000000003", "duong hồ sơ", "duong hồ sơ", 5, t1}, // exact duplicate name + count + last_used_at -> broken by id ASC
		{"00000000-0044-4000-8000-000000000004", "duong hồ sơ", "duong hồ sơ", 2, t1}, // broken by entry_count DESC
		{"00000000-0044-4000-8000-000000000005", "duong hồ sơ", "duong hồ sơ", 8, t2}, // broken by last_used_at DESC
		{"00000000-0044-4000-8000-000000000006", "đường sắt", "đường sắt", 6, t1},
		{"00000000-0044-4000-8000-000000000007", "đường sắt", "đường sắt", 6, t1}, // tie at tier 2 -> broken by id ASC
		{"00000000-0044-4000-8000-000000000008", "đường bộ", "đường bộ", 3, t2},
		{"00000000-0044-4000-8000-000000000009", "con đường nhỏ", "con đường nhỏ", 4, t1},
		{"00000000-0044-4000-8000-000000000010", "tuyến đường lớn", "tuyến đường lớn", 1, t2},
	}

	for _, s := range itemSeeds {
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, uuid.MustParse(s.id), uid, s.name, s.norm, s.count, s.lastUsed); err != nil {
			t.Fatalf("insert item seed %s: %v", s.id, err)
		}
	}

	qn := "duong"
	qPrefix := item.EscapeLikePrefix(qn)

	withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
		// 1. Tags: unpaged list vs walking keyset pages with page size = 2
		unpagedTags, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
			UserID:    uid,
			Qn:        qn,
			QPrefix:   qPrefix,
			Fuzzy:     true,
			PageLimit: 100,
		})
		if err != nil {
			t.Fatalf("SearchTagsLexical unpaged: %v", err)
		}
		if len(unpagedTags) != len(tagSeeds) {
			t.Fatalf("unpaged tags len = %d, want %d", len(unpagedTags), len(tagSeeds))
		}

		var pagedTags []gen.SearchTagsLexicalPageRow
		var curID *uuid.UUID
		var curTier *int32
		var curScore *float64
		var curLastUsed pgtype.Timestamptz
		var curCount *int32

		for pageNum := range 20 {
			page, err := q.SearchTagsLexicalPage(ctx, gen.SearchTagsLexicalPageParams{
				UserID:           uid,
				Qn:               qn,
				QPrefix:          qPrefix,
				Fuzzy:            true,
				CursorID:         curID,
				CursorTier:       curTier,
				CursorScore:      curScore,
				CursorLastUsedAt: curLastUsed,
				CursorCount:      curCount,
				PageLimit:        2,
			})
			if err != nil {
				t.Fatalf("SearchTagsLexicalPage page %d: %v", pageNum, err)
			}
			if len(page) == 0 {
				break
			}
			pagedTags = append(pagedTags, page...)
			last := page[len(page)-1]
			idCopy := last.ID
			tierCopy := last.Tier
			scoreCopy := last.Score
			countCopy := last.ItemCount
			curID = &idCopy
			curTier = &tierCopy
			curScore = &scoreCopy
			curLastUsed = last.LastUsedAt
			curCount = &countCopy
		}

		if len(pagedTags) != len(unpagedTags) {
			t.Fatalf("pagedTags len = %d, want %d", len(pagedTags), len(unpagedTags))
		}
		for i := range unpagedTags {
			if pagedTags[i].ID != unpagedTags[i].ID ||
				pagedTags[i].Tier != unpagedTags[i].Tier ||
				pagedTags[i].Score != unpagedTags[i].Score {
				t.Fatalf("tag page mismatch at [%d]: got (id=%s tier=%d score=%v), want (id=%s tier=%d score=%v)",
					i, pagedTags[i].ID, pagedTags[i].Tier, pagedTags[i].Score,
					unpagedTags[i].ID, unpagedTags[i].Tier, unpagedTags[i].Score)
			}
		}

		// 2. Items: unpaged list vs walking keyset pages with page size = 2
		unpagedItems, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
			UserID:    uid,
			Qn:        qn,
			QPrefix:   qPrefix,
			Fuzzy:     true,
			PageLimit: 100,
		})
		if err != nil {
			t.Fatalf("SearchItemsLexical unpaged: %v", err)
		}
		if len(unpagedItems) != len(itemSeeds) {
			t.Fatalf("unpaged items len = %d, want %d", len(unpagedItems), len(itemSeeds))
		}

		var pagedItems []gen.SearchItemsLexicalPageRow
		curID = nil
		curTier = nil
		curScore = nil
		curLastUsed = pgtype.Timestamptz{}
		curCount = nil

		for pageNum := range 20 {
			page, err := q.SearchItemsLexicalPage(ctx, gen.SearchItemsLexicalPageParams{
				UserID:           uid,
				Qn:               qn,
				QPrefix:          qPrefix,
				Fuzzy:            true,
				CursorID:         curID,
				CursorTier:       curTier,
				CursorScore:      curScore,
				CursorLastUsedAt: curLastUsed,
				CursorCount:      curCount,
				PageLimit:        2,
			})
			if err != nil {
				t.Fatalf("SearchItemsLexicalPage page %d: %v", pageNum, err)
			}
			if len(page) == 0 {
				break
			}
			pagedItems = append(pagedItems, page...)
			last := page[len(page)-1]
			idCopy := last.ID
			tierCopy := last.Tier
			scoreCopy := last.Score
			countCopy := last.EntryCount
			curID = &idCopy
			curTier = &tierCopy
			curScore = &scoreCopy
			curLastUsed = last.LastUsedAt
			curCount = &countCopy
		}

		if len(pagedItems) != len(unpagedItems) {
			t.Fatalf("pagedItems len = %d, want %d", len(pagedItems), len(unpagedItems))
		}
		for i := range unpagedItems {
			if pagedItems[i].ID != unpagedItems[i].ID ||
				pagedItems[i].Tier != unpagedItems[i].Tier ||
				pagedItems[i].Score != unpagedItems[i].Score {
				t.Fatalf("item page mismatch at [%d]: got (id=%s tier=%d score=%v), want (id=%s tier=%d score=%v)",
					i, pagedItems[i].ID, pagedItems[i].Tier, pagedItems[i].Score,
					unpagedItems[i].ID, unpagedItems[i].Tier, unpagedItems[i].Score)
			}
		}
	})
}

func TestMigration0008UpDown(t *testing.T) {
	ctx := context.Background()
	dsn := startTestDB(t)

	// Migrate to 0007 first and seed P04 rows (app_user, item, tag, item_tag).
	migrateToTargetVersion(t, dsn, 7)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "mig0008@example.com",
		Locale: "vi",
	})
	if err != nil {
		t.Fatalf("InsertUser at v7: %v", err)
	}
	it, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Đường sắt Bắc Nam",
		NameNormalized: "đường sắt bắc nam",
	})
	if err != nil {
		t.Fatalf("InsertItem at v7: %v", err)
	}
	tg, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u.ID,
		Display:    "đà-nẵng",
		Normalized: "đà-nẵng",
	})
	if err != nil {
		t.Fatalf("InsertTag at v7: %v", err)
	}
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{
		UserID: u.ID,
		ItemID: it.ID,
		TagID:  tg.ID,
	}); err != nil {
		t.Fatalf("AssignItemTag at v7: %v", err)
	}

	expectedIndexes := []struct {
		table string
		name  string
		sub   string
	}{
		{"item", "item_user_unaccent_prefix", "(user_id, name_unaccent text_pattern_ops)"},
		{"item", "item_user_name_trgm", "using gin (user_id, name_unaccent gin_trgm_ops)"},
		{"tag", "tag_user_unaccent_prefix", "(user_id, tag_unaccent text_pattern_ops)"},
		{"tag", "tag_user_tag_trgm", "using gin (user_id, tag_unaccent gin_trgm_ops)"},
	}

	// Step up to 0008.
	migrateToTargetVersion(t, dsn, 8)
	v, dirty, err := db.Version(dsn)
	if err != nil || dirty || v != 8 {
		t.Fatalf("after migrate to 8: v=%d dirty=%v err=%v", v, dirty, err)
	}

	var extCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_extension WHERE extname = 'btree_gin'`).Scan(&extCount); err != nil {
		t.Fatalf("check btree_gin extension: %v", err)
	}
	if extCount != 1 {
		t.Fatalf("expected btree_gin extension installed, count=%d", extCount)
	}

	for _, idx := range expectedIndexes {
		var idxDef string
		if err := pool.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, idx.table, idx.name).Scan(&idxDef); err != nil {
			t.Fatalf("index %s.%s missing at v8: %v", idx.table, idx.name, err)
		}
		lower := strings.ToLower(idxDef)
		if !strings.Contains(lower, idx.sub) || !strings.Contains(lower, "where (deleted_at is null)") {
			t.Fatalf("index %s.%s def mismatch: %s", idx.table, idx.name, idxDef)
		}
	}

	// Global trgm indexes must still exist until Task 23.
	for _, globalIdx := range []string{"item_name_trgm", "tag_norm_trgm"} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname = $1`, globalIdx).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("global index %s must be retained in 0008, count=%d", globalIdx, n)
		}
	}

	// Step down 8 -> 7: new indexes must be dropped, P04 rows and global indexes must survive intact.
	migrateToTargetVersion(t, dsn, 7)
	vDown, dirtyDown, err := db.Version(dsn)
	if err != nil || dirtyDown || vDown != 7 {
		t.Fatalf("after step down 8->7: v=%d dirty=%v err=%v", vDown, dirtyDown, err)
	}
	for _, idx := range expectedIndexes {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, idx.table, idx.name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("index %s.%s should be dropped at v7, count=%d", idx.table, idx.name, n)
		}
	}
	if _, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u.ID, ID: it.ID}); err != nil {
		t.Fatalf("P04 item must survive 0008 down: %v", err)
	}
	if _, err := q.GetLiveTagByUserAndID(ctx, gen.GetLiveTagByUserAndIDParams{UserID: u.ID, ID: tg.ID}); err != nil {
		t.Fatalf("P04 tag must survive 0008 down: %v", err)
	}

	// Re-apply 0008 up cleanly.
	migrateToTargetVersion(t, dsn, 8)
	for _, idx := range expectedIndexes {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, idx.table, idx.name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("index %s.%s must exist after re-applying 0008 up, count=%d", idx.table, idx.name, n)
		}
	}
}

func migrateToTargetVersion(t *testing.T, dsn string, target uint) {
	t.Helper()
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatalf("iofs.New: %v", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		t.Fatalf("migrate.NewWithSourceInstance: %v", err)
	}
	defer func() {
		_, _ = m.Close()
	}()
	if err := m.Migrate(target); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		t.Fatalf("Migrate(%d): %v", target, err)
	}
}
