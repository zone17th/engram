package authhttp

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/oauth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

type Captcha = auth.Captcha

type API struct {
	svc       *auth.Service
	oauth     *oauth.Service
	captcha   Captcha
	trusted   func(net.IP) bool
	credLimit *httpx.FixedWindow
	cbLimit   *httpx.FixedWindow
	mailMin   *httpx.FixedWindow
	mailHour  *httpx.FixedWindow
}

func NewAPI(svc *auth.Service, oa *oauth.Service, captcha Captcha, trusted func(net.IP) bool) *API {
	if captcha == nil {
		captcha = auth.NoCaptcha{}
	}
	return &API{
		svc:       svc,
		oauth:     oa,
		captcha:   captcha,
		trusted:   trusted,
		credLimit: httpx.NewFixedWindow(5),
		cbLimit:   httpx.NewFixedWindow(20),
		mailMin:   httpx.NewFixedWindow(1),
		mailHour:  httpx.NewFixedWindowWith(3, time.Hour),
	}
}

func (a *API) ip(r *http.Request) string {
	return httpx.ClientIP(r, a.trusted)
}

func (a *API) limit(l *httpx.FixedWindow, key string, w http.ResponseWriter, r *http.Request) bool {
	ok, retry := l.Allow(key)
	if ok {
		return true
	}
	httpx.WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited", httpx.ProblemTitle("rate_limited")+".", httpx.ProblemExtra{RetryAfter: &retry})
	return false
}

func (a *API) Config(w http.ResponseWriter, r *http.Request) {
	NoStore(w)
	writeJSON(w, http.StatusOK, a.svc.PublicConfig())
}

func (a *API) CSRF(w http.ResponseWriter, r *http.Request) {
	NoStore(w)
	if access := CookieValue(r, CookieSession); access != "" {
		if p, err := a.svc.Sessions().Authenticate(r.Context(), access); err == nil {
			a.issueSessionCSRF(w, r, p, auth.SessionTTL)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	if refresh := CookieValue(r, CookieRefresh); refresh != "" {
		if sess, _, err := a.svc.Sessions().LookupByRefresh(r.Context(), refresh); err == nil {
			if a.svc.Sessions().EnsureLive(r.Context(), authctx.Principal{UserID: sess.UserID, SessionID: sess.ID}) == nil {
				a.issueSessionCSRF(w, r, authctx.Principal{UserID: sess.UserID, SessionID: sess.ID}, time.Until(sess.ExpiresAt.Time))
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
	}
	nonce := CookieValue(r, CookieAnon)
	if nonce == "" {
		var err error
		nonce, err = auth.NewAnonNonce()
		if err != nil {
			WriteDomainError(w, r, err)
			return
		}
		SetAnonCookie(w, nonce, time.Now().Add(auth.AnonTTL))
	}
	if tok, ok := a.svc.CSRF().ReuseIfValid(CookieValue(r, CookieCSRF), auth.CSRFKindAnon, nonce); ok {
		SetCSRFCookie(w, tok.Raw, tok.Expiry)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	tok, err := a.svc.CSRF().Issue(auth.CSRFKindAnon, nonce, auth.AnonTTL)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	SetCSRFCookie(w, tok.Raw, tok.Expiry)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) issueSessionCSRF(w http.ResponseWriter, r *http.Request, p authctx.Principal, ttl time.Duration) {
	if ttl <= 0 || ttl > auth.SessionTTL {
		ttl = auth.SessionTTL
	}
	if tok, ok := a.svc.CSRF().ReuseIfValid(CookieValue(r, CookieCSRF), auth.CSRFKindSession, p.SessionID.String()); ok {
		SetCSRFCookie(w, tok.Raw, tok.Expiry)
		return
	}
	tok, err := a.svc.CSRF().Issue(auth.CSRFKindSession, p.SessionID.String(), ttl)
	if err != nil {
		return
	}
	SetCSRFCookie(w, tok.Raw, tok.Expiry)
}

func (a *API) applySession(w http.ResponseWriter, r *http.Request, issued auth.IssueResult) {
	SetSessionCookies(w, issued.Access, issued.AccessExp, issued.Refresh, issued.SessionExp)
	clearCookie(w, CookieAnon, PathAuth, true)
	clearCookie(w, CookieOAuth, PathAuth, true)
	tok, err := a.svc.CSRF().Issue(auth.CSRFKindSession, issued.Principal.SessionID.String(), time.Until(issued.SessionExp))
	if err == nil {
		SetCSRFCookie(w, tok.Raw, tok.Expiry)
	}
}

func (a *API) Signup(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Locale   string `json:"locale"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	me, issued, err := a.svc.Signup(r.Context(), auth.SignupInput{
		Email: in.Email, Password: in.Password, Locale: in.Locale, IP: a.ip(r), UA: r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	a.applySession(w, r, issued)
	NoStore(w)
	writeJSON(w, http.StatusCreated, me)
}

func (a *API) Login(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	var in struct {
		Email        string `json:"email"`
		Password     string `json:"password"`
		CaptchaToken string `json:"captcha_token"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	captchaOn := a.captcha.Enabled()
	captchaOK := false
	if captchaOn {
		captchaOK = a.captcha.Verify(r.Context(), in.CaptchaToken, a.ip(r), "", "login") == nil
	}
	me, issued, err := a.svc.Login(r.Context(), auth.LoginInput{
		Email: in.Email, Password: in.Password, CaptchaToken: in.CaptchaToken,
		IP: a.ip(r), UA: r.UserAgent(), CaptchaOK: captchaOK, CaptchaOn: captchaOn,
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	a.applySession(w, r, issued)
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func (a *API) Refresh(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	refresh := CookieValue(r, CookieRefresh)
	issued, err := a.svc.Refresh(r.Context(), refresh, CookieValue(r, CookieCSRF), r.Header.Get(HeaderCSRF))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	SetSessionCookies(w, issued.Access, issued.AccessExp, issued.Refresh, issued.SessionExp)
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) Logout(w http.ResponseWriter, r *http.Request) {
	var p *authctx.Principal
	if got, ok := authctx.PrincipalFrom(r.Context()); ok {
		p = &got
	}
	refresh := CookieValue(r, CookieRefresh)
	csrfCookie, csrfHeader := CookieValue(r, CookieCSRF), r.Header.Get(HeaderCSRF)
	if p != nil {
		if err := a.svc.CSRF().Verify(csrfCookie, csrfHeader, auth.CSRFKindSession, p.SessionID.String()); err != nil {
			WriteDomainError(w, r, err)
			return
		}
	} else if refresh != "" {
		sess, _, err := a.svc.Sessions().LookupByRefresh(r.Context(), refresh)
		if err == nil {
			if err := a.svc.CSRF().Verify(csrfCookie, csrfHeader, auth.CSRFKindSession, sess.ID.String()); err != nil {
				WriteDomainError(w, r, err)
				return
			}
		}
	}
	if err := a.svc.Logout(r.Context(), p, refresh); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	ClearAuthCookies(w)
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) Me(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	me, err := a.svc.BuildMe(r.Context(), p.UserID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func (a *API) OauthStart(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	provider := chi.URLParam(r, "provider")
	res, err := a.oauth.StartLogin(r.Context(), provider, CookieValue(r, CookieOAuth))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	SetOAuthCookie(w, res.Binding, res.BindingExp)
	http.Redirect(w, r, res.AuthorizationURL, http.StatusFound)
}

func (a *API) OauthLinkStart(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	deadline, err := a.svc.Grants().VerifiedExpiry(p, "account.identity_link", r.Header.Get(HeaderReauth))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	res, err := a.oauth.StartLink(r.Context(), p, chi.URLParam(r, "provider"), CookieValue(r, CookieOAuth), deadline)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	SetOAuthCookie(w, res.Binding, res.BindingExp)
	NoStore(w)
	writeJSON(w, http.StatusOK, map[string]string{"authorization_url": res.AuthorizationURL})
}

func (a *API) OauthReauthStart(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	var in struct {
		Action string `json:"action"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	res, err := a.oauth.StartReauth(r.Context(), p, chi.URLParam(r, "provider"), in.Action, CookieValue(r, CookieOAuth))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	SetOAuthCookie(w, res.Binding, res.BindingExp)
	NoStore(w)
	writeJSON(w, http.StatusOK, map[string]string{"authorization_url": res.AuthorizationURL})
}

func (a *API) OauthCallback(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.cbLimit, "cb:"+a.ip(r), w, r) {
		return
	}
	provider := chi.URLParam(r, "provider")
	status, receipt, exp, err := a.oauth.Callback(r.Context(), provider,
		r.URL.Query().Get("code"), r.URL.Query().Get("state"),
		CookieValue(r, CookieOAuth), r.URL.Query().Get("error"))
	if err != nil && status == "" {
		status = "provider_error"
	}
	if receipt != "" {
		SetReauthCookie(w, receipt, exp)
	}
	// Preserve a live binding when the callback did not prove ownership of a flow.
	if status != "login_ready" && status != "invalid_flow" {
		clearCookie(w, CookieOAuth, PathAuth, true)
	}
	http.Redirect(w, r, oauth.WebCallback(a.svc.AppOrigin(), provider, status), http.StatusSeeOther)
}

func (a *API) OauthComplete(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.cbLimit, "cb:"+a.ip(r), w, r) {
		return
	}
	_, issued, err := a.oauth.Complete(r.Context(), CookieValue(r, CookieOAuth), a.ip(r), r.UserAgent())
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	me, err := a.svc.BuildMe(r.Context(), issued.Principal.UserID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	a.applySession(w, r, issued)
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func (a *API) Reauth(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	var in struct {
		Action   string `json:"action"`
		Password string `json:"password"`
		Provider string `json:"provider"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	if (in.Password != "") == (in.Provider != "") {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Chỉ gửi password hoặc provider.")
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	if in.Provider != "" {
		if err := a.oauth.ConsumeReceipt(r.Context(), p, in.Provider, in.Action, CookieValue(r, CookieReauth)); err != nil {
			WriteDomainError(w, r, err)
			return
		}
		grant, err := a.svc.Grants().Issue(p, in.Action)
		if err != nil {
			WriteDomainError(w, r, err)
			return
		}
		clearCookie(w, CookieReauth, PathAuth, true)
		NoStore(w)
		writeJSON(w, http.StatusOK, grant)
		return
	}
	grant, err := a.svc.ReauthWithPassword(r.Context(), p, in.Action, in.Password)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, grant)
}

func (a *API) VerifyEmailSend(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	if !a.limitMail(w, r, p.UserID) {
		return
	}
	if err := a.svc.SendVerifyCurrent(r.Context(), p); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) VerifyEmailConfirm(w http.ResponseWriter, r *http.Request) {
	if !a.limit(a.credLimit, "cred:"+a.ip(r), w, r) {
		return
	}
	var in struct {
		Token string `json:"token"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	me, err := a.svc.ConfirmEmailToken(r.Context(), p, in.Token)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func (a *API) PasswordEnrollSend(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	if !a.limitMail(w, r, p.UserID) {
		return
	}
	if err := a.svc.SendEnroll(r.Context(), p); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) limitMail(w http.ResponseWriter, r *http.Request, userID uuid.UUID) bool {
	key := "mail:" + userID.String()
	return a.limit(a.mailMin, key, w, r) && a.limit(a.mailHour, key+":h", w, r)
}

func (a *API) SessionsList(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := a.svc.ListSessions(r.Context(), p, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, page)
}

func (a *API) SessionRevoke(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy.")
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	current, err := a.svc.RevokeSession(r.Context(), p, id)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	if current {
		ClearAuthCookies(w)
	}
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) SessionsRevokeOthers(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	n, err := a.svc.RevokeOthers(r.Context(), p, r.Header.Get(HeaderReauth))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, map[string]int64{"revoked": n})
}

func (a *API) IdentityUnlink(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	if err := a.svc.UnlinkIdentity(r.Context(), p, chi.URLParam(r, "provider"), r.Header.Get(HeaderReauth)); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) AuditList(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := a.svc.ListAudit(r.Context(), p, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, page)
}

func (a *API) NotificationsList(w http.ResponseWriter, r *http.Request) {
	p, _ := authctx.PrincipalFrom(r.Context())
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := a.svc.ListNotifications(r.Context(), p, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, page)
}

func (a *API) NotificationRead(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Read bool `json:"read"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	if !in.Read {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Chỉ chấp nhận read=true.")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy.")
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	if err := a.svc.MarkNotificationRead(r.Context(), p, id); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) SettingsPatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Locale          json.RawMessage `json:"locale"`
		Theme           json.RawMessage `json:"theme"`
		AutoLockMinutes json.RawMessage `json:"auto_lock_minutes"`
		SemanticSuggest json.RawMessage `json:"semantic_suggest"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	var patch auth.SettingsPatch
	if err := decodeSettingsPatchField(in.Locale, &patch.Locale); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return
	}
	if err := decodeSettingsPatchField(in.Theme, &patch.Theme); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return
	}
	if err := decodeSettingsPatchField(in.AutoLockMinutes, &patch.AutoLockMinutes); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return
	}
	if err := decodeSettingsPatchField(in.SemanticSuggest, &patch.SemanticSuggest); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	me, err := a.svc.PatchSettings(r.Context(), p, patch)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	if patch.Locale != nil {
		setCookie(w, CookieLocale, *patch.Locale, PathRoot, time.Now().Add(365*24*time.Hour), false)
	}
	if patch.Theme != nil {
		setCookie(w, CookieTheme, *patch.Theme, PathRoot, time.Now().Add(365*24*time.Hour), false)
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func decodeSettingsPatchField[T any](raw json.RawMessage, dst **T) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if len(raw) == 0 {
			return nil
		}
		return auth.ErrInvalidRequest
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return auth.ErrInvalidRequest
	}
	*dst = &value
	return nil
}

func (a *API) EmailChange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NewEmail string `json:"new_email"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	if !a.limitMail(w, r, p.UserID) {
		return
	}
	if err := a.svc.RequestEmailChange(r.Context(), p, in.NewEmail, r.Header.Get(HeaderReauth)); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) PasswordChange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NewPassword     string `json:"new_password"`
		EnrollmentToken string `json:"enrollment_token"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	p, _ := authctx.PrincipalFrom(r.Context())
	me, issued, err := a.svc.ChangePassword(r.Context(), p, in.NewPassword, in.EnrollmentToken, r.Header.Get(HeaderReauth), a.ip(r), r.UserAgent())
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	a.applySession(w, r, issued)
	NoStore(w)
	writeJSON(w, http.StatusOK, me)
}

func (a *API) FakeAuthorize(w http.ResponseWriter, r *http.Request) {
	f := a.oauth.Fake(chi.URLParam(r, "provider"))
	if f == nil {
		http.NotFound(w, r)
		return
	}
	f.ServeAuthorize(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
