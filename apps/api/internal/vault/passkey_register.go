package vault

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

// Các kiểu dữ liệu JSON trả về trên `POST /vault/passkeys/register/options`
// khớp chính xác OpenAPI `VaultPasskeyRegisterOptionsResponse` và `PublicKeyCredentialCreationOptionsJSON`
// (SPEC §3.13, §5.10, §9.2, ADR 0003 §1–§2).

// PasskeyRPEntityJSON biểu diễn `public_key.rp` trong creation options.
type PasskeyRPEntityJSON struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// PasskeyUserEntityJSON biểu diễn `public_key.user` trong creation options (`id` là base64url không padding).
type PasskeyUserEntityJSON struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}

// PasskeyCredParamJSON biểu diễn một phần tử của `public_key.pubKeyCredParams`.
type PasskeyCredParamJSON struct {
	Type string `json:"type"`
	Alg  int64  `json:"alg"`
}

// PasskeyCredentialDescriptorJSON biểu diễn một phần tử của `excludeCredentials` hoặc `allowCredentials`.
type PasskeyCredentialDescriptorJSON struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	Transports []string `json:"transports,omitempty"`
}

// PasskeyAuthenticatorSelectionJSON biểu diễn `public_key.authenticatorSelection`.
type PasskeyAuthenticatorSelectionJSON struct {
	ResidentKey      string `json:"residentKey,omitempty"`
	UserVerification string `json:"userVerification,omitempty"`
}

// PasskeyPRFEvalValuesJSON biểu diễn `{first, second?}` của phần mở rộng PRF (`hmac-secret`).
type PasskeyPRFEvalValuesJSON struct {
	First  string `json:"first"`
	Second string `json:"second,omitempty"`
}

// PasskeyPRFCreationExtensionJSON biểu diễn `extensions.prf` trong creation options.
type PasskeyPRFCreationExtensionJSON struct {
	Eval *PasskeyPRFEvalValuesJSON `json:"eval,omitempty"`
}

// PasskeyCreationExtensionsJSON biểu diễn `public_key.extensions` trong creation options.
type PasskeyCreationExtensionsJSON struct {
	PRF *PasskeyPRFCreationExtensionJSON `json:"prf,omitempty"`
}

// PublicKeyCredentialCreationOptionsJSON biểu diễn `public_key` trong `VaultPasskeyRegisterOptionsResponse`.
type PublicKeyCredentialCreationOptionsJSON struct {
	RP                     PasskeyRPEntityJSON                `json:"rp"`
	User                   PasskeyUserEntityJSON              `json:"user"`
	Challenge              string                             `json:"challenge"`
	PubKeyCredParams       []PasskeyCredParamJSON             `json:"pubKeyCredParams"`
	Timeout                int                                `json:"timeout,omitempty"`
	ExcludeCredentials     []PasskeyCredentialDescriptorJSON  `json:"excludeCredentials"`
	AuthenticatorSelection *PasskeyAuthenticatorSelectionJSON `json:"authenticatorSelection,omitempty"`
	Attestation            string                             `json:"attestation,omitempty"`
	Extensions             *PasskeyCreationExtensionsJSON     `json:"extensions,omitempty"`
}

// PasskeyRegisterOptionsResponse là body trả về của `POST /vault/passkeys/register/options` (200 OK).
type PasskeyRegisterOptionsResponse struct {
	ChallengeID uuid.UUID                              `json:"challenge_id"`
	PublicKey   PublicKeyCredentialCreationOptionsJSON `json:"public_key"`
	PRFSalt     string                                 `json:"prf_salt"`
}

// RegisterPasskeyInput là đầu vào của `POST /vault/passkeys` (`vaultPasskeyCreate`, plan Task 13).
// Lưu ý (ADR 0003 §3, plan mục 2.5): Server không nhận và không bao giờ tin `cred_id`, `pubkey`, `aaguid`
// do client gửi rời bên ngoài `attestation_object`.
type RegisterPasskeyInput struct {
	ChallengeID       uuid.UUID
	ClientDataJSON    string
	AttestationObject string
	PRFSalt           string
	VKWrap            string
	Name              string
	IP                string
	UA                string
}

// RegisterPasskeyOptions sinh WebAuthn creation options và `prf_salt` cho `POST /vault/passkeys/register/options`
// (`vaultPasskeyRegisterOptions`, plan Task 13, mục 2.5, mục 3, ADR 0003 §1):
//   - Yêu cầu người dùng đã tạo vault (`404 vault_absent` nếu chưa có).
//   - Sinh 32 byte `challenge` ngẫu nhiên CSPRNG (chỉ lưu `SHA-256(challenge)` vào `webauthn_challenge`,
//     không bao giờ lưu challenge thô) và 32 byte `prf_salt` ngẫu nhiên.
//   - Gắn bản ghi `webauthn_challenge` với `(user_id, session_id, vault_key_id hiện tại)`, TTL 5 phút theo `s.clk`.
//   - Điền mọi `cred_id` hiện có của user vào `excludeCredentials`, yêu cầu `userVerification: "required"`,
//     `residentKey: "preferred"`, `attestation: "none"` và extension `prf.eval.first = prf_salt`.
func (s *Service) RegisterPasskeyOptions(ctx context.Context, p authctx.Principal) (PasskeyRegisterOptionsResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	v, err := q.GetVaultByUser(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyRegisterOptionsResponse{}, ErrVaultAbsent
		}
		return PasskeyRegisterOptionsResponse{}, err
	}

	u, err := q.GetUserByID(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyRegisterOptionsResponse{}, ErrUnauthenticated
		}
		return PasskeyRegisterOptionsResponse{}, err
	}

	existingPasskeys, err := q.ListPasskeysByUser(ctx, p.UserID)
	if err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}

	challengeBytes := make([]byte, WebAuthnChallengeBytes)
	if _, err := rand.Read(challengeBytes); err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}
	challengeHash := sha256.Sum256(challengeBytes)
	challengeB64 := EncodeBase64URL(challengeBytes)

	prfSaltBytes := make([]byte, WebAuthnPRFSaltBytes)
	if _, err := rand.Read(prfSaltBytes); err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}
	prfSaltB64 := EncodeBase64URL(prfSaltBytes)

	expiresAt := s.clk.Now().UTC().Add(WebAuthnChallengeTTL)
	chRow, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
		UserID:        p.UserID,
		SessionID:     p.SessionID,
		VaultKeyID:    v.VaultKeyID,
		ChallengeHash: challengeHash[:],
		PrfSalt:       prfSaltBytes,
		ExpiresAt:     pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	if err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return PasskeyRegisterOptionsResponse{}, err
	}

	excludeCreds := make([]PasskeyCredentialDescriptorJSON, 0, len(existingPasskeys))
	for _, pk := range existingPasskeys {
		excludeCreds = append(excludeCreds, PasskeyCredentialDescriptorJSON{
			Type: "public-key",
			ID:   EncodeBase64URL(pk.CredID),
		})
	}

	defaultParams := DefaultCredentialParameters()
	credParams := make([]PasskeyCredParamJSON, 0, len(defaultParams))
	for _, cp := range defaultParams {
		credParams = append(credParams, PasskeyCredParamJSON{
			Type: string(cp.Type),
			Alg:  int64(cp.Algorithm),
		})
	}

	rp := s.WebAuthnConfig()
	userHandleB64 := EncodeBase64URL(p.UserID[:])
	userName := u.Email
	if userName == "" {
		userName = p.UserID.String()
	}

	return PasskeyRegisterOptionsResponse{
		ChallengeID: chRow.ID,
		PRFSalt:     prfSaltB64,
		PublicKey: PublicKeyCredentialCreationOptionsJSON{
			RP: PasskeyRPEntityJSON{
				ID:   rp.RPID,
				Name: rp.RPName,
			},
			User: PasskeyUserEntityJSON{
				ID:          userHandleB64,
				Name:        userName,
				DisplayName: userName,
			},
			Challenge:          challengeB64,
			PubKeyCredParams:   credParams,
			Timeout:            WebAuthnCeremonyTimeoutMS,
			ExcludeCredentials: excludeCreds,
			AuthenticatorSelection: &PasskeyAuthenticatorSelectionJSON{
				ResidentKey:      "preferred",
				UserVerification: "required",
			},
			Attestation: "none",
			Extensions: &PasskeyCreationExtensionsJSON{
				PRF: &PasskeyPRFCreationExtensionJSON{
					Eval: &PasskeyPRFEvalValuesJSON{
						First: prfSaltB64,
					},
				},
			},
		},
	}, nil
}

// RegisterPasskey hoàn tất đăng ký passkey WebAuthn PRF (`POST /vault/passkeys`, `vaultPasskeyCreate`,
// plan Task 13, mục 2.3, 2.5, 2.7, 3, ADR 0003 §2–§3):
//
// Thứ tự tiêu thụ challenge và ranh giới transaction (consume-then-verify):
//  1. Kiểm tra công tắc dừng `VAULT_KEY_MUTATIONS_DISABLED` (`503 vault_mutations_disabled`).
//  2. Kiểm tra `name` (`ValidatePasskeyName` -> `400 passkey_name_invalid`) và `vk_wrap`
//     (`ValidateWrapBase64URL(..., WrapKindPRF)` -> `400 vault_wrap_invalid`).
//  3. Giải mã `prf_salt` (32 B) và trích xuất `challenge` (32 B) từ `clientDataJSON`, tính `SHA-256(challenge)`.
//  4. **Transaction 1 (Consume challenge nguyên tử trước khi verify):**
//     Đọc `vault` hiện tại của user (`404 vault_absent` nếu chưa có vault) và gọi `ConsumeWebAuthnChallenge`
//     khớp đồng thời `(id, user_id, session_id, vault_key_id hiện tại, challenge_hash, prf_salt,
//     consumed_at IS NULL, expires_at > now)` rồi `COMMIT` ngay. Nếu không khớp bất kỳ điều kiện nào,
//     trả `400 passkey_challenge_invalid` (một mã chung, không làm oracle).
//     Việc commit bước consume trước khi chạy `VerifyRegistrationAttestation` đảm bảo tính chất
//     one-time của challenge: nếu bước verify attestation hoặc bước insert sau đó thất bại,
//     challenge đã tiêu thụ vẫn bị đốt (burned) và không thể dùng lại.
//  5. **Verify attestation (`VerifyRegistrationAttestation`):**
//     Xác minh qua `github.com/go-webauthn/webauthn/protocol` với đúng chuỗi `challenge` vừa tiêu thụ,
//     `RPID`, `RPOrigin`, `UV = true`, `UP = true`, chấp nhận định dạng `"none"`; nếu sai trả
//     `400 passkey_attestation_invalid`. Tự trích xuất `cred_id`, `pubkey`, `aaguid` từ `AttData`.
//  6. **Transaction 2 (Mutation tx gắn Idempotency-Key):**
//     Mở `BeginMutationTx` (`lock_timeout = 30s`, `statement_timeout = 30s`), khoá và kiểm tra lại
//     `vault` vẫn tồn tại với cùng `vault_key_id`, `InsertPasskey` (trùng `cred_id` -> `409 passkey_exists`),
//     ghi audit `passkey.register` + in-app security notice (+ job mail River `security_notice_mail`
//     nếu email đã xác minh) và cập nhật `idempotency_key` `status = 'done'` kèm `owner_token`
//     trước khi `COMMIT`. Không tăng `vault.version`.
func (s *Service) RegisterPasskey(ctx context.Context, p authctx.Principal, in RegisterPasskeyInput) (PasskeyItem, error) {
	if s.KeyMutationsDisabled() {
		return PasskeyItem{}, ErrVaultMutationsDisabled
	}

	normalizedName, err := ValidatePasskeyName(in.Name)
	if err != nil {
		return PasskeyItem{}, ErrPasskeyNameInvalid
	}

	vkWrapBytes, err := ValidateWrapBase64URL(in.VKWrap, WrapKindPRF)
	if err != nil {
		return PasskeyItem{}, ErrVaultWrapInvalid
	}

	if in.ChallengeID == uuid.Nil {
		return PasskeyItem{}, ErrPasskeyChallengeInvalid
	}
	prfSaltBytes, err := DecodeBase64URLStrict(in.PRFSalt, WebAuthnPRFSaltBytes)
	if err != nil {
		return PasskeyItem{}, ErrPasskeyChallengeInvalid
	}

	challengeB64, challengeHash, err := ExtractClientDataChallenge(in.ClientDataJSON)
	if err != nil {
		return PasskeyItem{}, err
	}

	// Transaction 1: Kiểm tra vault tồn tại và tiêu thụ (burn) nguyên tử bản ghi `webauthn_challenge`.
	consumeTx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return PasskeyItem{}, err
	}
	defer func() { _ = consumeTx.Rollback(ctx) }()

	cq := s.q.WithTx(consumeTx)
	curVault, err := cq.GetVaultByUser(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyItem{}, ErrVaultAbsent
		}
		return PasskeyItem{}, err
	}

	nowTS := pgtype.Timestamptz{Time: s.clk.Now().UTC(), Valid: true}
	if _, err := cq.ConsumeWebAuthnChallenge(ctx, gen.ConsumeWebAuthnChallengeParams{
		ID:            in.ChallengeID,
		UserID:        p.UserID,
		SessionID:     p.SessionID,
		VaultKeyID:    curVault.VaultKeyID,
		ChallengeHash: challengeHash[:],
		PrfSalt:       prfSaltBytes,
		Now:           nowTS,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyItem{}, ErrPasskeyChallengeInvalid
		}
		return PasskeyItem{}, err
	}

	if err := consumeTx.Commit(ctx); err != nil {
		return PasskeyItem{}, err
	}

	// Bước Verify attestation chạy sau khi challenge đã được burn thành công.
	verified, err := VerifyRegistrationAttestation(
		s.WebAuthnConfig(),
		in.ClientDataJSON,
		in.AttestationObject,
		challengeB64,
	)
	if err != nil {
		return PasskeyItem{}, ErrPasskeyAttestationInvalid
	}

	// Transaction 2: Ghi bản ghi `vault_passkey`, audit `passkey.register`, security notice (+ job mail River)
	// và hoàn tất `idempotency_key` (`status = 'done'`) trong cùng một transaction.
	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return PasskeyItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	lockedVault, err := q.GetVaultByUserForUpdate(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyItem{}, ErrVaultAbsent
		}
		return PasskeyItem{}, err
	}
	if lockedVault.VaultKeyID != curVault.VaultKeyID {
		return PasskeyItem{}, ErrPasskeyChallengeInvalid
	}

	passkeyRow, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  p.UserID,
		CredID:  verified.CredID,
		Pubkey:  verified.PubKey,
		PrfSalt: prfSaltBytes,
		VkWrap:  vkWrapBytes,
		Aaguid:  verified.AAGUID,
		Name:    normalizedName,
	})
	if err != nil {
		if IsUniqueViolation(err) {
			return PasskeyItem{}, ErrPasskeyExists
		}
		return PasskeyItem{}, err
	}

	// Metadata của audit và security notice không bao giờ chứa pubkey, attestation, clientDataJSON,
	// prf_salt, vk_wrap hay request body (secevent.Meta chỉ giữ các trường enum đã whitelist).
	if err := s.RecordAuditTx(ctx, tx, p, EventPasskeyRegister, in.IP, in.UA, secevent.Meta{}); err != nil {
		return PasskeyItem{}, err
	}
	if err := s.RecordSecurityNoticeTx(ctx, tx, p.UserID, secevent.Meta{}); err != nil {
		return PasskeyItem{}, err
	}

	resp := FormatPasskeyItem(passkeyRow)
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusCreated, resp); err != nil {
		return PasskeyItem{}, err
	}

	return resp, nil
}
