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

// TestSecurityNoticeWorkerContextQueryFailureReturnsErrorForRetry covers AU3-BE1-3:
// if GetNotificationForMail succeeds (e.g. a notification row exists) but
// GetNotificationMailContext fails (or encounters a transient DB error / missing joined row),
// Work must return the error so River retries rather than silently downgrading to a generic
// "security" mail with empty detail.
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

	// Corrupt the JSONB meta column into an invalid Meta shape (e.g. JSON array instead of object)
	// or drop the joined user lookup in a transaction so GetNotificationForMail succeeds while
	// context extraction fails, verifying Work returns an error and sends 0 generic emails.
	if _, err := pool.Exec(ctx, `UPDATE user_notification SET meta = '["corrupt"]'::jsonb WHERE id = $1`, notifID); err != nil {
		t.Fatalf("corrupt meta: %v", err)
	}

	sinkDir := t.TempDir()
	sink, err := auth.NewSinkMailer(sinkDir)
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	w := worker.NewSecurityNoticeWorker(pool, sink, silentLogger())
	err = w.Work(ctx, &river.Job[notification.SecurityNoticeArgs]{
		Args: notification.SecurityNoticeArgs{NotificationID: notifID},
	})
	if err == nil {
		t.Fatal("expected SecurityNoticeWorker.Work to return error when notification context cannot be decoded")
	}
	secMails, _ := sink.EntriesFor(email, "security")
	if len(secMails) != 0 {
		t.Fatalf("must not silently downgrade to generic security mail on context error, got %d", len(secMails))
	}
}
