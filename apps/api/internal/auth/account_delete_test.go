package auth_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// userOwnedTables are every table holding rows of one user (plan P06 mục
// 2.9.3e); vector tables are counted per generation separately.
var userOwnedTables = []string{
	"auth_identity", "session", "email_verification", "user_notification", "vault",
	"idempotency_key", "rate_event", "item", "tag", "entry", "export_job",
}

// exportEncryptedArgs mirrors the export_encrypted payload shape (user_id in
// args) so the test does not depend on the exportbe worker package.
type exportEncryptedArgs struct {
	JobID  string `json:"job_id"`
	UserID string `json:"user_id"`
}

func (exportEncryptedArgs) Kind() string { return "export_encrypted" }

func delCfg() *config.Config {
	return &config.Config{
		AppOrigin:        "http://localhost:3000",
		AuthJWTSecret:    bytes32(1),
		AuthCSRFSecret:   bytes32(2),
		AuthReauthSecret: bytes32(3),
		AuthIPPepper:     bytes32(4),
		AuthEmailPepper:  bytes32(5),
	}
}

func delRiver(t *testing.T, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()
	c, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	return c
}

// delService builds the auth service; withRiver=false models a process that
// dies after commit and before the post-commit enqueue.
func delService(t *testing.T, pool *pgxpool.Pool, withRiver bool) *auth.Service {
	t.Helper()
	var rc *river.Client[pgx.Tx]
	if withRiver {
		rc = delRiver(t, pool)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, _, err := compose.NewAuth(delCfg(), pool, rc, clock.NewFixed(semFixedNow), mail, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	t.Cleanup(svc.Close)
	return svc
}

type delSeed struct {
	semUser
	email   string
	itemID  uuid.UUID
	tagID   uuid.UUID
	vaultID string
}

// delSeedUser creates a user with a session, a vault row, one item+tag+link,
// one entry, vectors in every given generation and user-scoped River jobs.
func delSeedUser(t *testing.T, pool *pgxpool.Pool, svc *auth.Service, rc *river.Client[pgx.Tx], email string, n int, gens ...generation.Generation) delSeed {
	t.Helper()
	ctx := context.Background()
	u := semNewUser(t, pool, svc, email, true)
	q := gen.New(pool)
	vkID := fmt.Sprintf("vk:AAECAwQFBgcICQoLDA0OD%d", n)
	if _, err := pool.Exec(ctx, `INSERT INTO vault (user_id, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
VALUES ($1, '{}'::jsonb, $2, '\x01', '\x02', '\x03', '\x04')`, u.id, vkID); err != nil {
		t.Fatalf("insert vault: %v", err)
	}
	semSeedTargets(t, pool, u.id, fmt.Sprintf("u%d", n), gens...)
	var itemID, tagID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM item WHERE user_id = $1`, u.id).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM tag WHERE user_id = $1`, u.id).Scan(&tagID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{UserID: u.id, ItemID: itemID, TagID: tagID}); err != nil {
		t.Fatalf("AssignItemTag: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO entry (id, user_id, item_id, type, envelope, ciphertext, plaintext_len_bucket) VALUES ($1, $2, $3, 'text', '{}'::jsonb, $4, 256)`, uuid.New(), u.id, itemID, make([]byte, 32)); err != nil {
		t.Fatalf("insert entry: %v", err)
	}
	if rc != nil {
		if _, err := rc.Insert(ctx, jobargs.ReembedUserArgs{UserID: u.id.String()}, nil); err != nil {
			t.Fatalf("insert reembed_user: %v", err)
		}
		res, err := rc.Insert(ctx, jobargs.EmbedItemArgs{GenerationID: 1, UserID: u.id.String(), TargetID: itemID.String()}, nil)
		if err != nil {
			t.Fatalf("insert embed_item: %v", err)
		}
		if _, err := pool.Exec(ctx, `UPDATE river_job SET state = 'completed', finalized_at = now() WHERE id = $1`, res.Job.ID); err != nil {
			t.Fatalf("complete embed_item: %v", err)
		}
	}
	return delSeed{semUser: u, email: email, itemID: itemID, tagID: tagID, vaultID: vkID}
}

func delCount(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func delUserRows(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) map[string]int {
	t.Helper()
	out := map[string]int{}
	for _, tbl := range userOwnedTables {
		out[tbl] = delCount(t, pool, `SELECT count(*) FROM `+tbl+` WHERE user_id = $1`, userID)
	}
	out["app_user"] = delCount(t, pool, `SELECT count(*) FROM app_user WHERE id = $1`, userID)
	out["item_tag"] = delCount(t, pool, `SELECT count(*) FROM item_tag WHERE user_id = $1`, userID)
	return out
}

// TestDeleteAccount contrasts DELETE /vault (reset keeps app_user, session,
// item, tag, item_tag) with DELETE /me (every row of the user and every vector
// in every generation is gone, the other user is untouched, the audit row has
// user_id NULL and meta {}, user-scoped River jobs are removed).
func TestDeleteAccount(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := delService(t, pool, true)
	rc := delRiver(t, pool)
	g1 := semSeedGeneration(t, pool, 1, generation.ProviderTEI, generation.StateActive, nil)
	g2 := semSeedGeneration(t, pool, 2, generation.ProviderOpenAICompat, generation.StatePending, nil)

	alice := delSeedUser(t, pool, svc, rc, "alice-del@example.com", 1, g1, g2)
	bob := delSeedUser(t, pool, svc, rc, "bob-reset@example.com", 2, g1, g2)
	carol := delSeedUser(t, pool, svc, rc, "carol-keep@example.com", 3, g1, g2)
	carolBefore := delUserRows(t, pool, carol.id)

	// DELETE /vault for bob: account, sessions and items stay.
	vsvc, _, err := compose.NewVault(delCfg(), pool, nil, clock.NewFixed(semFixedNow), nil, nil, nil, obs.NewLogger("error", "test"))
	if err != nil {
		t.Fatalf("compose.NewVault: %v", err)
	}
	if err := vsvc.Reset(ctx, bob.principal, vault.ResetInput{IfMatch: httpx.VaultIfMatch{VaultKeyID: bob.vaultID, Version: 1}}); err != nil {
		t.Fatalf("vault reset bob: %v", err)
	}
	bobRows := delUserRows(t, pool, bob.id)
	for _, kept := range []string{"app_user", "session", "item", "tag", "item_tag"} {
		if bobRows[kept] == 0 {
			t.Fatalf("DELETE /vault must keep %s, rows=%v", kept, bobRows)
		}
	}
	if bobRows["vault"] != 0 {
		t.Fatalf("DELETE /vault must delete vault, rows=%v", bobRows)
	}
	if semVectorCount(t, pool, g1, bob.id) == 0 {
		t.Fatal("DELETE /vault must keep vectors")
	}

	// Wrong confirm email: nothing changes.
	if err := svc.DeleteAccount(ctx, alice.principal, "bob-reset@example.com", "203.0.113.9", "ua"); !errors.Is(err, auth.ErrAccountDeleteConfirmInvalid) {
		t.Fatalf("wrong email = %v, want ErrAccountDeleteConfirmInvalid", err)
	}
	if delUserRows(t, pool, alice.id)["app_user"] != 1 {
		t.Fatal("wrong email must not delete")
	}

	// DELETE /me for alice.
	if err := svc.DeleteAccount(ctx, alice.principal, "  ALICE-DEL@example.com ", "203.0.113.9", "ua-test"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	for tbl, n := range delUserRows(t, pool, alice.id) {
		if n != 0 {
			t.Fatalf("DELETE /me left %d rows in %s", n, tbl)
		}
	}
	for _, g := range []generation.Generation{g1, g2} {
		if n := semVectorCount(t, pool, g, alice.id); n != 0 {
			t.Fatalf("DELETE /me left %d vectors in g%d", n, g.ID)
		}
	}
	if n := delCount(t, pool, `SELECT count(*) FROM river_job WHERE args->>'user_id' = $1`, alice.id.String()); n != 0 {
		t.Fatalf("user-scoped river jobs left = %d", n)
	}
	if n := delCount(t, pool, `SELECT count(*) FROM audit_log WHERE event = 'account.delete' AND user_id IS NULL AND meta = '{}'::jsonb AND actor = 'user' AND session_id = $1`, alice.principal.SessionID); n != 1 {
		t.Fatalf("account.delete audit rows = %d, want 1", n)
	}
	if n := delCount(t, pool, `SELECT count(*) FROM audit_log WHERE user_id = $1`, alice.id); n != 0 {
		t.Fatalf("audit rows still linked to alice = %d", n)
	}

	// Carol is untouched; bob's reset state is unchanged.
	carolAfter := delUserRows(t, pool, carol.id)
	for k, v := range carolBefore {
		if carolAfter[k] != v {
			t.Fatalf("other user %s changed: %d -> %d", k, v, carolAfter[k])
		}
	}
	if semVectorCount(t, pool, g1, carol.id) == 0 || semVectorCount(t, pool, g2, carol.id) == 0 {
		t.Fatal("other user's vectors must stay")
	}
	if n := delCount(t, pool, `SELECT count(*) FROM river_job WHERE args->>'user_id' = $1`, carol.id.String()); n != 2 {
		t.Fatalf("other user's river jobs = %d, want 2", n)
	}

	// A stale principal (session cascaded) cannot delete again.
	if err := svc.DeleteAccount(ctx, alice.principal, "alice-del@example.com", "", ""); err == nil {
		t.Fatal("second delete with a deleted session must fail")
	}
}

// delSeedExportJobs gives the user a running job (attempt .tmp), a ready job
// (.sabk.enc) and an expired job (terminal, no new cleanup row).
func delSeedExportJobs(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) (running, ready gen.ExportJob) {
	t.Helper()
	ctx := context.Background()
	scan := func(sql string, args ...any) gen.ExportJob {
		var j gen.ExportJob
		if err := pool.QueryRow(ctx, sql+` RETURNING id, attempt_id, file_name`, args...).Scan(&j.ID, &j.AttemptID, &j.FileName); err != nil {
			t.Fatalf("seed export_job: %v", err)
		}
		return j
	}
	running = scan(`INSERT INTO export_job (user_id, kind, status, attempt_id, lease_until, started_at)
VALUES ($1, 'encrypted', 'running', gen_random_uuid(), now() + interval '10 minutes', now())`, userID)
	readyID, attempt := uuid.New(), uuid.New()
	ready = scan(`INSERT INTO export_job (id, user_id, kind, status, attempt_id, file_name, size_bytes, completed_at, expires_at)
VALUES ($1, $2, 'encrypted', 'ready', $3, $4, 10, now(), now() + interval '24 hours')`,
		readyID, userID, attempt, fmt.Sprintf("%s.%s.sabk.enc", readyID, attempt))
	expID, expAttempt := uuid.New(), uuid.New()
	_ = scan(`INSERT INTO export_job (id, user_id, kind, status, attempt_id, file_name, size_bytes, completed_at, expires_at)
VALUES ($1, $2, 'encrypted', 'expired', $3, $4, 10, now() - interval '2 days', now() - interval '1 day')`,
		expID, userID, expAttempt, fmt.Sprintf("%s.%s.sabk.enc", expID, expAttempt))
	return running, ready
}

// TestDeleteAccountCancelsExportJobs: queued/running/ready export jobs of the
// user become cleanup rows (reason account_delete, attempt file names, no
// user_id) in the delete tx, the job rows are gone with the user, River
// export_file_cleanup jobs carry only the cleanup id, user_id-bearing
// export_encrypted jobs are removed, and another user's jobs stay.
func TestDeleteAccountCancelsExportJobs(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := delService(t, pool, true)
	rc := delRiver(t, pool)
	alice := delSeedUser(t, pool, svc, nil, "alice-exp@example.com", 1)
	bob := delSeedUser(t, pool, svc, nil, "bob-exp@example.com", 2)
	running, ready := delSeedExportJobs(t, pool, alice.id)
	if _, err := rc.Insert(ctx, exportEncryptedArgs{JobID: running.ID.String(), UserID: alice.id.String()}, nil); err != nil {
		t.Fatal(err)
	}
	bobRunning, _ := delSeedExportJobs(t, pool, bob.id)
	if _, err := rc.Insert(ctx, exportEncryptedArgs{JobID: bobRunning.ID.String(), UserID: bob.id.String()}, nil); err != nil {
		t.Fatal(err)
	}

	if err := svc.DeleteAccount(ctx, alice.principal, alice.email, "", ""); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	wantFiles := map[uuid.UUID]string{
		running.ID: fmt.Sprintf("%s.%s.tmp", running.ID, *running.AttemptID),
		ready.ID:   *ready.FileName,
	}
	rows, err := pool.Query(ctx, `SELECT id, job_id, file_name, attempt_id, reason, done_at IS NULL FROM export_file_cleanup ORDER BY created_at, id`)
	if err != nil {
		t.Fatal(err)
	}
	cleanupIDs := map[string]bool{}
	got := 0
	for rows.Next() {
		var id, jobID uuid.UUID
		var name, reason string
		var attempt *uuid.UUID
		var pending bool
		if err := rows.Scan(&id, &jobID, &name, &attempt, &reason, &pending); err != nil {
			t.Fatal(err)
		}
		want, ok := wantFiles[jobID]
		if !ok || name != want || reason != "account_delete" || !pending || attempt == nil {
			t.Fatalf("unexpected cleanup row job=%s name=%s reason=%s pending=%v", jobID, name, reason, pending)
		}
		cleanupIDs[id.String()] = true
		got++
	}
	rows.Close()
	if got != len(wantFiles) {
		t.Fatalf("cleanup rows = %d, want %d", got, len(wantFiles))
	}
	if n := delCount(t, pool, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'export_file_cleanup' AND column_name IN ('user_id', 'email')`); n != 0 {
		t.Fatal("export_file_cleanup must not carry user_id/email")
	}
	if n := delCount(t, pool, `SELECT count(*) FROM export_job WHERE user_id = $1`, alice.id); n != 0 {
		t.Fatalf("alice export_job rows = %d, want 0", n)
	}
	jrows, err := pool.Query(ctx, `SELECT args->>'cleanup_id', args - 'cleanup_id' = '{}'::jsonb FROM river_job WHERE kind = $1`, exportcleanup.Kind)
	if err != nil {
		t.Fatal(err)
	}
	jobs := 0
	for jrows.Next() {
		var cid string
		var onlyID bool
		if err := jrows.Scan(&cid, &onlyID); err != nil {
			t.Fatal(err)
		}
		if !cleanupIDs[cid] || !onlyID {
			t.Fatalf("export_file_cleanup job args cleanup_id=%s onlyID=%v", cid, onlyID)
		}
		jobs++
	}
	jrows.Close()
	if jobs != len(wantFiles) {
		t.Fatalf("export_file_cleanup jobs = %d, want %d", jobs, len(wantFiles))
	}
	if n := delCount(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'export_encrypted' AND args->>'user_id' = $1`, alice.id.String()); n != 0 {
		t.Fatalf("alice export_encrypted jobs = %d", n)
	}
	if n := delCount(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'export_encrypted' AND args->>'user_id' = $1`, bob.id.String()); n != 1 {
		t.Fatalf("bob export_encrypted jobs = %d, want 1", n)
	}
	if n := delCount(t, pool, `SELECT count(*) FROM export_job WHERE user_id = $1 AND status IN ('running', 'ready')`, bob.id); n != 2 {
		t.Fatalf("bob live export jobs = %d, want 2", n)
	}
}

// TestDeleteAccountCleanupRecordSurvives: the process dies after commit and
// before the River enqueue (service without a River client): the cleanup row
// is committed without done_at and the export_prune sweep query still lists
// it, so the file is unlinked later.
func TestDeleteAccountCleanupRecordSurvives(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := delService(t, pool, false)
	alice := delSeedUser(t, pool, svc, nil, "alice-crash@example.com", 1)
	_, ready := delSeedExportJobs(t, pool, alice.id)

	if err := svc.DeleteAccount(ctx, alice.principal, alice.email, "", ""); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if n := delCount(t, pool, `SELECT count(*) FROM river_job WHERE kind = $1`, exportcleanup.Kind); n != 0 {
		t.Fatalf("no enqueue expected after simulated crash, got %d", n)
	}
	pending, err := gen.New(pool).ListPendingCleanup(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range pending {
		if p.JobID == ready.ID && p.FileName == *ready.FileName && !p.DoneAt.Valid {
			found = true
		}
	}
	if !found || len(pending) != 2 {
		t.Fatalf("pending cleanup rows = %d (ready found=%v), want 2 incl. ready file", len(pending), found)
	}
}

// TestDeleteAccountByEmail is the service half of the admin CLI: same
// transaction, unknown email -> not found, audit actor admin.
func TestDeleteAccountByEmail(t *testing.T) {
	ctx := context.Background()
	pool := semNewPool(t)
	svc := delService(t, pool, true)
	alice := delSeedUser(t, pool, svc, nil, "alice-admin@example.com", 1)
	if _, err := svc.DeleteAccountByEmail(ctx, "nobody@example.com"); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("unknown email = %v, want ErrNotFound", err)
	}
	res, err := svc.DeleteAccountByEmail(ctx, " Alice-Admin@Example.com ")
	if err != nil {
		t.Fatalf("DeleteAccountByEmail: %v", err)
	}
	if res.UserID != alice.id || res.AuditID == 0 {
		t.Fatalf("result = %+v", res)
	}
	for tbl, n := range delUserRows(t, pool, alice.id) {
		if n != 0 {
			t.Fatalf("admin delete left %d rows in %s", n, tbl)
		}
	}
	if n := delCount(t, pool, `SELECT count(*) FROM audit_log WHERE id = $1 AND event = 'account.delete' AND user_id IS NULL AND actor = 'admin' AND meta = '{}'::jsonb`, res.AuditID); n != 1 {
		t.Fatalf("admin audit row = %d, want 1", n)
	}
	var _ authctx.Principal
}
