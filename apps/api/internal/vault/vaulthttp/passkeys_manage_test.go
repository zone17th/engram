package vaulthttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/webauthntest"
)

type httpSeededPasskey struct {
	row        gen.VaultPasskey
	credIDB64  string
	prfSaltB64 string
	vkWrapB64  string
	pubkeyB64  string
	vk         []byte
}

func (h *harness) seedPasskeyWithVA(
	ctx context.Context,
	va *webauthntest.VirtualAuthenticator,
	userID uuid.UUID,
	vk []byte,
	name string,
	seed byte,
) httpSeededPasskey {
	h.t.Helper()
	rp := h.vaultSvc.WebAuthnConfig()
	challengeBytes := seqTestBytes(vault.WebAuthnChallengeBytes, seed)
	challengeB64 := vault.EncodeBase64URL(challengeBytes)
	prfSalt := seqTestBytes(vault.WebAuthnPRFSaltBytes, seed+0x20)

	regRes, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: challengeB64,
		PRFSalt:      prfSalt,
	})
	if err != nil {
		h.t.Fatalf("CreateCredential: %v", err)
	}
	verified, err := vault.VerifyRegistrationAttestation(
		rp,
		regRes.ClientDataJSONB64,
		regRes.AttestationObjectB64,
		challengeB64,
	)
	if err != nil {
		h.t.Fatalf("VerifyRegistrationAttestation: %v", err)
	}

	nonce := seqTestBytes(vault.WrapNonceBytes, seed+0x40)
	vkWrapB64, err := vault.SealWrapBase64URL(vault.WrapKindPRF, vk, regRes.PRFOutput, nonce)
	if err != nil {
		h.t.Fatalf("SealWrapBase64URL(PRF): %v", err)
	}
	vkWrapBytes, err := vault.ValidateWrapBase64URL(vkWrapB64, vault.WrapKindPRF)
	if err != nil {
		h.t.Fatalf("ValidateWrapBase64URL(PRF): %v", err)
	}

	q := gen.New(h.pool)
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
		h.t.Fatalf("InsertPasskey: %v", err)
	}

	return httpSeededPasskey{
		row:        row,
		credIDB64:  vault.EncodeBase64URL(verified.CredID),
		prfSaltB64: vault.EncodeBase64URL(prfSalt),
		vkWrapB64:  vkWrapB64,
		pubkeyB64:  vault.EncodeBase64URL(verified.PubKey),
		vk:         vk,
	}
}

// TestPasskeyRenameRevokeAndUnlockOptionsHTTP covers Task 13 passkey management & unlock options:
// - rename ok (200 VaultPasskeyItem + Cache-Control: no-store, no version bump, no audit)
// - empty / 65-rune / bidi / control-char name -> 400 passkey_name_invalid
// - user B cannot rename or revoke user A's passkey (404 passkey_not_found, same response as unknown id, A's row unchanged)
// - revoke 204 + audit `passkey.revoke` + in-app security notice in the same tx, no mail queued/sent
// - retry revoke of the same id -> 404 passkey_not_found
// - revoke without grant or with wrong action grant -> 401 reauth_invalid (P02 RequireReauth)
// - unlock options returns allowCredentials, evalByCredential (each credential's own salt), and credentials [{id, prf_salt, vk_wrap}], fresh random challenge NOT stored in webauthn_challenge
// - user without passkey -> 404 passkey_not_found; user without vault -> 404 vault_absent
// - none of PATCH /vault/passkeys/{id}, DELETE /vault/passkeys/{id}, POST /vault/unlock/passkey/options is blocked by kill switch VAULT_KEY_MUTATIONS_DISABLED
// - logs, audit_log, and user_notification capture free of salts, wraps, pubkeys, and request bodies
func TestPasskeyRenameRevokeAndUnlockOptionsHTTP(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()

	passA := "correct-horse-battery-staple-A"
	passB := "correct-horse-battery-staple-B"
	jarA, meA := h.signupUser("pk-http-a@example.com", passA)
	jarB, meB := h.signupUser("pk-http-b@example.com", passB)

	// Mark User A's email verified so any accidental RecordSecurityNoticeTx mail enqueue would be caught!
	if _, err := gen.New(h.pool).UpdateUserEmailVerified(ctx, gen.UpdateUserEmailVerifiedParams{
		ID:              meA.User.ID,
		EmailVerifiedAt: pgtype.Timestamptz{Time: h.clk.Now().UTC(), Valid: true},
	}); err != nil {
		t.Fatalf("UpdateUserEmailVerified(A): %v", err)
	}

	grantARevoke := h.reauthGrant(jarA, "vault.passkey_revoke", passA)
	wrongGrantA := h.reauthGrant(jarA, "vault.passkey_register", passA)
	grantBRevoke := h.reauthGrant(jarB, "vault.passkey_revoke", passB)

	// 1. User A before creating a vault gets 404 vault_absent across rename, revoke, and unlock options.
	resp, raw := h.doReq(jarA, http.MethodPatch, "/api/v1/vault/passkeys/"+uuid.NewString(), `{"name":"My Key"}`, reqOptions{})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "vault_absent" {
		t.Fatalf("PATCH rename without vault: status=%d body=%s", resp.StatusCode, raw)
	}
	resp, raw = h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+uuid.NewString(), "", reqOptions{grant: grantARevoke})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "vault_absent" {
		t.Fatalf("DELETE revoke without vault: status=%d body=%s", resp.StatusCode, raw)
	}
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "vault_absent" {
		t.Fatalf("POST unlock options without vault: status=%d body=%s", resp.StatusCode, raw)
	}

	// Create vaults for User A and User B.
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, makeCreatePayload(t, 0x10)), reqOptions{
		idemKey: "idem-pk-http-create-a",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault A = %d %s", resp.StatusCode, raw)
	}
	resp, raw = h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, makeCreatePayload(t, 0x40)), reqOptions{
		idemKey: "idem-pk-http-create-b",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault B = %d %s", resp.StatusCode, raw)
	}

	// 2. User A with vault but 0 passkeys -> POST /vault/unlock/passkey/options returns 404 passkey_not_found.
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "passkey_not_found" {
		t.Fatalf("unlock options with 0 passkeys: status=%d body=%s", resp.StatusCode, raw)
	}

	// Seed 2 passkeys for User A and 1 passkey for User B using the virtual authenticator.
	va := webauthntest.New()
	vkA := seqTestBytes(vault.VKBytes, 0x71)
	vkB := seqTestBytes(vault.VKBytes, 0x81)
	pkA1 := h.seedPasskeyWithVA(ctx, va, meA.User.ID, vkA, "Windows Hello", 0xA1)
	pkA2 := h.seedPasskeyWithVA(ctx, va, meA.User.ID, vkA, "YubiKey Bio", 0xB2)
	pkB1 := h.seedPasskeyWithVA(ctx, va, meB.User.ID, vkB, "Bob Key", 0xC3)

	// 3. Unlock options returns 200 with both credentials of User A, each with its own prf_salt & vk_wrap,
	//    and does not store a challenge in webauthn_challenge.
	var chBefore int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge`).Scan(&chBefore); err != nil {
		t.Fatal(err)
	}
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /vault/unlock/passkey/options = %d %s", resp.StatusCode, raw)
	}
	if gotCC := resp.Header.Get("Cache-Control"); gotCC != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", gotCC)
	}
	var chAfter int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge`).Scan(&chAfter); err != nil {
		t.Fatal(err)
	}
	if chAfter != chBefore {
		t.Fatalf("webauthn_challenge rows changed from %d to %d after unlock options", chBefore, chAfter)
	}

	var unlockResp vault.PasskeyUnlockOptionsResponse
	if err := json.Unmarshal([]byte(raw), &unlockResp); err != nil {
		t.Fatalf("decode unlock options: %v", err)
	}
	if unlockResp.PublicKey.UserVerification != "required" {
		t.Fatalf("userVerification = %q, want required", unlockResp.PublicKey.UserVerification)
	}
	if unlockResp.PublicKey.RPID != h.vaultSvc.WebAuthnRPID() {
		t.Fatalf("rpId = %q, want %q", unlockResp.PublicKey.RPID, h.vaultSvc.WebAuthnRPID())
	}
	challBytes, err := vault.DecodeBase64URLStrict(unlockResp.PublicKey.Challenge, vault.WebAuthnChallengeBytes)
	if err != nil || len(challBytes) != vault.WebAuthnChallengeBytes {
		t.Fatalf("invalid challenge %q: len=%d err=%v", unlockResp.PublicKey.Challenge, len(challBytes), err)
	}
	if len(unlockResp.Credentials) != 2 || len(unlockResp.PublicKey.AllowCredentials) != 2 || len(unlockResp.PublicKey.Extensions.PRF.EvalByCredential) != 2 {
		t.Fatalf("unexpected counts in unlockResp: %+v", unlockResp)
	}
	if unlockResp.Credentials[0].PRFSalt == unlockResp.Credentials[1].PRFSalt {
		t.Fatal("credentials must have distinct prf_salt values")
	}
	for i, exp := range []httpSeededPasskey{pkA1, pkA2} {
		if unlockResp.PublicKey.AllowCredentials[i].ID != exp.credIDB64 || unlockResp.PublicKey.AllowCredentials[i].Type != "public-key" {
			t.Fatalf("allowCredentials[%d] = %+v, want id=%s", i, unlockResp.PublicKey.AllowCredentials[i], exp.credIDB64)
		}
		if unlockResp.Credentials[i].ID != exp.credIDB64 || unlockResp.Credentials[i].PRFSalt != exp.prfSaltB64 || unlockResp.Credentials[i].VKWrap != exp.vkWrapB64 {
			t.Fatalf("credentials[%d] = %+v", i, unlockResp.Credentials[i])
		}
		eval, ok := unlockResp.PublicKey.Extensions.PRF.EvalByCredential[exp.credIDB64]
		if !ok || eval.First != exp.prfSaltB64 {
			t.Fatalf("evalByCredential[%s] = %+v, want first=%s", exp.credIDB64, eval, exp.prfSaltB64)
		}
	}

	// 4. Rename ok (trims whitespace, returns 200 VaultPasskeyItem).
	resp, raw = h.doReq(jarA, http.MethodPatch, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), `{"name":"  Desktop Hello  "}`, reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH rename = %d %s", resp.StatusCode, raw)
	}
	var renamedItem vault.PasskeyItem
	if err := json.Unmarshal([]byte(raw), &renamedItem); err != nil {
		t.Fatalf("decode renamed item: %v", err)
	}
	if renamedItem.ID != pkA1.row.ID || renamedItem.Name != "Desktop Hello" || renamedItem.AAGUID == nil {
		t.Fatalf("renamedItem = %+v", renamedItem)
	}

	// 5. Invalid names -> 400 passkey_name_invalid (empty, whitespace-only, 65 runes, bidi override, control char).
	badNamePayloads := []string{
		`{"name":""}`,
		`{"name":"    "}`,
		`{"name":"` + strings.Repeat("n", 65) + `"}`,
		`{"name":"bidi` + "\u202E" + `key"}`,
		`{"name":"lri` + "\u2066" + `key"}`,
		`{"name":"alm` + "\u061C" + `key"}`,
		`{"name":"ctrl\u0007key"}`,
	}
	for _, body := range badNamePayloads {
		resp, raw = h.doReq(jarA, http.MethodPatch, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), body, reqOptions{})
		if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "passkey_name_invalid" {
			t.Fatalf("PATCH rename bad name (%s): status=%d body=%s", body, resp.StatusCode, raw)
		}
	}

	// 6. User B cannot rename or revoke User A's passkey -> 404 passkey_not_found (same as unknown UUID, no oracle),
	//    and User A's row remains untouched.
	unknownID := uuid.NewString()
	respUnknownRename, rawUnknownRename := h.doReq(jarB, http.MethodPatch, "/api/v1/vault/passkeys/"+unknownID, `{"name":"Other"}`, reqOptions{})
	respCrossRename, rawCrossRename := h.doReq(jarB, http.MethodPatch, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), `{"name":"Other"}`, reqOptions{})
	if respUnknownRename.StatusCode != http.StatusNotFound || respCrossRename.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown (%d) and cross-user (%d) rename", respUnknownRename.StatusCode, respCrossRename.StatusCode)
	}
	if decodeProblem(t, rawUnknownRename).Code != "passkey_not_found" || decodeProblem(t, rawCrossRename).Code != "passkey_not_found" {
		t.Fatalf("expected passkey_not_found for both unknown (%s) and cross-user (%s)", rawUnknownRename, rawCrossRename)
	}

	respCrossRevoke, rawCrossRevoke := h.doReq(jarB, http.MethodDelete, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), "", reqOptions{
		grant: grantBRevoke,
	})
	if respCrossRevoke.StatusCode != http.StatusNotFound || decodeProblem(t, rawCrossRevoke).Code != "passkey_not_found" {
		t.Fatalf("cross-user DELETE revoke: status=%d body=%s", respCrossRevoke.StatusCode, rawCrossRevoke)
	}

	// Verify User A's passkey pkA1 is still intact with name "Desktop Hello".
	dbRowA1, err := gen.New(h.pool).GetPasskeyByUserAndID(ctx, gen.GetPasskeyByUserAndIDParams{
		UserID: meA.User.ID,
		ID:     pkA1.row.ID,
	})
	if err != nil || dbRowA1.Name != "Desktop Hello" {
		t.Fatalf("User A passkey modified after User B attempts: row=%+v err=%v", dbRowA1, err)
	}
	// Advance clock by 61s to clear the 1-minute `vault_sensitive` window consumed by the 10 PATCH/DELETE
	// checks above (reauth grants remain valid for 5 minutes = 300s).
	h.clk.Advance(61 * time.Second)

	// 7. Revoke without grant or with wrong action grant -> 401 reauth_invalid (P02 RequireReauth).
	resp, raw = h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), "", reqOptions{})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("DELETE revoke without grant: status=%d body=%s", resp.StatusCode, raw)
	}
	resp, raw = h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), "", reqOptions{
		grant: wrongGrantA,
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("DELETE revoke with wrong action grant: status=%d body=%s", resp.StatusCode, raw)
	}

	// 8. Valid revoke by User A -> 204 No Content, writes audit `passkey.revoke` + in-app security notice,
	//    and queues/sends ZERO emails.
	mailsBefore := h.countSecurityMailsDelivered(meA.User.Email)
	resp, raw = h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), "", reqOptions{
		grant: grantARevoke,
	})
	if resp.StatusCode != http.StatusNoContent || raw != "" {
		t.Fatalf("DELETE revoke valid: status=%d body=%q", resp.StatusCode, raw)
	}

	var auditRevokeCount int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventPasskeyRevoke,
	).Scan(&auditRevokeCount); err != nil {
		t.Fatal(err)
	}
	if auditRevokeCount != 1 {
		t.Fatalf("audit passkey.revoke count = %d, want 1", auditRevokeCount)
	}

	var noticeCount int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`,
		meA.User.ID,
	).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("user_notification security count = %d, want 1", noticeCount)
	}

	queuedJobs, err := h.runSecurityNoticeWorker(ctx, h.mail)
	if err != nil {
		t.Fatalf("runSecurityNoticeWorker: %v", err)
	}
	if queuedJobs != 0 || h.countSecurityMailsDelivered(meA.User.Email) != mailsBefore {
		t.Fatalf("expected 0 security mails for passkey.revoke, got queued=%d delivered=%d", queuedJobs, h.countSecurityMailsDelivered(meA.User.Email)-mailsBefore)
	}

	// 9. Retry revoke of the same passkey ID -> 404 passkey_not_found.
	resp, raw = h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pkA1.row.ID.String(), "", reqOptions{
		grant: grantARevoke,
	})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "passkey_not_found" {
		t.Fatalf("retry DELETE revoke of same id: status=%d body=%s", resp.StatusCode, raw)
	}

	// 10. Kill switch ON (`VAULT_KEY_MUTATIONS_DISABLED=true`):
	//     None of PATCH /vault/passkeys/{id}, DELETE /vault/passkeys/{id}, or POST /vault/unlock/passkey/options
	//     is in column K, so all three succeed when kill switch is enabled!
	hKS := h.withKillSwitch(true)

	resp, raw = hKS.doReq(jarA, http.MethodPatch, "/api/v1/vault/passkeys/"+pkA2.row.ID.String(), `{"name":"YubiKey Renamed Under KS"}`, reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH rename under kill switch = %d %s", resp.StatusCode, raw)
	}

	resp, raw = hKS.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST unlock options under kill switch = %d %s", resp.StatusCode, raw)
	}

	resp, raw = hKS.doReq(jarB, http.MethodDelete, "/api/v1/vault/passkeys/"+pkB1.row.ID.String(), "", reqOptions{
		grant: grantBRevoke,
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE revoke under kill switch = %d %s", resp.StatusCode, raw)
	}

	// 11. Log & audit capture check: no prf_salt, vk_wrap, pubkey, or request body leaked.
	var auditDump bytes.Buffer
	rows, err := h.pool.Query(ctx, `SELECT row_to_json(audit_log) FROM audit_log`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var line []byte
		if err := rows.Scan(&line); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		auditDump.Write(line)
		auditDump.WriteByte('\n')
	}
	rows.Close()

	combined := h.logs.String() + "\n" + auditDump.String()
	for _, secret := range []string{
		pkA1.prfSaltB64,
		pkA2.prfSaltB64,
		pkB1.prfSaltB64,
		pkA1.vkWrapB64,
		pkA2.vkWrapB64,
		pkB1.vkWrapB64,
		pkA1.pubkeyB64,
		pkA2.pubkeyB64,
		pkB1.pubkeyB64,
		vault.EncodeBase64URL(vkA),
		vault.EncodeBase64URL(vkB),
		"Desktop Hello",
		"YubiKey Renamed Under KS",
	} {
		if secret != "" && strings.Contains(combined, secret) {
			t.Fatalf("logs or audit leaked sensitive/body value %q", secret)
		}
	}
}

// TestPasskeyOptionsSharedRateLimitBucket21stRequestReturns429 verifies plan mục 2.4 & Task 13:
// `POST /vault/passkeys/register/options` and `POST /vault/unlock/passkey/options` share the
// `vault_passkey_options` bucket (20 requests / minute / user); the 21st request within 1 minute
// across both routes is rejected with 429 rate_limited + Retry-After.
func TestPasskeyOptionsSharedRateLimitBucket21stRequestReturns429(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()

	jar, me := h.signupUser("pk-ratelimit@example.com", "correct-horse-battery-staple")
	resp, raw := h.doReq(jar, http.MethodPost, "/api/v1/vault", mustJSON(t, makeCreatePayload(t, 0x22)), reqOptions{
		idemKey: "idem-pk-ratelimit-create",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", resp.StatusCode, raw)
	}

	va := webauthntest.New()
	vk := seqTestBytes(vault.VKBytes, 0x33)
	h.seedPasskeyWithVA(ctx, va, me.User.ID, vk, "Primary Passkey", 0x44)

	// Send 10 requests to POST /vault/passkeys/register/options and 10 requests to POST /vault/unlock/passkey/options
	// within the same 1-minute sliding window (total = 20 allowed requests).
	for i := range 10 {
		r1, b1 := h.doReq(jar, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
		if r1.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("register/options request %d unexpectedly rate-limited: %s", i+1, b1)
		}
		r2, b2 := h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
		if r2.StatusCode != http.StatusOK {
			t.Fatalf("unlock/options request %d status = %d, want 200: %s", i+1, r2.StatusCode, b2)
		}
	}

	// 21st request (on unlock/options) in the same 1-minute window -> 429 rate_limited + Retry-After.
	resp21, raw21 := h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp21.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("21st options request status = %d, want 429: %s", resp21.StatusCode, raw21)
	}
	if decodeProblem(t, raw21).Code != "rate_limited" {
		t.Fatalf("21st options problem code = %q, want rate_limited", decodeProblem(t, raw21).Code)
	}
	if resp21.Header.Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 response")
	}

	// 22nd request on register/options in the same window also hits 429 (shared bucket).
	resp22, raw22 := h.doReq(jar, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
	if resp22.StatusCode != http.StatusTooManyRequests || decodeProblem(t, raw22).Code != "rate_limited" {
		t.Fatalf("register/options after shared bucket exhausted: status=%d body=%s", resp22.StatusCode, raw22)
	}

	// Advance clock past 1 minute -> quota recovers without blocked requests extending the window.
	h.clk.Advance(61 * time.Second)
	respAfter, rawAfter := h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if respAfter.StatusCode != http.StatusOK {
		t.Fatalf("unlock/options after 61s advance = %d, want 200: %s", respAfter.StatusCode, rawAfter)
	}
}

// TestPasskeyRegisterRenameUnlockAndRevokeFullLifecycleHTTP exercises the full HTTP ceremony across
// register/options -> POST /vault/passkeys -> PATCH /vault/passkeys/{id} -> POST /vault/unlock/passkey/options -> DELETE /vault/passkeys/{id}.
func TestPasskeyRegisterRenameUnlockAndRevokeFullLifecycleHTTP(t *testing.T) {
	h := newHarness(t, harnessOpts{})

	password := "correct-horse-battery-staple"
	jar, _ := h.signupUser("pk-lifecycle@example.com", password)
	resp, raw := h.doReq(jar, http.MethodPost, "/api/v1/vault", mustJSON(t, makeCreatePayload(t, 0x31)), reqOptions{
		idemKey: "idem-pk-lifecycle-create",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", resp.StatusCode, raw)
	}

	va := webauthntest.New()
	vk := seqTestBytes(vault.VKBytes, 0x52)
	rp := h.vaultSvc.WebAuthnConfig()
	regGrant := h.reauthGrant(jar, "vault.passkey_register", password)
	revokeGrant := h.reauthGrant(jar, "vault.passkey_revoke", password)

	// 1. Register passkey #1 via POST /vault/passkeys/register/options + POST /vault/passkeys.
	resp, raw = h.doReq(jar, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register/options = %d %s", resp.StatusCode, raw)
	}
	var regOpts vault.PasskeyRegisterOptionsResponse
	if err := json.Unmarshal([]byte(raw), &regOpts); err != nil {
		t.Fatalf("decode register/options: %v", err)
	}
	prfSaltBytes, err := vault.DecodeBase64URLStrict(regOpts.PRFSalt, vault.WebAuthnPRFSaltBytes)
	if err != nil {
		t.Fatalf("decode prf_salt: %v", err)
	}
	ceremonyRes, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: regOpts.PublicKey.Challenge,
		PRFSalt:      prfSaltBytes,
	})
	if err != nil {
		t.Fatalf("va.CreateCredential: %v", err)
	}
	vkWrapB64, err := vault.SealWrapBase64URL(vault.WrapKindPRF, vk, ceremonyRes.PRFOutput, seqTestBytes(vault.WrapNonceBytes, 0x66))
	if err != nil {
		t.Fatalf("SealWrapBase64URL: %v", err)
	}

	createBody := mustJSON(t, map[string]any{
		"challenge_id": regOpts.ChallengeID.String(),
		"attestation": map[string]any{
			"client_data_json":   ceremonyRes.ClientDataJSONB64,
			"attestation_object": ceremonyRes.AttestationObjectB64,
		},
		"prf_salt": regOpts.PRFSalt,
		"vk_wrap":  vkWrapB64,
		"name":     "Initial Key Name",
	})
	resp, raw = h.doReq(jar, http.MethodPost, "/api/v1/vault/passkeys", createBody, reqOptions{
		idemKey: "idem-pk-lifecycle-reg-1",
		grant:   regGrant,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault/passkeys = %d %s", resp.StatusCode, raw)
	}
	var createdPK vault.PasskeyItem
	if err := json.Unmarshal([]byte(raw), &createdPK); err != nil {
		t.Fatalf("decode created passkey: %v", err)
	}

	// 2. Rename the registered passkey via PATCH /vault/passkeys/{id}.
	resp, raw = h.doReq(jar, http.MethodPatch, "/api/v1/vault/passkeys/"+createdPK.ID.String(), `{"name":"Renamed Lifecycle Key"}`, reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /vault/passkeys/{id} = %d %s", resp.StatusCode, raw)
	}

	// 3. Request unlock options via POST /vault/unlock/passkey/options and unwrap VK locally.
	resp, raw = h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /vault/unlock/passkey/options = %d %s", resp.StatusCode, raw)
	}
	var unlockOpts vault.PasskeyUnlockOptionsResponse
	if err := json.Unmarshal([]byte(raw), &unlockOpts); err != nil {
		t.Fatalf("decode unlock options: %v", err)
	}
	if len(unlockOpts.Credentials) != 1 || unlockOpts.Credentials[0].ID != ceremonyRes.CredentialIDB64 {
		t.Fatalf("unlockOpts.Credentials = %+v, want 1 item with id=%s", unlockOpts.Credentials, ceremonyRes.CredentialIDB64)
	}
	evalSaltB64 := unlockOpts.PublicKey.Extensions.PRF.EvalByCredential[ceremonyRes.CredentialIDB64].First
	evalSaltBytes, err := vault.DecodeBase64URLStrict(evalSaltB64, vault.WebAuthnPRFSaltBytes)
	if err != nil {
		t.Fatalf("decode evalByCredential salt: %v", err)
	}
	pwk, err := va.EvaluatePRF(ceremonyRes.CredentialIDB64, evalSaltBytes)
	if err != nil {
		t.Fatalf("va.EvaluatePRF: %v", err)
	}
	unwrappedVK, err := vault.OpenWrapBase64URL(vault.WrapKindPRF, unlockOpts.Credentials[0].VKWrap, pwk)
	if err != nil || !bytes.Equal(unwrappedVK, vk) {
		t.Fatalf("OpenWrapBase64URL mismatch: err=%v", err)
	}

	// 4. Revoke the passkey via DELETE /vault/passkeys/{id}; subsequent unlock options returns 404 passkey_not_found.
	resp, raw = h.doReq(jar, http.MethodDelete, "/api/v1/vault/passkeys/"+createdPK.ID.String(), "", reqOptions{
		grant: revokeGrant,
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /vault/passkeys/{id} = %d %s", resp.StatusCode, raw)
	}
	resp, raw = h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/passkey/options", "", reqOptions{})
	if resp.StatusCode != http.StatusNotFound || decodeProblem(t, raw).Code != "passkey_not_found" {
		t.Fatalf("unlock options after revoke: status=%d body=%s", resp.StatusCode, raw)
	}
}

// TestPasskeyRevoke_RollbackOnAuditAndNoticeFailureHTTP covers BE1-4 / BE1-8 for revoke over HTTP:
// injects failures inside the DELETE /vault/passkeys/{id} mutation transaction AFTER DeletePasskeyByOwner:
//  1. Postgres trigger raising on audit_log INSERT (event = 'passkey.revoke') -> rolls back credential
//     deletion; credential remains in vault_passkey and GET /vault/passkeys, with 0 passkey.revoke audits
//     and 0 security notices.
//  2. Postgres trigger raising on user_notification INSERT (kind = 'security') -> rolls back both
//     credential deletion and audit insert; credential remains intact with 0 passkey.revoke audits and
//     0 security notices.
func TestPasskeyRevoke_RollbackOnAuditAndNoticeFailureHTTP(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()

	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("pk-revoke-rollback@example.com", password)
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, makeCreatePayload(t, 0x35)), reqOptions{
		idemKey: "idem-pk-revoke-rb-create",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", resp.StatusCode, raw)
	}

	va := webauthntest.New()
	vk := seqTestBytes(vault.VKBytes, 0x77)
	pk := h.seedPasskeyWithVA(ctx, va, meA.User.ID, vk, "Rollback Protected Key", 0x91)
	revokeGrant := h.reauthGrant(jarA, "vault.passkey_revoke", password)

	assertCredentialPreservedAndNoSideEffects := func(step string) {
		t.Helper()
		dbRow, err := gen.New(h.pool).GetPasskeyByUserAndID(ctx, gen.GetPasskeyByUserAndIDParams{
			UserID: meA.User.ID,
			ID:     pk.row.ID,
		})
		if err != nil || dbRow.Name != "Rollback Protected Key" {
			t.Fatalf("%s: passkey missing or altered after rollback: row=%+v err=%v", step, dbRow, err)
		}
		list := h.listPasskeysForTest(jarA)
		if len(list.Items) != 1 || list.Items[0].ID != pk.row.ID {
			t.Fatalf("%s: GET /vault/passkeys = %+v, want [%s]", step, list.Items, pk.row.ID)
		}
		var audits, notices int
		if err := h.pool.QueryRow(ctx,
			`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
			meA.User.ID, vault.EventPasskeyRevoke,
		).Scan(&audits); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx,
			`SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`,
			meA.User.ID,
		).Scan(&notices); err != nil {
			t.Fatal(err)
		}
		if audits != 0 || notices != 0 {
			t.Fatalf("%s: leftover side effects after revoke rollback: audits=%d notices=%d, want 0/0", step, audits, notices)
		}
	}

	// 1. Trigger failure on audit_log INSERT (after DeletePasskeyByOwner has run in the tx).
	if _, err := h.pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_fail_passkey_revoke_audit() RETURNS trigger AS $$
		BEGIN
			IF NEW.user_id = '`+meA.User.ID.String()+`'::uuid AND NEW.event = 'passkey.revoke' THEN
				RAISE EXCEPTION 'simulated passkey.revoke audit failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER trg_fail_passkey_revoke_audit
		BEFORE INSERT ON audit_log
		FOR EACH ROW EXECUTE FUNCTION test_fail_passkey_revoke_audit();
	`); err != nil {
		t.Fatalf("create revoke audit trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(ctx, `
			DROP TRIGGER IF EXISTS trg_fail_passkey_revoke_audit ON audit_log;
			DROP FUNCTION IF EXISTS test_fail_passkey_revoke_audit();
		`)
	})

	resp1, raw1 := h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pk.row.ID.String(), "", reqOptions{
		grant: revokeGrant,
	})
	assertPasskeyProblem(t, resp1, raw1, http.StatusInternalServerError, "internal_error")
	assertCredentialPreservedAndNoSideEffects("audit_log failure")

	if _, err := h.pool.Exec(ctx, `
		DROP TRIGGER trg_fail_passkey_revoke_audit ON audit_log;
		DROP FUNCTION test_fail_passkey_revoke_audit();
	`); err != nil {
		t.Fatalf("drop revoke audit trigger: %v", err)
	}

	// 2. Trigger failure on user_notification INSERT (after DeletePasskeyByOwner AND RecordAuditTx have run).
	if _, err := h.pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_fail_passkey_revoke_notice() RETURNS trigger AS $$
		BEGIN
			IF NEW.user_id = '`+meA.User.ID.String()+`'::uuid AND NEW.kind = 'security' THEN
				RAISE EXCEPTION 'simulated passkey.revoke notice failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER trg_fail_passkey_revoke_notice
		BEFORE INSERT ON user_notification
		FOR EACH ROW EXECUTE FUNCTION test_fail_passkey_revoke_notice();
	`); err != nil {
		t.Fatalf("create revoke notice trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(ctx, `
			DROP TRIGGER IF EXISTS trg_fail_passkey_revoke_notice ON user_notification;
			DROP FUNCTION IF EXISTS test_fail_passkey_revoke_notice();
		`)
	})

	resp2, raw2 := h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pk.row.ID.String(), "", reqOptions{
		grant: revokeGrant,
	})
	assertPasskeyProblem(t, resp2, raw2, http.StatusInternalServerError, "internal_error")
	assertCredentialPreservedAndNoSideEffects("user_notification failure")

	if _, err := h.pool.Exec(ctx, `
		DROP TRIGGER trg_fail_passkey_revoke_notice ON user_notification;
		DROP FUNCTION test_fail_passkey_revoke_notice();
	`); err != nil {
		t.Fatalf("drop revoke notice trigger: %v", err)
	}

	// 3. With triggers removed, DELETE /vault/passkeys/{id} succeeds (204) and commits deletion + audit + notice.
	resp3, raw3 := h.doReq(jarA, http.MethodDelete, "/api/v1/vault/passkeys/"+pk.row.ID.String(), "", reqOptions{
		grant: revokeGrant,
	})
	if resp3.StatusCode != http.StatusNoContent || raw3 != "" {
		t.Fatalf("DELETE after rollback recovery = %d %q, want 204", resp3.StatusCode, raw3)
	}
}
