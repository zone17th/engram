package vaulthttp_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/compose"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/vaulthttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/webauthntest"
)

func (h *harness) registerPasskeyOptions(j cookieJar) vault.PasskeyRegisterOptionsResponse {
	h.t.Helper()
	resp, raw := h.doReq(j, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("POST /vault/passkeys/register/options = %d %s", resp.StatusCode, raw)
	}
	if gotCC := resp.Header.Get("Cache-Control"); gotCC != "no-store" {
		h.t.Fatalf("Cache-Control = %q, want no-store", gotCC)
	}
	var out vault.PasskeyRegisterOptionsResponse
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		h.t.Fatalf("unmarshal PasskeyRegisterOptionsResponse: %v (%s)", err, raw)
	}
	return out
}

func (h *harness) loginPasskeyTestUser(email, password string) cookieJar {
	h.t.Helper()
	j := cookieJar{}
	resp, raw := h.doReq(j, http.MethodGet, "/api/v1/auth/csrf", "", reqOptions{noCSRF: true})
	if resp.StatusCode != http.StatusNoContent {
		h.t.Fatalf("csrf = %d %s", resp.StatusCode, raw)
	}
	payload := `{"email":"` + email + `","password":"` + password + `"}`
	resp, raw = h.doReq(j, http.MethodPost, "/api/v1/auth/login", payload, reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("login %s = %d %s", email, resp.StatusCode, raw)
	}
	return j
}

func (h *harness) reauthGrantXFF(j cookieJar, action, password, xff string) string {
	h.t.Helper()
	payload := `{"action":"` + action + `","password":"` + password + `"}`
	req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/auth/reauth", strings.NewReader(payload))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	req.Header.Set("X-Forwarded-For", xff)
	j.apply(req)
	if c := j[authhttp.CookieCSRF]; c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var rawBuf bytes.Buffer
	_, _ = rawBuf.ReadFrom(resp.Body)
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("reauth %s = %d %s", action, resp.StatusCode, rawBuf.String())
	}
	var g auth.ReauthGrant
	if err := json.Unmarshal(rawBuf.Bytes(), &g); err != nil {
		h.t.Fatalf("decode grant: %v", err)
	}
	return g.Grant
}

func (h *harness) createPasskeyTestVault(j cookieJar, idemKey string, seed byte) vault.VaultCreatedResponse {
	h.t.Helper()
	p := makeCreatePayload(h.t, seed)
	resp, raw := h.doReq(j, http.MethodPost, "/api/v1/vault", mustJSON(h.t, p), reqOptions{
		idemKey: idemKey,
	})
	if resp.StatusCode != http.StatusCreated {
		h.t.Fatalf("POST /vault = %d %s", resp.StatusCode, raw)
	}
	var out vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		h.t.Fatalf("unmarshal VaultCreatedResponse: %v", err)
	}
	return out
}

func (h *harness) getPasskeyTestVault(j cookieJar) vault.VaultState {
	h.t.Helper()
	resp, raw := h.doReq(j, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("GET /vault = %d %s", resp.StatusCode, raw)
	}
	var out vault.VaultState
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		h.t.Fatalf("unmarshal VaultState: %v", err)
	}
	return out
}

func (h *harness) listPasskeysForTest(j cookieJar) vault.PasskeyList {
	h.t.Helper()
	resp, raw := h.doReq(j, http.MethodGet, "/api/v1/vault/passkeys", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("GET /vault/passkeys = %d %s", resp.StatusCode, raw)
	}
	var out vault.PasskeyList
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		h.t.Fatalf("unmarshal PasskeyList: %v", err)
	}
	return out
}

func assertPasskeyProblem(t *testing.T, resp testResponse, raw string, wantStatus int, wantCode string) {
	t.Helper()
	if resp.StatusCode != wantStatus {
		t.Fatalf("status = %d, want %d (body: %s)", resp.StatusCode, wantStatus, raw)
	}
	prob := decodeProblem(t, raw)
	if prob.Code != wantCode {
		t.Fatalf("problem.Code = %q, want %q (body: %s)", prob.Code, wantCode, raw)
	}
}

func makePasskeyCreateBody(
	t *testing.T,
	challengeID uuid.UUID,
	clientDataJSONB64 string,
	attestationObjectB64 string,
	prfSaltB64 string,
	vkWrapB64 string,
	name string,
	extraTopLevel map[string]any,
) string {
	t.Helper()
	payload := map[string]any{
		"challenge_id": challengeID.String(),
		"attestation": map[string]any{
			"client_data_json":   clientDataJSONB64,
			"attestation_object": attestationObjectB64,
		},
		"prf_salt": prfSaltB64,
		"vk_wrap":  vkWrapB64,
		"name":     name,
	}
	for k, v := range extraTopLevel {
		payload[k] = v
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return string(b)
}

// TestPasskeyRegisterOptionsAndCreate_EndToEndAndExcludeCredentials kiểm tra luồng đăng ký passkey đầy đủ:
//   - Khi chưa có vault -> 404 vault_absent trên cả register/options và POST /vault/passkeys.
//   - Khi đã có vault -> register/options trả challenge_id, public_key (RP, user, challenge, UV=required,
//     prf.eval.first = prf_salt, excludeCredentials) và lưu SHA-256(challenge) vào DB.
//   - POST /vault/passkeys trả 201 {id, name, aaguid, created_at}, không tăng vault.version,
//     ghi audit `passkey.register` + in-app security notice + gửi mail qua hàng đợi River (lỗi mail không rollback).
//   - Lần gọi register/options tiếp theo chứa mọi cred_id đã đăng ký trong excludeCredentials.
//   - Bỏ qua các trường `cred_id`, `pubkey`, `aaguid` do client gửi kèm bên ngoài attestation_object.
//   - Trùng cred_id -> 409 passkey_exists.
func TestPasskeyRegisterOptionsAndCreate_EndToEndAndExcludeCredentials(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()

	jarA, meA := h.signupUser("pk-e2e-a@example.com", "correcthorsebattery")
	// Verify email for user A so security notice email is queued via River.
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatalf("verify email: %v", err)
	}

	// 1. Before vault creation -> 404 vault_absent.
	respNoVault, rawNoVault := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
	assertPasskeyProblem(t, respNoVault, rawNoVault, http.StatusNotFound, "vault_absent")

	grantReg := h.reauthGrant(jarA, "vault.passkey_register", "correcthorsebattery")
	va := webauthntest.New()
	dummyChal := base64.RawURLEncoding.EncodeToString(seqTestBytes(32, 0x01))
	dummyAtt, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: dummyChal,
	})
	if err != nil {
		t.Fatal(err)
	}
	dummyBody := makePasskeyCreateBody(
		t,
		uuid.New(),
		dummyAtt.ClientDataJSONB64,
		dummyAtt.AttestationObjectB64,
		base64.RawURLEncoding.EncodeToString(seqTestBytes(32, 0x02)),
		makeWrapB64U(t, vault.WrapKindPRF, 0x03),
		"No Vault Key",
		nil,
	)
	respCreateNoVault, rawCreateNoVault := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", dummyBody, reqOptions{
		idemKey: "idem-pk-novault-0001",
		grant:   grantReg,
	})
	assertPasskeyProblem(t, respCreateNoVault, rawCreateNoVault, http.StatusNotFound, "vault_absent")

	// 2. Create vault for user A.
	created := h.createPasskeyTestVault(jarA, "idem-pk-create-vault-01", 0x10)
	if created.Version != 1 {
		t.Fatalf("initial version = %d, want 1", created.Version)
	}

	// 3. Request register options -> excludeCredentials is empty [].
	opts1 := h.registerPasskeyOptions(jarA)
	if len(opts1.PublicKey.ExcludeCredentials) != 0 {
		t.Fatalf("ExcludeCredentials = %+v, want empty", opts1.PublicKey.ExcludeCredentials)
	}
	if opts1.PublicKey.AuthenticatorSelection == nil || opts1.PublicKey.AuthenticatorSelection.UserVerification != "required" {
		t.Fatalf("expected userVerification=required, got %+v", opts1.PublicKey.AuthenticatorSelection)
	}

	// 4. Create credential via virtual authenticator and send client-supplied fake cred_id/pubkey/aaguid
	// at top-level to verify the server ignores them and extracts only from verified attestationObject.
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts1.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential 1: %v", err)
	}
	vkWrap1 := makeWrapB64U(t, vault.WrapKindPRF, 0x21)
	fakeClientCredID := base64.RawURLEncoding.EncodeToString(seqTestBytes(32, 0xFE))
	fakeClientPubKey := base64.RawURLEncoding.EncodeToString(seqTestBytes(64, 0xFD))
	fakeClientAAGUID := "11111111-2222-3333-4444-555555555555"

	body1 := makePasskeyCreateBody(
		t,
		opts1.ChallengeID,
		reg1.ClientDataJSONB64,
		reg1.AttestationObjectB64,
		opts1.PRFSalt,
		vkWrap1,
		"  Windows Hello Laptop  ",
		map[string]any{
			"cred_id": fakeClientCredID,
			"pubkey":  fakeClientPubKey,
			"aaguid":  fakeClientAAGUID,
		},
	)

	resp1, raw1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
		idemKey: "idem-pk-register-0001",
		grant:   grantReg,
	})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault/passkeys = %d %s", resp1.StatusCode, raw1)
	}
	var item1 vault.PasskeyItem
	if err := json.Unmarshal([]byte(raw1), &item1); err != nil {
		t.Fatalf("unmarshal PasskeyItem: %v", err)
	}
	if item1.Name != "Windows Hello Laptop" {
		t.Fatalf("item1.Name = %q, want 'Windows Hello Laptop'", item1.Name)
	}
	if item1.AAGUID == nil || *item1.AAGUID != reg1.AAGUIDString {
		t.Fatalf("item1.AAGUID = %v, want %q (client-sent fake aaguid %q must be ignored)", item1.AAGUID, reg1.AAGUIDString, fakeClientAAGUID)
	}

	// Verify DB row stores the attestation's real cred_id, pubkey, aaguid (NOT client-sent values).
	var dbCredID, dbPubKey, dbAAGUID []byte
	if err := h.pool.QueryRow(ctx, `SELECT cred_id, pubkey, aaguid FROM vault_passkey WHERE id = $1`, item1.ID).Scan(&dbCredID, &dbPubKey, &dbAAGUID); err != nil {
		t.Fatalf("query vault_passkey: %v", err)
	}
	if !bytes.Equal(dbCredID, reg1.CredentialID) {
		t.Fatal("DB cred_id did not match attestation credential ID")
	}
	if !bytes.Equal(dbPubKey, reg1.PublicKeyCOSE) {
		t.Fatal("DB pubkey did not match attestation COSE public key")
	}
	if !bytes.Equal(dbAAGUID, reg1.AAGUID) {
		t.Fatal("DB aaguid did not match attestation AAGUID")
	}

	// 5. Idempotent retry with the same Idempotency-Key and same body returns stored 201 without creating a second row,
	// even after the re-auth grant has expired ( > 5m).
	h.clk.Advance(6 * time.Minute)
	respRetry, rawRetry := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
		idemKey: "idem-pk-register-0001",
		grant:   grantReg, // now expired, but step 2 Idempotency.Lookup replays before RequireReauth!
	})
	if respRetry.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent retry status = %d, want 201 (%s)", respRetry.StatusCode, rawRetry)
	}
	var itemRetry vault.PasskeyItem
	if err := json.Unmarshal([]byte(rawRetry), &itemRetry); err != nil {
		t.Fatal(err)
	}
	if itemRetry.ID != item1.ID {
		t.Fatalf("idempotent retry ID = %s, want %s", itemRetry.ID, item1.ID)
	}
	var pkCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, meA.User.ID).Scan(&pkCount); err != nil {
		t.Fatal(err)
	}
	if pkCount != 1 {
		t.Fatalf("vault_passkey count after idempotent retry = %d, want 1", pkCount)
	}

	// 6. Verify vault.version is still 1, audit `passkey.register` + security notice + River mail job queued,
	// and mail failure does not roll back the committed passkey.
	vState := h.getPasskeyTestVault(jarA)
	if vState.Version != 1 {
		t.Fatalf("vault.version = %d, want 1", vState.Version)
	}

	var auditCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND result = 'success'`, meA.User.ID, vault.EventPasskeyRegister).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit passkey.register count = %d, want 1", auditCount)
	}

	var noticeCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, meA.User.ID).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("user_notification security count = %d, want 1", noticeCount)
	}

	// Deliver queued River security mail.
	jobsRun, err := h.runSecurityNoticeWorker(ctx, h.mail)
	if err != nil || jobsRun != 1 {
		t.Fatalf("runSecurityNoticeWorker: jobs=%d err=%v", jobsRun, err)
	}
	if gotMails := h.countSecurityMailsDelivered("pk-e2e-a@example.com"); gotMails != 1 {
		t.Fatalf("security mails delivered = %d, want 1", gotMails)
	}

	// 7. Next register/options includes item1's credential ID in excludeCredentials.
	opts2 := h.registerPasskeyOptions(jarA)
	if len(opts2.PublicKey.ExcludeCredentials) != 1 || opts2.PublicKey.ExcludeCredentials[0].ID != reg1.CredentialIDB64 {
		t.Fatalf("opts2 ExcludeCredentials = %+v, want [%s]", opts2.PublicKey.ExcludeCredentials, reg1.CredentialIDB64)
	}

	// 8. Duplicate cred_id (re-registering the same CredentialID on a new challenge) -> 409 passkey_exists.
	grantReg2 := h.reauthGrant(jarA, "vault.passkey_register", "correcthorsebattery")
	dupReg, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts2.PublicKey.Challenge,
		CredentialID: reg1.CredentialID,
	})
	if err != nil {
		t.Fatal(err)
	}
	dupBody := makePasskeyCreateBody(
		t,
		opts2.ChallengeID,
		dupReg.ClientDataJSONB64,
		dupReg.AttestationObjectB64,
		opts2.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x22),
		"Duplicate Cred Key",
		nil,
	)
	respDup, rawDup := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", dupBody, reqOptions{
		idemKey: "idem-pk-register-dup-01",
		grant:   grantReg2,
	})
	assertPasskeyProblem(t, respDup, rawDup, http.StatusConflict, "passkey_exists")

	// 9. Verify audit_log, user_notification, and slog logs contain NO secrets/pubkeys/attestation/prf_salt/vk_wrap/body.
	var metaDump string
	rows, err := h.pool.Query(ctx, `SELECT COALESCE(meta::text, '') FROM audit_log WHERE user_id = $1 UNION ALL SELECT COALESCE(meta::text, '') FROM user_notification WHERE user_id = $1`, meA.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		metaDump += m + "\n"
	}
	rows.Close()

	forbiddenSubstrings := []string{
		reg1.ClientDataJSONB64,
		reg1.AttestationObjectB64,
		reg1.PublicKeyB64,
		reg1.CredentialIDB64,
		opts1.PRFSalt,
		vkWrap1,
		"Windows Hello Laptop",
	}
	logStr := h.logs.String()
	for _, secret := range forbiddenSubstrings {
		if secret == "" {
			continue
		}
		if strings.Contains(metaDump, secret) {
			t.Fatalf("audit/notification meta leaked forbidden value %q", secret)
		}
		if strings.Contains(logStr, secret) {
			t.Fatalf("slog output leaked forbidden value %q", secret)
		}
	}

	// 10. Simulate mail adapter failure after commit: registration still commits 201 and does not roll back.
	opts3 := h.registerPasskeyOptions(jarA)
	reg3, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts3.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	body3 := makePasskeyCreateBody(
		t,
		opts3.ChallengeID,
		reg3.ClientDataJSONB64,
		reg3.AttestationObjectB64,
		opts3.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x23),
		"Backup Security Key",
		nil,
	)
	resp3, raw3 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body3, reqOptions{
		idemKey: "idem-pk-register-mailfail-01",
		grant:   grantReg2,
	})
	if resp3.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault/passkeys 3 = %d %s", resp3.StatusCode, raw3)
	}
	failingMailer := failingMailerFunc(func(context.Context, string, string, string) error {
		return errors.New("smtp down")
	})
	if _, err := h.runSecurityNoticeWorker(ctx, failingMailer); err == nil {
		t.Fatal("expected worker error when mailer fails")
	}
	listAfterMailFail := h.listPasskeysForTest(jarA)
	if len(listAfterMailFail.Items) != 2 {
		t.Fatalf("passkeys count after mail failure = %d, want 2", len(listAfterMailFail.Items))
	}
}

type failingMailerFunc func(ctx context.Context, recipient, purpose, link string) error

func (f failingMailerFunc) Send(ctx context.Context, recipient, purpose, link string) error {
	return f(ctx, recipient, purpose, link)
}

var _ auth.Mailer = failingMailerFunc(nil)

// TestPasskeyRegister_ChallengeAndAttestationRejections kiểm tra toàn bộ ma trận từ chối của Task 13:
//   - Challenge replay (dùng lại challenge đã thành công) -> 400 passkey_challenge_invalid.
//   - Challenge hết hạn (> 5 phút) -> 400 passkey_challenge_invalid.
//   - Sai session (xin options ở session 1, gọi POST ở session 2 của cùng user) -> 400 passkey_challenge_invalid.
//   - Sai vault_key_id (reset rồi tạo lại vault giữa bước xin options và bước POST) -> 400 passkey_challenge_invalid.
//   - prf_salt không khớp challenge -> 400 passkey_challenge_invalid.
//   - Sai challenge trong clientDataJSON -> 400 passkey_challenge_invalid.
//   - Sai origin (khác host hoặc cùng host nhưng sai port dev) -> 400 passkey_attestation_invalid.
//   - Sai rpIdHash -> 400 passkey_attestation_invalid.
//   - Thiếu cờ UV (User Verified) hoặc UP (User Present) -> 400 passkey_attestation_invalid.
//   - Sai ceremony type ("webauthn.get") hoặc hỏng CBOR attestationObject -> 400 passkey_attestation_invalid.
//   - Tên rỗng / chỉ khoảng trắng / > 64 rune / chứa ký tự điều khiển hoặc bidi override -> 400 passkey_name_invalid.
//   - Thiếu hoặc sai grant re-auth (sai action) -> 401 reauth_required / reauth_invalid.
func TestPasskeyRegister_ChallengeAndAttestationRejections(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	va := webauthntest.New()

	jarA1, _ := h.signupUser("pk-matrix-a@example.com", "correcthorsebattery")
	jarA2 := h.loginPasskeyTestUser("pk-matrix-a@example.com", "correcthorsebattery")

	v1 := h.createPasskeyTestVault(jarA1, "idem-pk-matrix-create-1", 0x30)
	grantReg1 := h.reauthGrant(jarA1, "vault.passkey_register", "correcthorsebattery")

	// 1. Challenge replay: register once (201), then send a new request (new Idempotency-Key) reusing the same challenge -> 400 passkey_challenge_invalid.
	optsReplay := h.registerPasskeyOptions(jarA1)
	regReplay, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsReplay.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	bodyReplay1 := makePasskeyCreateBody(
		t,
		optsReplay.ChallengeID,
		regReplay.ClientDataJSONB64,
		regReplay.AttestationObjectB64,
		optsReplay.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x31),
		"First Use Key",
		nil,
	)
	respFirst, rawFirst := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodyReplay1, reqOptions{
		idemKey: "idem-pk-replay-first-01",
		grant:   grantReg1,
	})
	if respFirst.StatusCode != http.StatusCreated {
		t.Fatalf("first register = %d %s", respFirst.StatusCode, rawFirst)
	}

	regReplay2, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsReplay.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	bodyReplay2 := makePasskeyCreateBody(
		t,
		optsReplay.ChallengeID,
		regReplay2.ClientDataJSONB64,
		regReplay2.AttestationObjectB64,
		optsReplay.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x32),
		"Second Use Replay",
		nil,
	)
	respSecond, rawSecond := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodyReplay2, reqOptions{
		idemKey: "idem-pk-replay-second-02",
		grant:   grantReg1,
	})
	assertPasskeyProblem(t, respSecond, rawSecond, http.StatusBadRequest, "passkey_challenge_invalid")

	// 2. Wrong session: options requested in jarA1, POST submitted in jarA2 (different session of same user) -> 400 passkey_challenge_invalid.
	optsSess := h.registerPasskeyOptions(jarA1)
	regSess, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsSess.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	grantRegA2 := h.reauthGrant(jarA2, "vault.passkey_register", "correcthorsebattery")
	bodySess := makePasskeyCreateBody(
		t,
		optsSess.ChallengeID,
		regSess.ClientDataJSONB64,
		regSess.AttestationObjectB64,
		optsSess.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x33),
		"Wrong Session Key",
		nil,
	)
	respSess, rawSess := h.doReq(jarA2, http.MethodPost, "/api/v1/vault/passkeys", bodySess, reqOptions{
		idemKey: "idem-pk-wrong-session-01",
		grant:   grantRegA2,
	})
	assertPasskeyProblem(t, respSess, rawSess, http.StatusBadRequest, "passkey_challenge_invalid")

	// 3. prf_salt mismatch -> 400 passkey_challenge_invalid.
	optsSalt := h.registerPasskeyOptions(jarA1)
	regSalt, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsSalt.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	wrongSaltB64 := base64.RawURLEncoding.EncodeToString(seqTestBytes(32, 0x99))
	bodySalt := makePasskeyCreateBody(
		t,
		optsSalt.ChallengeID,
		regSalt.ClientDataJSONB64,
		regSalt.AttestationObjectB64,
		wrongSaltB64,
		makeWrapB64U(t, vault.WrapKindPRF, 0x34),
		"Wrong Salt Key",
		nil,
	)
	respSalt, rawSalt := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodySalt, reqOptions{
		idemKey: "idem-pk-wrong-salt-0001",
		grant:   grantReg1,
	})
	assertPasskeyProblem(t, respSalt, rawSalt, http.StatusBadRequest, "passkey_challenge_invalid")

	// 4. Wrong challenge in clientDataJSON -> 400 passkey_challenge_invalid.
	optsWrongChal := h.registerPasskeyOptions(jarA1)
	otherChalB64 := base64.RawURLEncoding.EncodeToString(seqTestBytes(32, 0xAB))
	regWrongChal, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:                 h.vaultSvc.WebAuthnRPID(),
		Origin:               h.origin,
		ChallengeB64:         optsWrongChal.PublicKey.Challenge,
		OverrideChallengeB64: otherChalB64,
	})
	if err != nil {
		t.Fatal(err)
	}
	bodyWrongChal := makePasskeyCreateBody(
		t,
		optsWrongChal.ChallengeID,
		regWrongChal.ClientDataJSONB64,
		regWrongChal.AttestationObjectB64,
		optsWrongChal.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x35),
		"Wrong Challenge Key",
		nil,
	)
	respWrongChal, rawWrongChal := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodyWrongChal, reqOptions{
		idemKey: "idem-pk-wrong-chal-0001",
		grant:   grantReg1,
	})
	assertPasskeyProblem(t, respWrongChal, rawWrongChal, http.StatusBadRequest, "passkey_challenge_invalid")

	// 5. Attestation verification failures (wrong origin, wrong dev port, wrong rpIdHash, missing UV, missing UP, wrong type, broken CBOR) -> 400 passkey_attestation_invalid.
	attestationCases := []struct {
		name   string
		idem   string
		mutate func(chal string) webauthntest.RegistrationOptions
	}{
		{
			name: "wrong origin host",
			idem: "idem-pk-att-wrong-origin-1",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:           h.vaultSvc.WebAuthnRPID(),
					Origin:         h.origin,
					ChallengeB64:   chal,
					OverrideOrigin: "https://evil.example.com",
				}
			},
		},
		{
			name: "wrong dev port on same host",
			idem: "idem-pk-att-wrong-port-02",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:           h.vaultSvc.WebAuthnRPID(),
					Origin:         h.origin,
					ChallengeB64:   chal,
					OverrideOrigin: "http://127.0.0.1:1",
				}
			},
		},
		{
			name: "wrong rpIdHash",
			idem: "idem-pk-att-wrong-rpid-03",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:                h.vaultSvc.WebAuthnRPID(),
					Origin:              h.origin,
					ChallengeB64:        chal,
					OverrideRPIDForHash: "evil.example.com",
				}
			},
		},
		{
			name: "missing UV flag",
			idem: "idem-pk-att-no-uv-flag-04",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:                    h.vaultSvc.WebAuthnRPID(),
					Origin:                  h.origin,
					ChallengeB64:            chal,
					DisableUserVerification: true,
				}
			},
		},
		{
			name: "missing UP flag",
			idem: "idem-pk-att-no-up-flag-05",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:                h.vaultSvc.WebAuthnRPID(),
					Origin:              h.origin,
					ChallengeB64:        chal,
					DisableUserPresence: true,
				}
			},
		},
		{
			name: "wrong ceremony type webauthn.get",
			idem: "idem-pk-att-wrong-type-06",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:                 h.vaultSvc.WebAuthnRPID(),
					Origin:               h.origin,
					ChallengeB64:         chal,
					OverrideCeremonyType: "webauthn.get",
				}
			},
		},
		{
			name: "broken CBOR attestationObject",
			idem: "idem-pk-att-broken-cbor-7",
			mutate: func(chal string) webauthntest.RegistrationOptions {
				return webauthntest.RegistrationOptions{
					RPID:                   h.vaultSvc.WebAuthnRPID(),
					Origin:                 h.origin,
					ChallengeB64:           chal,
					CorruptAttestationCBOR: true,
				}
			},
		},
	}

	for _, tc := range attestationCases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := h.pool.Exec(context.Background(), "DELETE FROM rate_event"); err != nil {
				t.Fatal(err)
			}
			opts := h.registerPasskeyOptions(jarA1)
			badAtt, err := va.CreateCredential(tc.mutate(opts.PublicKey.Challenge))
			if err != nil {
				t.Fatalf("CreateCredential: %v", err)
			}
			b := makePasskeyCreateBody(
				t,
				opts.ChallengeID,
				badAtt.ClientDataJSONB64,
				badAtt.AttestationObjectB64,
				opts.PRFSalt,
				makeWrapB64U(t, vault.WrapKindPRF, 0x36),
				"Attestation Test Key",
				nil,
			)
			resp, raw := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", b, reqOptions{
				idemKey: tc.idem,
				grant:   grantReg1,
			})
			assertPasskeyProblem(t, resp, raw, http.StatusBadRequest, "passkey_attestation_invalid")

			// T-3: Verify the challenge was burned before attestation verification failed:
			// consumed_at is set and reusing the same challenge with a valid attestation returns 400 passkey_challenge_invalid.
			var consumedAt pgtype.Timestamptz
			if err := h.pool.QueryRow(context.Background(), `SELECT consumed_at FROM webauthn_challenge WHERE id = $1`, opts.ChallengeID).Scan(&consumedAt); err != nil {
				t.Fatalf("query webauthn_challenge consumed_at: %v", err)
			}
			if !consumedAt.Valid {
				t.Fatalf("expected challenge %s to be burned (consumed_at valid) after rejected attestation", opts.ChallengeID)
			}
			validRetryAtt, err := va.CreateCredential(webauthntest.RegistrationOptions{
				RPID:         h.vaultSvc.WebAuthnRPID(),
				Origin:       h.origin,
				ChallengeB64: opts.PublicKey.Challenge,
			})
			if err != nil {
				t.Fatalf("CreateCredential retry: %v", err)
			}
			retryBody := makePasskeyCreateBody(
				t,
				opts.ChallengeID,
				validRetryAtt.ClientDataJSONB64,
				validRetryAtt.AttestationObjectB64,
				opts.PRFSalt,
				makeWrapB64U(t, vault.WrapKindPRF, 0x36),
				"Retry After Rejected Attestation",
				nil,
			)
			respBurned, rawBurned := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", retryBody, reqOptions{
				idemKey: tc.idem + "-retry",
				grant:   grantReg1,
			})
			assertPasskeyProblem(t, respBurned, rawBurned, http.StatusBadRequest, "passkey_challenge_invalid")
		})
	}
	// 6. Name invalid (empty, whitespace, 65 runes, bidi override, control char) -> 400 passkey_name_invalid.
	badNames := []struct {
		label string
		name  string
		idem  string
	}{
		{"empty", "", "idem-pk-badname-empty-01"},
		{"whitespace only", "   ", "idem-pk-badname-space-02"},
		{"65 runes", strings.Repeat("k", 65), "idem-pk-badname-65run-03"},
		{"bidi RLO U+202E", "Key\u202EName", "idem-pk-badname-bidi1-04"},
		{"bidi RLI U+2067", "Key\u2067Name", "idem-pk-badname-bidi2-05"},
		{"bidi ALM U+061C", "Key\u061CName", "idem-pk-badname-bidi3-06"},
		{"control char", "Key\x00Name", "idem-pk-badname-ctrl0-07"},
	}
	optsForName := h.registerPasskeyOptions(jarA1)
	regForName, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsForName.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, bn := range badNames {
		t.Run("name_"+bn.label, func(t *testing.T) {
			if _, err := h.pool.Exec(context.Background(), "DELETE FROM rate_event"); err != nil {
				t.Fatal(err)
			}
			b := makePasskeyCreateBody(
				t,
				optsForName.ChallengeID,
				regForName.ClientDataJSONB64,
				regForName.AttestationObjectB64,
				optsForName.PRFSalt,
				makeWrapB64U(t, vault.WrapKindPRF, 0x37),
				bn.name,
				nil,
			)
			resp, raw := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", b, reqOptions{
				idemKey: bn.idem,
				grant:   grantReg1,
			})
			assertPasskeyProblem(t, resp, raw, http.StatusBadRequest, "passkey_name_invalid")
		})
	}

	// 7. Missing grant or wrong action grant -> 401 reauth error.
	validBody := makePasskeyCreateBody(
		t,
		optsForName.ChallengeID,
		regForName.ClientDataJSONB64,
		regForName.AttestationObjectB64,
		optsForName.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x38),
		"Valid Key Name",
		nil,
	)
	respNoGrant, rawNoGrant := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", validBody, reqOptions{
		idemKey: "idem-pk-no-grant-000001",
	})
	if respNoGrant.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing grant status = %d, want 401 (%s)", respNoGrant.StatusCode, rawNoGrant)
	}
	probNoGrant := decodeProblem(t, rawNoGrant)
	if probNoGrant.Code != "reauth_required" && probNoGrant.Code != "reauth_invalid" {
		t.Fatalf("missing grant code = %q, want reauth_required or reauth_invalid", probNoGrant.Code)
	}

	wrongGrant := h.reauthGrantXFF(jarA1, "vault.rewrap", "correcthorsebattery", "198.51.100.11")
	respWrongGrant, rawWrongGrant := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", validBody, reqOptions{
		idemKey: "idem-pk-wrong-grant-001",
		grant:   wrongGrant,
	})
	assertPasskeyProblem(t, respWrongGrant, rawWrongGrant, http.StatusUnauthorized, "reauth_invalid")

	// 8. Wrong vault_key_id: reset vault and recreate between register/options and POST /vault/passkeys -> 400 passkey_challenge_invalid.
	optsBeforeReset := h.registerPasskeyOptions(jarA1)
	regBeforeReset, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsBeforeReset.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(context.Background(), "DELETE FROM rate_event"); err != nil {
		t.Fatal(err)
	}
	h.clk.Advance(61 * time.Second)
	grantReset := h.reauthGrantXFF(jarA1, "vault.reset", "correcthorsebattery", "198.51.100.12")
	ifMatchReset := `"` + v1.VaultKeyID + `:1"`
	respReset, rawReset := h.doReq(jarA1, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: "idem-pk-reset-vault-001",
		ifMatch: ifMatchReset,
		grant:   grantReset,
	})
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /vault = %d %s", respReset.StatusCode, rawReset)
	}
	v2 := h.createPasskeyTestVault(jarA1, "idem-pk-recreate-vault-2", 0x40)
	if v2.VaultKeyID == v1.VaultKeyID {
		t.Fatal("recreated vault must have a new vault_key_id")
	}

	grantRegAfterReset := h.reauthGrantXFF(jarA1, "vault.passkey_register", "correcthorsebattery", "198.51.100.13")
	bodyStaleVaultKeyID := makePasskeyCreateBody(
		t,
		optsBeforeReset.ChallengeID,
		regBeforeReset.ClientDataJSONB64,
		regBeforeReset.AttestationObjectB64,
		optsBeforeReset.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x41),
		"Stale VaultKeyID Passkey",
		nil,
	)
	respStaleVK, rawStaleVK := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodyStaleVaultKeyID, reqOptions{
		idemKey: "idem-pk-stale-vkid-0001",
		grant:   grantRegAfterReset,
	})
	assertPasskeyProblem(t, respStaleVK, rawStaleVK, http.StatusBadRequest, "passkey_challenge_invalid")

	// 9. Expired challenge (> 5 minutes) -> 400 passkey_challenge_invalid.
	optsExp := h.registerPasskeyOptions(jarA1)
	regExp, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: optsExp.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.clk.Advance(5*time.Minute + time.Second)
	grantRegAfterAdvance := h.reauthGrantXFF(jarA1, "vault.passkey_register", "correcthorsebattery", "198.51.100.14")
	bodyExp := makePasskeyCreateBody(
		t,
		optsExp.ChallengeID,
		regExp.ClientDataJSONB64,
		regExp.AttestationObjectB64,
		optsExp.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x42),
		"Expired Challenge Passkey",
		nil,
	)
	respExp, rawExp := h.doReq(jarA1, http.MethodPost, "/api/v1/vault/passkeys", bodyExp, reqOptions{
		idemKey: "idem-pk-expired-chal-01",
		grant:   grantRegAfterAdvance,
	})
	assertPasskeyProblem(t, respExp, rawExp, http.StatusBadRequest, "passkey_challenge_invalid")
}

// TestPasskeyRegisterOptions_RateLimit21stBlocked kiểm tra giới hạn tốc độ `vault_passkey_options`
// (20 yêu cầu / phút / user): 20 lần gọi đầu trả 200, lần thứ 21 trong 1 phút trả 429 rate_limited
// kèm header Retry-After.
func TestPasskeyRegisterOptions_RateLimit21stBlocked(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	jarA, _ := h.signupUser("pk-ratelimit-a@example.com", "correcthorsebattery")
	h.createPasskeyTestVault(jarA, "idem-pk-rl-create-0001", 0x50)

	for i := range 20 {
		resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("register/options #%d = %d %s", i+1, resp.StatusCode, raw)
		}
	}

	resp21, raw21 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys/register/options", "", reqOptions{})
	assertPasskeyProblem(t, resp21, raw21, http.StatusTooManyRequests, "rate_limited")
	if resp21.Header.Get("Retry-After") == "" {
		t.Fatal("429 response must include Retry-After header")
	}
}

// TestPasskeyCreate_KillSwitchAndIdempotentReplay kiểm tra KS-AC-1 (advisor-dec-022):
//   - Khi một thao tác `POST /vault/passkeys` đã commit (`status = 'done'`) trước khi bật công tắc dừng,
//     việc replay lại đúng `Idempotency-Key` và đúng body khi `VAULT_KEY_MUTATIONS_DISABLED=true`
//     vẫn trả lại response 201 đã lưu (vì `Idempotency.Lookup` đứng trước K).
//   - Mọi request tạo passkey mới khi công tắc dừng đang bật trả `503 vault_mutations_disabled`
//     mà không tiêu tốn rate_event và không tạo bản ghi claim idempotency.
//   - `POST /vault/passkeys/register/options` và `GET /vault/passkeys` không thuộc cột K nên vẫn trả 200.
func TestPasskeyCreate_KillSwitchAndIdempotentReplay(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	va := webauthntest.New()

	jarA, meA := h.signupUser("pk-killswitch-a@example.com", "correcthorsebattery")
	h.createPasskeyTestVault(jarA, "idem-pk-ks-create-vault", 0x60)

	opts1 := h.registerPasskeyOptions(jarA)
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts1.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	grantReg := h.reauthGrant(jarA, "vault.passkey_register", "correcthorsebattery")
	bodyCommitted := makePasskeyCreateBody(
		t,
		opts1.ChallengeID,
		reg1.ClientDataJSONB64,
		reg1.AttestationObjectB64,
		opts1.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x61),
		"Committed Before KillSwitch",
		nil,
	)

	const committedKey = "idem-pk-ks-committed-01"
	resp1, raw1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", bodyCommitted, reqOptions{
		idemKey: committedKey,
		grant:   grantReg,
	})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("initial POST /vault/passkeys = %d %s", resp1.StatusCode, raw1)
	}
	var item1 vault.PasskeyItem
	if err := json.Unmarshal([]byte(raw1), &item1); err != nil {
		t.Fatal(err)
	}

	// Turn on VAULT_KEY_MUTATIONS_DISABLED.
	hDisabled := h.withKillSwitch(true)

	var rateEventsBeforeReplay int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM rate_event WHERE user_id = $1 AND scope = 'vault_sensitive'`, meA.User.ID).Scan(&rateEventsBeforeReplay); err != nil {
		t.Fatal(err)
	}

	// 1. Replay of committed POST /vault/passkeys under killSwitch=true still returns stored 201!
	respReplay, rawReplay := hDisabled.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", bodyCommitted, reqOptions{
		idemKey: committedKey,
		grant:   grantReg,
	})
	if respReplay.StatusCode != http.StatusCreated {
		t.Fatalf("replay under killSwitch=true: status = %d, want 201 (%s)", respReplay.StatusCode, rawReplay)
	}
	var itemReplay vault.PasskeyItem
	if err := json.Unmarshal([]byte(rawReplay), &itemReplay); err != nil {
		t.Fatal(err)
	}
	if itemReplay.ID != item1.ID || itemReplay.Name != item1.Name {
		t.Fatalf("replay item = %+v, want %+v", itemReplay, item1)
	}
	// 2. New POST /vault/passkeys mutation under killSwitch=true returns 503 vault_mutations_disabled
	// before Reauth / RateLimit / Claim.
	opts2 := hDisabled.registerPasskeyOptions(jarA)
	reg2, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         hDisabled.vaultSvc.WebAuthnRPID(),
		Origin:       hDisabled.origin,
		ChallengeB64: opts2.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	bodyNew := makePasskeyCreateBody(
		t,
		opts2.ChallengeID,
		reg2.ClientDataJSONB64,
		reg2.AttestationObjectB64,
		opts2.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x62),
		"Blocked By KillSwitch",
		nil,
	)
	var rateEventsBeforeBlocked int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&rateEventsBeforeBlocked); err != nil {
		t.Fatal(err)
	}

	const blockedKey = "idem-pk-ks-blocked-0002"
	respBlocked, rawBlocked := hDisabled.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", bodyNew, reqOptions{
		idemKey: blockedKey,
		// Even without a grant, K runs before RequireReauth!
	})
	assertPasskeyProblem(t, respBlocked, rawBlocked, http.StatusServiceUnavailable, "vault_mutations_disabled")

	// T-4: Verify no rate_event row and no idempotency claim row were created for the blocked request.
	var rateEventsAfterBlocked, sensitiveRateEventsAfter int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&rateEventsAfterBlocked); err != nil {
		t.Fatal(err)
	}
	if rateEventsAfterBlocked != rateEventsBeforeBlocked {
		t.Fatalf("blocked request under kill switch must not record rate_event: before=%d after=%d", rateEventsBeforeBlocked, rateEventsAfterBlocked)
	}
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM rate_event WHERE user_id = $1 AND scope = 'vault_sensitive'`, meA.User.ID).Scan(&sensitiveRateEventsAfter); err != nil {
		t.Fatal(err)
	}
	if sensitiveRateEventsAfter != rateEventsBeforeReplay {
		t.Fatalf("vault_sensitive rate_event count changed under kill switch: before=%d after=%d", rateEventsBeforeReplay, sensitiveRateEventsAfter)
	}
	var claimRows int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, blockedKey).Scan(&claimRows); err != nil {
		t.Fatal(err)
	}
	if claimRows != 0 {
		t.Fatalf("blocked request under kill switch must not claim idempotency_key, got %d rows", claimRows)
	}
	// 3. GET /vault/passkeys is not in K and still returns 200 with the 1 committed passkey.
	list := hDisabled.listPasskeysForTest(jarA)
	if len(list.Items) != 1 {
		t.Fatalf("listPasskeysForTest under kill switch = %d items, want 1", len(list.Items))
	}
}

// pollTwoBlockedChallengeConsumers polls pg_stat_activity / pg_blocking_pids until two backends in
// current_database() are blocked directly or transitively on holderPID (the tx holding the FOR UPDATE
// lock on the target webauthn_challenge row), failing fast if either HTTP worker exits early.
func pollTwoBlockedChallengeConsumers(ctx context.Context, pool *pgxpool.Pool, holderPID int32, earlyDone <-chan int, formatEarly func(int) string) error {
	for {
		select {
		case idx := <-earlyDone:
			return fmt.Errorf("consumer %d exited before both consumers were blocked on holderPID=%d: %s", idx, holderPID, formatEarly(idx))
		default:
		}

		var blockedCount int
		if err := pool.QueryRow(ctx, `
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
		`, holderPID).Scan(&blockedCount); err != nil {
			return fmt.Errorf("query pg_blocking_pids for holderPID=%d: %w", holderPID, err)
		}
		if blockedCount >= 2 {
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting for 2 consumers blocked on holderPID=%d (last blockedCount=%d): %w", holderPID, blockedCount, ctx.Err())
		case idx := <-earlyDone:
			return fmt.Errorf("consumer %d exited before both consumers were blocked on holderPID=%d: %s", idx, holderPID, formatEarly(idx))
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestPasskeyRegister_ConcurrentChallengeConsumeDeterministic covers BE1-3 / BE1-7:
// two concurrent POST /vault/passkeys requests using ONE live challenge, DIFFERENT Idempotency-Keys,
// and DISTINCT credentials:
//   - holds the webauthn_challenge row lock in a separate transaction until PostgreSQL pg_stat_activity /
//     pg_blocking_pids confirms both consumers are blocked on the challenge row;
//   - releases the lock and asserts exactly one 201 Created and one 400 passkey_challenge_invalid;
//   - asserts exactly one new passkey (the winner's credential), one passkey.register audit, one security
//     notice, one done idempotency row for the winner, and the loser's in_progress claim is released.
func TestPasskeyRegister_ConcurrentChallengeConsumeDeterministic(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()
	va := webauthntest.New()

	jarA, meA := h.signupUser("pk-conc-consume@example.com", "correcthorsebattery")
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatalf("verify email: %v", err)
	}
	h.createPasskeyTestVault(jarA, "idem-pk-conc-create-vault", 0x10)
	grantReg := h.reauthGrant(jarA, "vault.passkey_register", "correcthorsebattery")

	opts := h.registerPasskeyOptions(jarA)
	reg0, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts.PublicKey.Challenge,
		CredentialID: seqTestBytes(32, 0xA1),
	})
	if err != nil {
		t.Fatalf("CreateCredential 0: %v", err)
	}
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts.PublicKey.Challenge,
		CredentialID: seqTestBytes(32, 0xB2),
	})
	if err != nil {
		t.Fatalf("CreateCredential 1: %v", err)
	}
	if bytes.Equal(reg0.CredentialID, reg1.CredentialID) {
		t.Fatal("credentials must have distinct CredentialIDs")
	}

	bodies := [2]string{
		makePasskeyCreateBody(
			t,
			opts.ChallengeID,
			reg0.ClientDataJSONB64,
			reg0.AttestationObjectB64,
			opts.PRFSalt,
			makeWrapB64U(t, vault.WrapKindPRF, 0x71),
			"Concurrent Key 0",
			nil,
		),
		makePasskeyCreateBody(
			t,
			opts.ChallengeID,
			reg1.ClientDataJSONB64,
			reg1.AttestationObjectB64,
			opts.PRFSalt,
			makeWrapB64U(t, vault.WrapKindPRF, 0x72),
			"Concurrent Key 1",
			nil,
		),
	}
	idemKeys := [2]string{
		"idem-pk-conc-consume-0001",
		"idem-pk-conc-consume-0002",
	}
	creds := [2][]byte{reg0.CredentialID, reg1.CredentialID}

	// Hold the webauthn_challenge row FOR UPDATE in a separate transaction so both concurrent
	// ConsumeWebAuthnChallenge UPDATEs block deterministically on the challenge row.
	lockTx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin lockTx: %v", err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()

	var holderPID int32
	if err := lockTx.QueryRow(ctx,
		`SELECT pg_backend_pid() FROM webauthn_challenge WHERE id = $1 FOR UPDATE`,
		opts.ChallengeID,
	).Scan(&holderPID); err != nil {
		t.Fatalf("lock webauthn_challenge FOR UPDATE: %v", err)
	}

	type consumerResult struct {
		status int
		body   string
		err    error
	}
	var results [2]consumerResult
	earlyDone := make(chan int, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			defer func() { earlyDone <- idx }()
			req, reqErr := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/vault/passkeys", strings.NewReader(bodies[idx]))
			if reqErr != nil {
				results[idx] = consumerResult{err: reqErr}
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", h.origin)
			req.Header.Set(httpx.HeaderIdempotencyKey, idemKeys[idx])
			req.Header.Set(authhttp.HeaderReauth, grantReg)
			jarA.apply(req)
			if c := jarA[authhttp.CookieCSRF]; c != nil {
				req.Header.Set(authhttp.HeaderCSRF, c.Value)
			}
			resp, doErr := http.DefaultClient.Do(req)
			if doErr != nil {
				results[idx] = consumerResult{err: doErr}
				return
			}
			defer func() { _ = resp.Body.Close() }()
			var buf bytes.Buffer
			_, _ = buf.ReadFrom(resp.Body)
			results[idx] = consumerResult{
				status: resp.StatusCode,
				body:   buf.String(),
			}
		}(i)
	}

	waitCtx, waitCancel := context.WithTimeout(ctx, 5*time.Second)
	defer waitCancel()
	if err := pollTwoBlockedChallengeConsumers(waitCtx, h.pool, holderPID, earlyDone, func(idx int) string {
		r := results[idx]
		return fmt.Sprintf("status=%d err=%v body=%s", r.status, r.err, r.body)
	}); err != nil {
		t.Fatal(err)
	}

	// Both distinct idempotency keys must be claimed as in_progress while blocked on the challenge row.
	var inProgressClaims int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key IN ($2, $3) AND status = 'in_progress'`,
		meA.User.ID, idemKeys[0], idemKeys[1],
	).Scan(&inProgressClaims); err != nil {
		t.Fatalf("count in_progress idempotency claims: %v", err)
	}
	if inProgressClaims != 2 {
		t.Fatalf("in_progress idempotency claims while blocked = %d, want 2", inProgressClaims)
	}

	// Release the row lock so both consumers race on the challenge row.
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
		t.Fatal("timeout waiting for concurrent passkey registration consumers to finish")
	}

	winnerIdx := -1
	loserIdx := -1
	for i := range 2 {
		if results[i].err != nil {
			t.Fatalf("consumer %d transport error: %v", i, results[i].err)
		}
		switch results[i].status {
		case http.StatusCreated:
			winnerIdx = i
		case http.StatusBadRequest:
			prob := decodeProblem(t, results[i].body)
			if prob.Code != "passkey_challenge_invalid" {
				t.Fatalf("consumer %d 400 problem.Code = %q, want passkey_challenge_invalid (%s)", i, prob.Code, results[i].body)
			}
			loserIdx = i
		default:
			t.Fatalf("consumer %d unexpected status = %d (%s)", i, results[i].status, results[i].body)
		}
	}
	if winnerIdx == -1 || loserIdx == -1 || winnerIdx == loserIdx {
		t.Fatalf("expected exactly one 201 and one 400 passkey_challenge_invalid, got r0=%+v r1=%+v", results[0], results[1])
	}

	var createdItem vault.PasskeyItem
	if err := json.Unmarshal([]byte(results[winnerIdx].body), &createdItem); err != nil {
		t.Fatalf("unmarshal winner PasskeyItem: %v", err)
	}

	// Verify side effects: 1 passkey (with winner's credential ID), 1 passkey.register audit, 1 security notice, 1 River mail job.
	var passkeyCount int
	var storedCredID []byte
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*), (array_agg(cred_id))[1] FROM vault_passkey WHERE user_id = $1`,
		meA.User.ID,
	).Scan(&passkeyCount, &storedCredID); err != nil {
		t.Fatalf("query vault_passkey: %v", err)
	}
	if passkeyCount != 1 || !bytes.Equal(storedCredID, creds[winnerIdx]) {
		t.Fatalf("vault_passkey count=%d cred match=%v, want 1 and winner cred", passkeyCount, bytes.Equal(storedCredID, creds[winnerIdx]))
	}

	var auditCount, noticeCount, jobCount int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventPasskeyRegister,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`,
		meA.User.ID,
	).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`,
	).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 || noticeCount != 1 || jobCount != 1 {
		t.Fatalf("side-effect counts: audit=%d notice=%d job=%d, want 1/1/1", auditCount, noticeCount, jobCount)
	}

	// Winner's idempotency claim is 'done' (201); loser's pre-commit 400 released its idempotency row.
	winnerRow, err := gen.New(h.pool).GetIdempotencyKey(ctx, gen.GetIdempotencyKeyParams{
		UserID: meA.User.ID,
		Key:    idemKeys[winnerIdx],
		Now:    pgtype.Timestamptz{Time: h.clk.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("GetIdempotencyKey(winner): %v", err)
	}
	if winnerRow.Status != "done" || winnerRow.StatusCode == nil || *winnerRow.StatusCode != http.StatusCreated {
		t.Fatalf("winner idempotency row = %+v, want status=done status_code=201", winnerRow)
	}
	var loserIdemRows int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`,
		meA.User.ID, idemKeys[loserIdx],
	).Scan(&loserIdemRows); err != nil {
		t.Fatal(err)
	}
	if loserIdemRows != 0 {
		t.Fatalf("loser idempotency row count = %d, want 0 (released after pre-commit 400)", loserIdemRows)
	}
}

// TestPasskeyRegister_RollbackOnAuditNoticeAndOwnerTokenMismatch covers BE1-4 / BE1-8 for registration:
// injects failures inside the second (mutation) transaction AFTER InsertPasskey has executed:
//  1. Postgres trigger raising on audit_log INSERT (event = 'passkey.register') -> rolls back passkey
//     insert, leaves 0 passkeys, 0 audits, 0 notices, 0 mail jobs, 0 done idempotency rows, releases the
//     in_progress idempotency claim per mục 2.3, and keeps the consumed challenge burned.
//  2. Postgres trigger raising on user_notification INSERT (kind = 'security') -> rolls back both
//     passkey insert and audit insert, leaves 0 passkeys/audits/notices/mail jobs/idempotency rows,
//     and keeps the consumed challenge burned.
//  3. Idempotency owner_token mismatch at FinishIdempotencyKey right before COMMIT (after InsertPasskey,
//     RecordAuditTx, and RecordSecurityNoticeTx + River job insert) -> rolls back passkey, audit, notice,
//     and River mail job, leaves no done response, preserves the new owner's claim, and keeps the
//     consumed challenge burned.
func TestPasskeyRegister_RollbackOnAuditNoticeAndOwnerTokenMismatch(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()
	va := webauthntest.New()

	password := "correcthorsebattery"
	email := "pk-rollback-reg@example.com"
	jarA, meA := h.signupUser(email, password)
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatalf("verify email: %v", err)
	}
	h.createPasskeyTestVault(jarA, "idem-pk-rb-create-vault", 0x10)
	grantReg := h.reauthGrant(jarA, "vault.passkey_register", password)

	assertNoPasskeySideEffects := func(step string) {
		t.Helper()
		var passkeys, audits, notices, jobs int
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, meA.User.ID).Scan(&passkeys); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, meA.User.ID, vault.EventPasskeyRegister).Scan(&audits); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, meA.User.ID).Scan(&notices); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobs); err != nil {
			t.Fatal(err)
		}
		if passkeys != 0 || audits != 0 || notices != 0 || jobs != 0 {
			t.Fatalf("%s: leftover state after rollback: passkeys=%d audits=%d notices=%d jobs=%d, want 0/0/0/0",
				step, passkeys, audits, notices, jobs)
		}
		if delivered := h.countSecurityMailsDelivered(email); delivered != 0 {
			t.Fatalf("%s: delivered emails = %d, want 0", step, delivered)
		}
	}

	// 1. Trigger failure on audit_log INSERT (after InsertPasskey has run in the mutation tx).
	if _, err := h.pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_fail_passkey_reg_audit() RETURNS trigger AS $$
		BEGIN
			IF NEW.user_id = '`+meA.User.ID.String()+`'::uuid AND NEW.event = 'passkey.register' THEN
				RAISE EXCEPTION 'simulated passkey.register audit failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER trg_fail_passkey_reg_audit
		BEFORE INSERT ON audit_log
		FOR EACH ROW EXECUTE FUNCTION test_fail_passkey_reg_audit();
	`); err != nil {
		t.Fatalf("create audit failure trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(ctx, `
			DROP TRIGGER IF EXISTS trg_fail_passkey_reg_audit ON audit_log;
			DROP FUNCTION IF EXISTS test_fail_passkey_reg_audit();
		`)
	})

	opts1 := h.registerPasskeyOptions(jarA)
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts1.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	body1 := makePasskeyCreateBody(
		t,
		opts1.ChallengeID,
		reg1.ClientDataJSONB64,
		reg1.AttestationObjectB64,
		opts1.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x81),
		"Audit Rollback Key",
		nil,
	)
	const idemKey1 = "idem-pk-rb-audit-fail-01"
	resp1, raw1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
		idemKey: idemKey1,
		grant:   grantReg,
	})
	assertPasskeyProblem(t, resp1, raw1, http.StatusInternalServerError, "internal_error")
	assertNoPasskeySideEffects("audit_log failure")

	// Claim must be released on pre-commit 500, and challenge must stay burned.
	var idemRows1 int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, idemKey1).Scan(&idemRows1); err != nil {
		t.Fatal(err)
	}
	if idemRows1 != 0 {
		t.Fatalf("audit_log failure: idempotency_key count = %d, want 0 (in_progress claim released)", idemRows1)
	}
	var consumed1 pgtype.Timestamptz
	if err := h.pool.QueryRow(ctx, `SELECT consumed_at FROM webauthn_challenge WHERE id = $1`, opts1.ChallengeID).Scan(&consumed1); err != nil {
		t.Fatal(err)
	}
	if !consumed1.Valid {
		t.Fatal("audit_log failure: challenge must remain burned after mutation tx rollback")
	}

	if _, err := h.pool.Exec(ctx, `
		DROP TRIGGER trg_fail_passkey_reg_audit ON audit_log;
		DROP FUNCTION test_fail_passkey_reg_audit();
	`); err != nil {
		t.Fatalf("drop audit trigger: %v", err)
	}

	// Retrying with the same (released) idempotency key and same (burned) challenge executes fresh and returns 400 passkey_challenge_invalid.
	respRetry1, rawRetry1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
		idemKey: idemKey1,
		grant:   grantReg,
	})
	assertPasskeyProblem(t, respRetry1, rawRetry1, http.StatusBadRequest, "passkey_challenge_invalid")

	// 2. Trigger failure on user_notification INSERT (after InsertPasskey AND RecordAuditTx have run in the mutation tx).
	if _, err := h.pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_fail_passkey_reg_notice() RETURNS trigger AS $$
		BEGIN
			IF NEW.user_id = '`+meA.User.ID.String()+`'::uuid AND NEW.kind = 'security' THEN
				RAISE EXCEPTION 'simulated passkey.register notice failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER trg_fail_passkey_reg_notice
		BEFORE INSERT ON user_notification
		FOR EACH ROW EXECUTE FUNCTION test_fail_passkey_reg_notice();
	`); err != nil {
		t.Fatalf("create notice failure trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(ctx, `
			DROP TRIGGER IF EXISTS trg_fail_passkey_reg_notice ON user_notification;
			DROP FUNCTION IF EXISTS test_fail_passkey_reg_notice();
		`)
	})

	opts2 := h.registerPasskeyOptions(jarA)
	reg2, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts2.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	body2 := makePasskeyCreateBody(
		t,
		opts2.ChallengeID,
		reg2.ClientDataJSONB64,
		reg2.AttestationObjectB64,
		opts2.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x82),
		"Notice Rollback Key",
		nil,
	)
	const idemKey2 = "idem-pk-rb-notice-fail-2"
	resp2, raw2 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body2, reqOptions{
		idemKey: idemKey2,
		grant:   grantReg,
	})
	assertPasskeyProblem(t, resp2, raw2, http.StatusInternalServerError, "internal_error")
	assertNoPasskeySideEffects("user_notification failure")

	var idemRows2 int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, idemKey2).Scan(&idemRows2); err != nil {
		t.Fatal(err)
	}
	if idemRows2 != 0 {
		t.Fatalf("user_notification failure: idempotency_key count = %d, want 0 (in_progress claim released)", idemRows2)
	}
	var consumed2 pgtype.Timestamptz
	if err := h.pool.QueryRow(ctx, `SELECT consumed_at FROM webauthn_challenge WHERE id = $1`, opts2.ChallengeID).Scan(&consumed2); err != nil {
		t.Fatal(err)
	}
	if !consumed2.Valid {
		t.Fatal("user_notification failure: challenge must remain burned after mutation tx rollback")
	}

	if _, err := h.pool.Exec(ctx, `
		DROP TRIGGER trg_fail_passkey_reg_notice ON user_notification;
		DROP FUNCTION test_fail_passkey_reg_notice();
	`); err != nil {
		t.Fatalf("drop notice trigger: %v", err)
	}

	// 3. Idempotency owner_token mismatch right before COMMIT (after InsertPasskey, RecordAuditTx,
	//    and RecordSecurityNoticeTx + River job insert have all executed in the mutation tx).
	opts3 := h.registerPasskeyOptions(jarA)
	reg3, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts3.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatal(err)
	}
	body3 := makePasskeyCreateBody(
		t,
		opts3.ChallengeID,
		reg3.ClientDataJSONB64,
		reg3.AttestationObjectB64,
		opts3.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x83),
		"Owner Mismatch Rollback Key",
		nil,
	)
	const idemKey3 = "idem-pk-rb-ownermismatch"
	fp3 := httpx.ComputeIdempotencyFingerprint(http.MethodPost, "/api/v1/vault/passkeys", []byte(body3))
	newOwner := uuid.New()
	var takeoverErr error

	tracer := &lateOwnershipTakeoverTracer{
		onFinishTx: func() {
			// Advance clock past the 60s in_progress window so a second claimant legitimately takes
			// over idemKey3 right before the first transaction runs FinishIdempotencyKey.
			h.clk.Advance(61 * time.Second)
			reclaimNow := h.clk.Now()
			_, takeoverErr = gen.New(h.pool).ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
				UserID:      meA.User.ID,
				Key:         idemKey3,
				Method:      http.MethodPost,
				Path:        "/api/v1/vault/passkeys",
				RequestHash: fp3,
				OwnerToken:  newOwner,
				Now:         pgtype.Timestamptz{Time: reclaimNow, Valid: true},
			})
		},
	}

	pcfg := h.pool.Config()
	pcfg.ConnConfig.Tracer = tracer
	tracedPool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.AppOrigin = h.origin
	riverInsert, err := river.NewClient(riverpgxv5.New(tracedPool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	_, _, authAPI, err := compose.NewAuth(cfg, tracedPool, riverInsert, h.clk, h.mail, nil)
	if err != nil {
		t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, tracedPool, riverInsert, h.clk, h.mail, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(h.authSvc)
	srv := httptest.NewServer(httpx.NewRouter(httpx.Deps{
		Config:        cfg,
		Logger:        slog.Default(),
		Authenticator: authn,
		CSRF:          csrfv,
		Reauth:        reauth,
		MountAPI:      compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI)),
	}))
	t.Cleanup(srv.Close)

	tracedHarness := &harness{
		t:        t,
		srv:      srv,
		origin:   h.origin,
		clk:      h.clk,
		mail:     h.mail,
		authSvc:  h.authSvc,
		vaultSvc: vaultSvc,
		vaultAPI: vaultAPI,
		pool:     tracedPool,
		logs:     h.logs,
	}

	resp3, raw3 := tracedHarness.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body3, reqOptions{
		idemKey: idemKey3,
		grant:   grantReg,
	})
	if takeoverErr != nil {
		t.Fatalf("ownership takeover ClaimIdempotencyKey failed: %v", takeoverErr)
	}
	if !tracer.once.Load() {
		t.Fatal("lateOwnershipTakeoverTracer was never triggered")
	}
	assertPasskeyProblem(t, resp3, raw3, http.StatusConflict, "idempotency_in_progress")
	assertNoPasskeySideEffects("owner_token mismatch")

	var consumed3 pgtype.Timestamptz
	if err := h.pool.QueryRow(ctx, `SELECT consumed_at FROM webauthn_challenge WHERE id = $1`, opts3.ChallengeID).Scan(&consumed3); err != nil {
		t.Fatal(err)
	}
	if !consumed3.Valid {
		t.Fatal("owner_token mismatch: challenge must remain burned after mutation tx rollback")
	}

	idemRow3, err := gen.New(h.pool).GetIdempotencyKey(ctx, gen.GetIdempotencyKeyParams{
		UserID: meA.User.ID,
		Key:    idemKey3,
		Now:    pgtype.Timestamptz{Time: h.clk.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("GetIdempotencyKey after owner_token mismatch rollback: %v", err)
	}
	if idemRow3.Status != "in_progress" || idemRow3.OwnerToken != newOwner || idemRow3.StatusCode != nil || len(idemRow3.Response) != 0 {
		t.Fatalf("idempotency row after owner_token mismatch = %+v, want status=in_progress owner=%s status_code=NULL response=empty",
			idemRow3, newOwner)
	}
}

// TestPasskeyCreate_DeadlineAndPostClaimGrantRecheck covers F-API-PASSKEY-DEADLINE (advisor-dec-057):
//  1. Race: first request is held after Claim (via SetPasskeyAttestationVerifier), clock advances past
//     grant expiry (and >60s in_progress window), client replay with the same Idempotency-Key and original
//     X-Reauth-Token is rejected (401 reauth_invalid), then the first request resumes -> the post-Claim
//     grant re-check inside the mutation transaction aborts with 401 reauth_invalid and rolls back:
//     0 passkey rows, 0 passkey.register audit rows, 0 security notices, 0 River mail jobs, and the
//     in_progress idempotency claim is released.
//  2. Deadline: first request stalled past the handler deadline (SetPasskeyCreateTimeout) -> aborts with
//     503 dependency_unavailable, 0 passkey rows, 0 audit rows, 0 notices, and idempotency claim released.
//  3. Positive control: normal create returns 201 Created, and an idempotent replay of the committed
//     request (even after the grant expires) returns the stored 201 without creating a second row.
func TestPasskeyCreate_DeadlineAndPostClaimGrantRecheck(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	ctx := context.Background()
	va := webauthntest.New()

	password := "correcthorsebattery"
	email := "pk-deadline-race@example.com"
	jarA, meA := h.signupUser(email, password)
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatalf("verify email: %v", err)
	}
	h.createPasskeyTestVault(jarA, "idem-pk-dl-create-vault", 0x10)

	assertNoPasskeySideEffects := func(step string) {
		t.Helper()
		var passkeys, audits, notices, jobs int
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, meA.User.ID).Scan(&passkeys); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND result = 'success'`, meA.User.ID, vault.EventPasskeyRegister).Scan(&audits); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, meA.User.ID).Scan(&notices); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobs); err != nil {
			t.Fatal(err)
		}
		if passkeys != 0 || audits != 0 || notices != 0 || jobs != 0 {
			t.Fatalf("%s: unexpected side effects: passkeys=%d audits=%d notices=%d jobs=%d, want 0/0/0/0",
				step, passkeys, audits, notices, jobs)
		}
	}

	// --- Subcase 1: Stalled first request held after Claim -> replay rejected (401 reauth_invalid) -> first resumes -> MUST NOT commit ---
	opts1 := h.registerPasskeyOptions(jarA)
	reg1, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts1.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential 1: %v", err)
	}
	grant1 := h.reauthGrant(jarA, "vault.passkey_register", password)
	body1 := makePasskeyCreateBody(
		t,
		opts1.ChallengeID,
		reg1.ClientDataJSONB64,
		reg1.AttestationObjectB64,
		opts1.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x91),
		"Stalled Race Key",
		nil,
	)
	const idemKeyRace = "idem-pk-dl-race-000001"

	type reqResult struct {
		resp testResponse
		raw  string
	}

	enteredVerifier := make(chan struct{})
	releaseVerifier := make(chan struct{})
	var verifierOnce sync.Once
	var releaseOnce sync.Once
	releaseGate := func() { releaseOnce.Do(func() { close(releaseVerifier) }) }
	firstDone := make(chan reqResult, 1)
	var joinOnce sync.Once
	var firstRes reqResult
	var firstJoined bool
	joinFirst := func() (reqResult, bool) {
		joinOnce.Do(func() {
			select {
			case firstRes = <-firstDone:
				firstJoined = true
			case <-time.After(5 * time.Second):
			}
		})
		return firstRes, firstJoined
	}
	t.Cleanup(func() {
		h.vaultSvc.SetPasskeyAttestationVerifier(nil)
		h.vaultAPI.SetPasskeyCreateTimeout(vaulthttp.DefaultPasskeyCreateTimeout)
		releaseGate()
		_, _ = joinFirst()
	})
	h.vaultSvc.SetPasskeyAttestationVerifier(func(
		rp vault.WebAuthnRPConfig,
		clientDataJSONB64 string,
		attestationObjectB64 string,
		storedChallengeB64 string,
	) (vault.VerifiedAttestation, error) {
		verifierOnce.Do(func() {
			close(enteredVerifier)
			<-releaseVerifier
		})
		return vault.VerifyRegistrationAttestation(rp, clientDataJSONB64, attestationObjectB64, storedChallengeB64)
	})

	go func() {
		r, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
			idemKey: idemKeyRace,
			grant:   grant1,
		})
		firstDone <- reqResult{resp: r, raw: raw}
	}()
	select {
	case <-enteredVerifier:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for first request to enter attestation verifier after Claim")
	}

	// Confirm the first request has claimed the idempotency key as 'in_progress'.
	var claimedCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2 AND status = 'in_progress'`, meA.User.ID, idemKeyRace).Scan(&claimedCount); err != nil {
		t.Fatal(err)
	}
	if claimedCount != 1 {
		t.Fatalf("expected 1 in_progress idempotency_key row while first request is held, got %d", claimedCount)
	}

	// Advance clock past the 5m re-auth grant TTL (and >60s in_progress window) so the client's replay
	// with the same Idempotency-Key and original grant passes Lookup and gets rejected at RequireReauth (401 reauth_invalid).
	// Issue a fresh session cookie by advancing in steps < 10m access JWT TTL (5m + 1s).
	h.clk.Advance(auth.GrantTTL + time.Second)

	replayResp, replayRaw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1, reqOptions{
		idemKey: idemKeyRace,
		grant:   grant1,
	})
	assertPasskeyProblem(t, replayResp, replayRaw, http.StatusUnauthorized, "reauth_invalid")

	// Now resume the held first request: its post-Claim grant re-check inside the mutation tx must fail
	// with 401 reauth_invalid and roll back all writes.
	releaseGate()

	if _, ok := joinFirst(); !ok {
		t.Fatal("timeout waiting for first request to finish after release")
	}
	assertPasskeyProblem(t, firstRes.resp, firstRes.raw, http.StatusUnauthorized, "reauth_invalid")
	assertNoPasskeySideEffects("stalled first request after replay rejection")

	var leftoverRaceIdem int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, idemKeyRace).Scan(&leftoverRaceIdem); err != nil {
		t.Fatal(err)
	}
	if leftoverRaceIdem != 0 {
		t.Fatalf("expected in_progress idempotency claim to be released after pre-commit 401 rollback, got %d rows", leftoverRaceIdem)
	}

	// --- Subcase 1b: Stalled first request held after Claim -> session revoked while grant still in TTL -> replay rejected (401 session_invalid) -> first resumes -> MUST NOT commit ---
	jarA = h.loginPasskeyTestUser(email, password)
	meCurrent := h.getMe(jarA)
	opts1b := h.registerPasskeyOptions(jarA)
	reg1b, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts1b.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential 1b: %v", err)
	}
	grant1b := h.reauthGrantXFF(jarA, "vault.passkey_register", password, "198.51.100.76")
	body1b := makePasskeyCreateBody(
		t,
		opts1b.ChallengeID,
		reg1b.ClientDataJSONB64,
		reg1b.AttestationObjectB64,
		opts1b.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x94),
		"Stalled Session Revoked Key",
		nil,
	)
	const idemKeySessRevoked = "idem-pk-dl-sess-rev-001"

	enteredVerifier1b := make(chan struct{})
	releaseVerifier1b := make(chan struct{})
	var verifierOnce1b sync.Once
	var releaseOnce1b sync.Once
	releaseGate1b := func() { releaseOnce1b.Do(func() { close(releaseVerifier1b) }) }
	firstDone1b := make(chan reqResult, 1)
	var joinOnce1b sync.Once
	var firstRes1b reqResult
	var firstJoined1b bool
	joinFirst1b := func() (reqResult, bool) {
		joinOnce1b.Do(func() {
			select {
			case firstRes1b = <-firstDone1b:
				firstJoined1b = true
			case <-time.After(5 * time.Second):
			}
		})
		return firstRes1b, firstJoined1b
	}
	t.Cleanup(func() {
		releaseGate1b()
		_, _ = joinFirst1b()
	})
	h.vaultSvc.SetPasskeyAttestationVerifier(func(
		rp vault.WebAuthnRPConfig,
		clientDataJSONB64 string,
		attestationObjectB64 string,
		storedChallengeB64 string,
	) (vault.VerifiedAttestation, error) {
		verifierOnce1b.Do(func() {
			close(enteredVerifier1b)
			<-releaseVerifier1b
		})
		return vault.VerifyRegistrationAttestation(rp, clientDataJSONB64, attestationObjectB64, storedChallengeB64)
	})

	go func() {
		r, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1b, reqOptions{
			idemKey: idemKeySessRevoked,
			grant:   grant1b,
		})
		firstDone1b <- reqResult{resp: r, raw: raw}
	}()

	select {
	case <-enteredVerifier1b:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for first request (1b) to enter attestation verifier after Claim")
	}

	// Advance >60s (still well within 5m grant TTL) and revoke the session in DB.
	h.clk.Advance(65 * time.Second)
	if _, err := h.pool.Exec(ctx, `UPDATE session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, meCurrent.User.ID, h.clk.Now()); err != nil {
		t.Fatalf("revoke session: %v", err)
	}

	// Replay with the same Idempotency-Key is rejected with 401 session_invalid.
	replayResp1b, replayRaw1b := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body1b, reqOptions{
		idemKey: idemKeySessRevoked,
		grant:   grant1b,
	})
	assertPasskeyProblem(t, replayResp1b, replayRaw1b, http.StatusUnauthorized, "session_invalid")

	// Resume held first request: EnsureLiveTx inside the mutation tx rejects with 401 session_invalid and rolls back.
	releaseGate1b()
	if _, ok := joinFirst1b(); !ok {
		t.Fatal("timeout waiting for first request (1b) to finish after release")
	}
	assertPasskeyProblem(t, firstRes1b.resp, firstRes1b.raw, http.StatusUnauthorized, "session_invalid")
	assertNoPasskeySideEffects("stalled first request after session revocation")

	var leftoverSessRevIdem int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, idemKeySessRevoked).Scan(&leftoverSessRevIdem); err != nil {
		t.Fatal(err)
	}
	if leftoverSessRevIdem != 0 {
		t.Fatalf("expected in_progress idempotency claim to be released after session_invalid rollback, got %d rows", leftoverSessRevIdem)
	}

	// --- Subcase 2: First request stalls past handler deadline -> 503 dependency_unavailable, no passkey row, claim released ---
	// Re-login so the session is fresh after revocation.
	jarA = h.loginPasskeyTestUser(email, password)
	opts2 := h.registerPasskeyOptions(jarA)
	reg2, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts2.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential 2: %v", err)
	}
	grant2 := h.reauthGrantXFF(jarA, "vault.passkey_register", password, "198.51.100.77")
	body2 := makePasskeyCreateBody(
		t,
		opts2.ChallengeID,
		reg2.ClientDataJSONB64,
		reg2.AttestationObjectB64,
		opts2.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x92),
		"Deadline Exceeded Key",
		nil,
	)
	const idemKeyDeadline = "idem-pk-dl-timeout-0002"

	h.vaultAPI.SetPasskeyCreateTimeout(50 * time.Millisecond)
	h.vaultSvc.SetPasskeyAttestationVerifier(func(
		rp vault.WebAuthnRPConfig,
		clientDataJSONB64 string,
		attestationObjectB64 string,
		storedChallengeB64 string,
	) (vault.VerifiedAttestation, error) {
		time.Sleep(150 * time.Millisecond)
		return vault.VerifyRegistrationAttestation(rp, clientDataJSONB64, attestationObjectB64, storedChallengeB64)
	})

	dlResp, dlRaw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body2, reqOptions{
		idemKey: idemKeyDeadline,
		grant:   grant2,
	})
	assertPasskeyProblem(t, dlResp, dlRaw, http.StatusServiceUnavailable, "dependency_unavailable")
	assertNoPasskeySideEffects("handler deadline exceeded")

	var leftoverDlIdem int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, idemKeyDeadline).Scan(&leftoverDlIdem); err != nil {
		t.Fatal(err)
	}
	if leftoverDlIdem != 0 {
		t.Fatalf("expected in_progress idempotency claim to be released after deadline exceeded, got %d rows", leftoverDlIdem)
	}

	// Restore normal verifier and default 30s timeout.
	h.vaultSvc.SetPasskeyAttestationVerifier(nil)
	h.vaultAPI.SetPasskeyCreateTimeout(vaulthttp.DefaultPasskeyCreateTimeout)
	// --- Subcase 3: Positive control — normal create returns 201 and replay of committed request returns stored 201 ---
	opts3 := h.registerPasskeyOptions(jarA)
	reg3, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         h.vaultSvc.WebAuthnRPID(),
		Origin:       h.origin,
		ChallengeB64: opts3.PublicKey.Challenge,
	})
	if err != nil {
		t.Fatalf("CreateCredential 3: %v", err)
	}
	body3 := makePasskeyCreateBody(
		t,
		opts3.ChallengeID,
		reg3.ClientDataJSONB64,
		reg3.AttestationObjectB64,
		opts3.PRFSalt,
		makeWrapB64U(t, vault.WrapKindPRF, 0x93),
		"Positive Control Key",
		nil,
	)
	const idemKeyPos = "idem-pk-dl-positive-003"
	posResp, posRaw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body3, reqOptions{
		idemKey: idemKeyPos,
		grant:   grant2,
	})
	if posResp.StatusCode != http.StatusCreated {
		t.Fatalf("positive control POST /vault/passkeys = %d %s", posResp.StatusCode, posRaw)
	}
	var createdItem vault.PasskeyItem
	if err := json.Unmarshal([]byte(posRaw), &createdItem); err != nil {
		t.Fatalf("unmarshal PasskeyItem: %v", err)
	}
	if createdItem.Name != "Positive Control Key" {
		t.Fatalf("createdItem.Name = %q, want 'Positive Control Key'", createdItem.Name)
	}

	// Advance past grant expiry and replay with the same Idempotency-Key -> stored 201 returned by Lookup.
	h.clk.Advance(auth.GrantTTL + time.Second)
	posReplayResp, posReplayRaw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", body3, reqOptions{
		idemKey: idemKeyPos,
		grant:   grant2,
	})
	if posReplayResp.StatusCode != http.StatusCreated {
		t.Fatalf("positive control replay = %d, want 201 (%s)", posReplayResp.StatusCode, posReplayRaw)
	}
	var replayedItem vault.PasskeyItem
	if err := json.Unmarshal([]byte(posReplayRaw), &replayedItem); err != nil {
		t.Fatalf("unmarshal replayed PasskeyItem: %v", err)
	}
	if replayedItem.ID != createdItem.ID {
		t.Fatalf("replayedItem.ID = %s, want %s", replayedItem.ID, createdItem.ID)
	}

	var finalPasskeys, finalAudits int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, meA.User.ID).Scan(&finalPasskeys); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND result = 'success'`, meA.User.ID, vault.EventPasskeyRegister).Scan(&finalAudits); err != nil {
		t.Fatal(err)
	}
	if finalPasskeys != 1 || finalAudits != 1 {
		t.Fatalf("after positive control + replay: passkeys=%d audits=%d, want 1/1", finalPasskeys, finalAudits)
	}
}

func init() {
	var b [1]byte
	_, _ = rand.Read(b[:])
}
