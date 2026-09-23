// Package authhttp là adapter HTTP: cookie, decode, map lỗi domain, mount route.
package authhttp

import (
	"net/http"
	"time"
)

const (
	CookieSession = "sabk_session"
	CookieRefresh = "sabk_refresh"
	CookieCSRF    = "sabk_csrf"
	CookieAnon    = "sabk_anon"
	CookieOAuth   = "sabk_oauth"
	CookieReauth  = "sabk_reauth"
	CookieLocale  = "sabk_locale"
	CookieTheme   = "sabk_theme"

	PathAPI      = "/api"
	PathAuth     = "/api/v1/auth"
	PathRoot     = "/"
	HeaderCSRF   = "X-CSRF-Token"
	HeaderReauth = "X-Reauth-Token"
)

func setCookie(w http.ResponseWriter, name, value, path string, exp time.Time, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		Expires:  exp,
		MaxAge:   maxAge(exp),
		Secure:   true,
		HttpOnly: httpOnly,
		SameSite: http.SameSiteLaxMode,
	})
}

func maxAge(exp time.Time) int {
	if exp.IsZero() {
		return 0
	}
	n := int(time.Until(exp).Seconds())
	if n < 0 {
		return 0
	}
	return n
}

func clearCookie(w http.ResponseWriter, name, path string, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		Secure:   true,
		HttpOnly: httpOnly,
		SameSite: http.SameSiteLaxMode,
	})
}

func SetSessionCookies(w http.ResponseWriter, access string, accessExp time.Time, refresh string, sessionExp time.Time) {
	setCookie(w, CookieSession, access, PathAPI, accessExp, true)
	setCookie(w, CookieRefresh, refresh, PathAuth, sessionExp, true)
}

func SetCSRFCookie(w http.ResponseWriter, token string, exp time.Time) {
	setCookie(w, CookieCSRF, token, PathRoot, exp, false)
}

func SetAnonCookie(w http.ResponseWriter, nonce string, exp time.Time) {
	setCookie(w, CookieAnon, nonce, PathAuth, exp, true)
}

func SetOAuthCookie(w http.ResponseWriter, token string, exp time.Time) {
	setCookie(w, CookieOAuth, token, PathAuth, exp, true)
}

func SetReauthCookie(w http.ResponseWriter, token string, exp time.Time) {
	setCookie(w, CookieReauth, token, PathAuth, exp, true)
}

func ClearAuthCookies(w http.ResponseWriter) {
	clearCookie(w, CookieSession, PathAPI, true)
	clearCookie(w, CookieRefresh, PathAuth, true)
	clearCookie(w, CookieCSRF, PathRoot, false)
	clearCookie(w, CookieAnon, PathAuth, true)
	clearCookie(w, CookieOAuth, PathAuth, true)
	clearCookie(w, CookieReauth, PathAuth, true)
}

func CookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || c == nil {
		return ""
	}
	return c.Value
}

func NoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}
