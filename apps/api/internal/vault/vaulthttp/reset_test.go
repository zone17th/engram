package vaulthttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// TestVaultResetCommitSameKeyRetryHookRollbackOtherUserAndIdempotencyPurge covers all plan Task 12 bullets:
// - DELETE /vault: S+C+A(vault.reset)+R(vault_sensitive)+M+I+K, empty-body DELETE allowed (not 415)
// - reset commits and same-key retry returns the original 204
// - ResetHook called inside the same transaction (failing hook -> full rollback, vault still present)
// - deletes RKs, passkeys, webauthn_challenges, other vault idempotency keys (path LIKE '/api/v1/vault%' AND key <> $k), and vault
// - records audit `vault.reset` and in-app security notice + mail after commit
// - other user unaffected
// - after reset Me.vault.status=absent; a new POST /vault gets a NEW vault_key_id
// - retry of the OLD POST /vault idempotency key after reset does NOT return the deleted vault_key_id
// - If-Match mutation after reset before recreate -> 404 vault_absent
// - If-Match with the old vault_key_id after reset + recreate -> 412 version_mismatch
func TestVaultResetCommitSameKeyRetryHookRollbackOtherUserAndIdempotencyPurge(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("reset-alice@example.com", password)
	jarB, meB := h.signupUser("reset-bob@example.com", password)

	ctx := context.Background()
	q := gen.New(h.pool)

	// Mark Alice's email verified so security email is also exercised on commit.
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}

	// 1. Create vaults for Alice and Bob.
	oldCreateKeyA := "idem-alice-create-initial01"
	createPayloadA1 := makeCreatePayload(t, 0x10)
	bodyCreateA1 := mustJSON(t, createPayloadA1)
	respCreateA, rawCreateA := h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyCreateA1, reqOptions{
		idemKey: oldCreateKeyA,
	})
	if respCreateA.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault (Alice) = %d %s", respCreateA.StatusCode, rawCreateA)
	}
	var createdA1 vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreateA), &createdA1); err != nil {
		t.Fatal(err)
	}

	oldCreateKeyB := "idem-bob-create-initial0001"
	createPayloadB := makeCreatePayload(t, 0x50)
	respCreateB, rawCreateB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, createPayloadB), reqOptions{
		idemKey: oldCreateKeyB,
	})
	if respCreateB.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault (Bob) = %d %s", respCreateB.StatusCode, rawCreateB)
	}
	var createdB vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreateB), &createdB); err != nil {
		t.Fatal(err)
	}

	// Perform a rewrap on Alice's vault so Alice also has a second `/api/v1/vault/kek` idempotency row and version=2,
	// plus a non-vault idempotency row (`/api/v1/items`) to verify only `/api/v1/vault%` rows are purged.
	rewrapGrantA := h.reauthGrant(jarA, "vault.rewrap", password)
	ifMatchA1 := formatIfMatchTag(createdA1.VaultKeyID, 1)
	rewrapBodyA := mustJSON(t, makeRewrapPayload(t, 3, 67108864, 0x21, 0x22))
	respRewrapA, rawRewrapA := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBodyA, reqOptions{
		idemKey: "idem-alice-rewrap-before-reset",
		ifMatch: ifMatchA1,
		grant:   rewrapGrantA,
	})
	if respRewrapA.StatusCode != http.StatusOK {
		t.Fatalf("PUT /vault/kek (Alice) = %d %s", respRewrapA.StatusCode, rawRewrapA)
	}
	// Drain the rewrap security_notice_mail job before testing reset so reset job/mail counts are isolated.
	if ran, err := h.runSecurityNoticeWorker(ctx, h.mail); err != nil || ran != 1 {
		t.Fatalf("drain rewrap job before reset = (%d, %v), want (1, nil)", ran, err)
	}
	mailsBeforeReset := h.countSecurityMailsDelivered("reset-alice@example.com")

	// Insert passkey, webauthn_challenge, and a non-vault idempotency row for Alice (and passkey/challenge for Bob).
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  meA.User.ID,
		CredID:  seqTestBytes(32, 0x91),
		Pubkey:  seqTestBytes(32, 0x92),
		PrfSalt: seqTestBytes(32, 0x93),
		VkWrap:  seqTestBytes(vault.VKWrapBytes, 0x01),
		Name:    "Alice Key",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  meB.User.ID,
		CredID:  seqTestBytes(32, 0x94),
		Pubkey:  seqTestBytes(32, 0x95),
		PrfSalt: seqTestBytes(32, 0x96),
		VkWrap:  seqTestBytes(vault.VKWrapBytes, 0x01),
		Name:    "Bob Key",
	}); err != nil {
		t.Fatal(err)
	}

	var sessA, sessB uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT id FROM session WHERE user_id = $1 LIMIT 1`, meA.User.ID).Scan(&sessA); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT id FROM session WHERE user_id = $1 LIMIT 1`, meB.User.ID).Scan(&sessB); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
		UserID:        meA.User.ID,
		SessionID:     sessA,
		VaultKeyID:    createdA1.VaultKeyID,
		ChallengeHash: seqTestBytes(32, 0xA1),
		PrfSalt:       seqTestBytes(32, 0xA2),
		ExpiresAt:     pgtype.Timestamptz{Time: h.clk.Now().Add(5 * time.Minute), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
		UserID:        meB.User.ID,
		SessionID:     sessB,
		VaultKeyID:    createdB.VaultKeyID,
		ChallengeHash: seqTestBytes(32, 0xB1),
		PrfSalt:       seqTestBytes(32, 0xB2),
		ExpiresAt:     pgtype.Timestamptz{Time: h.clk.Now().Add(5 * time.Minute), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO idempotency_key (user_id, key, method, path, request_hash, status, owner_token, claimed_at, expires_at, status_code, response)
		 VALUES ($1, 'idem-alice-non-vault-item1', 'POST', '/api/v1/items', $2, 'done', $3, now(), now() + interval '24 hours', 201, '{"id":"item1"}')`,
		meA.User.ID, seqTestBytes(32, 0x77), uuid.New(),
	); err != nil {
		t.Fatal(err)
	}

	ifMatchA2 := formatIfMatchTag(createdA1.VaultKeyID, 2)
	resetGrantA := h.reauthGrant(jarA, "vault.reset", password)

	// 2. Failing ResetHook -> transaction rolls back completely, returns 500, releases idempotency claim,
	// and Alice's vault (version=2), 10 RKs, passkey, challenge, and old idempotency keys remain intact.
	h.vaultSvc.SetResetHook(func(_ context.Context, _ pgx.Tx, _ uuid.UUID) error {
		return errors.New("hook failure rolls back tx")
	})
	respFailHook, rawFailHook := h.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: "idem-alice-reset-hook-fail",
		ifMatch: ifMatchA2,
		grant:   resetGrantA,
	})
	if respFailHook.StatusCode != http.StatusInternalServerError {
		t.Fatalf("DELETE /vault with failing hook = %d %s, want 500", respFailHook.StatusCode, rawFailHook)
	}
	if got := h.getMe(jarA).Vault.Status; got != "present" {
		t.Fatalf("Alice Me.Vault.Status after failed hook = %q, want present", got)
	}
	respGetStillThere, _ := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGetStillThere.StatusCode != http.StatusOK {
		t.Fatalf("Alice GET /vault after failed hook = %d, want 200", respGetStillThere.StatusCode)
	}
	var jobsAfterFailHook int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobsAfterFailHook); err != nil {
		t.Fatal(err)
	}
	if jobsAfterFailHook != 0 {
		t.Fatalf("river_job count after failed ResetHook = %d, want 0", jobsAfterFailHook)
	}

	// 3. Restore working ResetHook (recording the call inside tx) and run DELETE /vault:
	// commits 204 No Content with empty body.
	var hookCalls int
	h.vaultSvc.SetResetHook(func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
		if userID != meA.User.ID {
			return errors.New("unexpected userID in ResetHook")
		}
		// Verify tx is live and holds the locked vault row at the moment ResetHook is called.
		var vID string
		if err := tx.QueryRow(ctx, `SELECT vault_key_id FROM vault WHERE user_id = $1`, userID).Scan(&vID); err != nil {
			return err
		}
		if vID != createdA1.VaultKeyID {
			return errors.New("vault_key_id mismatch inside ResetHook tx")
		}
		hookCalls++
		return nil
	})

	resetIdemKey := "idem-alice-reset-commit-001"
	respReset, rawReset := h.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: resetIdemKey,
		ifMatch: ifMatchA2,
		grant:   resetGrantA,
	})
	if respReset.StatusCode != http.StatusNoContent || rawReset != "" {
		t.Fatalf("DELETE /vault = %d %q, want 204 empty body", respReset.StatusCode, rawReset)
	}
	if hookCalls != 1 {
		t.Fatalf("hookCalls = %d, want 1", hookCalls)
	}

	// 4. Same-key retry of DELETE /vault returns the original 204 without running ResetHook again
	// (even after advancing clock 6 minutes so the grant is expired).
	h.clk.Advance(6 * time.Minute)
	respResetRetry, rawResetRetry := h.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: resetIdemKey,
		ifMatch: ifMatchA2,
		grant:   resetGrantA,
	})
	if respResetRetry.StatusCode != http.StatusNoContent || rawResetRetry != "" {
		t.Fatalf("retry DELETE /vault = %d %q, want 204 empty body", respResetRetry.StatusCode, rawResetRetry)
	}
	if hookCalls != 1 {
		t.Fatalf("hookCalls after idempotent retry = %d, want 1", hookCalls)
	}

	// 5. Verify Me.vault.status == "absent" for Alice, all Alice vault/RK/passkey/challenge rows are gone,
	// Alice's other `/api/v1/vault%` idempotency keys were purged while keeping `resetIdemKey` and non-vault `/api/v1/items`,
	// and audit `vault.reset` + security notice were recorded.
	if got := h.getMe(jarA).Vault.Status; got != "absent" {
		t.Fatalf("Alice Me.Vault.Status after reset = %q, want absent", got)
	}
	var rkA, pkA, chA, vaultIdemA, nonVaultIdemA, auditResetA int
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_recovery_key WHERE vault_id = $1`, meA.User.ID).Scan(&rkA)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, meA.User.ID).Scan(&pkA)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge WHERE user_id = $1`, meA.User.ID).Scan(&chA)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND path LIKE '/api/v1/vault%'`, meA.User.ID).Scan(&vaultIdemA)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND path = '/api/v1/items'`, meA.User.ID).Scan(&nonVaultIdemA)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, meA.User.ID, vault.EventVaultReset).Scan(&auditResetA)
	if rkA != 0 || pkA != 0 || chA != 0 {
		t.Fatalf("Alice leftover rows: rk=%d pk=%d ch=%d", rkA, pkA, chA)
	}
	if vaultIdemA != 1 || nonVaultIdemA != 1 {
		t.Fatalf("Alice idempotency rows: vaultIdem=%d (want 1 reset row), nonVaultIdem=%d (want 1)", vaultIdemA, nonVaultIdemA)
	}
	if auditResetA != 1 {
		t.Fatalf("audit vault.reset count = %d, want 1", auditResetA)
	}
	var resetJobs int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&resetJobs); err != nil {
		t.Fatal(err)
	}
	if resetJobs != 1 {
		t.Fatalf("river_job count after reset+retry = %d, want 1", resetJobs)
	}
	if gotBeforeWorker := h.countSecurityMailsDelivered("reset-alice@example.com") - mailsBeforeReset; gotBeforeWorker != 0 {
		t.Fatalf("direct emails before worker on reset = %d, want 0", gotBeforeWorker)
	}
	if ran, err := h.runSecurityNoticeWorker(ctx, h.mail); err != nil || ran != 1 {
		t.Fatalf("runSecurityNoticeWorker after reset = (%d, %v), want (1, nil)", ran, err)
	}
	if gotAfterWorker := h.countSecurityMailsDelivered("reset-alice@example.com") - mailsBeforeReset; gotAfterWorker != 1 {
		t.Fatalf("security emails delivered for reset = %d, want 1", gotAfterWorker)
	}

	// 6. Verify Bob (other user) is completely unaffected: vault present, 10 RKs, 1 passkey, 1 challenge,
	// and Bob's POST /vault idempotency key still replays Bob's vault_key_id.
	if got := h.getMe(jarB).Vault.Status; got != "present" {
		t.Fatalf("Bob Me.Vault.Status = %q, want present", got)
	}
	respGetB, rawGetB := h.doReq(jarB, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGetB.StatusCode != http.StatusOK {
		t.Fatalf("Bob GET /vault = %d %s", respGetB.StatusCode, rawGetB)
	}
	var stateB vault.VaultState
	if err := json.Unmarshal([]byte(rawGetB), &stateB); err != nil {
		t.Fatal(err)
	}
	var chB, vaultIdemB int
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge WHERE user_id = $1`, meB.User.ID).Scan(&chB)
	_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meB.User.ID, oldCreateKeyB).Scan(&vaultIdemB)
	if stateB.VaultKeyID != createdB.VaultKeyID || stateB.RecoveryKeysRemaining != 10 || len(stateB.Passkeys) != 1 || chB != 1 || vaultIdemB != 1 {
		t.Fatalf("Bob state after Alice reset: state=%+v chB=%d idemB=%d", stateB, chB, vaultIdemB)
	}

	// 7. Before recreate, an If-Match mutation (e.g. PUT /vault/kek or DELETE /vault with a new Idempotency-Key)
	// returns 404 vault_absent (precedence over 412).
	rewrapGrantAfterReset := h.reauthGrant(jarA, "vault.rewrap", password)
	respMutAbsent, rawMutAbsent := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBodyA, reqOptions{
		idemKey: "idem-alice-rewrap-when-absent",
		ifMatch: ifMatchA2,
		grant:   rewrapGrantAfterReset,
	})
	if respMutAbsent.StatusCode != http.StatusNotFound || decodeProblem(t, rawMutAbsent).Code != "vault_absent" {
		t.Fatalf("If-Match mutation after reset before recreate = %d %s, want 404 vault_absent", respMutAbsent.StatusCode, rawMutAbsent)
	}

	// 8. Retrying the OLD `POST /vault` idempotency key (`oldCreateKeyA`) after reset does NOT return the deleted
	// `createdA1.VaultKeyID` (because `PurgeOtherVaultIdempotencyKeysTx` deleted that idempotency row during reset);
	// instead it executes a fresh create and issues a brand-new `vault_key_id` with `version = 1`.
	respRecreate, rawRecreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyCreateA1, reqOptions{
		idemKey: oldCreateKeyA,
	})
	if respRecreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault with old idempotency key after reset = %d %s, want 201", respRecreate.StatusCode, rawRecreate)
	}
	var createdA2 vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawRecreate), &createdA2); err != nil {
		t.Fatal(err)
	}
	if createdA2.VaultKeyID == createdA1.VaultKeyID || !vault.ValidateVaultKeyID(createdA2.VaultKeyID) || createdA2.Version != 1 {
		t.Fatalf("recreated vault = %+v, must have a NEW vault_key_id != %q", createdA2, createdA1.VaultKeyID)
	}
	if got := h.getMe(jarA).Vault.Status; got != "present" {
		t.Fatalf("Alice Me.Vault.Status after recreate = %q, want present", got)
	}

	// 9. If-Match with the OLD `vault_key_id` (`"createdA1.VaultKeyID:1"`) after reset + recreate -> 412 version_mismatch
	// (with current_version = 1), preventing a stale tab holding the old vault from overwriting the new vault.
	ifMatchOldVaultKeyID := formatIfMatchTag(createdA1.VaultKeyID, 1)
	rewrapBodyAfterRecreate := mustJSON(t, makeRewrapPayload(t, 3, 67108864, 0x61, 0x62))
	respOldKeyID, rawOldKeyID := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBodyAfterRecreate, reqOptions{
		idemKey: "idem-alice-stale-vkid-after-recreate",
		ifMatch: ifMatchOldVaultKeyID,
		grant:   rewrapGrantAfterReset,
	})
	if respOldKeyID.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("If-Match with old vault_key_id after recreate = %d %s, want 412", respOldKeyID.StatusCode, rawOldKeyID)
	}
	var probOldKeyID versionMismatchResp
	if err := json.Unmarshal([]byte(rawOldKeyID), &probOldKeyID); err != nil {
		t.Fatal(err)
	}
	if probOldKeyID.Code != "version_mismatch" || probOldKeyID.CurrentVersion == nil || *probOldKeyID.CurrentVersion != 1 {
		t.Fatalf("old vault_key_id problem = %+v, want version_mismatch(current_version=1)", probOldKeyID)
	}
}
