package vault

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

// Tên sự kiện audit cho các thao tác vault (SPEC §3.9–§3.15, §8, plan Task 8–12).
// Metadata của các bản ghi này không bao giờ chứa passphrase, KEK, VK, RK, lookup_hash, wrap hay body.
const (
	EventVaultCreate           = "vault.create"
	EventVaultRewrap           = "vault.rewrap"
	EventVaultRecover          = "vault.recover"
	EventVaultReset            = "vault.reset"
	EventRecoveryKeyConsume    = "recovery_key.consume"
	EventRecoveryKeyRegenerate = "recovery_key.regenerate"
	EventRecoveryKeyRotate     = "recovery_key.rotate"
	EventPasskeyRegister       = "passkey.register"
	EventPasskeyRevoke         = "passkey.revoke"
)

// Auditor ghi nhận sự kiện bảo mật vào bảng `audit_log` trong cùng transaction với mutation.
type Auditor interface {
	Record(ctx context.Context, tx pgx.Tx, rec secevent.Record) error
}

// Notifier tạo thông báo bảo mật trong ứng dụng (`user_notification`) và enqueue job
// `security_notice_mail` trong cùng transaction River để `worker.SecurityNoticeWorker` gửi sau khi commit.
type Notifier interface {
	NotifySecurity(ctx context.Context, tx pgx.Tx, n secevent.Notice) error
}

// Mailer được giữ lại cho chữ ký tương thích của `compose.NewVault`; việc gửi email bảo mật
// thuộc duy nhất về hàng đợi giao dịch P02 (`notification.Store.NotifySecurity` -> `worker.SecurityNoticeWorker`).
type Mailer interface {
	Send(ctx context.Context, recipient, purpose, link string) error
}

// Service thực thi nghiệp vụ cho các endpoint `/vault*` (P03 Task 8–12).
// Server chỉ xử lý các bản wrap AEAD opaque, `lookup_hash`, KDF công khai và public key;
// tuyệt đối không bao giờ nhận hoặc ghi log passphrase, KEK, VK, plaintext RK, PWK hay private key chưa wrap.
// PasskeyAttestationVerifier là hàm xác minh dữ liệu đăng ký WebAuthn; mặc định là `VerifyRegistrationAttestation`.
type PasskeyAttestationVerifier func(
	rp WebAuthnRPConfig,
	clientDataJSONB64 string,
	attestationObjectB64 string,
	storedChallengeB64 string,
) (VerifiedAttestation, error)

type Service struct {
	cfg             *config.Config
	pool            *pgxpool.Pool
	q               *gen.Queries
	clk             clock.Clock
	grants          *auth.Grants
	grantVerifier   GrantVerifier
	sessions        *auth.SessionStore
	audit           Auditor
	notify          Notifier
	metrics         *Metrics
	resetHook       ResetHook
	passkeyVerifier PasskeyAttestationVerifier
	logger          *slog.Logger
	ipPepper        []byte
}

// NewService khởi tạo `*Service` cho vault.
// Nếu `clk == nil` dùng `clock.System{}`; nếu `resetHook == nil` dùng `NoopResetHook`;
// nếu `metrics == nil` tạo bộ counter không gắn registry (safe no-op).
func NewService(
	cfg *config.Config,
	pool *pgxpool.Pool,
	clk clock.Clock,
	audit Auditor,
	notify Notifier,
	_ Mailer,
	metrics *Metrics,
	resetHook ResetHook,
	logger *slog.Logger,
) (*Service, error) {
	if cfg == nil || pool == nil || audit == nil || notify == nil {
		return nil, errors.New("vault service thiếu dependency bắt buộc")
	}
	if clk == nil {
		clk = clock.System{}
	}
	if resetHook == nil {
		resetHook = NoopResetHook
	}
	if metrics == nil {
		metrics = NewMetrics(nil)
	}
	return &Service{
		cfg:             cfg,
		pool:            pool,
		q:               gen.New(pool),
		clk:             clk,
		grants:          auth.NewGrants(cfg.AuthReauthSecret, clk),
		sessions:        auth.NewSessionStore(pool, nil, clk),
		audit:           audit,
		notify:          notify,
		metrics:         metrics,
		resetHook:       resetHook,
		passkeyVerifier: VerifyRegistrationAttestation,
		logger:          logger,
		ipPepper:        cfg.AuthIPPepper,
	}, nil
}

// Pool trả về `*pgxpool.Pool` của Service.
func (s *Service) Pool() *pgxpool.Pool { return s.pool }

// Clock trả về đồng hồ của Service.
func (s *Service) Clock() clock.Clock { return s.clk }

// Metrics trả về bộ counter Prometheus của Service.
func (s *Service) Metrics() *Metrics { return s.metrics }

// KeyMutationsDisabled cho biết công tắc `VAULT_KEY_MUTATIONS_DISABLED` có đang bật hay không.
func (s *Service) KeyMutationsDisabled() bool {
	return s != nil && s.cfg != nil && s.cfg.KeyMutationsDisabled
}

// WebAuthnRPID trả về Relying Party ID đã cấu hình của Service.
func (s *Service) WebAuthnRPID() string {
	if s == nil || s.cfg == nil {
		return ""
	}
	return s.cfg.EffectiveWebAuthnRPID()
}

// WebAuthnRPOrigin trả về Relying Party Origin đã cấu hình của Service.
func (s *Service) WebAuthnRPOrigin() string {
	if s == nil || s.cfg == nil {
		return ""
	}
	return s.cfg.EffectiveWebAuthnRPOrigin()
}

// SetResetHook cho phép cấu hình `ResetHook` (dùng trong test Task 12 và khi P04 nối xoá entry).
func (s *Service) SetResetHook(hook ResetHook) {
	if hook == nil {
		s.resetHook = NoopResetHook
		return
	}
	s.resetHook = hook
}

// ResetHook trả về `ResetHook` hiện hành.
func (s *Service) ResetHook() ResetHook {
	if s == nil || s.resetHook == nil {
		return NoopResetHook
	}
	return s.resetHook
}

// SetPasskeyAttestationVerifier cho phép cấu hình hàm verify attestation đăng ký passkey (dùng trong test F-API-PASSKEY-DEADLINE).
func (s *Service) SetPasskeyAttestationVerifier(fn PasskeyAttestationVerifier) {
	if fn == nil {
		s.passkeyVerifier = VerifyRegistrationAttestation
		return
	}
	s.passkeyVerifier = fn
}

// PasskeyAttestationVerifier trả về hàm verify attestation đăng ký passkey hiện hành.
func (s *Service) PasskeyAttestationVerifier() PasskeyAttestationVerifier {
	if s == nil || s.passkeyVerifier == nil {
		return VerifyRegistrationAttestation
	}
	return s.passkeyVerifier
}

// GrantVerifier verifies a re-authentication grant token (HMAC, principal binding, action, and TTL)
// without acquiring a database connection.
type GrantVerifier interface {
	VerifyGrant(principal authctx.Principal, action, token string) error
}

// SetGrantVerifier attaches the shared route grant verifier (e.g. from httpx.Deps.Reauth in vaulthttp.Mount)
// so the final check inside RegisterPasskey Transaction 2 uses the exact route grant authority without
// acquiring a second pool connection (BR1-6, BR2-1).
func (s *Service) SetGrantVerifier(v GrantVerifier) {
	if s == nil {
		return
	}
	s.grantVerifier = v
}

// GrantVerifier returns the route GrantVerifier attached to Service, if any.
func (s *Service) GrantVerifier() GrantVerifier {
	if s == nil {
		return nil
	}
	return s.grantVerifier
}

// BeginMutationTx mở một `pgx.Tx` trên pool với `lock_timeout = '30s'` và `statement_timeout = '30s'`
// theo đúng bước 7 của plan mục 2.3.
func (s *Service) BeginMutationTx(ctx context.Context) (pgx.Tx, error) {
	return httpx.BeginMutationTx(ctx, s.pool)
}

// CommitMutationWithIdempotency hoàn tất transaction mutation có gắn `Idempotency-Key`
// theo đúng bước 7 & bước 8 của plan mục 2.3:
//   - Marshal `respPayload` thành JSON (hoặc nil nếu `statusCode == 204` / `respPayload == nil`).
//   - Nếu trong `ctx` có `*httpx.IdempotencyClaim` (route đi qua middleware Idempotency):
//     cập nhật hàng `idempotency_key` sang `status = 'done'` kèm kiểm tra `owner_token` ngay trước `COMMIT`
//     qua `httpx.CommitIdempotencyTx` (nếu lệch `owner_token` thì rollback toàn bộ mutation).
//   - Nếu gọi trực tiếp Service trong unit test không qua HTTP middleware Idempotency:
//     gọi `tx.Commit(ctx)` trực tiếp.
func (s *Service) CommitMutationWithIdempotency(ctx context.Context, tx pgx.Tx, statusCode int, respPayload any) ([]byte, error) {
	var rawResp []byte
	if respPayload != nil && statusCode != 204 {
		var err error
		rawResp, err = json.Marshal(respPayload)
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, err
		}
	}
	if _, hasClaim := httpx.IdempotencyClaimFrom(ctx); hasClaim {
		if err := httpx.CommitIdempotencyTx(ctx, tx, statusCode, rawResp); err != nil {
			return nil, err
		}
		return rawResp, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return rawResp, nil
}

// RecordAuditTx ghi một bản ghi `audit_log` trong transaction `tx` với metadata đã qua `Sanitize()`
// (không bao giờ chứa `lookup_hash`, wrap hay bí mật).
func (s *Service) RecordAuditTx(ctx context.Context, tx pgx.Tx, p authctx.Principal, event string, ip, ua string, meta secevent.Meta) error {
	uid := p.UserID
	sid := p.SessionID
	var ipHash []byte
	if ip != "" && len(s.ipPepper) > 0 {
		ipHash = auth.HashIP(s.ipPepper, ip)
	}
	return s.audit.Record(ctx, tx, secevent.Record{
		UserID:    &uid,
		SessionID: &sid,
		Event:     event,
		Result:    secevent.ResultSuccess,
		Actor:     "user",
		IPHash:    ipHash,
		UserAgent: ua,
		Meta:      meta.Sanitize(),
	})
}

// RecordSecurityNoticeTx tạo in-app security notice (`user_notification`) và (khi user có email đã xác minh)
// xếp hàng job `security_notice_mail` vào River trong cùng transaction `tx` thông qua `s.notify.NotifySecurity`.
// Lưu ý (SPEC §3.9, plan Task 9–12, BE1-12/BE1-16):
//   - Notice luôn được tạo trong DB kể cả khi user chưa xác minh email (`email_targets` rỗng -> không xếp job mail).
//   - Việc gửi email thực tế diễn ra sau khi transaction đã commit qua `worker.SecurityNoticeWorker`,
//     nên lỗi gửi mail không bao giờ làm rollback mutation đã commit và mỗi mutation chỉ có duy nhất một chủ sở hữu gửi mail.
func (s *Service) RecordSecurityNoticeTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, meta secevent.Meta) error {
	q := s.q.WithTx(tx)
	u, err := q.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	var targets []string
	if u.EmailVerifiedAt.Valid && u.Email != "" {
		targets = []string{u.Email}
	}
	return s.notify.NotifySecurity(ctx, tx, secevent.Notice{
		UserID:       userID,
		Kind:         secevent.NoticeSecurity,
		Meta:         meta.Sanitize(),
		EmailTargets: targets,
	})
}

// DTO dùng chung cho các endpoint `/vault*` (khớp OpenAPI `api/openapi.yaml` và plan mục 3).

// RecoveryKeyUploadItem biểu diễn một phần tử `{slot, lookup_hash, wrap}` khi tạo/bù/xoay RK.
type RecoveryKeyUploadItem struct {
	Slot       int    `json:"slot"`
	LookupHash string `json:"lookup_hash"`
	Wrap       string `json:"wrap"`
}

// PasskeyItem biểu diễn metadata của một passkey trên `GET /vault` và `GET /vault/passkeys`.
type PasskeyItem struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AAGUID    *string   `json:"aaguid"`
	CreatedAt time.Time `json:"created_at"`
}

// PasskeyList là body trả về của `GET /vault/passkeys`.
type PasskeyList struct {
	Items []PasskeyItem `json:"items"`
}

// VaultState là body trả về của `GET /vault`.
type VaultState struct {
	VaultKeyID            string        `json:"vault_key_id"`
	Version               int32         `json:"version"`
	KDF                   KDFParams     `json:"kdf"`
	VaultKeyWrappedByKEK  string        `json:"vault_key_wrapped_by_kek"`
	X25519Public          string        `json:"x25519_public"`
	Ed25519Public         string        `json:"ed25519_public"`
	PrivateKeysWrapped    string        `json:"private_keys_wrapped"`
	RecoveryKeysRemaining int           `json:"recovery_keys_remaining"`
	Passkeys              []PasskeyItem `json:"passkeys"`
}

// VaultCreatedResponse là body trả về của `POST /vault` (201 Created).
type VaultCreatedResponse struct {
	VaultKeyID string `json:"vault_key_id"`
	Version    int32  `json:"version"`
}

// VaultVersionResponse là body trả về của `PUT /vault/kek` và `POST /vault/recover/complete`.
type VaultVersionResponse struct {
	Version int32 `json:"version"`
}

// RecoveryKeysStatus là body trả về của `GET /vault/recovery-keys`.
type RecoveryKeysStatus struct {
	Remaining  int   `json:"remaining"`
	Slots      int   `json:"slots"`
	EmptySlots []int `json:"empty_slots"`
}

// RecoveryLookupResponse là body trả về của `POST /vault/unlock/recovery`.
type RecoveryLookupResponse struct {
	RecoveryKeyID uuid.UUID `json:"recovery_key_id"`
	Wrap          string    `json:"wrap"`
}

// RecoveryKeysMutationResponse là body trả về của `POST /vault/recovery-keys/regenerate` và `/rotate`.
type RecoveryKeysMutationResponse struct {
	Remaining int   `json:"remaining"`
	Version   int32 `json:"version"`
}
