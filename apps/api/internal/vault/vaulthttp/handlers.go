// Package vaulthttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/vault*`.
package vaulthttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// VaultJSONLimit là giới hạn kích thước JSON body cho các route `/vault*` (64 KiB, khớp IdempotencyMaxBodyBytes).
const VaultJSONLimit = 64 * 1024

// DefaultPasskeyCreateTimeout là thời hạn xử lý tối đa cho handler `POST /api/v1/vault/passkeys`
// (F-API-PASSKEY-DEADLINE, advisor-dec-057), đồng nhất với `lock_timeout = 30s` và `statement_timeout = 30s`
// trong `httpx.ConfigureMutationTxTimeouts` (plan mục 2.3 bước 7).
const DefaultPasskeyCreateTimeout = 30 * time.Second

// PasskeyRoutesHook là điểm mở rộng dành cho Task 13 (WebAuthn passkey routes:
// POST /vault/passkeys/register/options, POST /vault/passkeys [cột K kill switch],
// PATCH /vault/passkeys/{id}, DELETE /vault/passkeys/{id}, POST /vault/unlock/passkey/options).
type PasskeyRoutesHook func(v1Router interface{}, d httpx.Deps)

// API gom các dependency HTTP của nhóm route `/vault*`.
type API struct {
	svc                  *vault.Service
	idem                 *httpx.Idempotency
	limiter              *httpx.UserLimiter
	trusted              func(net.IP) bool
	killSwitch           func(http.Handler) http.Handler
	passkeyCreateTimeout time.Duration
}

// NewAPI khởi tạo `*API` cho các route `/vault*`.
// Nếu `idem == nil` hoặc `limiter == nil`, tự khởi tạo từ pool và clock của `svc`.
func NewAPI(
	svc *vault.Service,
	idem *httpx.Idempotency,
	limiter *httpx.UserLimiter,
	trusted func(net.IP) bool,
) *API {
	if svc != nil {
		if idem == nil && svc.Pool() != nil {
			idem = httpx.NewIdempotency(svc.Pool(), svc.Clock())
		}
		if limiter == nil && svc.Pool() != nil {
			limiter = httpx.NewUserLimiter(svc.Pool(), svc.Clock())
		}
	}
	disabled := svc != nil && svc.KeyMutationsDisabled()
	return &API{
		svc:                  svc,
		idem:                 idem,
		limiter:              limiter,
		trusted:              trusted,
		killSwitch:           vault.RequireKeyMutationsEnabled(disabled),
		passkeyCreateTimeout: DefaultPasskeyCreateTimeout,
	}
}

// Service trả về `*vault.Service` của API.
func (a *API) Service() *vault.Service { return a.svc }

// Idempotency trả về middleware `*httpx.Idempotency` đang gắn với API.
func (a *API) Idempotency() *httpx.Idempotency { return a.idem }

// UserLimiter trả về `*httpx.UserLimiter` đang gắn với API.
func (a *API) UserLimiter() *httpx.UserLimiter { return a.limiter }

// KillSwitchMiddleware trả về middleware công tắc dừng `VAULT_KEY_MUTATIONS_DISABLED` (cột K mục 3).
// Exported để Task 13 gắn vào `POST /vault/passkeys`.
func (a *API) KillSwitchMiddleware() func(http.Handler) http.Handler {
	return a.killSwitch
}

// SetPasskeyCreateTimeout đặt thời hạn xử lý của handler `POST /api/v1/vault/passkeys`
// (nếu `d <= 0` sẽ quay về `DefaultPasskeyCreateTimeout` = 30s).
func (a *API) SetPasskeyCreateTimeout(d time.Duration) {
	if d <= 0 {
		a.passkeyCreateTimeout = DefaultPasskeyCreateTimeout
		return
	}
	a.passkeyCreateTimeout = d
}

// PasskeyCreateTimeout trả về thời hạn xử lý hiện hành của handler `POST /api/v1/vault/passkeys`.
func (a *API) PasskeyCreateTimeout() time.Duration {
	if a == nil || a.passkeyCreateTimeout <= 0 {
		return DefaultPasskeyCreateTimeout
	}
	return a.passkeyCreateTimeout
}

func (a *API) ip(r *http.Request) string {
	return httpx.ClientIP(r, a.trusted)
}

// NoStore đặt `Cache-Control: no-store` và xoá `ETag` nếu có.
func NoStore(w http.ResponseWriter) {
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
}

// NoStoreNoTransform đặt `Cache-Control: no-store, no-transform` và đảm bảo không có header `ETag`
// cho các GET đọc trạng thái vault (plan mục 2.3, mục 3, Task 8).
func NoStoreNoTransform(w http.ResponseWriter) {
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store, no-transform")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// DecodeVaultJSON đọc và kiểm tra nghiêm ngặt JSON body của request `/vault*`:
//   - Kiểm tra `Content-Type: application/json`, giới hạn kích thước 64 KiB, không rỗng.
//   - Kiểm tra không có khoá trùng lặp (duplicate keys) ở mọi cấp lồng nhau trước khi unmarshal.
//   - Từ chối trường lạ (`DisallowUnknownFields`) và dữ liệu thừa phía sau.
//
// Khi lỗi, ghi ngay `400 invalid_request` (hoặc `415`/`413`) và trả `false`.
func DecodeVaultJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct := r.Header.Get("Content-Type")
	if mt := strings.TrimSpace(strings.Split(ct, ";")[0]); !strings.EqualFold(mt, "application/json") {
		httpx.WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", "Yêu cầu Content-Type application/json.")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, VaultJSONLimit+1))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
		return false
	}
	if len(body) > VaultJSONLimit {
		httpx.WriteProblem(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "Nội dung quá lớn.")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Thiếu nội dung JSON.")
		return false
	}
	if err := rejectDuplicateOrAliasJSONKeys(body, reflect.TypeOf(dst)); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON có dữ liệu thừa.")
		return false
	}
	return true
}

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

func rejectDuplicateOrAliasJSONKeys(data []byte, dstType reflect.Type) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return walkStrictJSON(dec, dstType)
}

func derefType(t reflect.Type) reflect.Type {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func allowedStructJSONFields(t reflect.Type) map[string]reflect.Type {
	out := make(map[string]reflect.Type, t.NumField())
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name := f.Name
		if tag != "" {
			if head, _, _ := strings.Cut(tag, ","); head != "" {
				name = head
			}
		}
		out[name] = f.Type
	}
	return out
}

func walkStrictJSON(dec *json.Decoder, targetType reflect.Type) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	t := derefType(targetType)
	if t == rawMessageType {
		t = nil
	}
	switch d := tok.(type) {
	case json.Delim:
		switch d {
		case '{':
			var allowed map[string]reflect.Type
			if t != nil && t.Kind() == reflect.Struct {
				allowed = allowedStructJSONFields(t)
			}
			seen := map[string]struct{}{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				k, ok := kt.(string)
				if !ok {
					return errors.New("object key not string")
				}
				if _, dup := seen[k]; dup {
					return errors.New("duplicate key")
				}
				seen[k] = struct{}{}
				var childType reflect.Type
				if allowed != nil {
					ft, ok := allowed[k]
					if !ok {
						return errors.New("unknown or non-canonical JSON property")
					}
					childType = ft
				}
				if err := walkStrictJSON(dec, childType); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if ed, ok := end.(json.Delim); !ok || ed != '}' {
				return errors.New("unclosed object")
			}
		case '[':
			var elemType reflect.Type
			if t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
				elemType = t.Elem()
			}
			for dec.More() {
				if err := walkStrictJSON(dec, elemType); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if ed, ok := end.(json.Delim); !ok || ed != ']' {
				return errors.New("unclosed array")
			}
		default:
			return errors.New("unexpected delimiter")
		}
	}
	return nil
}

// Create xử lý `POST /api/v1/vault` (`vaultCreate`, plan Task 8, mục 3).
func (a *API) Create(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	var req struct {
		KDF                  json.RawMessage               `json:"kdf"`
		VaultKeyWrappedByKEK string                        `json:"vault_key_wrapped_by_kek"`
		X25519Public         string                        `json:"x25519_public"`
		Ed25519Public        string                        `json:"ed25519_public"`
		PrivateKeysWrapped   string                        `json:"private_keys_wrapped"`
		RecoveryKeys         []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	if req.RecoveryKeys == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "recovery_keys_count", httpx.ProblemTitle("recovery_keys_count")+".")
		return
	}
	res, err := a.svc.Create(r.Context(), p, vault.CreateVaultInput{
		KDFRaw:               req.KDF,
		VaultKeyWrappedByKEK: req.VaultKeyWrappedByKEK,
		X25519Public:         req.X25519Public,
		Ed25519Public:        req.Ed25519Public,
		PrivateKeysWrapped:   req.PrivateKeysWrapped,
		RecoveryKeys:         req.RecoveryKeys,
		IP:                   a.ip(r),
		UA:                   r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusCreated, res)
}

// Get xử lý `GET /api/v1/vault` (`vaultGet`, plan Task 8, mục 3).
// Trả về dữ liệu của chính principal với `Cache-Control: no-store, no-transform` và không có `ETag`.
func (a *API) Get(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	state, err := a.svc.Get(r.Context(), p.UserID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStoreNoTransform(w)
	writeJSON(w, http.StatusOK, state)
}

// RecoveryKeysGet xử lý `GET /api/v1/vault/recovery-keys` (`vaultRecoveryKeysGet`, plan Task 8, mục 3).
// Trả về `{remaining, slots: 10, empty_slots: [...]}` của chính principal với `Cache-Control: no-store, no-transform` và không có `ETag`.
func (a *API) RecoveryKeysGet(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	status, err := a.svc.GetRecoveryKeysStatus(r.Context(), p.UserID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStoreNoTransform(w)
	writeJSON(w, http.StatusOK, status)
}

// PasskeysList xử lý `GET /api/v1/vault/passkeys` (`vaultPasskeysList`, plan Task 8, mục 3).
// Trả về `{items: [...]}` (chỉ metadata, không có `vk_wrap`) của chính principal với `Cache-Control: no-store, no-transform` và không có `ETag`.
func (a *API) PasskeysList(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	list, err := a.svc.ListPasskeys(r.Context(), p.UserID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStoreNoTransform(w)
	writeJSON(w, http.StatusOK, list)
}
