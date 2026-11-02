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
	"github.com/jackc/pgx/v5/pgconn"
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
	Name                     string `json:"name"`
	Input                    string `json:"input"`
	Normalized               string `json:"normalized"`
	Unaccent                 string `json:"unaccent"`
	Error                    string `json:"error"`
	EquivNFCInput            string `json:"equiv_nfc_input"`
	FoldedPrefixMatchesASCII string `json:"folded_prefix_matches_ascii"`
	FuzzyMatchesTarget       string `json:"fuzzy_matches_target"`
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

			if tc.FoldedPrefixMatchesASCII != "" {
				if qn == tc.FoldedPrefixMatchesASCII {
					t.Fatalf("NormalizeQuery(%q) = %q, must stay NFC full-width and not fold to ASCII %q in Go", tc.Input, qn, tc.FoldedPrefixMatchesASCII)
				}
				var tier int32
				if err := pool.QueryRow(ctx, `
					WITH q AS (
					  SELECT
					    $1::text AS qn,
					    immutable_unaccent($1::text) AS qa,
					    replace(replace(replace(immutable_unaccent($1::text), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS qa_prefix
					)
					SELECT (CASE
					  WHEN $2::text LIKE $3::text ESCAPE '\' THEN 3
					  WHEN immutable_unaccent($2::text) LIKE q.qa_prefix ESCAPE '\' THEN 2
					  ELSE 1
					END)::int
					FROM q
				`, qn, tc.FoldedPrefixMatchesASCII, item.EscapeLikePrefix(qn)).Scan(&tier); err != nil {
					t.Fatalf("folded prefix tier check(%q, %q): %v", qn, tc.FoldedPrefixMatchesASCII, err)
				}
				if tier != 2 {
					t.Fatalf("expected %q (qn=%q, qa=%q) to match ASCII %q at tier 2 (prefix_folded), got tier %d",
						tc.Input, qn, qa, tc.FoldedPrefixMatchesASCII, tier)
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
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Display string   `json:"display"`
	Tier    int32    `json:"tier"`
	Score   *float64 `json:"score,omitempty"`
	Match   string   `json:"match"`
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
						if exp.Score != nil && got.Score != *exp.Score {
							t.Fatalf("hit[%d] Score = %v, want %v", i, got.Score, *exp.Score)
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
						if exp.Score != nil && got.Score != *exp.Score {
							t.Fatalf("tag hit[%d] Score = %v, want %v", i, got.Score, *exp.Score)
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

		// RV-T2-BE-6: Verify ListTagRefsForItems across:
		//   - >= 2 owned u1 items each having > 3 live tags (assert per-item first 3 by display ASC + full live tag_total),
		//   - 1 owned u1 item with no tags (produces 0 rows),
		//   - 1 foreign u2 item ID (produces 0 rows),
		//   - 1 cross-tenant item_tag row associating a u1 item with a u2 tag (excluded from both refs and tag_total),
		//   - 1 soft-deleted u1 tag on a u1 item (excluded from both refs and tag_total).
		item1ID := uuid.MustParse("00000000-0001-4000-8000-000000000001")
		item2ID := uuid.MustParse("00000000-0001-4000-8000-000000000002")
		itemNoTagsID := uuid.MustParse("00000000-0001-4000-8000-000000000003")
		u2ItemID := uuid.MustParse("00000000-0002-4000-8000-000000000065")
		u2TagID := uuid.MustParse("00000000-0022-4000-8000-000000000021")

		item1LiveTags := []uuid.UUID{
			uuid.MustParse("00000000-0011-4000-8000-000000000001"), // wifi-khách
			uuid.MustParse("00000000-0011-4000-8000-000000000002"), // wifi-nhà
			uuid.MustParse("00000000-0011-4000-8000-000000000010"), // gia-đình
			uuid.MustParse("00000000-0011-4000-8000-000000000011"), // công-việc
		}
		for _, tid := range item1LiveTags {
			if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item1ID, tid); err != nil {
				t.Fatalf("attach item1 tag %s: %v", tid, err)
			}
		}
		deletedTagID := uuid.MustParse("00000000-0011-4000-8000-000000000012")
		if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = now() WHERE id = $1`, deletedTagID); err != nil {
			t.Fatalf("soft-delete tag: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item1ID, deletedTagID); err != nil {
			t.Fatalf("attach deleted tag to item1: %v", err)
		}
		// Cross-tenant item_tag row: u1 item1 linked to u2 tag (allowed by FK schema, must be filtered by t.user_id = user_id).
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item1ID, u2TagID); err != nil {
			t.Fatalf("attach cross-tenant u2 tag to item1: %v", err)
		}

		// Attach 5 live u1 tags to item2 + 1 cross-tenant u2 tag.
		item2LiveTags := []uuid.UUID{
			uuid.MustParse("00000000-0011-4000-8000-000000000003"), // đường-bộ
			uuid.MustParse("00000000-0011-4000-8000-000000000004"), // duong-sat
			uuid.MustParse("00000000-0011-4000-8000-000000000005"), // đà-nẵng
			uuid.MustParse("00000000-0011-4000-8000-000000000006"), // da-nang-trip
			uuid.MustParse("00000000-0011-4000-8000-000000000007"), // mã-pin
		}
		for _, tid := range item2LiveTags {
			if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item2ID, tid); err != nil {
				t.Fatalf("attach item2 tag %s: %v", tid, err)
			}
		}
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, item2ID, u2TagID); err != nil {
			t.Fatalf("attach cross-tenant u2 tag to item2: %v", err)
		}
		// Also attach a tag to u2ItemID (owned by u2) to verify u1 query never returns rows for u2ItemID.
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, u2ItemID, u2TagID); err != nil {
			t.Fatalf("attach u2 tag to u2 item: %v", err)
		}

		// Compute expected display-ordered top 3 for item1 and item2 directly from Postgres `ORDER BY display ASC, id ASC`
		// so collation order is verified against the database's exact ordering of the live u1 tags.
		expectedRefsFor := func(liveTagIDs []uuid.UUID) []string {
			rows, err := pool.Query(ctx, `
				SELECT display FROM tag WHERE id = ANY($1::uuid[]) ORDER BY display ASC, id ASC LIMIT 3
			`, liveTagIDs)
			if err != nil {
				t.Fatalf("query expected tag displays: %v", err)
			}
			defer rows.Close()
			var out []string
			for rows.Next() {
				var d string
				if err := rows.Scan(&d); err != nil {
					t.Fatalf("scan expected tag display: %v", err)
				}
				out = append(out, d)
			}
			return out
		}
		wantItem1Displays := expectedRefsFor(item1LiveTags)
		wantItem2Displays := expectedRefsFor(item2LiveTags)

		refRows, err := q.ListTagRefsForItems(ctx, gen.ListTagRefsForItemsParams{
			UserID:  u1,
			ItemIds: []uuid.UUID{item1ID, item2ID, itemNoTagsID, u2ItemID},
		})
		if err != nil {
			t.Fatalf("ListTagRefsForItems: %v", err)
		}
		if len(refRows) != 6 {
			t.Fatalf("ListTagRefsForItems len = %d, want 6 (3 for item1 + 3 for item2, 0 for itemNoTags and u2Item)", len(refRows))
		}
		byItem := make(map[uuid.UUID][]gen.ListTagRefsForItemsRow)
		for _, r := range refRows {
			if r.ItemID == itemNoTagsID {
				t.Fatalf("unexpected row for owned item with no tags: %+v", r)
			}
			if r.ItemID == u2ItemID {
				t.Fatalf("cross-tenant leak: returned row for u2 item: %+v", r)
			}
			if r.TagID == u2TagID {
				t.Fatalf("cross-tenant leak: returned u2 tag %s on item %s", r.TagID, r.ItemID)
			}
			byItem[r.ItemID] = append(byItem[r.ItemID], r)
		}

		gotItem1 := byItem[item1ID]
		if len(gotItem1) != 3 {
			t.Fatalf("item1 ref count = %d, want 3", len(gotItem1))
		}
		for i, r := range gotItem1 {
			if r.TagTotal != 4 {
				t.Fatalf("item1[%d].TagTotal = %d, want 4 (live u1 tags only, excluding deleted and u2 tag)", i, r.TagTotal)
			}
			if r.Display != wantItem1Displays[i] {
				t.Fatalf("item1[%d].Display = %q, want %q", i, r.Display, wantItem1Displays[i])
			}
		}

		gotItem2 := byItem[item2ID]
		if len(gotItem2) != 3 {
			t.Fatalf("item2 ref count = %d, want 3", len(gotItem2))
		}
		for i, r := range gotItem2 {
			if r.TagTotal != 5 {
				t.Fatalf("item2[%d].TagTotal = %d, want 5 (live u1 tags only, excluding u2 tag)", i, r.TagTotal)
			}
			if r.Display != wantItem2Displays[i] {
				t.Fatalf("item2[%d].Display = %q, want %q", i, r.Display, wantItem2Displays[i])
			}
		}
	})
}

// TestLexicalLikeMetacharacterEscaping verifies RV-T2-BE-3 (lead call A):
// both ASCII LIKE metacharacters (`%`, `_`, `\`) and full-width variants (`％`, `＿`, `＼`)
// that PostgreSQL 16 `unaccent` transliterates into ASCII metacharacters are treated as
// literal characters in prefix-only mode (fuzzy=false) across SearchItemsLexical,
// SearchTagsLexical, SearchItemsLexicalPage, and SearchTagsLexicalPage, never matching
// unrelated `axxxb`-style rows.
func TestLexicalLikeMetacharacterEscaping(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("44444444-4444-4000-8000-000000000004")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'likeescape@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

	seeds := []struct {
		itemID string
		tagID  string
		text   string
	}{
		// Unrelated decoy rows that would match if `%`, `_`, or `\` acted as wildcards/escapes:
		{"00000000-0055-4000-8000-000000000001", "00000000-0066-4000-8000-000000000001", "axxxb decoy"},
		{"00000000-0055-4000-8000-000000000002", "00000000-0066-4000-8000-000000000002", "axb decoy"},
		{"00000000-0055-4000-8000-000000000003", "00000000-0066-4000-8000-000000000003", "ab decoy"},
		// Literal ASCII metacharacter target rows:
		{"00000000-0055-4000-8000-000000000011", "00000000-0066-4000-8000-000000000011", "a%b literal"},
		{"00000000-0055-4000-8000-000000000012", "00000000-0066-4000-8000-000000000012", "a_b literal"},
		{"00000000-0055-4000-8000-000000000013", "00000000-0066-4000-8000-000000000013", `a\b literal`},
	}

	for _, s := range seeds {
		_, normItem, err := textnorm.NormalizeName(s.text)
		if err != nil {
			t.Fatalf("NormalizeName(%q): %v", s.text, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 1, $5, $5, $5)
		`, uuid.MustParse(s.itemID), uid, s.text, normItem, ts); err != nil {
			t.Fatalf("insert item %q: %v", s.text, err)
		}
		_, normTag, err := textnorm.NormalizeTag(s.text)
		if err != nil {
			t.Fatalf("NormalizeTag(%q): %v", s.text, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 1, $5, $5, $5)
		`, uuid.MustParse(s.tagID), uid, s.text, normTag, ts); err != nil {
			t.Fatalf("insert tag %q: %v", s.text, err)
		}
	}

	cases := []struct {
		name       string
		rawQuery   string
		wantItemID string
		wantTagID  string
		wantTier   int32
	}{
		{
			name:       "ascii-percent-literal-prefix",
			rawQuery:   "a%b",
			wantItemID: "00000000-0055-4000-8000-000000000011",
			wantTagID:  "00000000-0066-4000-8000-000000000011",
			wantTier:   3,
		},
		{
			name:       "ascii-underscore-literal-prefix",
			rawQuery:   "a_b",
			wantItemID: "00000000-0055-4000-8000-000000000012",
			wantTagID:  "00000000-0066-4000-8000-000000000012",
			wantTier:   3,
		},
		{
			name:       "ascii-backslash-literal-prefix",
			rawQuery:   `a\b`,
			wantItemID: "00000000-0055-4000-8000-000000000013",
			wantTagID:  "00000000-0066-4000-8000-000000000013",
			wantTier:   3,
		},
		{
			name:       "fullwidth-percent-folded-literal-prefix",
			rawQuery:   "a\uff05b",
			wantItemID: "00000000-0055-4000-8000-000000000011",
			wantTagID:  "00000000-0066-4000-8000-000000000011",
			wantTier:   2,
		},
		{
			name:       "fullwidth-underscore-folded-literal-prefix",
			rawQuery:   "a\uff3fb",
			wantItemID: "00000000-0055-4000-8000-000000000012",
			wantTagID:  "00000000-0066-4000-8000-000000000012",
			wantTier:   2,
		},
		{
			name:       "fullwidth-backslash-folded-literal-prefix",
			rawQuery:   "a\uff3cb",
			wantItemID: "00000000-0055-4000-8000-000000000013",
			wantTagID:  "00000000-0066-4000-8000-000000000013",
			wantTier:   2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			qn, err := textnorm.NormalizeQuery(tc.rawQuery)
			if err != nil {
				t.Fatalf("NormalizeQuery(%q): %v", tc.rawQuery, err)
			}
			qPrefix := item.EscapeLikePrefix(qn)

			withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
				// 1. SearchItemsLexical (unpaged, fuzzy=false)
				items, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
					UserID:    uid,
					Qn:        qn,
					QPrefix:   qPrefix,
					Fuzzy:     false,
					PageLimit: 20,
				})
				if err != nil {
					t.Fatalf("SearchItemsLexical(%q): %v", qn, err)
				}
				if len(items) != 1 || items[0].ID.String() != tc.wantItemID || items[0].Tier != tc.wantTier {
					t.Fatalf("SearchItemsLexical(%q) = %+v, want single item %s at tier %d (no decoy match)",
						qn, items, tc.wantItemID, tc.wantTier)
				}

				// 2. SearchItemsLexicalPage (paged, fuzzy=false)
				itemPage, err := q.SearchItemsLexicalPage(ctx, gen.SearchItemsLexicalPageParams{
					UserID:    uid,
					Qn:        qn,
					QPrefix:   qPrefix,
					Fuzzy:     false,
					PageLimit: 20,
				})
				if err != nil {
					t.Fatalf("SearchItemsLexicalPage(%q): %v", qn, err)
				}
				if len(itemPage) != 1 || itemPage[0].ID.String() != tc.wantItemID || itemPage[0].Tier != tc.wantTier {
					t.Fatalf("SearchItemsLexicalPage(%q) = %+v, want single item %s at tier %d (no decoy match)",
						qn, itemPage, tc.wantItemID, tc.wantTier)
				}

				// 3. SearchTagsLexical (unpaged, fuzzy=false)
				tags, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
					UserID:    uid,
					Qn:        qn,
					QPrefix:   qPrefix,
					Fuzzy:     false,
					PageLimit: 20,
				})
				if err != nil {
					t.Fatalf("SearchTagsLexical(%q): %v", qn, err)
				}
				if len(tags) != 1 || tags[0].ID.String() != tc.wantTagID || tags[0].Tier != tc.wantTier {
					t.Fatalf("SearchTagsLexical(%q) = %+v, want single tag %s at tier %d (no decoy match)",
						qn, tags, tc.wantTagID, tc.wantTier)
				}

				// 4. SearchTagsLexicalPage (paged, fuzzy=false)
				tagPage, err := q.SearchTagsLexicalPage(ctx, gen.SearchTagsLexicalPageParams{
					UserID:    uid,
					Qn:        qn,
					QPrefix:   qPrefix,
					Fuzzy:     false,
					PageLimit: 20,
				})
				if err != nil {
					t.Fatalf("SearchTagsLexicalPage(%q): %v", qn, err)
				}
				if len(tagPage) != 1 || tagPage[0].ID.String() != tc.wantTagID || tagPage[0].Tier != tc.wantTier {
					t.Fatalf("SearchTagsLexicalPage(%q) = %+v, want single tag %s at tier %d (no decoy match)",
						qn, tagPage, tc.wantTagID, tc.wantTier)
				}
			})
		})
	}
}

// capturingDBTX wraps a gen.DBTX (inside a transaction) and records the exact SQL
// statement and argument slice issued by gen.Queries methods (RV-T2-BE-5).
type capturingDBTX struct {
	inner    gen.DBTX
	lastSQL  string
	lastArgs []any
}

func (c *capturingDBTX) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	c.lastSQL = sql
	c.lastArgs = append([]any(nil), args...)
	return c.inner.Exec(ctx, sql, args...)
}

func (c *capturingDBTX) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.lastSQL = sql
	c.lastArgs = append([]any(nil), args...)
	return c.inner.Query(ctx, sql, args...)
}

func (c *capturingDBTX) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.lastSQL = sql
	c.lastArgs = append([]any(nil), args...)
	return c.inner.QueryRow(ctx, sql, args...)
}

func explainCapturedQuery(t *testing.T, ctx context.Context, tx pgx.Tx, capDB *capturingDBTX) string {
	t.Helper()
	if capDB.lastSQL == "" {
		t.Fatal("capturingDBTX did not capture any SQL statement")
	}
	var planJSON string
	if err := tx.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+capDB.lastSQL, capDB.lastArgs...).Scan(&planJSON); err != nil {
		t.Fatalf("EXPLAIN captured query: %v\nSQL:\n%s", err, capDB.lastSQL)
	}
	return planJSON
}

func TestLexicalIndexesUsed(t *testing.T) {
	// NOTE: No t.Parallel() — DROP INDEX inside the transaction takes ACCESS EXCLUSIVE locks (plan Task 2 / FS-29 / RV-T2-BE-5).
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
	// Force fresh statistics and disable plain indexscan/bitmapscan fallback on user_id-only btrees where needed
	// by running ANALYZE so the planner sees all three OR arms (exact prefix, folded prefix, trigram).
	if _, err := tx.Exec(ctx, `ANALYZE item, tag`); err != nil {
		t.Fatalf("ANALYZE item, tag in tx: %v", err)
	}
	// Drop competing user-leading non-lexical btree indexes inside this rolled-back transaction so PostgreSQL
	// cannot satisfy all OR arms via a single full-user btree scan + Filter when enable_seqscan=off,
	// proving that the prefix and trigram indexes themselves are indexable for the production SQL.
	// Before dropping item_user_id_id_key / tag_user_id_id_key (such as entry_user_id_item_id_fkey on entry
	// and item_tag_item_id_fkey / item_tag_tag_id_fkey on item_tag), look up and drop every dependent
	// foreign-key constraint referencing item or tag from pg_constraint inside this rolled-back transaction
	// so both current (0006_content.up.sql) and future migrations are handled without broad CASCADE.
	if _, err := tx.Exec(ctx, `
		DO $$
		DECLARE
			r record;
		BEGIN
			FOR r IN
				SELECT c.conrelid::regclass AS tbl, c.conname
				FROM pg_constraint c
				WHERE c.contype = 'f'
				  AND c.confrelid IN ('item'::regclass, 'tag'::regclass)
				ORDER BY c.conrelid::regclass::text, c.conname
			LOOP
				EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
			END LOOP;
		END
		$$;
		ALTER TABLE item DROP CONSTRAINT IF EXISTS item_user_id_id_key;
		ALTER TABLE tag DROP CONSTRAINT IF EXISTS tag_user_id_id_key;
		DROP INDEX IF EXISTS
			item_user_recent,
			item_user_created,
			item_user_name_exact,
			item_user_name_alpha,
			tag_user_recent,
			tag_user_norm_uq,
			tag_user_norm;
	`); err != nil {
		t.Fatalf("DROP user-only btree indexes in tx: %v", err)
	}

	capDB := &capturingDBTX{inner: tx}
	q := gen.New(capDB)

	// 1. Prefix-only path (fuzzy = false) via real gen.Queries calls:
	//    Must use item_user_unaccent_prefix (and item_user_name_prefix) on item,
	//    and tag_user_unaccent_prefix (and tag_user_norm_prefix) on tag.
	qnPrefix := "duong"
	qPrefix := item.EscapeLikePrefix(qnPrefix)

	if _, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
		UserID:    u1,
		Qn:        qnPrefix,
		QPrefix:   qPrefix,
		Fuzzy:     false,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchItemsLexical(fuzzy=false): %v", err)
	}
	itemPrefixPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, itemPrefixPlan, "item", "item_user_unaccent_prefix", "name_unaccent ~>=~", "name_unaccent ~<~")
	assertPlanContainsResidualCond(t, itemPrefixPlan, "item", "name_unaccent ~~")

	if _, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
		UserID:    u1,
		Qn:        qnPrefix,
		QPrefix:   qPrefix,
		Fuzzy:     false,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchTagsLexical(fuzzy=false): %v", err)
	}
	tagPrefixPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, tagPrefixPlan, "tag", "tag_user_unaccent_prefix", "tag_unaccent ~>=~", "tag_unaccent ~<~")
	assertPlanContainsResidualCond(t, tagPrefixPlan, "tag", "tag_unaccent ~~")

	if _, err := q.SearchItemsLexicalPage(ctx, gen.SearchItemsLexicalPageParams{
		UserID:    u1,
		Qn:        qnPrefix,
		QPrefix:   qPrefix,
		Fuzzy:     false,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchItemsLexicalPage(fuzzy=false): %v", err)
	}
	itemPagePrefixPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, itemPagePrefixPlan, "item", "item_user_unaccent_prefix", "name_unaccent ~>=~", "name_unaccent ~<~")
	assertPlanContainsResidualCond(t, itemPagePrefixPlan, "item", "name_unaccent ~~")

	if _, err := q.SearchTagsLexicalPage(ctx, gen.SearchTagsLexicalPageParams{
		UserID:    u1,
		Qn:        qnPrefix,
		QPrefix:   qPrefix,
		Fuzzy:     false,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchTagsLexicalPage(fuzzy=false): %v", err)
	}
	tagPagePrefixPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, tagPagePrefixPlan, "tag", "tag_user_unaccent_prefix", "tag_unaccent ~>=~", "tag_unaccent ~<~")
	assertPlanContainsResidualCond(t, tagPagePrefixPlan, "tag", "tag_unaccent ~~")

	// 2. Selective fuzzy path (fuzzy = true) via real gen.Queries calls (`pasword` -> `password`):
	//    Must specifically use the per-user GIN trigram indexes `item_user_name_trgm` on item
	//    and `tag_user_tag_trgm` on tag (with trigram index condition `%` or `<%`), NOT just prefix indexes.
	//    Insert a large synthetic batch for u1 whose names share no trigrams with `pasword` and refresh
	//    planner statistics so a full-user btree bitmap scan + Filter is much more expensive than the
	//    BitmapOr(prefix btree, trigram GIN) plan.
	if _, err := tx.Exec(ctx, `
		INSERT INTO item (user_id, name, name_normalized)
		SELECT $1, 'zq' || to_hex(g), 'zq' || to_hex(g)
		FROM generate_series(1, 20000) AS g
	`, u1); err != nil {
		t.Fatalf("bulk insert items for fuzzy plan selectivity: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tag (user_id, display, normalized)
		SELECT $1, 'zq' || to_hex(g), 'zq' || to_hex(g)
		FROM generate_series(1, 5000) AS g
	`, u1); err != nil {
		t.Fatalf("bulk insert tags for fuzzy plan selectivity: %v", err)
	}
	if _, err := tx.Exec(ctx, `ANALYZE item; ANALYZE tag;`); err != nil {
		t.Fatalf("ANALYZE item; ANALYZE tag; after bulk insert in tx: %v", err)
	}
	qnFuzzy := "pasword"
	qFuzzyPrefix := item.EscapeLikePrefix(qnFuzzy)

	if _, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
		UserID:    u1,
		Qn:        qnFuzzy,
		QPrefix:   qFuzzyPrefix,
		Fuzzy:     true,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchItemsLexical(fuzzy=true): %v", err)
	}
	itemFuzzyPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, itemFuzzyPlan, "item", "item_user_name_trgm", "%")

	if _, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
		UserID:    u1,
		Qn:        qnFuzzy,
		QPrefix:   qFuzzyPrefix,
		Fuzzy:     true,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchTagsLexical(fuzzy=true): %v", err)
	}
	tagFuzzyPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, tagFuzzyPlan, "tag", "tag_user_tag_trgm", "%")

	// 3. Also verify the paged queries (SearchItemsLexicalPage, SearchTagsLexicalPage) use the trigram indexes.
	if _, err := q.SearchItemsLexicalPage(ctx, gen.SearchItemsLexicalPageParams{
		UserID:    u1,
		Qn:        qnFuzzy,
		QPrefix:   qFuzzyPrefix,
		Fuzzy:     true,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchItemsLexicalPage(fuzzy=true): %v", err)
	}
	itemPageFuzzyPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, itemPageFuzzyPlan, "item", "item_user_name_trgm", "%")

	if _, err := q.SearchTagsLexicalPage(ctx, gen.SearchTagsLexicalPageParams{
		UserID:    u1,
		Qn:        qnFuzzy,
		QPrefix:   qFuzzyPrefix,
		Fuzzy:     true,
		PageLimit: 10,
	}); err != nil {
		t.Fatalf("SearchTagsLexicalPage(fuzzy=true): %v", err)
	}
	tagPageFuzzyPlan := explainCapturedQuery(t, ctx, tx, capDB)
	assertPlanRequiresIndex(t, tagPageFuzzyPlan, "tag", "tag_user_tag_trgm", "%")
}

func assertPlanRequiresIndex(t *testing.T, planJSON string, tableName string, requiredIndex string, requiredCondSubstrs ...string) {
	t.Helper()
	var plans []map[string]any
	if err := json.Unmarshal([]byte(planJSON), &plans); err != nil {
		t.Fatalf("unmarshal EXPLAIN JSON: %v", err)
	}
	var indexNames []string
	var seqScansOnTable []string
	matchedIndexAndCond := false
	var walk func(node any)
	walk = func(node any) {
		switch v := node.(type) {
		case map[string]any:
			nodeType, _ := v["Node Type"].(string)
			relName, _ := v["Relation Name"].(string)
			idxName, _ := v["Index Name"].(string)
			idxCond, _ := v["Index Cond"].(string)
			if idxName != "" {
				indexNames = append(indexNames, idxName)
			}
			if idxName == requiredIndex {
				allPresent := len(requiredCondSubstrs) > 0
				for _, sub := range requiredCondSubstrs {
					if sub == "" || !strings.Contains(idxCond, sub) {
						allPresent = false
						break
					}
				}
				if allPresent {
					matchedIndexAndCond = true
				}
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
	if !matchedIndexAndCond {
		t.Fatalf("plan on %s did not use required index %q with Index Cond containing all of %q (used indexes=%v):\n%s",
			tableName, requiredIndex, requiredCondSubstrs, indexNames, planJSON)
	}
}

func assertPlanContainsResidualCond(t *testing.T, planJSON string, tableName string, requiredResidualSubstr string) {
	t.Helper()
	var plans []map[string]any
	if err := json.Unmarshal([]byte(planJSON), &plans); err != nil {
		t.Fatalf("unmarshal EXPLAIN JSON: %v", err)
	}
	matched := false
	var walk func(node any)
	walk = func(node any) {
		switch v := node.(type) {
		case map[string]any:
			for _, field := range []string{"Filter", "Recheck Cond", "Index Cond"} {
				if cond, ok := v[field].(string); ok && strings.Contains(cond, requiredResidualSubstr) {
					matched = true
				}
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
	if !matched {
		t.Fatalf("plan on %s did not contain residual condition %q in Filter/Recheck Cond/Index Cond:\n%s",
			tableName, requiredResidualSubstr, planJSON)
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
	t1Plus500us := t1.Add(500 * time.Microsecond)
	t1Plus100us := t1.Add(100 * time.Microsecond)
	t2 := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

	// RV-T2-BE-4: Seed items and tags for query `duongsat` (9 unique trigrams) with:
	//   - distinct non-integral rounded scores within the same tier across page boundaries:
	//     * Tier 3: 1.00 (9/9) -> 0.89 (8/9 = 0.888889)
	//     * Tier 2: 1.00 (9/9) -> 0.89 (8/9 = 0.888889)
	//     * Tier 1: 0.78 (7/9 = 0.777778) -> 0.67 (6/9 = 0.666667) -> 0.58 (7/12 = 0.583333) -> 0.56
	//   - two distinct raw scores that round to the SAME 2-decimal value 0.56:
	//     * `duong` (raw 5/9 = 0.555556 -> 0.56) with newer microsecond timestamp `t1Plus500us`
	//     * `duongxyzw-ngsat` (raw 9/16 = 0.562500 -> 0.56) with older microsecond timestamp `t1Plus100us`
	//     Because scores are rounded to 2 decimals before ordering, `duong` (0.56, t1+500µs) MUST rank
	//     BEFORE `duongxyzw-ngsat` (0.56, t1+100µs).
	//   - microsecond timestamp tie-breaks (`t1Plus500us` vs `t1Plus100us` vs `t1`) on page boundaries,
	//   - count tie-breaks (`count=9` vs `count=4`) and ascending UUID tie-breaks (`...0012` vs `...0013`).
	type keysetSeed struct {
		tagID     string
		itemID    string
		text      string
		count     int32
		lastUsed  time.Time
		wantTier  int32
		wantScore float64
	}

	seeds := []keysetSeed{
		// Tier 3 (exact prefix `duongsat...`):
		{"00000000-0033-4000-8000-000000000001", "00000000-0044-4000-8000-000000000001", "duongsat-alpha", 8, t1Plus500us, 3, 1.00},
		{"00000000-0033-4000-8000-000000000002", "00000000-0044-4000-8000-000000000002", "duongsat-beta", 8, t1Plus100us, 3, 1.00},
		{"00000000-0033-4000-8000-000000000003", "00000000-0044-4000-8000-000000000003", "duongsat", 10, t1, 3, 1.00},
		{"00000000-0033-4000-8000-000000000004", "00000000-0044-4000-8000-000000000004", "duongsatx", 9, t1Plus500us, 3, 0.89},
		// Tier 2 (folded prefix `đườngsắt...`):
		{"00000000-0033-4000-8000-000000000005", "00000000-0044-4000-8000-000000000005", "đườngsắt", 7, t1, 2, 1.00},
		{"00000000-0033-4000-8000-000000000006", "00000000-0044-4000-8000-000000000006", "đườngsắtx", 6, t1, 2, 0.89},
		// Tier 1 (fuzzy non-prefix with distinct non-integral scores + rounded-score tie-break):
		{"00000000-0033-4000-8000-000000000007", "00000000-0044-4000-8000-000000000007", "duongsa", 5, t2, 1, 0.78},
		{"00000000-0033-4000-8000-000000000008", "00000000-0044-4000-8000-000000000008", "duongs", 5, t2, 1, 0.67},
		{"00000000-0033-4000-8000-000000000009", "00000000-0044-4000-8000-000000000009", "duoxngsat", 5, t2, 1, 0.58},
		{"00000000-0033-4000-8000-000000000010", "00000000-0044-4000-8000-000000000010", "duong", 3, t1Plus500us, 1, 0.56},
		{"00000000-0033-4000-8000-000000000011", "00000000-0044-4000-8000-000000000011", "duongxyzw-ngsat", 9, t1Plus100us, 1, 0.56},
		{"00000000-0033-4000-8000-000000000012", "00000000-0044-4000-8000-000000000012", "duongxyzv-ngsat", 4, t1Plus100us, 1, 0.56},
		{"00000000-0033-4000-8000-000000000013", "00000000-0044-4000-8000-000000000013", "duongxyzu-ngsat", 4, t1Plus100us, 1, 0.56},
	}

	for _, s := range seeds {
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, uuid.MustParse(s.tagID), uid, s.text, s.text, s.count, s.lastUsed); err != nil {
			t.Fatalf("insert tag seed %s: %v", s.tagID, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, uuid.MustParse(s.itemID), uid, s.text, s.text, s.count, s.lastUsed); err != nil {
			t.Fatalf("insert item seed %s: %v", s.itemID, err)
		}
	}

	qn := "duongsat"
	qPrefix := item.EscapeLikePrefix(qn)

	withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
		// 1. Tags: verify independent expected order, tiers, non-integral rounded scores, and microsecond timestamps
		//    across page boundaries of size 2.
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
		if len(unpagedTags) != len(seeds) {
			t.Fatalf("unpaged tags len = %d, want %d", len(unpagedTags), len(seeds))
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

		if len(pagedTags) != len(seeds) {
			t.Fatalf("pagedTags len = %d, want %d", len(pagedTags), len(seeds))
		}
		for i, want := range seeds {
			wantID := uuid.MustParse(want.tagID)
			if unpagedTags[i].ID != wantID || unpagedTags[i].Tier != want.wantTier || unpagedTags[i].Score != want.wantScore {
				t.Fatalf("unpaged tag[%d] = (id=%s display=%q tier=%d score=%v), want (id=%s text=%q tier=%d score=%v)",
					i, unpagedTags[i].ID, unpagedTags[i].Display, unpagedTags[i].Tier, unpagedTags[i].Score,
					wantID, want.text, want.wantTier, want.wantScore)
			}
			if pagedTags[i].ID != wantID ||
				pagedTags[i].Tier != want.wantTier ||
				pagedTags[i].Score != want.wantScore ||
				!pagedTags[i].LastUsedAt.Time.Equal(want.lastUsed) {
				t.Fatalf("paged tag[%d] = (id=%s display=%q tier=%d score=%v lastUsed=%v), want (id=%s text=%q tier=%d score=%v lastUsed=%v)",
					i, pagedTags[i].ID, pagedTags[i].Display, pagedTags[i].Tier, pagedTags[i].Score, pagedTags[i].LastUsedAt.Time,
					wantID, want.text, want.wantTier, want.wantScore, want.lastUsed)
			}
		}

		// 2. Items: verify independent expected order, tiers, non-integral rounded scores, and microsecond timestamps
		//    across page boundaries of size 2.
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
		if len(unpagedItems) != len(seeds) {
			t.Fatalf("unpaged items len = %d, want %d", len(unpagedItems), len(seeds))
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

		if len(pagedItems) != len(seeds) {
			t.Fatalf("pagedItems len = %d, want %d", len(pagedItems), len(seeds))
		}
		for i, want := range seeds {
			wantID := uuid.MustParse(want.itemID)
			if unpagedItems[i].ID != wantID || unpagedItems[i].Tier != want.wantTier || unpagedItems[i].Score != want.wantScore {
				t.Fatalf("unpaged item[%d] = (id=%s name=%q tier=%d score=%v), want (id=%s text=%q tier=%d score=%v)",
					i, unpagedItems[i].ID, unpagedItems[i].Name, unpagedItems[i].Tier, unpagedItems[i].Score,
					wantID, want.text, want.wantTier, want.wantScore)
			}
			if pagedItems[i].ID != wantID ||
				pagedItems[i].Tier != want.wantTier ||
				pagedItems[i].Score != want.wantScore ||
				!pagedItems[i].LastUsedAt.Time.Equal(want.lastUsed) {
				t.Fatalf("paged item[%d] = (id=%s name=%q tier=%d score=%v lastUsed=%v), want (id=%s text=%q tier=%d score=%v lastUsed=%v)",
					i, pagedItems[i].ID, pagedItems[i].Name, pagedItems[i].Tier, pagedItems[i].Score, pagedItems[i].LastUsedAt.Time,
					wantID, want.text, want.wantTier, want.wantScore, want.lastUsed)
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

	// Re-apply MigrateUp to latest cleanly (advisor-dec-264: assert v < 8 so future migrations >= 0009 do not break this check).
	dbtest.MigrateUp(t, dsn)
	vLatest, dirtyLatest, err := db.Version(dsn)
	if err != nil || dirtyLatest || vLatest < 8 {
		t.Fatalf("after MigrateUp to latest: v=%d dirty=%v err=%v", vLatest, dirtyLatest, err)
	}
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
