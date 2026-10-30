package vaulthttp

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// Mount đăng ký toàn bộ bảng route `/vault*` của P03 Task 8–13 (15 operations trên `/api/v1`)
// với đúng chuỗi middleware theo từng cột (S, C, I, A(action), R(scope), M, K) và đúng thứ tự
// của plan mục 2.3 & mục 3:
//
//   - GET /vault (`vaultGet`): S
//   - POST /vault (`vaultCreate`): S + C + I.Lookup + K + I.Claim
//   - PUT /vault/kek (`vaultRewrap`, T9): S + C + I.Lookup + K + A(`vault.rewrap`) + R(`vault_sensitive`) + M + I.Claim
//   - DELETE /vault (`vaultReset`, T12): S + C(AllowEmptyDelete) + I.Lookup + K + A(`vault.reset`) + R(`vault_sensitive`) + M + I.Claim
//   - GET /vault/recovery-keys (`vaultRecoveryKeysGet`): S
//   - POST /vault/unlock/recovery (`vaultRecoveryLookup`, T10): S + C + R(`vault_recovery_lookup`)
//   - POST /vault/recover/complete (`vaultRecoverComplete`, T10): S + C + I.Lookup + K + A(`vault.recover`) + R(`vault_recovery_complete`) + M + I.Claim
//   - POST /vault/recovery-keys/regenerate (`vaultRecoveryKeysRegenerate`, T11): S + C + I.Lookup + K + A(`vault.recovery_keys_regenerate`) + R(`vault_sensitive`) + M + I.Claim
//   - POST /vault/recovery-keys/rotate (`vaultRecoveryKeysRotate`, T11): S + C + I.Lookup + K + A(`vault.recovery_keys_rotate`) + R(`vault_sensitive`) + M + I.Claim
//   - GET /vault/passkeys (`vaultPasskeysList`): S
//   - POST /vault/passkeys/register/options (`vaultPasskeyRegisterOptions`, T13): S + C + R(`vault_passkey_options`)
//   - POST /vault/passkeys (`vaultPasskeyCreate`, T13): S + C + I.Lookup + K + A(`vault.passkey_register`) + R(`vault_sensitive`) + I.Claim
//   - PATCH /vault/passkeys/{id} (`vaultPasskeyRename`, T13): S + C + R(`vault_sensitive`)
//   - DELETE /vault/passkeys/{id} (`vaultPasskeyRevoke`, T13): S + C(AllowEmptyDelete) + A(`vault.passkey_revoke`) + R(`vault_sensitive`)
//   - POST /vault/unlock/passkey/options (`vaultPasskeyUnlockOptions`, T13): S + C + R(`vault_passkey_options`)
//
// Lưu ý về vị trí công tắc dừng K (`VAULT_KEY_MUTATIONS_DISABLED`, advisor-dec-022):
// `Idempotency.Lookup` (plan mục 2.3 bước 2) chạy TRƯỚC K để replay của mutation đã commit (`done` + cùng
// fingerprint) trả về response gốc và các phản hồi `409 idempotency_conflict` / `409 idempotency_in_progress`
// giữ nguyên như bước 2. K được đặt ngay SAU `Idempotency.Lookup` và TRƯỚC `RequireReauth(action)`,
// `UserLimiter.Middleware(scope)`, `RequireIfMatch` và `Idempotency.Claim`. Nhờ đó, mọi request thực hiện
// mutation mới (chưa có hàng còn hạn, hoặc giành lại hàng `in_progress` quá 60 giây) nhận `503 vault_mutations_disabled`
// mà không tiêu tốn `rate_event` và không tạo/cập nhật bản ghi claim `idempotency_key`.
//
// Trong các route passkey của Task 13, chỉ `POST /vault/passkeys` thuộc cột K (ghi bản wrap mới);
// các route options, rename và revoke không nằm trong cột K.
func Mount(api *API) func(v1 chi.Router, d httpx.Deps) {
	return func(v1 chi.Router, d httpx.Deps) {
		if api == nil || api.svc == nil {
			panic("vault routes yêu cầu vault.Service thật — không mount rỗng")
		}
		if api.idem == nil || api.limiter == nil {
			panic("vault routes yêu cầu Idempotency và UserLimiter thật — không mount rỗng")
		}
		if d.Authenticator == nil || d.CSRF == nil || d.Reauth == nil {
			panic("vault routes yêu cầu Authenticator, CSRF và Reauth thật — không mount verifier rỗng")
		}

		origin := ""
		if d.Config != nil {
			origin = d.Config.AppOrigin
		}

		// Nhóm đọc trạng thái (cột S): GET /vault, GET /vault/recovery-keys, GET /vault/passkeys
		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Get("/vault", api.Get)
			g.Get("/vault/recovery-keys", api.RecoveryKeysGet)
			g.Get("/vault/passkeys", api.PasskeysList)
		})

		// POST /vault (vaultCreate): S + C + K + I (không A, không R, không M)
		v1.Method(http.MethodPost, "/vault", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "",
			rateLimitScope:   "",
			requireIfMatch:   false,
			allowEmptyDelete: false,
			killSwitch:       true,
		}, http.HandlerFunc(api.Create)))

		// PUT /vault/kek (vaultRewrap, T9): S + C + A("vault.rewrap") + R("vault_sensitive") + M + I + K
		v1.Method(http.MethodPut, "/vault/kek", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "vault.rewrap",
			rateLimitScope:   httpx.ScopeVaultSensitive,
			requireIfMatch:   true,
			allowEmptyDelete: false,
			killSwitch:       true,
		}, http.HandlerFunc(api.Rewrap)))

		// DELETE /vault (vaultReset, T12): S + C(AllowEmptyDelete) + A("vault.reset") + R("vault_sensitive") + M + I + K
		v1.Method(http.MethodDelete, "/vault", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "vault.reset",
			rateLimitScope:   httpx.ScopeVaultSensitive,
			requireIfMatch:   true,
			allowEmptyDelete: true,
			killSwitch:       true,
		}, http.HandlerFunc(api.Reset)))

		// POST /vault/unlock/recovery (vaultRecoveryLookup, T10): S + C + R("vault_recovery_lookup") (không I, không K)
		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireOrigin(origin))
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Use(httpx.RequireCSRF(d.CSRF))
			g.Use(httpx.RequireJSONContent)
			g.Use(api.limiter.Middleware(httpx.ScopeVaultRecoveryLookup))
			g.Post("/vault/unlock/recovery", api.RecoveryLookup)
		})

		// POST /vault/recover/complete (vaultRecoverComplete, T10): S + C + A("vault.recover") + R("vault_recovery_complete") + M + I + K
		v1.Method(http.MethodPost, "/vault/recover/complete", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "vault.recover",
			rateLimitScope:   httpx.ScopeVaultRecoveryComplete,
			requireIfMatch:   true,
			allowEmptyDelete: false,
			killSwitch:       true,
		}, http.HandlerFunc(api.RecoverComplete)))

		// POST /vault/recovery-keys/regenerate (vaultRecoveryKeysRegenerate, T11): S + C + A("vault.recovery_keys_regenerate") + R("vault_sensitive") + M + I + K
		v1.Method(http.MethodPost, "/vault/recovery-keys/regenerate", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "vault.recovery_keys_regenerate",
			rateLimitScope:   httpx.ScopeVaultSensitive,
			requireIfMatch:   true,
			allowEmptyDelete: false,
			killSwitch:       true,
		}, http.HandlerFunc(api.RecoveryKeysRegenerate)))

		// POST /vault/recovery-keys/rotate (vaultRecoveryKeysRotate, T11): S + C + A("vault.recovery_keys_rotate") + R("vault_sensitive") + M + I + K
		v1.Method(http.MethodPost, "/vault/recovery-keys/rotate", api.chainIdempotentMutation(idempotentRouteSpec{
			appOrigin:        origin,
			deps:             d,
			reauthAction:     "vault.recovery_keys_rotate",
			rateLimitScope:   httpx.ScopeVaultSensitive,
			requireIfMatch:   true,
			allowEmptyDelete: false,
			killSwitch:       true,
		}, http.HandlerFunc(api.RecoveryKeysRotate)))

		// Hook cho Task 13 (WebAuthn passkey routes, bao gồm POST /vault/passkeys thuộc cột K).
		api.mountPasskeyRoutes(v1, origin, d)
	}
}

type idempotentRouteSpec struct {
	appOrigin        string
	deps             httpx.Deps
	reauthAction     string
	rateLimitScope   string
	requireIfMatch   bool
	allowEmptyDelete bool
	killSwitch       bool
}

// chainIdempotentMutation ghép chuỗi middleware cho route có Idempotency-Key theo đúng thứ tự
// của plan mục 2.3 + công tắc dừng K (nếu `spec.killSwitch == true`):
//  1. `RequireOrigin` -> `RequireSession` -> `RequireCSRF` -> `RequireJSONContent` (hoặc `RequireJSONContentExceptEmptyDelete`)
//  2. `Idempotency.Lookup` (trả lại response đã commit hoặc 409 conflict/in_progress trước K)
//     2b. `KillSwitch` (`503 vault_mutations_disabled` khi bật — đặt ngay sau Lookup và trước Reauth/RateLimit/If-Match/Claim)
//  3. `RequireReauth(action)` (nếu `reauthAction != ""`)
//  4. `UserLimiter.Middleware(scope)` (nếu `rateLimitScope != ""`)
//  5. `RequireIfMatch` (nếu `requireIfMatch == true`)
//  6. `Idempotency.Claim` (kèm bước 8 Release trong defer)
//  7. `handler`
func (a *API) chainIdempotentMutation(spec idempotentRouteSpec, handler http.Handler) http.Handler {
	h := handler
	h = a.idem.Claim(h)
	if spec.requireIfMatch {
		h = httpx.RequireIfMatch(h)
	}
	if spec.rateLimitScope != "" {
		h = a.limiter.Middleware(spec.rateLimitScope)(h)
	}
	if spec.reauthAction != "" {
		h = httpx.RequireReauth(spec.deps.Reauth, spec.reauthAction)(h)
	}
	if spec.killSwitch && a.killSwitch != nil {
		h = a.killSwitch(h)
	}
	h = a.idem.Lookup(h)
	if spec.allowEmptyDelete {
		h = httpx.RequireJSONContentExceptEmptyDelete(h)
	} else {
		h = httpx.RequireJSONContent(h)
	}
	h = httpx.RequireCSRF(spec.deps.CSRF)(h)
	h = httpx.RequireSession(spec.deps.Authenticator)(h)
	h = httpx.RequireOrigin(spec.appOrigin)(h)
	return h
}

// mountPasskeyRoutes đăng ký 5 operation WebAuthn passkey của Task 13 (plan mục 2.3, 2.4, 2.5, 3):
//   - POST /vault/passkeys/register/options (`vaultPasskeyRegisterOptions`): S + C + R(`vault_passkey_options`)
//   - POST /vault/passkeys (`vaultPasskeyCreate`): S + C + I.Lookup + K + A(`vault.passkey_register`) + R(`vault_sensitive`) + I.Claim (không M)
//   - PATCH /vault/passkeys/{id} (`vaultPasskeyRename`): S + C + R(`vault_sensitive`)
//   - DELETE /vault/passkeys/{id} (`vaultPasskeyRevoke`): S + C(AllowEmptyDelete) + A(`vault.passkey_revoke`) + R(`vault_sensitive`)
//   - POST /vault/unlock/passkey/options (`vaultPasskeyUnlockOptions`): S + C + R(`vault_passkey_options`)
func (a *API) mountPasskeyRoutes(v1 chi.Router, origin string, d httpx.Deps) {
	// POST /vault/passkeys/register/options & POST /vault/unlock/passkey/options:
	// S + C + R("vault_passkey_options") (chung một bucket 20/phút/user; không I, không K, không M).
	v1.Group(func(g chi.Router) {
		g.Use(httpx.RequireOrigin(origin))
		g.Use(httpx.RequireSession(d.Authenticator))
		g.Use(httpx.RequireCSRF(d.CSRF))
		g.Use(requireJSONContentOrEmptyBody)
		g.Use(a.limiter.Middleware(httpx.ScopeVaultPasskeyOptions))
		g.Post("/vault/passkeys/register/options", a.PasskeyRegisterOptions)
		g.Post("/vault/unlock/passkey/options", a.PasskeyUnlockOptions)
	})

	// POST /vault/passkeys (vaultPasskeyCreate):
	// S + C + I.Lookup + K + A("vault.passkey_register") + R("vault_sensitive") + I.Claim (không M).
	v1.Method(http.MethodPost, "/vault/passkeys", a.chainIdempotentMutation(idempotentRouteSpec{
		appOrigin:        origin,
		deps:             d,
		reauthAction:     "vault.passkey_register",
		rateLimitScope:   httpx.ScopeVaultSensitive,
		requireIfMatch:   false,
		allowEmptyDelete: false,
		killSwitch:       true,
	}, http.HandlerFunc(a.PasskeyCreate)))

	// PATCH /vault/passkeys/{id} (vaultPasskeyRename): S + C + R("vault_sensitive") (không A, không I, không K, không M).
	v1.Group(func(g chi.Router) {
		g.Use(httpx.RequireOrigin(origin))
		g.Use(httpx.RequireSession(d.Authenticator))
		g.Use(httpx.RequireCSRF(d.CSRF))
		g.Use(httpx.RequireJSONContent)
		g.Use(a.limiter.Middleware(httpx.ScopeVaultSensitive))
		g.Patch("/vault/passkeys/{id}", a.PasskeyRename)
	})

	// DELETE /vault/passkeys/{id} (vaultPasskeyRevoke):
	// S + C(AllowEmptyDelete) + A("vault.passkey_revoke") + R("vault_sensitive") (không I, không K, không M).
	v1.Group(func(g chi.Router) {
		g.Use(httpx.RequireOrigin(origin))
		g.Use(httpx.RequireSession(d.Authenticator))
		g.Use(httpx.RequireCSRF(d.CSRF))
		g.Use(httpx.RequireJSONContentExceptEmptyDelete)
		g.Use(httpx.RequireReauth(d.Reauth, "vault.passkey_revoke"))
		g.Use(a.limiter.Middleware(httpx.ScopeVaultSensitive))
		g.Delete("/vault/passkeys/{id}", a.PasskeyRevoke)
	})
}

// requireJSONContentOrEmptyBody cho phép các route POST options không có requestBody trong OpenAPI
// (`POST /vault/passkeys/register/options`, `POST /vault/unlock/passkey/options`) đi qua khi
// cả body và `Content-Type` đều rỗng, đồng thời vẫn bắt buộc `application/json` nếu có body
// hoặc có gửi `Content-Type` (chặn form-urlencoded CSRF).
func requireJSONContentOrEmptyBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimSpace(r.Header.Get("Content-Type")) == "" &&
			(r.ContentLength == 0 || r.Body == nil || r.Body == http.NoBody) {
			next.ServeHTTP(w, r)
			return
		}
		httpx.RequireJSONContent(next).ServeHTTP(w, r)
	})
}
