package httpx

import (
	"context"
	"net/http"
	"strings"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
)

// Authenticator xác minh access token rồi kiểm session DB. httpx không import auth.
type Authenticator interface {
	Authenticate(ctx context.Context, access string) (authctx.Principal, error)
}

// CSRFVerifier kiểm cookie/header. principal nil = anonymous.
type CSRFVerifier interface {
	VerifyCSRF(ctx context.Context, principal *authctx.Principal, cookie, header string) error
}

// ReauthVerifier kiểm grant HMAC cho đúng action.
type ReauthVerifier interface {
	VerifyReauth(ctx context.Context, principal authctx.Principal, action, token string) error
}

const (
	cookieSession = "sabk_session"
	cookieCSRF    = "sabk_csrf"
	headerCSRF    = "X-CSRF-Token"
	headerReauth  = "X-Reauth-Token"
)

func cookieVal(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || c == nil {
		return ""
	}
	return c.Value
}

// OptionalSession gắn principal nếu access hợp lệ; thiếu/hết hạn thì tiếp tục anonymous.
func OptionalSession(a Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if a == nil || cookieVal(r, cookieSession) == "" {
				next.ServeHTTP(w, r)
				return
			}
			p, err := a.Authenticate(r.Context(), cookieVal(r, cookieSession))
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r.WithContext(authctx.WithPrincipal(r.Context(), p)))
		})
	}
}

// RequireSession gắn principal. JWT hết hạn → access_expired; thiếu → unauthenticated.
func RequireSession(a Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if a == nil {
				WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
				return
			}
			p, err := a.Authenticate(r.Context(), cookieVal(r, cookieSession))
			if err != nil {
				writeAuthError(w, r, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(authctx.WithPrincipal(r.Context(), p)))
		})
	}
}

// RequireCSRF đứng sau RequireSession (hoặc riêng cho anonymous nếu principal vắng).
func RequireCSRF(v CSRFVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if v == nil {
				WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
				return
			}
			var principal *authctx.Principal
			if p, ok := authctx.PrincipalFrom(r.Context()); ok {
				principal = &p
			}
			if err := v.VerifyCSRF(r.Context(), principal, cookieVal(r, cookieCSRF), r.Header.Get(headerCSRF)); err != nil {
				writeAuthError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireReauth kiểm header grant cho action cố định của route — không lấy action từ body.
func RequireReauth(v ReauthVerifier, action string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if v == nil {
				WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
				return
			}
			p, ok := authctx.PrincipalFrom(r.Context())
			if !ok {
				WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
				return
			}
			if err := v.VerifyReauth(r.Context(), p, action, r.Header.Get(headerReauth)); err != nil {
				writeAuthError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireOrigin so khớp Origin với APP_ORIGIN đã cấu hình — không tin Host.
func RequireOrigin(appOrigin string) func(http.Handler) http.Handler {
	want := strings.TrimRight(appOrigin, "/")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			origin := r.Header.Get("Origin")
			if origin == "" || strings.TrimRight(origin, "/") != want {
				WriteProblem(w, r, http.StatusForbidden, "csrf_invalid", "Origin không hợp lệ.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireJSONContent bắt Content-Type application/json trên unsafe method (phòng form CSRF).
func RequireJSONContent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			ct := r.Header.Get("Content-Type")
			mt := strings.TrimSpace(strings.Split(ct, ";")[0])
			if !strings.EqualFold(mt, "application/json") {
				WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type phải là application/json.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// RejectCrossSiteGET từ chối GET csrf/bootstrap khi Fetch Metadata nói cross-site.
func RejectCrossSiteGET(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
				WriteProblem(w, r, http.StatusForbidden, "csrf_invalid", "Yêu cầu cross-site bị từ chối.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeAuthError(w http.ResponseWriter, r *http.Request, err error) {
	code, status, extra := ClassifyAuthError(err)
	WriteProblemExtra(w, r, status, code, ProblemTitle(code)+".", extra)
}

// AuthError là lỗi middleware trung lập — adapter auth map sang đây.
type AuthError struct {
	Code   string
	Reason string
}

func (e *AuthError) Error() string { return e.Code }

// ClassifyAuthError đổi lỗi domain/adapter sang code HTTP. Fail closed nếu lạ.
func ClassifyAuthError(err error) (code string, status int, extra ProblemExtra) {
	if err == nil {
		return "internal_error", http.StatusInternalServerError, ProblemExtra{}
	}
	var ae *AuthError
	code = err.Error()
	if asAuthError(err, &ae) {
		code = ae.Code
		extra.Reason = ae.Reason
	}
	switch code {
	case "unauthenticated":
		return code, http.StatusUnauthorized, extra
	case "access_expired":
		return code, http.StatusUnauthorized, extra
	case "session_invalid":
		if extra.Reason == "" {
			extra.Reason = SessionReasonInvalid
		}
		return code, http.StatusUnauthorized, extra
	case "csrf_invalid":
		return code, http.StatusForbidden, extra
	case "forbidden":
		return code, http.StatusForbidden, extra
	case "reauth_required":
		return code, http.StatusUnauthorized, extra
	case "reauth_invalid":
		return code, http.StatusUnauthorized, extra
	case "reauth_unsupported_provider":
		return code, http.StatusForbidden, extra
	case "not_found":
		return code, http.StatusNotFound, extra
	default:
		return "internal_error", http.StatusInternalServerError, ProblemExtra{}
	}
}

func asAuthError(err error, dest **AuthError) bool {
	type causer interface{ Unwrap() error }
	for err != nil {
		if e, ok := err.(*AuthError); ok {
			*dest = e
			return true
		}
		u, ok := err.(causer)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
