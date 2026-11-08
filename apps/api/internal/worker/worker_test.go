package worker_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/export"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// Worker phải Start/Stop gọn: P01 chỉ cần lifecycle, chưa cần job thật.
func TestClientStartsAndStops(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 30*time.Second)
	defer stopCancel()
	if err := client.Stop(stopCtx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

func TestNoopJobRunsToCompletion(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, worker.NoopArgs{}, nil); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	select {
	case ev := <-subscribeCh:
		if ev.Job.Kind != "noop" {
			t.Errorf("kind = %q, muốn noop", ev.Job.Kind)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("job noop không hoàn thành trong 20s")
	}
}

// TestWorkerRunDeliversSecurityNoticeMailWithDefaultDevelopmentSink covers BE2-1 / BE2-4 (advisor-dec-024):
// when APP_ENV=development and AUTH_MAIL_SINK_DIR is empty, actual worker.Run registers
// SecurityNoticeWorker using cfg.EffectiveMailSinkDir() (.data/mail-sink) and delivers
// queued security_notice_mail jobs without failing as an unhandled job kind.
func TestWorkerRunDeliversSecurityNoticeMailWithDefaultDevelopmentSink(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MAIL_SINK_DIR", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.ShutdownTimeout = 5 * time.Second
	wantSink := filepath.Join(".data", "mail-sink")
	if got := cfg.EffectiveMailSinkDir(); got != wantSink {
		t.Fatalf("EffectiveMailSinkDir() = %q, want %q", got, wantSink)
	}

	email := "worker-default-sink@example.com"
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, email_verified_at, locale) VALUES ($1, now(), 'en') RETURNING id`,
		email,
	).Scan(&userID); err != nil {
		t.Fatalf("insert verified user: %v", err)
	}

	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	runDone := make(chan error, 1)
	go func() {
		defer close(runDone)
		runDone <- worker.Run(runCtx, cfg, silentLogger())
	}()
	var stopOnce sync.Once
	var runErr error
	var stopTimedOut bool
	stopWorker := func() (error, bool) {
		stopOnce.Do(func() {
			cancelRun()
			select {
			case runErr = <-runDone:
			case <-time.After(10 * time.Second):
				stopTimedOut = true
			}
		})
		return runErr, stopTimedOut
	}
	defer func() {
		_, _ = stopWorker()
	}()
	time.Sleep(150 * time.Millisecond)

	notes := notification.NewStore(pool, riverInsert)
	if err := notes.NotifySecurity(ctx, nil, secevent.Notice{
		UserID:       userID,
		Kind:         secevent.NoticeSecurity,
		Meta:         secevent.Meta{},
		EmailTargets: []string{email},
	}); err != nil {
		t.Fatalf("NotifySecurity: %v", err)
	}
	if err := notes.NotifySecurity(ctx, nil, secevent.Notice{
		UserID: userID,
		Kind:   secevent.NoticeSecurity,
		Meta: secevent.Meta{
			Event:             secevent.EventPasswordReset,
			UnlinkedProviders: []string{secevent.ProviderGoogle},
		},
		EmailTargets: []string{email},
	}); err != nil {
		t.Fatalf("NotifySecurity password_reset: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		var completedCount int
		var jobErrors string
		err := pool.QueryRow(ctx,
			`SELECT count(*) FILTER (WHERE state = 'completed'), coalesce(string_agg(errors::text, ';'), '') FROM river_job WHERE kind = 'security_notice_mail'`,
		).Scan(&completedCount, &jobErrors)
		if err == nil {
			if strings.Contains(jobErrors, "not registered") || strings.Contains(jobErrors, "Unhandled job kind") {
				t.Fatalf("security_notice_mail failed with unhandled job kind under worker.Run: errors=%s", jobErrors)
			}
			if completedCount == 2 {
				break
			}
		}
		state := fmt.Sprintf("completed=%d", completedCount)
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for security_notice_mail job to complete under worker.Run (last state=%q errors=%s)", state, jobErrors)
		}
		time.Sleep(25 * time.Millisecond)
	}

	if err, timedOut := stopWorker(); timedOut {
		t.Fatal("timed out waiting for worker.Run to stop")
	} else if err != nil {
		t.Fatalf("worker.Run returned error: %v", err)
	}

	sink, err := auth.NewSinkMailer(wantSink)
	if err != nil {
		t.Fatalf("NewSinkMailer(%q): %v", wantSink, err)
	}
	entries, err := sink.EntriesFor(email, "security")
	if err != nil {
		t.Fatalf("EntriesFor: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("delivered security emails in default sink %q = %d, want 1", wantSink, len(entries))
	}
	resetEntries, err := sink.EntriesFor(email, auth.PurposePasswordResetNotice)
	if err != nil {
		t.Fatalf("EntriesFor password_reset_notice: %v", err)
	}
	if len(resetEntries) != 1 || !strings.Contains(resetEntries[0].Link, "Google") {
		t.Fatalf("delivered password_reset_notice emails = %+v, want 1 mentioning Google", resetEntries)
	}
}

// TestSecurityNoticeWorkerContextQueryFailureReturnsErrorForRetry covers AU3-BE1-3 / AU3-BE2-4:
// if GetNotificationForMail succeeds (a notification row exists) but GetNotificationMailContext
// fails on the context SELECT itself (or on JSON decoding), Work must return the error so River
// retries rather than silently downgrading to a generic "security" mail with empty detail;
// once the fault is repaired, retrying Work delivers the localized password_reset_notice email.
func TestSecurityNoticeWorkerContextQueryFailureReturnsErrorForRetry(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	email := "notice-err-retry@example.com"
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, email_verified_at, locale) VALUES ($1, now(), 'vi') RETURNING id`,
		email,
	).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	var notifID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_notification (user_id, kind, meta, email_targets) VALUES ($1, 'security', $2, $3) RETURNING id`,
		userID,
		[]byte(`{"event":"auth.password.reset","unlinked_providers":["google"]}`),
		[]string{email},
	).Scan(&notifID); err != nil {
		t.Fatalf("insert notification: %v", err)
	}

	sinkDir := t.TempDir()
	sink, err := auth.NewSinkMailer(sinkDir)
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	w := worker.NewSecurityNoticeWorker(pool, sink, silentLogger())
	job := &river.Job[notification.SecurityNoticeArgs]{
		Args: notification.SecurityNoticeArgs{NotificationID: notifID},
	}

	// Case 1 (AU3-BE2-4): Force GetNotificationMailContext's SQL SELECT itself to fail while
	// GetNotificationForMail (which only selects id, user_id, kind, email_targets) succeeds,
	// by temporarily renaming user_notification.meta.
	var metaRenamed bool
	if _, err := pool.Exec(ctx, `ALTER TABLE user_notification RENAME COLUMN meta TO meta_hidden`); err != nil {
		t.Fatalf("rename meta column: %v", err)
	}
	metaRenamed = true
	t.Cleanup(func() {
		if metaRenamed {
			_, _ = pool.Exec(ctx, `ALTER TABLE user_notification RENAME COLUMN meta_hidden TO meta`)
		}
	})

	if err := w.Work(ctx, job); err == nil {
		t.Fatal("expected SecurityNoticeWorker.Work to return error when GetNotificationMailContext SELECT fails")
	}
	if secMails, _ := sink.EntriesFor(email, "security"); len(secMails) != 0 {
		t.Fatalf("must not silently downgrade to generic security mail on context query failure, got %d", len(secMails))
	}
	if resetMails, _ := sink.EntriesFor(email, auth.PurposePasswordResetNotice); len(resetMails) != 0 {
		t.Fatalf("expected 0 reset notice mails while context query fails, got %d", len(resetMails))
	}

	// Repair the schema fault and verify River retry succeeds and delivers the localized VI reset notice naming Google.
	if _, err := pool.Exec(ctx, `ALTER TABLE user_notification RENAME COLUMN meta_hidden TO meta`); err != nil {
		t.Fatalf("restore meta column: %v", err)
	}
	metaRenamed = false

	if err := w.Work(ctx, job); err != nil {
		t.Fatalf("expected SecurityNoticeWorker.Work retry after schema repair to succeed, got: %v", err)
	}
	if secMails, _ := sink.EntriesFor(email, "security"); len(secMails) != 0 {
		t.Fatalf("expected 0 generic security mails after repaired retry, got %d", len(secMails))
	}
	resetMails, err := sink.EntriesFor(email, auth.PurposePasswordResetNotice)
	if err != nil || len(resetMails) != 1 {
		t.Fatalf("expected 1 password_reset_notice mail after repaired retry, got %d err=%v", len(resetMails), err)
	}
	if !strings.Contains(resetMails[0].Link, "Mật khẩu đăng nhập engram của bạn vừa được đặt lại") || !strings.Contains(resetMails[0].Link, "Google") {
		t.Fatalf("unexpected localized reset notice detail after retry: %q", resetMails[0].Link)
	}

	// Case 2: Corrupt JSONB meta shape so GetNotificationMailContext SQL succeeds but json.Unmarshal fails.
	var notifID2 int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_notification (user_id, kind, meta, email_targets) VALUES ($1, 'security', '["corrupt"]'::jsonb, $2) RETURNING id`,
		userID,
		[]string{email},
	).Scan(&notifID2); err != nil {
		t.Fatalf("insert corrupt notification: %v", err)
	}
	if err := w.Work(ctx, &river.Job[notification.SecurityNoticeArgs]{
		Args: notification.SecurityNoticeArgs{NotificationID: notifID2},
	}); err == nil {
		t.Fatal("expected SecurityNoticeWorker.Work to return error when notification meta JSON cannot be decoded")
	}
	if secMails, _ := sink.EntriesFor(email, "security"); len(secMails) != 0 {
		t.Fatalf("must not silently downgrade to generic security mail on JSON decode error, got %d", len(secMails))
	}
}

// TestExportWorkersRegistered verifies that worker.NewWithMail registers
// export_encrypted, export_file_cleanup, and export_prune without panicking or
// rejecting River insert/start.
func TestExportWorkersRegistered(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	client, err := worker.NewWithMail(pool, silentLogger(), 90, nil, worker.Deps{
		Export: &worker.ExportDeps{
			StorageDir: t.TempDir(),
			Secret:     config.NewSecretBytes([]byte(config.DevExportAtRestSecret)),
		},
	})
	if err != nil {
		t.Fatalf("NewWithMail: %v", err)
	}
	if _, err := client.Insert(ctx, exportcleanup.Args{CleanupID: uuid.New()}, nil); err != nil {
		t.Fatalf("Insert exportcleanup.Args: %v", err)
	}
	if _, err := client.Insert(ctx, export.ExportPruneArgs{}, nil); err != nil {
		t.Fatalf("Insert ExportPruneArgs: %v", err)
	}
	// r1 R1-14: security_notice_mail must be registered even with a nil mailer,
	// otherwise every verified-owner export finalize rolls back on insert.
	if _, err := client.Insert(ctx, notification.SecurityNoticeArgs{NotificationID: 1}, nil); err != nil {
		t.Fatalf("Insert SecurityNoticeArgs with nil mailer: %v", err)
	}
}

// TestExportReadyWithDisabledMailRealRiver is the dec-039 R1-14 runtime proof:
// a real River client built by worker.NewWithMail with a nil (disabled) mailer
// runs a verified owner's export end to end. The export reaches ready exactly
// once, the download opens, exactly one success audit and one in-app security
// notice commit, and the security_notice_mail job completes terminally on the
// first attempt (no retry, no rollback of finalization).
func TestExportReadyWithDisabledMailRealRiver(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	storage := t.TempDir()
	secret := config.NewSecretBytes([]byte(config.DevExportAtRestSecret))
	client, err := worker.NewWithMail(pool, silentLogger(), 90, nil, worker.Deps{
		Export: &worker.ExportDeps{StorageDir: storage, Secret: secret},
	})
	if err != nil {
		t.Fatalf("NewWithMail: %v", err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 30*time.Second)
		defer c()
		_ = client.Stop(stopCtx)
	})

	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, email_verified_at) VALUES ($1, $2, now())`,
		userID, "export-nomail-"+userID.String()+"@example.com"); err != nil {
		t.Fatalf("insert verified user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
		VALUES ($1, 1, '{"alg":"argon2id"}', 'vk:AAECAwQFBgcICQoLDA0ODw', $2, $3, $3, $4)
	`, userID, make([]byte, 73), make([]byte, 32), make([]byte, 105)); err != nil {
		t.Fatalf("insert vault: %v", err)
	}

	cfg := &config.Config{
		Env:                "development",
		ExportStorageDir:   storage,
		ExportAtRestSecret: secret,
	}
	svc, err := export.NewService(cfg, pool, client, nil, nil)
	if err != nil {
		t.Fatalf("export.NewService: %v", err)
	}
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	waitFor := func(what, query string, args ...any) {
		t.Helper()
		for {
			var ok bool
			if err := pool.QueryRow(ctx, query, args...).Scan(&ok); err != nil {
				t.Fatalf("%s: %v", what, err)
			}
			if ok {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("timed out waiting for %s", what)
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	waitFor("export ready", `SELECT status = 'ready' FROM export_job WHERE id = $1`, job.ID)
	waitFor("security_notice_mail settled",
		`SELECT count(*) = 1 AND bool_and(state IN ('completed','discarded','cancelled')) FROM river_job WHERE kind = 'security_notice_mail'`)

	var noticeState string
	var noticeAttempt int
	if err := pool.QueryRow(ctx,
		`SELECT state, attempt FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&noticeState, &noticeAttempt); err != nil {
		t.Fatal(err)
	}
	if noticeState != "completed" || noticeAttempt != 1 {
		t.Fatalf("security_notice_mail state=%s attempt=%d, want completed on attempt 1 (disabled delivery is terminal)", noticeState, noticeAttempt)
	}
	var exportState string
	var exportAttempt int
	if err := pool.QueryRow(ctx,
		`SELECT state, attempt FROM river_job WHERE kind = 'export_encrypted'`).Scan(&exportState, &exportAttempt); err != nil {
		t.Fatal(err)
	}
	if exportState != "completed" || exportAttempt != 1 {
		t.Fatalf("export_encrypted state=%s attempt=%d, want completed once", exportState, exportAttempt)
	}
	var audits, notices int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND result = $3`,
		userID, secevent.EventExportEncrypted, secevent.ResultSuccess).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, userID).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	if audits != 1 || notices != 1 {
		t.Fatalf("audits=%d notices=%d, want exactly 1 each", audits, notices)
	}
	dl, err := svc.OpenDownload(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("OpenDownload after ready: %v", err)
	}
	b, err := io.ReadAll(dl)
	_ = dl.Close()
	if err != nil || !strings.HasPrefix(string(b), `{"format":`) {
		t.Fatalf("download body: err=%v prefix=%q", err, string(b[:min(len(b), 16)]))
	}
}
