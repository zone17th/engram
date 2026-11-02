package vault

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

// RenamePasskeyInput là đầu vào cho `PATCH /vault/passkeys/{id}` (`vaultPasskeyRename`, plan Task 13, mục 2.5, 3).
type RenamePasskeyInput struct {
	PasskeyID uuid.UUID `json:"-"`
	Name      string    `json:"name"`
}

// RevokePasskeyInput là đầu vào cho `DELETE /vault/passkeys/{id}` (`vaultPasskeyRevoke`, plan Task 13, mục 2.5, 3).
type RevokePasskeyInput struct {
	PasskeyID uuid.UUID `json:"-"`
	IP        string    `json:"-"`
	UA        string    `json:"-"`
}

// PasskeyUnlockCredentialDescriptor biểu diễn một phần tử của `public_key.allowCredentials`
// trong `POST /vault/unlock/passkey/options` (OpenAPI `PublicKeyCredentialRequestOptionsJSON`).
type PasskeyUnlockCredentialDescriptor struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	Transports []string `json:"transports,omitempty"`
}

// PasskeyUnlockPRFEvalValues biểu diễn giá trị đánh giá PRF (`{first: prf_salt}`) trong `evalByCredential`
// (OpenAPI `PrfEvalValuesJSON`).
type PasskeyUnlockPRFEvalValues struct {
	First  string `json:"first"`
	Second string `json:"second,omitempty"`
}

// PasskeyUnlockPRFExtension biểu diễn phần mở rộng `extensions.prf` trong request options mở khoá
// (OpenAPI `PublicKeyCredentialRequestOptionsJSON.extensions.prf`).
type PasskeyUnlockPRFExtension struct {
	Eval             *PasskeyUnlockPRFEvalValues           `json:"eval,omitempty"`
	EvalByCredential map[string]PasskeyUnlockPRFEvalValues `json:"evalByCredential"`
}

// PasskeyUnlockExtensions biểu diễn `public_key.extensions` trong request options mở khoá.
type PasskeyUnlockExtensions struct {
	PRF PasskeyUnlockPRFExtension `json:"prf"`
}

// PasskeyUnlockRequestOptions biểu diễn `public_key` (`PublicKeyCredentialRequestOptionsJSON`)
// trả về trên `POST /vault/unlock/passkey/options` (ADR 0003 §1, SPEC §3.14, §9.2, OpenAPI).
type PasskeyUnlockRequestOptions struct {
	Challenge        string                              `json:"challenge"`
	Timeout          int                                 `json:"timeout"`
	RPID             string                              `json:"rpId"`
	AllowCredentials []PasskeyUnlockCredentialDescriptor `json:"allowCredentials"`
	UserVerification string                              `json:"userVerification"`
	Extensions       PasskeyUnlockExtensions             `json:"extensions"`
}

// PasskeyUnlockCredentialItem biểu diễn một phần tử `{id, prf_salt, vk_wrap}` trong `credentials`
// của `POST /vault/unlock/passkey/options` (OpenAPI `PasskeyUnlockCredentialItem`).
// Trường `id` là WebAuthn `cred_id` (base64url không padding) khớp `public_key.allowCredentials[].id`
// và khoá của `public_key.extensions.prf.evalByCredential`.
type PasskeyUnlockCredentialItem struct {
	ID      string `json:"id"`
	PRFSalt string `json:"prf_salt"`
	VKWrap  string `json:"vk_wrap"`
}

// PasskeyUnlockOptionsResponse là body trả về của `POST /vault/unlock/passkey/options`
// (`vaultPasskeyUnlockOptions`, OpenAPI `VaultPasskeyUnlockOptionsResponse`).
type PasskeyUnlockOptionsResponse struct {
	PublicKey   PasskeyUnlockRequestOptions   `json:"public_key"`
	Credentials []PasskeyUnlockCredentialItem `json:"credentials"`
}

// RenamePasskey đổi tên một passkey thuộc sở hữu của `p.UserID` (`PATCH /vault/passkeys/{id}`,
// `vaultPasskeyRename`, plan Task 13, mục 2.5, 2.7, 3, SPEC §8, §9.2, OpenAPI):
//   - Chuẩn hoá và kiểm tra `in.Name` bằng `ValidatePasskeyName` (trim, 1–64 rune, từ chối ký tự điều khiển
//     và bidi override -> sai trả `400 passkey_name_invalid`).
//   - Kiểm tra user hiện tại đã có vault (`404 vault_absent` nếu chưa tạo vault).
//   - Cập nhật tên theo `(user_id = p.UserID, id = in.PasskeyID)`: nếu `id` không tồn tại hoặc thuộc user khác,
//     trả cùng một lỗi `404 passkey_not_found` (không lộ sự tồn tại của passkey user khác).
//   - Không tăng `vault.version` và không ghi sự kiện audit (theo đúng SPEC §8 và plan mục 3).
func (s *Service) RenamePasskey(ctx context.Context, p authctx.Principal, in RenamePasskeyInput) (PasskeyItem, error) {
	trimmedName, err := ValidatePasskeyName(in.Name)
	if err != nil {
		return PasskeyItem{}, ErrPasskeyNameInvalid
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return PasskeyItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	exists, err := q.VaultExistsByUser(ctx, p.UserID)
	if err != nil {
		return PasskeyItem{}, err
	}
	if !exists {
		return PasskeyItem{}, ErrVaultAbsent
	}
	if in.PasskeyID == uuid.Nil {
		return PasskeyItem{}, ErrPasskeyNotFound
	}

	row, err := q.RenamePasskeyByOwner(ctx, gen.RenamePasskeyByOwnerParams{
		Name:   trimmedName,
		UserID: p.UserID,
		ID:     in.PasskeyID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PasskeyItem{}, ErrPasskeyNotFound
		}
		return PasskeyItem{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return PasskeyItem{}, err
	}
	return FormatPasskeyItem(row), nil
}

// RevokePasskey thu hồi một passkey trên live server thuộc sở hữu của `p.UserID`
// (`DELETE /vault/passkeys/{id}`, `vaultPasskeyRevoke`, plan Task 13, mục 2.5, 2.7, 3, SPEC §3.15, §8, §9.2):
//   - Kiểm tra user hiện tại đã có vault (`404 vault_absent` nếu chưa tạo vault).
//   - Xoá bản ghi `vault_passkey` theo `(user_id = p.UserID, id = in.PasskeyID)`: nếu `id` không tồn tại,
//     đã bị thu hồi trước đó (retry), hoặc thuộc user khác -> trả cùng lỗi `404 passkey_not_found`
//     (không làm thay đổi hàng của user khác, không lộ oracle).
//   - Trong cùng transaction: ghi audit `passkey.revoke` (`EventPasskeyRevoke`) và tạo in-app security notice
//     (`user_notification` với `kind = "security"`, `EmailTargets = nil` — không gửi email bảo mật theo đúng
//     plan mục 3 "audit + notice" và Task 13 "`passkey.revoke` (+ notice)").
//   - Không tăng `vault.version` và không chịu ảnh hưởng của công tắc `VAULT_KEY_MUTATIONS_DISABLED`.
func (s *Service) RevokePasskey(ctx context.Context, p authctx.Principal, in RevokePasskeyInput) error {
	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	exists, err := q.VaultExistsByUser(ctx, p.UserID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrVaultAbsent
	}
	if in.PasskeyID == uuid.Nil {
		return ErrPasskeyNotFound
	}

	deleted, err := q.DeletePasskeyByOwner(ctx, gen.DeletePasskeyByOwnerParams{
		UserID: p.UserID,
		ID:     in.PasskeyID,
	})
	if err != nil {
		return err
	}
	if deleted == 0 {
		return ErrPasskeyNotFound
	}

	if err := s.RecordAuditTx(ctx, tx, p, EventPasskeyRevoke, in.IP, in.UA, secevent.Meta{}); err != nil {
		return err
	}

	if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{
		UserID: p.UserID,
		Kind:   secevent.NoticeSecurity,
		Meta:   secevent.Meta{}.Sanitize(),
	}); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// PasskeyUnlockOptions sinh WebAuthn request options cùng danh sách bản bọc PRF của từng credential
// cho `POST /vault/unlock/passkey/options` (`vaultPasskeyUnlockOptions`, plan Task 13, mục 2.5, 2.7, 3,
// ADR 0003 §1, SPEC §3.14, §9.2, OpenAPI):
//   - Nếu user chưa có vault -> trả `404 vault_absent`.
//   - Nếu user chưa đăng ký passkey nào -> trả `404 passkey_not_found`.
//   - Sinh `challenge` 32 byte ngẫu nhiên bằng CSPRNG (base64url không padding) và KHÔNG lưu vào
//     `webauthn_challenge` (ở P03 mở khoá bằng passkey là thao tác cục bộ trong Worker, client không gửi
//     assertion quay lại server).
//   - Điền `allowCredentials` chứa mọi `cred_id` của user, `userVerification = "required"`, `rpId` từ config,
//     `extensions.prf.evalByCredential` ánh xạ mỗi `cred_id` sang đúng `prf_salt` riêng của credential đó
//     (tuyệt đối không dùng chung một salt cho nhiều credential), và `credentials: [{id, prf_salt, vk_wrap}]`.
func (s *Service) PasskeyUnlockOptions(ctx context.Context, p authctx.Principal) (PasskeyUnlockOptionsResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return PasskeyUnlockOptionsResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	exists, err := q.VaultExistsByUser(ctx, p.UserID)
	if err != nil {
		return PasskeyUnlockOptionsResponse{}, err
	}
	if !exists {
		return PasskeyUnlockOptionsResponse{}, ErrVaultAbsent
	}

	rows, err := q.ListPasskeysByUser(ctx, p.UserID)
	if err != nil {
		return PasskeyUnlockOptionsResponse{}, err
	}
	if len(rows) == 0 {
		return PasskeyUnlockOptionsResponse{}, ErrPasskeyNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return PasskeyUnlockOptionsResponse{}, err
	}

	var challengeBytes [WebAuthnChallengeBytes]byte
	if _, err := rand.Read(challengeBytes[:]); err != nil {
		return PasskeyUnlockOptionsResponse{}, err
	}
	challengeB64 := EncodeBase64URL(challengeBytes[:])

	allowCreds := make([]PasskeyUnlockCredentialDescriptor, 0, len(rows))
	evalByCred := make(map[string]PasskeyUnlockPRFEvalValues, len(rows))
	creds := make([]PasskeyUnlockCredentialItem, 0, len(rows))

	for _, row := range rows {
		credIDB64 := EncodeBase64URL(row.CredID)
		prfSaltB64 := EncodeBase64URL(row.PrfSalt)
		vkWrapB64 := EncodeBase64URL(row.VkWrap)

		allowCreds = append(allowCreds, PasskeyUnlockCredentialDescriptor{
			Type: string(protocol.PublicKeyCredentialType),
			ID:   credIDB64,
		})
		evalByCred[credIDB64] = PasskeyUnlockPRFEvalValues{
			First: prfSaltB64,
		}
		creds = append(creds, PasskeyUnlockCredentialItem{
			ID:      credIDB64,
			PRFSalt: prfSaltB64,
			VKWrap:  vkWrapB64,
		})
	}

	return PasskeyUnlockOptionsResponse{
		PublicKey: PasskeyUnlockRequestOptions{
			Challenge:        challengeB64,
			Timeout:          WebAuthnCeremonyTimeoutMS,
			RPID:             s.WebAuthnRPID(),
			AllowCredentials: allowCreds,
			UserVerification: string(protocol.VerificationRequired),
			Extensions: PasskeyUnlockExtensions{
				PRF: PasskeyUnlockPRFExtension{
					EvalByCredential: evalByCred,
				},
			},
		},
		Credentials: creds,
	}, nil
}
