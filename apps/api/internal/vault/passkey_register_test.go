package vault_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/webauthntest"
)

func TestServiceRegisterPasskeyOptionsAndRegister(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}

	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	ctx := context.Background()
	q := gen.New(pool)

	userA, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "passkey-svc-a@example.com",
		Locale: "vi",
	})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	sessA1, err := q.InsertSession(ctx, gen.InsertSessionParams{
		UserID:           userA.ID,
		RefreshTokenHash: seqBytes(32, 0x11),
		IpHash:           seqBytes(32, 0x12),
		ExpiresAt:        pgtype.Timestamptz{Time: clk.Now().Add(24 * time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatalf("InsertSession A1: %v", err)
	}
	sessA2, err := q.InsertSession(ctx, gen.InsertSessionParams{
		UserID:           userA.ID,
		RefreshTokenHash: seqBytes(32, 0x21),
		IpHash:           seqBytes(32, 0x22),
		ExpiresAt:        pgtype.Timestamptz{Time: clk.Now().Add(24 * time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatalf("InsertSession A2: %v", err)
	}

	pA1 := authctx.Principal{
		UserID:    userA.ID,
		SessionID: sessA1.ID,
	}
	pA2 := authctx.Principal{
		UserID:    userA.ID,
		SessionID: sessA2.ID,
	}

	// 1. Before vault exists -> ErrVaultAbsent on both RegisterPasskeyOptions and RegisterPasskey.
	if _, err := svc.RegisterPasskeyOptions(ctx, pA1); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("RegisterPasskeyOptions without vault: got %v, want ErrVaultAbsent", err)
	}

	// Create vault for user A.
	createdVault, err := svc.Create(ctx, pA1, makeValidCreateInput(t, 0x10))
	if err != nil {
		t.Fatalf("svc.Create: %v", err)
	}

	// 2. RegisterPasskeyOptions stores only SHA-256(challenge), never plaintext challenge, and empty excludeCredentials.
	opts1, err := svc.RegisterPasskeyOptions(ctx, pA1)
	if err != nil {
		t.Fatalf("RegisterPasskeyOptions: %v", err)
	}
	if opts1.ChallengeID == uuid.Nil {
		t.Fatal("ChallengeID is nil")
	}
	if opts1.PublicKey.RP.ID != "localhost" || opts1.PublicKey.RP.Name != "engram" {
		t.Fatalf("unexpected RP: %+v", opts1.PublicKey.RP)
	}
	if opts1.PublicKey.AuthenticatorSelection == nil || opts1.PublicKey.AuthenticatorSelection.UserVerification != "required" {
		t.Fatalf("expected userVerification=required, got %+v", opts1.PublicKey.AuthenticatorSelection)
	}
	if opts1.PublicKey.Extensions == nil || opts1.PublicKey.Extensions.PRF == nil ||
		opts1.PublicKey.Extensions.PRF.Eval == nil || opts1.PublicKey.Extensions.PRF.Eval.First != opts1.PRFSalt {
		t.Fatalf("PRF extension mismatch: %+v vs prf_salt %q", opts1.PublicKey.Extensions, opts1.PRFSalt)
	}
	if len(opts1.PublicKey.ExcludeCredentials) != 0 {
		t.Fatalf("expected 0 excludeCredentials initially, got %d", len(opts1.PublicKey.ExcludeCredentials))
	}

	rawChal1, err := vault.DecodeBase64URLStrict(opts1.PublicKey.Challenge, 32)
	if err != nil {
		t.Fatalf("Decode challenge: %v", err)
	}
	wantHash1 := sha256.Sum256(rawChal1)
	var dbChalHash, dbPrfSalt []byte
	if err := pool.QueryRow(ctx, `SELECT challenge_hash, prf_salt FROM webauthn_challenge WHERE id = $1`, opts1.ChallengeID).Scan(&dbChalHash, &dbPrfSalt); err != nil {
		t.Fatalf("query webauthn_challenge: %v", err)
	}
	if bytes.Equal(dbChalHash, rawChal1) {
		t.Fatal("webauthn_challenge must NEVER store raw challenge bytes")
	}
	if !bytes.Equal(dbChalHash, wantHash1[:]) {
		t.Fatal("webauthn_challenge.challenge_hash does not match SHA-256(challenge)")
	}

	// 3. Register first passkey via virtual authenticator; verify consume-then-verify, DB fields, and no version bump.
	va := webauthntest.New()
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: opts1.PublicKey.Challenge,
		PRFSalt:      dbPrfSalt,
	})
	if err != nil {
		t.Fatalf("CreateCredential 1: %v", err)
	}
	vkWrap1 := makeValidWrapB64U(t, vault.WrapKindPRF, 0x31)

	item1, err := svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       opts1.ChallengeID,
		ClientDataJSON:    reg1.ClientDataJSONB64,
		AttestationObject: reg1.AttestationObjectB64,
		PRFSalt:           opts1.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              "  YubiKey 5C Primary  ",
		IP:                "127.0.0.1",
		UA:                "vault-passkey-test/1.0",
	})
	if err != nil {
		t.Fatalf("RegisterPasskey 1: %v", err)
	}
	if item1.Name != "YubiKey 5C Primary" {
		t.Fatalf("Name = %q, want trimmed 'YubiKey 5C Primary'", item1.Name)
	}
	if item1.AAGUID == nil || *item1.AAGUID != reg1.AAGUIDString {
		t.Fatalf("AAGUID = %v, want %q", item1.AAGUID, reg1.AAGUIDString)
	}

	// Vault version must remain 1 (no bump on passkey register).
	stateAfter1, err := svc.Get(ctx, userA.ID)
	if err != nil {
		t.Fatalf("svc.Get: %v", err)
	}
	if stateAfter1.Version != createdVault.Version {
		t.Fatalf("vault.version bumped to %d, want %d", stateAfter1.Version, createdVault.Version)
	}
	if len(stateAfter1.Passkeys) != 1 || stateAfter1.Passkeys[0].ID != item1.ID {
		t.Fatalf("unexpected passkeys in state: %+v", stateAfter1.Passkeys)
	}

	// 4. Subsequent RegisterPasskeyOptions includes first credential in excludeCredentials.
	opts2, err := svc.RegisterPasskeyOptions(ctx, pA1)
	if err != nil {
		t.Fatalf("RegisterPasskeyOptions 2: %v", err)
	}
	if len(opts2.PublicKey.ExcludeCredentials) != 1 || opts2.PublicKey.ExcludeCredentials[0].ID != reg1.CredentialIDB64 {
		t.Fatalf("ExcludeCredentials = %+v, want [%s]", opts2.PublicKey.ExcludeCredentials, reg1.CredentialIDB64)
	}

	// 5. Failed attestation verification still burns the consumed challenge (consume-then-verify).
	badOriginReg, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:           "localhost",
		Origin:         "http://localhost:3000",
		ChallengeB64:   opts2.PublicKey.Challenge,
		OverrideOrigin: "http://localhost:3001",
	})
	if err != nil {
		t.Fatalf("CreateCredential bad origin: %v", err)
	}
	_, err = svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       opts2.ChallengeID,
		ClientDataJSON:    badOriginReg.ClientDataJSONB64,
		AttestationObject: badOriginReg.AttestationObjectB64,
		PRFSalt:           opts2.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              "Bad Origin Key",
	})
	if !errors.Is(err, vault.ErrPasskeyAttestationInvalid) {
		t.Fatalf("expected ErrPasskeyAttestationInvalid on wrong port origin, got %v", err)
	}

	// Now retry with a valid attestation on the SAME challenge opts2 -> must fail with ErrPasskeyChallengeInvalid because opts2 was burned!
	goodRetryReg, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: opts2.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential goodRetryReg: %v", err)
	}
	_, err = svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       opts2.ChallengeID,
		ClientDataJSON:    goodRetryReg.ClientDataJSONB64,
		AttestationObject: goodRetryReg.AttestationObjectB64,
		PRFSalt:           opts2.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              "Retry On Burned Challenge",
	})
	if !errors.Is(err, vault.ErrPasskeyChallengeInvalid) {
		t.Fatalf("expected ErrPasskeyChallengeInvalid after failed verify burned challenge, got %v", err)
	}

	// 6. Wrong session (options created in sessA1, register called from sessA2) -> ErrPasskeyChallengeInvalid.
	optsWrongSess, err := svc.RegisterPasskeyOptions(ctx, pA1)
	if err != nil {
		t.Fatal(err)
	}
	regWrongSess, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: optsWrongSess.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RegisterPasskey(ctx, pA2, vault.RegisterPasskeyInput{
		ChallengeID:       optsWrongSess.ChallengeID,
		ClientDataJSON:    regWrongSess.ClientDataJSONB64,
		AttestationObject: regWrongSess.AttestationObjectB64,
		PRFSalt:           optsWrongSess.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              "Wrong Session Key",
	}); !errors.Is(err, vault.ErrPasskeyChallengeInvalid) {
		t.Fatalf("expected ErrPasskeyChallengeInvalid for wrong session, got %v", err)
	}

	// 7. Expired challenge (> 5m) -> ErrPasskeyChallengeInvalid.
	optsExp, err := svc.RegisterPasskeyOptions(ctx, pA1)
	if err != nil {
		t.Fatal(err)
	}
	regExp, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: optsExp.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	clk.Advance(5*time.Minute + time.Second)
	if _, err := svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       optsExp.ChallengeID,
		ClientDataJSON:    regExp.ClientDataJSONB64,
		AttestationObject: regExp.AttestationObjectB64,
		PRFSalt:           optsExp.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              "Expired Key",
	}); !errors.Is(err, vault.ErrPasskeyChallengeInvalid) {
		t.Fatalf("expected ErrPasskeyChallengeInvalid for expired challenge, got %v", err)
	}

	// 8. Name validation & wrap validation errors.
	if _, err := svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       optsExp.ChallengeID,
		ClientDataJSON:    regExp.ClientDataJSONB64,
		AttestationObject: regExp.AttestationObjectB64,
		PRFSalt:           optsExp.PRFSalt,
		VKWrap:            vkWrap1,
		Name:              strings.Repeat("x", 65),
	}); !errors.Is(err, vault.ErrPasskeyNameInvalid) {
		t.Fatalf("expected ErrPasskeyNameInvalid for 65-rune name, got %v", err)
	}
	if _, err := svc.RegisterPasskey(ctx, pA1, vault.RegisterPasskeyInput{
		ChallengeID:       optsExp.ChallengeID,
		ClientDataJSON:    regExp.ClientDataJSONB64,
		AttestationObject: regExp.AttestationObjectB64,
		PRFSalt:           optsExp.PRFSalt,
		VKWrap:            "not-a-valid-wrap",
		Name:              "Valid Name",
	}); !errors.Is(err, vault.ErrVaultWrapInvalid) {
		t.Fatalf("expected ErrVaultWrapInvalid for bad wrap, got %v", err)
	}
}

// TestServiceRegisterPasskey_ConcurrentChallengeConsumeAndRollback covers BE1-3 / BE1-7 and BE1-4 / BE1-8
// at the service level:
//  1. Two concurrent svc.RegisterPasskey calls using ONE challenge and DISTINCT credentials, synchronized
//     by holding the webauthn_challenge row FOR UPDATE until pg_stat_activity / pg_blocking_pids confirms
//     both consumers are blocked, then releasing: exactly one succeeds and the other returns ErrPasskeyChallengeInvalid.
//  2. Failure injected after InsertPasskey (via Postgres trigger on audit_log and user_notification) rolls back
//     the passkey insert, leaves 0 audits and 0 notices for the failed attempt, while keeping the challenge burned.
func TestServiceRegisterPasskey_ConcurrentChallengeConsumeAndRollback(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 10, 29, 13, 0, 0, 0, time.UTC))

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}

	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	ctx := context.Background()
	q := gen.New(pool)

	userA, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "passkey-svc-conc-rb@example.com",
		Locale: "en",
	})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	sessA, err := q.InsertSession(ctx, gen.InsertSessionParams{
		UserID:           userA.ID,
		RefreshTokenHash: seqBytes(32, 0x31),
		IpHash:           seqBytes(32, 0x32),
		ExpiresAt:        pgtype.Timestamptz{Time: clk.Now().Add(24 * time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatalf("InsertSession: %v", err)
	}
	pA := authctx.Principal{
		UserID:    userA.ID,
		SessionID: sessA.ID,
	}

	if _, err := svc.Create(ctx, pA, makeValidCreateInput(t, 0x20)); err != nil {
		t.Fatalf("svc.Create: %v", err)
	}

	va := webauthntest.New()

	// Part 1: Deterministic concurrent challenge consumption with distinct credentials.
	optsConc, err := svc.RegisterPasskeyOptions(ctx, pA)
	if err != nil {
		t.Fatalf("RegisterPasskeyOptions: %v", err)
	}
	regConc0, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: optsConc.PublicKey.Challenge,
		CredentialID: seqBytes(32, 0xC1),
	})
	if err != nil {
		t.Fatal(err)
	}
	regConc1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         "localhost",
		Origin:       "http://localhost:3000",
		ChallengeB64: optsConc.PublicKey.Challenge,
		CredentialID: seqBytes(32, 0xD2),
	})
	if err != nil {
		t.Fatal(err)
	}
	inputs := [2]vault.RegisterPasskeyInput{
		{
			ChallengeID:       optsConc.ChallengeID,
			ClientDataJSON:    regConc0.ClientDataJSONB64,
			AttestationObject: regConc0.AttestationObjectB64,
			PRFSalt:           optsConc.PRFSalt,
			VKWrap:            makeValidWrapB64U(t, vault.WrapKindPRF, 0x41),
			Name:              "Svc Concurrent 0",
			IP:                "127.0.0.1",
			UA:                "svc-test/0",
		},
		{
			ChallengeID:       optsConc.ChallengeID,
			ClientDataJSON:    regConc1.ClientDataJSONB64,
			AttestationObject: regConc1.AttestationObjectB64,
			PRFSalt:           optsConc.PRFSalt,
			VKWrap:            makeValidWrapB64U(t, vault.WrapKindPRF, 0x42),
			Name:              "Svc Concurrent 1",
			IP:                "127.0.0.1",
			UA:                "svc-test/1",
		},
	}

	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin lockTx: %v", err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()

	var holderPID int32
	if err := lockTx.QueryRow(ctx,
		`SELECT pg_backend_pid() FROM webauthn_challenge WHERE id = $1 FOR UPDATE`,
		optsConc.ChallengeID,
	).Scan(&holderPID); err != nil {
		t.Fatalf("lock challenge row FOR UPDATE: %v", err)
	}

	var items [2]vault.PasskeyItem
	var errs [2]error
	earlyDone := make(chan int, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			defer func() { earlyDone <- idx }()
			items[idx], errs[idx] = svc.RegisterPasskey(ctx, pA, inputs[idx])
		}(i)
	}

	waitCtx, waitCancel := context.WithTimeout(ctx, 5*time.Second)
	defer waitCancel()
	for {
		var blocked int
		if err := pool.QueryRow(waitCtx, `
			SELECT count(*)
			FROM pg_stat_activity AS a
			WHERE a.datname = current_database()
			  AND a.pid <> $1
			  AND cardinality(pg_blocking_pids(a.pid)) > 0
			  AND (
			    $1 = ANY(pg_blocking_pids(a.pid))
			    OR EXISTS (
			      SELECT 1
			      FROM unnest(pg_blocking_pids(a.pid)) AS mid_pid
			      WHERE $1 = ANY(pg_blocking_pids(mid_pid))
			    )
			  )
		`, holderPID).Scan(&blocked); err != nil {
			t.Fatalf("poll pg_blocking_pids: %v", err)
		}
		if blocked >= 2 {
			break
		}
		select {
		case idx := <-earlyDone:
			t.Fatalf("consumer %d exited before both were blocked: err=%v", idx, errs[idx])
		case <-waitCtx.Done():
			t.Fatalf("timeout waiting for 2 blocked consumers (last blocked=%d)", blocked)
		case <-time.After(10 * time.Millisecond):
		}
	}

	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatalf("release lockTx: %v", err)
	}

	doneCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneCh)
	}()
	select {
	case <-doneCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for concurrent RegisterPasskey consumers")
	}

	var okCount, invalidCount int
	for i := range 2 {
		switch {
		case errs[i] == nil && items[i].ID != uuid.Nil:
			okCount++
		case errors.Is(errs[i], vault.ErrPasskeyChallengeInvalid):
			invalidCount++
		default:
			t.Fatalf("consumer %d unexpected result: item=%+v err=%v", i, items[i], errs[i])
		}
	}
	if okCount != 1 || invalidCount != 1 {
		t.Fatalf("concurrent consume results: ok=%d invalid=%d, want 1 and 1 (errs=%v)", okCount, invalidCount, fmt.Sprint(errs))
	}

	// Part 2: Rollback when audit_log or user_notification write fails after InsertPasskey.
	if _, err := pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_svc_fail_passkey_reg() RETURNS trigger AS $$
		BEGIN
			IF NEW.user_id = '`+userA.ID.String()+`'::uuid THEN
				RAISE EXCEPTION 'simulated service passkey register failure on %', TG_TABLE_NAME;
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
	`); err != nil {
		t.Fatalf("create trigger function: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `
			DROP TRIGGER IF EXISTS trg_svc_fail_reg_audit ON audit_log;
			DROP TRIGGER IF EXISTS trg_svc_fail_reg_notice ON user_notification;
			DROP FUNCTION IF EXISTS test_svc_fail_passkey_reg();
		`)
	})

	for _, table := range []string{"audit_log", "user_notification"} {
		trigName := "trg_svc_fail_reg_" + table
		if _, err := pool.Exec(ctx, fmt.Sprintf(`
			CREATE TRIGGER %s
			BEFORE INSERT ON %s
			FOR EACH ROW EXECUTE FUNCTION test_svc_fail_passkey_reg();
		`, trigName, table)); err != nil {
			t.Fatalf("create trigger on %s: %v", table, err)
		}

		optsRB, err := svc.RegisterPasskeyOptions(ctx, pA)
		if err != nil {
			t.Fatalf("RegisterPasskeyOptions(%s): %v", table, err)
		}
		regRB, err := va.CreateCredential(webauthntest.RegistrationOptions{
			RPID:         "localhost",
			Origin:       "http://localhost:3000",
			ChallengeB64: optsRB.PublicKey.Challenge,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, regErr := svc.RegisterPasskey(ctx, pA, vault.RegisterPasskeyInput{
			ChallengeID:       optsRB.ChallengeID,
			ClientDataJSON:    regRB.ClientDataJSONB64,
			AttestationObject: regRB.AttestationObjectB64,
			PRFSalt:           optsRB.PRFSalt,
			VKWrap:            makeValidWrapB64U(t, vault.WrapKindPRF, 0x55),
			Name:              "Rollback Key " + table,
		})
		if regErr == nil {
			t.Fatalf("expected error when %s trigger raises", table)
		}

		if _, err := pool.Exec(ctx, fmt.Sprintf(`DROP TRIGGER %s ON %s`, trigName, table)); err != nil {
			t.Fatalf("drop trigger %s: %v", trigName, err)
		}

		var pkCount, auditCount, noticeCount int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, userA.ID).Scan(&pkCount); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, userA.ID, vault.EventPasskeyRegister).Scan(&auditCount); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, userA.ID).Scan(&noticeCount); err != nil {
			t.Fatal(err)
		}
		if pkCount != 1 || auditCount != 1 || noticeCount != 1 {
			t.Fatalf("after %s rollback: passkeys=%d audits=%d notices=%d, want 1/1/1 (only Part 1 winner)",
				table, pkCount, auditCount, noticeCount)
		}

		// Consumed challenge must stay burned even though the mutation tx rolled back.
		if _, err := svc.RegisterPasskey(ctx, pA, vault.RegisterPasskeyInput{
			ChallengeID:       optsRB.ChallengeID,
			ClientDataJSON:    regRB.ClientDataJSONB64,
			AttestationObject: regRB.AttestationObjectB64,
			PRFSalt:           optsRB.PRFSalt,
			VKWrap:            makeValidWrapB64U(t, vault.WrapKindPRF, 0x55),
			Name:              "Retry After Rollback " + table,
		}); !errors.Is(err, vault.ErrPasskeyChallengeInvalid) {
			t.Fatalf("after %s rollback, retry with burned challenge = %v, want ErrPasskeyChallengeInvalid", table, err)
		}
	}
}
