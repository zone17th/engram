package vault_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/webauthntest"
)

type seededPasskeyFixture struct {
	row        gen.VaultPasskey
	credIDB64  string
	prfSaltB64 string
	vkWrapB64  string
	pubkeyB64  string
	vk         []byte
}

func seedVirtualAuthenticatorPasskey(
	t *testing.T,
	ctx context.Context,
	q *gen.Queries,
	va *webauthntest.VirtualAuthenticator,
	rp vault.WebAuthnRPConfig,
	userID uuid.UUID,
	vk []byte,
	name string,
	seed byte,
) seededPasskeyFixture {
	t.Helper()
	challengeBytes := seqBytes(vault.WebAuthnChallengeBytes, seed)
	challengeB64 := vault.EncodeBase64URL(challengeBytes)
	prfSalt := seqBytes(vault.WebAuthnPRFSaltBytes, seed+0x20)

	regRes, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: challengeB64,
		PRFSalt:      prfSalt,
	})
	if err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	verified, err := vault.VerifyRegistrationAttestation(
		rp,
		regRes.ClientDataJSONB64,
		regRes.AttestationObjectB64,
		challengeB64,
	)
	if err != nil {
		t.Fatalf("VerifyRegistrationAttestation: %v", err)
	}

	nonce := seqBytes(vault.WrapNonceBytes, seed+0x40)
	vkWrapB64, err := vault.SealWrapBase64URL(vault.WrapKindPRF, vk, regRes.PRFOutput, nonce)
	if err != nil {
		t.Fatalf("SealWrapBase64URL(PRF): %v", err)
	}
	vkWrapBytes, err := vault.ValidateWrapBase64URL(vkWrapB64, vault.WrapKindPRF)
	if err != nil {
		t.Fatalf("ValidateWrapBase64URL(PRF): %v", err)
	}

	row, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  userID,
		CredID:  verified.CredID,
		Pubkey:  verified.PubKey,
		PrfSalt: prfSalt,
		VkWrap:  vkWrapBytes,
		Aaguid:  verified.AAGUID,
		Name:    name,
	})
	if err != nil {
		t.Fatalf("InsertPasskey: %v", err)
	}

	return seededPasskeyFixture{
		row:        row,
		credIDB64:  vault.EncodeBase64URL(verified.CredID),
		prfSaltB64: vault.EncodeBase64URL(prfSalt),
		vkWrapB64:  vkWrapB64,
		pubkeyB64:  vault.EncodeBase64URL(verified.PubKey),
		vk:         vk,
	}
}

func TestServicePasskeyRenameRevokeAndUnlockOptions(t *testing.T) {
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
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, vault.MetricsFromObs(obsMetrics), nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	userA, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "pk-svc-a@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	userB, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "pk-svc-b@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser B: %v", err)
	}
	userNoVault, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "pk-svc-novault@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser NoVault: %v", err)
	}

	pA := authctx.Principal{UserID: userA.ID, SessionID: uuid.New()}
	pB := authctx.Principal{UserID: userB.ID, SessionID: uuid.New()}
	pNoVault := authctx.Principal{UserID: userNoVault.ID, SessionID: uuid.New()}

	// 1. User without a vault gets ErrVaultAbsent across all three operations.
	if _, err := svc.RenamePasskey(ctx, pNoVault, vault.RenamePasskeyInput{
		PasskeyID: uuid.New(),
		Name:      "Valid Name",
	}); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("RenamePasskey(no vault) = %v, want ErrVaultAbsent", err)
	}
	if err := svc.RevokePasskey(ctx, pNoVault, vault.RevokePasskeyInput{
		PasskeyID: uuid.New(),
	}); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("RevokePasskey(no vault) = %v, want ErrVaultAbsent", err)
	}
	if _, err := svc.PasskeyUnlockOptions(ctx, pNoVault); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("PasskeyUnlockOptions(no vault) = %v, want ErrVaultAbsent", err)
	}

	// Create vaults for User A and User B.
	createdA, err := svc.Create(ctx, pA, makeValidCreateInput(t, 0x11))
	if err != nil {
		t.Fatalf("svc.Create(A): %v", err)
	}
	if _, err := svc.Create(ctx, pB, makeValidCreateInput(t, 0x55)); err != nil {
		t.Fatalf("svc.Create(B): %v", err)
	}

	// 2. User with vault but 0 passkeys -> PasskeyUnlockOptions returns ErrPasskeyNotFound.
	if _, err := svc.PasskeyUnlockOptions(ctx, pA); !errors.Is(err, vault.ErrPasskeyNotFound) {
		t.Fatalf("PasskeyUnlockOptions(0 passkeys) = %v, want ErrPasskeyNotFound", err)
	}

	// 3. Seed two passkeys for User A via virtual authenticator with distinct PRF salts and wraps.
	va := webauthntest.New()
	rp := svc.WebAuthnConfig()
	vkA := seqBytes(vault.VKBytes, 0x91)
	pk1 := seedVirtualAuthenticatorPasskey(t, ctx, q, va, rp, userA.ID, vkA, "Laptop Hello", 0xA1)
	pk2 := seedVirtualAuthenticatorPasskey(t, ctx, q, va, rp, userA.ID, vkA, "YubiKey 5C", 0xB2)

	// 4. Unlock options returns both credentials with distinct salts, matching evalByCredential,
	//    and does NOT store a challenge row in webauthn_challenge.
	var challengeRowsBefore int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge`).Scan(&challengeRowsBefore); err != nil {
		t.Fatal(err)
	}

	unlockOpts, err := svc.PasskeyUnlockOptions(ctx, pA)
	if err != nil {
		t.Fatalf("PasskeyUnlockOptions(A): %v", err)
	}

	var challengeRowsAfter int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge`).Scan(&challengeRowsAfter); err != nil {
		t.Fatal(err)
	}
	if challengeRowsAfter != challengeRowsBefore {
		t.Fatalf("webauthn_challenge count changed from %d to %d; unlock options must NOT store challenge", challengeRowsBefore, challengeRowsAfter)
	}

	challBytes, err := vault.DecodeBase64URLStrict(unlockOpts.PublicKey.Challenge, vault.WebAuthnChallengeBytes)
	if err != nil || len(challBytes) != vault.WebAuthnChallengeBytes {
		t.Fatalf("invalid unlock challenge %q: len=%d err=%v", unlockOpts.PublicKey.Challenge, len(challBytes), err)
	}
	if unlockOpts.PublicKey.RPID != rp.RPID {
		t.Fatalf("rpId = %q, want %q", unlockOpts.PublicKey.RPID, rp.RPID)
	}
	if unlockOpts.PublicKey.UserVerification != "required" {
		t.Fatalf("userVerification = %q, want required", unlockOpts.PublicKey.UserVerification)
	}
	if len(unlockOpts.PublicKey.AllowCredentials) != 2 || len(unlockOpts.Credentials) != 2 || len(unlockOpts.PublicKey.Extensions.PRF.EvalByCredential) != 2 {
		t.Fatalf("unexpected credential counts in unlockOpts: %+v", unlockOpts)
	}
	if pk1.prfSaltB64 == pk2.prfSaltB64 {
		t.Fatal("expected distinct prf_salt per credential")
	}

	expectedCreds := []seededPasskeyFixture{pk1, pk2}
	for i, exp := range expectedCreds {
		gotAllow := unlockOpts.PublicKey.AllowCredentials[i]
		if gotAllow.Type != "public-key" || gotAllow.ID != exp.credIDB64 {
			t.Fatalf("allowCredentials[%d] = %+v, want id=%s", i, gotAllow, exp.credIDB64)
		}
		gotCred := unlockOpts.Credentials[i]
		if gotCred.ID != exp.credIDB64 || gotCred.PRFSalt != exp.prfSaltB64 || gotCred.VKWrap != exp.vkWrapB64 {
			t.Fatalf("credentials[%d] = %+v, want id=%s salt=%s wrap=%s", i, gotCred, exp.credIDB64, exp.prfSaltB64, exp.vkWrapB64)
		}
		evalEntry, ok := unlockOpts.PublicKey.Extensions.PRF.EvalByCredential[exp.credIDB64]
		if !ok || evalEntry.First != exp.prfSaltB64 {
			t.Fatalf("evalByCredential[%q] = %+v, want first=%s", exp.credIDB64, evalEntry, exp.prfSaltB64)
		}

		// Prove the returned salt + wrap actually unwraps VK with the virtual authenticator PRF!
		saltBytes, err := vault.DecodeBase64URLStrict(evalEntry.First, vault.WebAuthnPRFSaltBytes)
		if err != nil {
			t.Fatalf("DecodeBase64URLStrict(prf_salt): %v", err)
		}
		pwk, err := va.EvaluatePRF(gotCred.ID, saltBytes)
		if err != nil {
			t.Fatalf("EvaluatePRF: %v", err)
		}
		unwrappedVK, err := vault.OpenWrapBase64URL(vault.WrapKindPRF, gotCred.VKWrap, pwk)
		if err != nil {
			t.Fatalf("OpenWrapBase64URL(PRF): %v", err)
		}
		if !bytes.Equal(unwrappedVK, vkA) {
			t.Fatalf("unwrapped VK mismatch for credential %d", i)
		}
	}

	// 5. Rename ok (trims surrounding whitespace, does not bump vault.version, does not write audit).
	var auditsBeforeRename int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1`, userA.ID).Scan(&auditsBeforeRename); err != nil {
		t.Fatal(err)
	}
	renamed, err := svc.RenamePasskey(ctx, pA, vault.RenamePasskeyInput{
		PasskeyID: pk1.row.ID,
		Name:      "  Work MacBook Pro  ",
	})
	if err != nil {
		t.Fatalf("RenamePasskey valid: %v", err)
	}
	if renamed.ID != pk1.row.ID || renamed.Name != "Work MacBook Pro" {
		t.Fatalf("renamed = %+v, want name 'Work MacBook Pro'", renamed)
	}
	var auditsAfterRename int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1`, userA.ID).Scan(&auditsAfterRename); err != nil {
		t.Fatal(err)
	}
	if auditsAfterRename != auditsBeforeRename {
		t.Fatalf("RenamePasskey must not write audit log: before=%d after=%d", auditsBeforeRename, auditsAfterRename)
	}

	// 6. Invalid names (empty, whitespace-only, 65 runes, control char, bidi override) -> ErrPasskeyNameInvalid.
	invalidNames := []string{
		"",
		"   ",
		strings.Repeat("k", 65),
		"bad\x00name",
		"bidi\u202Eoverride",
		"isolate\u2066name",
	}
	for _, bad := range invalidNames {
		if _, err := svc.RenamePasskey(ctx, pA, vault.RenamePasskeyInput{
			PasskeyID: pk1.row.ID,
			Name:      bad,
		}); !errors.Is(err, vault.ErrPasskeyNameInvalid) {
			t.Fatalf("RenamePasskey(%q) = %v, want ErrPasskeyNameInvalid", bad, err)
		}
	}

	// 7. User B cannot rename or revoke User A's passkey (returns ErrPasskeyNotFound, A's row unchanged).
	if _, err := svc.RenamePasskey(ctx, pB, vault.RenamePasskeyInput{
		PasskeyID: pk1.row.ID,
		Name:      "Hacked by B",
	}); !errors.Is(err, vault.ErrPasskeyNotFound) {
		t.Fatalf("User B RenamePasskey(A's id) = %v, want ErrPasskeyNotFound", err)
	}
	if err := svc.RevokePasskey(ctx, pB, vault.RevokePasskeyInput{
		PasskeyID: pk1.row.ID,
		IP:        "127.0.0.1",
		UA:        "test",
	}); !errors.Is(err, vault.ErrPasskeyNotFound) {
		t.Fatalf("User B RevokePasskey(A's id) = %v, want ErrPasskeyNotFound", err)
	}
	rowAfterBAttempt, err := q.GetPasskeyByUserAndID(ctx, gen.GetPasskeyByUserAndIDParams{
		UserID: userA.ID,
		ID:     pk1.row.ID,
	})
	if err != nil {
		t.Fatalf("GetPasskeyByUserAndID(A, pk1) after B attempt: %v", err)
	}
	if rowAfterBAttempt.Name != "Work MacBook Pro" {
		t.Fatalf("User A passkey name changed to %q after User B attempt", rowAfterBAttempt.Name)
	}

	// 8. Revoke by owner A succeeds, records audit `passkey.revoke` and in-app security notice (no mail targets),
	//    and does NOT bump vault.version.
	if err := svc.RevokePasskey(ctx, pA, vault.RevokePasskeyInput{
		PasskeyID: pk1.row.ID,
		IP:        "127.0.0.1",
		UA:        "vault-passkey-test",
	}); err != nil {
		t.Fatalf("RevokePasskey(A, pk1): %v", err)
	}

	var revokeAuditCount int
	var revokeAuditMeta []byte
	if err := pool.QueryRow(ctx,
		`SELECT count(*), coalesce((array_agg(meta))[1], '{}'::jsonb) FROM audit_log WHERE user_id = $1 AND event = $2`,
		userA.ID, vault.EventPasskeyRevoke,
	).Scan(&revokeAuditCount, &revokeAuditMeta); err != nil {
		t.Fatal(err)
	}
	if revokeAuditCount != 1 {
		t.Fatalf("passkey.revoke audit count = %d, want 1", revokeAuditCount)
	}

	var noticeCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`,
		userA.ID,
	).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("security notice count = %d, want 1", noticeCount)
	}
	var emailTargets []string
	if err := pool.QueryRow(ctx,
		`SELECT coalesce(email_targets, ARRAY[]::citext[]) FROM user_notification WHERE user_id = $1 AND kind = 'security' LIMIT 1`,
		userA.ID,
	).Scan(&emailTargets); err != nil {
		t.Fatal(err)
	}
	if len(emailTargets) != 0 {
		t.Fatalf("passkey.revoke notice email_targets = %v, want empty (no mail per plan)", emailTargets)
	}

	// Retry revoke of the same id -> ErrPasskeyNotFound, no extra audit or notice.
	if err := svc.RevokePasskey(ctx, pA, vault.RevokePasskeyInput{
		PasskeyID: pk1.row.ID,
		IP:        "127.0.0.1",
		UA:        "vault-passkey-test",
	}); !errors.Is(err, vault.ErrPasskeyNotFound) {
		t.Fatalf("retry RevokePasskey(A, pk1) = %v, want ErrPasskeyNotFound", err)
	}

	stateAAfter, err := svc.Get(ctx, userA.ID)
	if err != nil {
		t.Fatalf("svc.Get(A): %v", err)
	}
	if stateAAfter.Version != createdA.Version {
		t.Fatalf("vault.version changed from %d to %d after passkey rename/revoke", createdA.Version, stateAAfter.Version)
	}
	if len(stateAAfter.Passkeys) != 1 || stateAAfter.Passkeys[0].ID != pk2.row.ID {
		t.Fatalf("remaining passkeys = %+v, want only pk2 (%s)", stateAAfter.Passkeys, pk2.row.ID)
	}

	// 9. Verify logs and audit rows never contain salts, wraps, pubkeys, or VK.
	var allAuditJSON []byte
	rows, err := pool.Query(ctx, `SELECT row_to_json(audit_log) FROM audit_log WHERE user_id = $1`, userA.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		allAuditJSON = append(allAuditJSON, raw...)
	}
	rows.Close()

	combinedTelemetry := logBuf.String() + "\n" + string(allAuditJSON)
	forbiddenSecrets := []string{
		pk1.prfSaltB64,
		pk2.prfSaltB64,
		pk1.vkWrapB64,
		pk2.vkWrapB64,
		pk1.pubkeyB64,
		pk2.pubkeyB64,
		vault.EncodeBase64URL(vkA),
	}
	for _, secret := range forbiddenSecrets {
		if secret != "" && strings.Contains(combinedTelemetry, secret) {
			t.Fatalf("telemetry/audit leaked secret material %q", secret)
		}
	}
}
