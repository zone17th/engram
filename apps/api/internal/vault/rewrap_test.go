package vault_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

type spyMailer struct {
	mu    sync.Mutex
	err   error
	calls []mailCall
}

type mailCall struct {
	recipient string
	purpose   string
	link      string
}

func (m *spyMailer) Send(_ context.Context, recipient, purpose, link string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, mailCall{
		recipient: recipient,
		purpose:   purpose,
		link:      link,
	})
	return m.err
}

func (m *spyMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.calls)
}

func TestServiceRewrapRulesAuditNoticeAndMailFailureDoesNotRollback(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	_, obsMetrics := obs.NewRegistry()
	mailer := &spyMailer{}

	svc, err := vault.NewService(cfg, pool, clk, aud, notes, mailer, vault.MetricsFromObs(obsMetrics), nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	userUnverified, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "rewrap-unverified@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	pA := authctx.Principal{UserID: userUnverified.ID, SessionID: uuid.New()}

	// 1. Rewrap when vault is absent -> 404 vault_absent (precedence over 412).
	freshSalt0 := vault.EncodeBase64URL(seqBytes(16, 0x99))
	_, err = svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + freshSalt0 + `"}`),
		VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x99),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: "vk:AAECAwQFBgcICQoLDA0ODw", Version: 1},
		IP:                   "127.0.0.1",
		UA:                   "rewrap-service-test",
	})
	if !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("Rewrap on absent vault = %v, want ErrVaultAbsent", err)
	}

	// Create vault for userUnverified (version = 1, ops = 3, mem = 64 MiB).
	createIn := makeValidCreateInput(t, 0x10)
	created, err := svc.Create(ctx, pA, createIn)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Insert a passkey row to verify passkeys and recovery keys remain untouched after rewrap.
	pkRow, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  userUnverified.ID,
		CredID:  seqBytes(32, 0xA1),
		Pubkey:  seqBytes(32, 0xA2),
		PrfSalt: seqBytes(32, 0xA3),
		VkWrap:  seqBytes(vault.VKWrapBytes, 0x01),
		Name:    "Service Test Passkey",
	})
	if err != nil {
		t.Fatalf("InsertPasskey: %v", err)
	}

	rkRowsBefore, err := pool.Query(ctx, `SELECT id, slot, lookup_hash, wrap FROM vault_recovery_key WHERE vault_id = $1 ORDER BY slot ASC`, userUnverified.ID)
	if err != nil {
		t.Fatalf("query RKs before: %v", err)
	}
	type rkSnap struct {
		id         uuid.UUID
		slot       int32
		lookupHash string
		wrap       string
	}
	var snapBefore []rkSnap
	for rkRowsBefore.Next() {
		var id uuid.UUID
		var slot int32
		var lh, wr []byte
		if err := rkRowsBefore.Scan(&id, &slot, &lh, &wr); err != nil {
			t.Fatal(err)
		}
		snapBefore = append(snapBefore, rkSnap{
			id:         id,
			slot:       slot,
			lookupHash: vault.EncodeBase64URL(lh),
			wrap:       vault.EncodeBase64URL(wr),
		})
	}
	rkRowsBefore.Close()

	// 2. Old version or wrong vault_key_id -> 412 version_mismatch with CurrentVersion=1.
	_, err = svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + freshSalt0 + `"}`),
		VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x22),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 99},
	})
	ve, ok := vault.AsError(err)
	if !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 1 {
		t.Fatalf("Rewrap stale version = %v (%+v), want 412 version_mismatch(current=1)", err, ve)
	}

	// 3. Reused salt -> 400 vault_kdf_invalid.
	_, err = svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               createIn.KDFRaw,
		VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x22),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("Rewrap reused salt = %v, want ErrVaultKDFInvalid", err)
	}

	// 4. Invalid wrap -> 400 vault_wrap_invalid.
	_, err = svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + freshSalt0 + `"}`),
		VaultKeyWrappedByKEK: vault.EncodeBase64URL(seqBytes(40, 0x01)),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrVaultWrapInvalid) {
		t.Fatalf("Rewrap invalid wrap = %v, want ErrVaultWrapInvalid", err)
	}

	// 5. Valid rewrap raising ops=4, mem=128 MiB for unverified user:
	// commits version=2, creates in-app notice even without verified email, and does not call mailer.
	salt2 := vault.EncodeBase64URL(seqBytes(16, 0x31))
	wrap2 := makeValidWrapB64U(t, vault.WrapKindKEK, 0x31)
	kdf2 := json.RawMessage(`{"alg":"argon2id13","ops":4,"mem":134217728,"parallelism":1,"salt":"` + salt2 + `"}`)
	res2, err := svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               kdf2,
		VaultKeyWrappedByKEK: wrap2,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
		IP:                   "127.0.0.1",
		UA:                   "rewrap-service-test",
	})
	if err != nil {
		t.Fatalf("Rewrap(v1->v2): %v", err)
	}
	if res2.Version != 2 {
		t.Fatalf("res2.Version = %d, want 2", res2.Version)
	}
	if mailer.count() != 0 {
		t.Fatalf("unverified user should not trigger mail.Send, got %d calls", mailer.count())
	}

	var noticeCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, userUnverified.ID).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("user_notification count for unverified user = %d, want 1", noticeCount)
	}

	// 6. Now current KDF has ops=4, mem=128 MiB. Attempting to downgrade ops=3 or mem=64 MiB -> ErrVaultKDFInvalid.
	salt3 := vault.EncodeBase64URL(seqBytes(16, 0x41))
	downgradedKDF := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt3 + `"}`)
	_, err = svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               downgradedKDF,
		VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x41),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 2},
	})
	if !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("Rewrap with lower KDF than current = %v, want ErrVaultKDFInvalid", err)
	}

	// 7. Mark user email verified, configure mailer to return an error, and rewrap (v2->v3):
	// failing mail adapter must NOT roll back the committed rewrap.
	if _, err := pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, userUnverified.ID); err != nil {
		t.Fatal(err)
	}
	mailer.err = errors.New("simulated SMTP transport failure")

	wrap3 := makeValidWrapB64U(t, vault.WrapKindKEK, 0x51)
	kdf3 := json.RawMessage(`{"alg":"argon2id13","ops":4,"mem":134217728,"parallelism":1,"salt":"` + salt3 + `"}`)
	res3, err := svc.Rewrap(ctx, pA, vault.RewrapInput{
		KDFRaw:               kdf3,
		VaultKeyWrappedByKEK: wrap3,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 2},
		IP:                   "127.0.0.1",
		UA:                   "rewrap-service-test",
	})
	if err != nil {
		t.Fatalf("Rewrap(v2->v3) with failing mailer returned error: %v", err)
	}
	if res3.Version != 3 {
		t.Fatalf("res3.Version = %d, want 3", res3.Version)
	}
	if mailer.count() != 1 {
		t.Fatalf("mailer.count() = %d, want 1", mailer.count())
	}

	// Verify vault state, RK rows, and passkeys are intact after both rewraps.
	stateAfter, err := svc.Get(ctx, userUnverified.ID)
	if err != nil {
		t.Fatalf("Get after rewrap: %v", err)
	}
	if stateAfter.VaultKeyID != created.VaultKeyID || stateAfter.Version != 3 ||
		stateAfter.VaultKeyWrappedByKEK != wrap3 || stateAfter.KDF.Salt != salt3 ||
		stateAfter.KDF.Ops != 4 || stateAfter.KDF.Mem != 134217728 {
		t.Fatalf("stateAfter = %+v", stateAfter)
	}
	if len(stateAfter.Passkeys) != 1 || stateAfter.Passkeys[0].ID != pkRow.ID {
		t.Fatalf("passkeys changed after rewrap: %+v", stateAfter.Passkeys)
	}

	rkRowsAfter, err := pool.Query(ctx, `SELECT id, slot, lookup_hash, wrap FROM vault_recovery_key WHERE vault_id = $1 ORDER BY slot ASC`, userUnverified.ID)
	if err != nil {
		t.Fatal(err)
	}
	var snapAfter []rkSnap
	for rkRowsAfter.Next() {
		var id uuid.UUID
		var slot int32
		var lh, wr []byte
		if err := rkRowsAfter.Scan(&id, &slot, &lh, &wr); err != nil {
			t.Fatal(err)
		}
		snapAfter = append(snapAfter, rkSnap{
			id:         id,
			slot:       slot,
			lookupHash: vault.EncodeBase64URL(lh),
			wrap:       vault.EncodeBase64URL(wr),
		})
	}
	rkRowsAfter.Close()
	if len(snapAfter) != len(snapBefore) {
		t.Fatalf("RK count changed: %d vs %d", len(snapAfter), len(snapBefore))
	}
	for i := range snapBefore {
		if snapAfter[i] != snapBefore[i] {
			t.Fatalf("RK row %d changed: got %+v, want %+v", i, snapAfter[i], snapBefore[i])
		}
	}

	// Ensure logs never leaked wraps or salts.
	logs := logBuf.String()
	for _, secret := range []string{wrap2, wrap3, salt2, salt3} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs leaked %q: %s", secret, logs)
		}
	}
}
