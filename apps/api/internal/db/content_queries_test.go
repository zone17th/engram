package db_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// contentTenantAllowlist lists the ONLY content queries that intentionally do not
// take a user_id parameter, with their justification.
var contentTenantAllowlist = map[string]string{
	// Purge discovery queries: only return distinct user_id values that have
	// expired soft-deleted rows so the purge worker can iterate per user and
	// acquire LockUserContent(user_id) before deleting.
	"ListUsersWithPurgeableItems":   "purge discovery: returns distinct user_id of expired items for per-user locked purge",
	"ListUsersWithPurgeableTags":    "purge discovery: returns distinct user_id of expired tags for per-user locked purge",
	"ListUsersWithPurgeableEntries": "purge discovery: returns distinct user_id of expired entries for per-user locked purge",
	// Global entry UUID conflict check: SPEC §8 & plan §2.6 require entry.id (client UUID)
	// to return 409 entry_id_conflict across all users (live or soft-deleted) without
	// leaking owner identity. Returns only a boolean.
	"EntryIDExistsGlobal": "global client-generated entry UUID existence check for 409 entry_id_conflict without leaking owner",
}

type parsedSQLQuery struct {
	file string
	name string
	body string
}

var (
	queryHeaderRe  = regexp.MustCompile(`^--\s*name:\s*([A-Za-z0-9_]+)\s*:[a-z]+\s*$`)
	contentTableRe = regexp.MustCompile(`(?i)\b(item|tag|item_tag|entry)\b`)
	userIDArgRe    = regexp.MustCompile(`(?i)(sqlc\.arg\(\s*'user_id'\s*\)|\buser_id\b)`)
	userIDPredRe   = regexp.MustCompile(`(?i)(\buser_id\s*=|\bhashtext\s*\([^;]*user_id)`)
)

func parseSQLQueryFile(t *testing.T, relPath string) []parsedSQLQuery {
	t.Helper()
	raw, err := os.ReadFile(relPath)
	if err != nil {
		t.Fatalf("read %s: %v", relPath, err)
	}
	lines := strings.Split(string(raw), "\n")
	var (
		queries []parsedSQLQuery
		cur     *parsedSQLQuery
		buf     strings.Builder
	)
	flush := func() {
		if cur != nil {
			cur.body = strings.TrimSpace(buf.String())
			queries = append(queries, *cur)
			cur = nil
			buf.Reset()
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := queryHeaderRe.FindStringSubmatch(trimmed); m != nil {
			flush()
			cur = &parsedSQLQuery{
				file: filepath.Base(relPath),
				name: m[1],
			}
			continue
		}
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		if cur != nil {
			buf.WriteString(line)
			buf.WriteByte('\n')
		}
	}
	flush()
	return queries
}

func TestContentQueriesRequireUserID(t *testing.T) {
	files := []string{
		filepath.Join("queries", "item.sql"),
		filepath.Join("queries", "tag.sql"),
		filepath.Join("queries", "entry.sql"),
	}

	seenAllowlist := make(map[string]bool, len(contentTenantAllowlist))
	totalQueries := 0

	for _, f := range files {
		queries := parseSQLQueryFile(t, f)
		if len(queries) == 0 {
			t.Fatalf("%s: no sqlc queries found", f)
		}
		for _, q := range queries {
			totalQueries++
			if q.body == "" {
				t.Errorf("%s (%s): empty SQL body", q.name, q.file)
				continue
			}

			if reason, allowed := contentTenantAllowlist[q.name]; allowed {
				seenAllowlist[q.name] = true
				if strings.TrimSpace(reason) == "" {
					t.Errorf("%s (%s): allowlist entry must document justification", q.name, q.file)
				}
				continue
			}

			// Every non-allowlisted query in item.sql, tag.sql, entry.sql (including
			// LockVaultKeyForShare, LockUserContent, and all queries touching item,
			// tag, item_tag, or entry) MUST bind sqlc.arg('user_id') and enforce a
			// user_id predicate or per-user advisory lock.
			touchesContent := contentTableRe.MatchString(q.body)
			hasUserArg := strings.Contains(q.body, "sqlc.arg('user_id')")
			hasUserPredicate := userIDPredRe.MatchString(q.body)

			if !hasUserArg || !hasUserPredicate {
				t.Errorf("%s (%s, touchesContent=%v): missing user_id parameter or predicate (hasUserArg=%v, hasUserPredicate=%v)\nSQL:\n%s",
					q.name, q.file, touchesContent, hasUserArg, hasUserPredicate, q.body)
			}

			// Specifically if a query touches item_tag, it has no user_id column of its own
			// and MUST join item or tag on user_id.
			if regexp.MustCompile(`(?i)\bitem_tag\b`).MatchString(q.body) {
				if !regexp.MustCompile(`(?i)\b(item|tag)\b`).MatchString(q.body) || !userIDArgRe.MatchString(q.body) {
					t.Errorf("%s (%s): query touching item_tag must join item/tag and filter by user_id\nSQL:\n%s",
						q.name, q.file, q.body)
				}
			}
		}
	}

	if totalQueries == 0 {
		t.Fatal("expected content queries to be parsed")
	}

	for name := range contentTenantAllowlist {
		if !seenAllowlist[name] {
			t.Errorf("stale allowlist entry %q does not match any query in item.sql, tag.sql, or entry.sql", name)
		}
	}
}
