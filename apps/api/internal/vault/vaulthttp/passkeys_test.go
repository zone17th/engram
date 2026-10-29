package vaulthttp_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
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
	const blockedKey = "idem-pk-ks-blocked-0002"
	respBlocked, rawBlocked := hDisabled.doReq(jarA, http.MethodPost, "/api/v1/vault/passkeys", bodyNew, reqOptions{
		idemKey: blockedKey,
		// Even without a grant, K runs before RequireReauth!
	})
	assertPasskeyProblem(t, respBlocked, rawBlocked, http.StatusServiceUnavailable, "vault_mutations_disabled")

	// Verify no idempotency claim row was created for blockedKey.
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

func init() {
	var b [1]byte
	_, _ = rand.Read(b[:])
}
