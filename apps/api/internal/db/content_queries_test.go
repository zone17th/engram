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

// contentMetadataOnlyQueries lists narrow, documented queries in the content SQL
// files that read no table at all (e.g. database clock watermark).
var contentMetadataOnlyQueries = map[string]string{
	// Plan §2.9 feed watermark: captures the database clock_timestamp() before
	// the first page of GET /entries/changes independently of any table or row.
	"ContentClockNow": "plan §2.9 feed watermark: SELECT clock_timestamp()::timestamptz (reads no table)",
}

type parsedSQLQuery struct {
	file string
	name string
	body string
}

var (
	queryHeaderRe      = regexp.MustCompile(`^--\s*name:\s*([A-Za-z0-9_]+)\s*:[a-z]+\s*$`)
	contentTableRe     = regexp.MustCompile(`(?i)\b(item|tag|item_tag|entry)\b`)
	anyTableClauseRe   = regexp.MustCompile(`(?i)\b(FROM|INTO|UPDATE|JOIN|TABLE)\b`)
	userIDArgRe        = regexp.MustCompile(`(?i)(sqlc\.arg\(\s*'user_id'\s*\)|\buser_id\b)`)
	userIDPredRe       = regexp.MustCompile(`(?i)(\buser_id\s*=|\bhashtext\s*\([^;]*user_id)`)
	insertValuesHeadRe = regexp.MustCompile(`(?is)^\s*INSERT\s+INTO\s+(?:item|tag|entry)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*(?:ON\s+CONFLICT\b.*|RETURNING\b.*)?;\s*$`)
)

func parseSQLQueryString(srcName, raw string) []parsedSQLQuery {
	lines := strings.Split(raw, "\n")
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
				file: srcName,
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

func parseSQLQueryFile(t *testing.T, relPath string) []parsedSQLQuery {
	t.Helper()
	raw, err := os.ReadFile(relPath)
	if err != nil {
		t.Fatalf("read %s: %v", relPath, err)
	}
	return parseSQLQueryString(filepath.Base(relPath), string(raw))
}

// splitTopLevelCSV splits a comma-separated SQL column or expression list at
// parentheses depth 0 (respecting single-quoted SQL literals).
func splitTopLevelCSV(s string) []string {
	var (
		parts   []string
		start   int
		depth   int
		inQuote bool
	)
	for i := range len(s) {
		ch := s[i]
		if ch == '\'' {
			inQuote = !inQuote
			continue
		}
		if inQuote {
			continue
		}
		switch ch {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(s[start:i]))
				start = i + 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(s[start:]))
	return parts
}

// insertBindsUserIDColumn reports whether body is an INSERT INTO item|tag|entry (...)
// VALUES (...) statement whose user_id target column is bound directly to sqlc.arg('user_id').
func insertBindsUserIDColumn(body string) bool {
	m := insertValuesHeadRe.FindStringSubmatch(body)
	if m == nil {
		return false
	}
	cols := splitTopLevelCSV(m[1])
	vals := splitTopLevelCSV(m[2])
	if len(cols) == 0 || len(cols) != len(vals) {
		return false
	}
	for i, col := range cols {
		if strings.EqualFold(strings.TrimSpace(col), "user_id") {
			val := strings.TrimSpace(vals[i])
			return strings.HasPrefix(val, "sqlc.arg('user_id')")
		}
	}
	return false
}

// checkContentQueryTenantScope validates a single parsed SQL query against the
// content tenant-scoping rules and returns a list of violation descriptions.
func checkContentQueryTenantScope(q parsedSQLQuery, seenAllowlist, seenMetadata map[string]bool) []string {
	var errs []string
	if q.body == "" {
		return []string{q.name + " (" + q.file + "): empty SQL body"}
	}

	if reason, allowed := contentTenantAllowlist[q.name]; allowed {
		if seenAllowlist != nil {
			seenAllowlist[q.name] = true
		}
		if strings.TrimSpace(reason) == "" {
			errs = append(errs, q.name+" ("+q.file+"): allowlist entry must document justification")
		}
		return errs
	}

	if reason, isMeta := contentMetadataOnlyQueries[q.name]; isMeta {
		if seenMetadata != nil {
			seenMetadata[q.name] = true
		}
		if strings.TrimSpace(reason) == "" {
			errs = append(errs, q.name+" ("+q.file+"): metadata-only exception must document justification")
		}
		if contentTableRe.MatchString(q.body) || anyTableClauseRe.MatchString(q.body) {
			errs = append(errs, q.name+" ("+q.file+"): metadata-only query must not reference any table\nSQL:\n"+q.body)
		}
		return errs
	}

	touchesContent := contentTableRe.MatchString(q.body)
	hasUserArg := strings.Contains(q.body, "sqlc.arg('user_id')")
	isTrimmedInsert := strings.HasPrefix(strings.ToUpper(strings.TrimSpace(q.body)), "INSERT")

	var hasTenantScope bool
	if isTrimmedInsert && insertValuesHeadRe.MatchString(q.body) {
		// INSERT ... VALUES (...) into a content table: must bind user_id target column to sqlc.arg('user_id').
		hasTenantScope = insertBindsUserIDColumn(q.body)
	} else {
		// SELECT / UPDATE / DELETE / INSERT ... SELECT / advisory lock: must have user_id predicate or hashtext(user_id).
		hasTenantScope = userIDPredRe.MatchString(q.body)
	}

	if !hasUserArg || !hasTenantScope {
		errs = append(errs, q.name+" ("+q.file+", touchesContent="+boolStr(touchesContent)+"): missing user_id parameter or tenant scope (hasUserArg="+boolStr(hasUserArg)+", hasTenantScope="+boolStr(hasTenantScope)+")\nSQL:\n"+q.body)
	}

	// Specifically if a query touches item_tag, it has no user_id column of its own
	// and MUST join item or tag on user_id.
	if regexp.MustCompile(`(?i)\bitem_tag\b`).MatchString(q.body) {
		if !regexp.MustCompile(`(?i)\b(item|tag)\b`).MatchString(q.body) || !userIDArgRe.MatchString(q.body) || !userIDPredRe.MatchString(q.body) {
			errs = append(errs, q.name+" ("+q.file+"): query touching item_tag must join item/tag and filter by user_id\nSQL:\n"+q.body)
		}
	}

	return errs
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestContentQueriesRequireUserID(t *testing.T) {
	files := []string{
		filepath.Join("queries", "item.sql"),
		filepath.Join("queries", "tag.sql"),
		filepath.Join("queries", "entry.sql"),
	}

	seenAllowlist := make(map[string]bool, len(contentTenantAllowlist))
	seenMetadata := make(map[string]bool, len(contentMetadataOnlyQueries))
	totalQueries := 0

	for _, f := range files {
		queries := parseSQLQueryFile(t, f)
		if len(queries) == 0 {
			t.Fatalf("%s: no sqlc queries found", f)
		}
		for _, q := range queries {
			totalQueries++
			for _, errMsg := range checkContentQueryTenantScope(q, seenAllowlist, seenMetadata) {
				t.Error(errMsg)
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
	for name := range contentMetadataOnlyQueries {
		if !seenMetadata[name] {
			t.Errorf("stale metadata-only entry %q does not match any query in item.sql, tag.sql, or entry.sql", name)
		}
	}

	// Negative self-tests against inline SQL strings: verify the scanner provably
	// rejects an INSERT that does not bind user_id, an INSERT that binds user_id
	// to the wrong column/value, and a SELECT/UPDATE/DELETE without a user_id predicate.
	negativeCases := []struct {
		desc string
		sql  string
	}{
		{
			desc: "INSERT without user_id column",
			sql: `-- name: BadInsertItemNoUserID :one
INSERT INTO item (id, name, name_normalized)
VALUES (gen_random_uuid(), sqlc.arg('name'), sqlc.arg('name_normalized'))
RETURNING *;`,
		},
		{
			desc: "INSERT with user_id column not bound to sqlc.arg('user_id')",
			sql: `-- name: BadInsertTagWrongUserIDBinding :one
INSERT INTO tag (user_id, display, normalized)
VALUES (gen_random_uuid(), sqlc.arg('display'), sqlc.arg('normalized'))
RETURNING *;`,
		},
		{
			desc: "SELECT without user_id predicate",
			sql: `-- name: BadSelectItemNoUserIDPredicate :one
SELECT * FROM item WHERE id = sqlc.arg('id') AND deleted_at IS NULL;`,
		},
		{
			desc: "SELECT mentioning user_id arg in projection but lacking WHERE user_id =",
			sql: `-- name: BadSelectEntryProjectionOnly :one
SELECT id, sqlc.arg('user_id')::uuid AS caller_id FROM entry WHERE id = sqlc.arg('id');`,
		},
		{
			desc: "DELETE on item_tag without joining item/tag on user_id",
			sql: `-- name: BadDeleteItemTagNoJoin :exec
DELETE FROM item_tag WHERE item_id = sqlc.arg('item_id') AND tag_id = sqlc.arg('tag_id');`,
		},
	}

	for _, tc := range negativeCases {
		parsed := parseSQLQueryString("inline_negative.sql", tc.sql)
		if len(parsed) != 1 {
			t.Fatalf("negative case %q: expected 1 parsed query, got %d", tc.desc, len(parsed))
		}
		errs := checkContentQueryTenantScope(parsed[0], nil, nil)
		if len(errs) == 0 {
			t.Errorf("negative self-test %q (%s): expected scanner to fail, but it passed", tc.desc, parsed[0].name)
		}
	}
}
