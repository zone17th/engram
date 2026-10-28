package authhttp

import (
	"github.com/go-chi/chi/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// Mount đăng ký 26 operation P02. Từ chối mount khi thiếu verifier thật.
func Mount(api *API) func(v1 chi.Router, d httpx.Deps) {
	return func(v1 chi.Router, d httpx.Deps) {
		if api == nil || api.svc == nil || api.oauth == nil {
			panic("auth routes yêu cầu service/oauth thật — không mount rỗng")
		}
		if d.Authenticator == nil || d.CSRF == nil || d.Reauth == nil {
			panic("auth routes yêu cầu Authenticator, CSRF và Reauth thật — không mount verifier rỗng")
		}
		origin := ""
		if d.Config != nil {
			origin = d.Config.AppOrigin
		}

		v1.Get("/auth/config", api.Config)
		v1.With(httpx.RejectCrossSiteGET).Get("/auth/csrf", api.CSRF)

		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireOrigin(origin))
			g.Use(httpx.RequireJSONContent)
			g.Use(AttachAnon)
			g.Use(httpx.OptionalSession(d.Authenticator))
			g.With(httpx.RequireCSRF(d.CSRF)).Post("/auth/signup", api.Signup)
			g.With(httpx.RequireCSRF(d.CSRF)).Post("/auth/login", api.Login)
			g.Post("/auth/refresh", api.Refresh)
			g.Post("/auth/logout", api.Logout)
			g.With(httpx.RequireCSRF(d.CSRF)).Post("/auth/oauth/complete", api.OauthComplete)
		})

		v1.Get("/auth/oauth/{provider}/start", api.OauthStart)
		v1.Get("/auth/oauth/{provider}/callback", api.OauthCallback)
		if api.oauth.HasFake() {
			v1.Get("/__fake/oauth/{provider}", api.FakeAuthorize)
			v1.Post("/__fake/oauth/{provider}", api.FakeAuthorize)
		}

		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Get("/auth/me", api.Me)
			g.Get("/auth/sessions", api.SessionsList)
			g.Get("/auth/audit", api.AuditList)
			g.Get("/me/notifications", api.NotificationsList)
		})

		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireOrigin(origin))
			g.Use(httpx.RequireJSONContent)
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Use(httpx.RequireCSRF(d.CSRF))
			g.Post("/auth/reauth", api.Reauth)
			g.Post("/auth/verify-email/send", api.VerifyEmailSend)
			g.Post("/auth/verify-email/confirm", api.VerifyEmailConfirm)
			g.Post("/auth/password/enroll/send", api.PasswordEnrollSend)
			g.Delete("/auth/sessions/{id}", api.SessionRevoke)
			g.Patch("/me/notifications/{id}", api.NotificationRead)
			g.Patch("/me/settings", api.SettingsPatch)
			g.Post("/me/password", api.PasswordChange)
			g.With(httpx.RequireReauth(d.Reauth, "account.identity_link")).Post("/auth/oauth/{provider}/link", api.OauthLinkStart)
			g.Post("/auth/oauth/{provider}/reauth", api.OauthReauthStart)
			g.With(httpx.RequireReauth(d.Reauth, "session.revoke_others")).Post("/auth/sessions/revoke-others", api.SessionsRevokeOthers)
			g.With(httpx.RequireReauth(d.Reauth, "account.identity_unlink")).Delete("/auth/identities/{provider}", api.IdentityUnlink)
			g.With(httpx.RequireReauth(d.Reauth, "account.email_change")).Post("/me/email", api.EmailChange)
		})
	}
}
