package oauth

import (
	"context"
	"crypto/subtle"
	"html"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zone17th/engram/apps/api/internal/auth"
)

// Fake là provider in-process: kiểm PKCE/nonce thật, không bỏ qua challenge.
type Fake struct {
	name          string
	reauth        bool
	base          string
	mu            sync.Mutex
	pending       map[string]pendingAuth
	Identity      Identity
	Now           func() time.Time
	DropAuthTime  bool
	StaleAuthTime bool
	onExchange    func(in ExchangeRequest)
}

type pendingAuth struct {
	Challenge string
	Nonce     string
	Issued    time.Time
	Identity  *Identity
}

func NewFake(name string, reauth bool, identity Identity) *Fake {
	if identity.Provider == "" {
		identity.Provider = name
	}
	return &Fake{
		name:     name,
		reauth:   reauth,
		pending:  make(map[string]pendingAuth),
		Identity: identity,
		Now:      time.Now,
	}
}

func (f *Fake) Name() string              { return f.name }
func (f *Fake) SupportsReauth() bool      { return f.reauth }
func (f *Fake) SetAuthorizeBase(u string) { f.base = u }

func (f *Fake) SetOnExchange(fn func(in ExchangeRequest)) {
	f.mu.Lock()
	f.onExchange = fn
	f.mu.Unlock()
}

func (f *Fake) AuthorizationURL(in AuthRequest) (string, error) {
	f.mu.Lock()
	f.pending[in.State] = pendingAuth{Challenge: in.CodeChallenge, Nonce: in.Nonce, Issued: f.Now()}
	f.mu.Unlock()
	base := f.base
	if base == "" {
		base = "/__fake/oauth/" + f.name
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("state", in.State)
	q.Set("redirect_uri", in.RedirectURI)
	q.Set("code_challenge", in.CodeChallenge)
	if in.Nonce != "" {
		q.Set("nonce", in.Nonce)
	}
	if in.PromptLogin {
		q.Set("prompt", "login")
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (f *Fake) IssueCode(state, challenge, nonce string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pending[state] = pendingAuth{Challenge: challenge, Nonce: nonce, Issued: f.Now()}
	return "fake-" + state
}

func (f *Fake) Exchange(_ context.Context, in ExchangeRequest) (Identity, error) {
	f.mu.Lock()
	onEx := f.onExchange
	f.mu.Unlock()
	if onEx != nil {
		onEx(in)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	state := ""
	if len(in.Code) > 5 && in.Code[:5] == "fake-" {
		state = in.Code[5:]
	}
	p, ok := f.pending[state]
	if !ok {
		return Identity{}, auth.ErrOAuthStateInvalid
	}
	delete(f.pending, state)
	if p.Challenge != "" {
		got := PKCEChallenge(in.CodeVerifier)
		if subtle.ConstantTimeCompare([]byte(got), []byte(p.Challenge)) != 1 {
			return Identity{}, auth.ErrOAuthStateInvalid
		}
	}
	if p.Nonce != "" && in.Nonce != "" && p.Nonce != in.Nonce {
		return Identity{}, auth.ErrOAuthStateInvalid
	}
	id := f.Identity
	if p.Identity != nil {
		id = *p.Identity
	}
	if !id.EmailVerified {
		return Identity{}, auth.ErrOAuthProviderError
	}
	if f.DropAuthTime {
		id.AuthTime = nil
	} else if f.StaleAuthTime {
		t := f.Now().Add(-10 * time.Minute)
		id.AuthTime = &t
	} else if id.AuthTime == nil {
		t := f.Now()
		id.AuthTime = &t
	}
	return id, nil
}

// ServeAuthorize hoàn tất vòng authorize → callback trên cùng origin test.
// Trình duyệt (Accept: text/html) thấy form chọn identity/cancel. Client HTTP
// không HTML vẫn auto-redirect — giữ harness Go hiện tại.
func (f *Fake) ServeAuthorize(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		values = r.Form
	}
	state := values.Get("state")
	redirect := values.Get("redirect_uri")
	challenge := values.Get("code_challenge")
	nonce := values.Get("nonce")
	if state == "" || redirect == "" {
		http.Error(w, "invalid", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodPost && wantsHTML(r) {
		writeFakeAuthorizeForm(w, f.name, f.Identity, values)
		return
	}
	outcome := values.Get("outcome")
	if outcome == "" {
		outcome = "ok"
	}
	target, err := url.Parse(redirect)
	if err != nil {
		http.Error(w, "invalid", http.StatusBadRequest)
		return
	}
	q := target.Query()
	q.Set("state", state)
	if outcome == "cancel" {
		q.Set("error", "access_denied")
		target.RawQuery = q.Encode()
		http.Redirect(w, r, target.String(), http.StatusFound)
		return
	}
	if outcome == "error" {
		q.Set("error", "server_error")
		target.RawQuery = q.Encode()
		http.Redirect(w, r, target.String(), http.StatusFound)
		return
	}
	overlay := f.Identity
	if email := strings.TrimSpace(values.Get("email")); email != "" {
		overlay.Email = email
	}
	if subject := strings.TrimSpace(values.Get("subject")); subject != "" {
		overlay.UID = subject
	}
	code := f.issueCode(state, challenge, nonce, &overlay)
	q.Set("code", code)
	target.RawQuery = q.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (f *Fake) issueCode(state, challenge, nonce string, id *Identity) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pending[state] = pendingAuth{Challenge: challenge, Nonce: nonce, Issued: f.Now(), Identity: id}
	return "fake-" + state
}

func wantsHTML(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func writeFakeAuthorizeForm(w http.ResponseWriter, provider string, id Identity, values url.Values) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	email := values.Get("email")
	if email == "" {
		email = id.Email
	}
	subject := values.Get("subject")
	if subject == "" {
		subject = id.UID
	}
	hidden := func(name string) string {
		return `<input type="hidden" name="` + html.EscapeString(name) + `" value="` + html.EscapeString(values.Get(name)) + `">`
	}
	_, _ = w.Write([]byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake ` + html.EscapeString(provider) + ` (not production)</title></head><body>
<p>Local fake provider — not Google or GitHub production.</p>
<form method="post">
` + hidden("state") + hidden("redirect_uri") + hidden("code_challenge") + hidden("nonce") + `
<label>Email <input name="email" type="email" value="` + html.EscapeString(email) + `"></label>
<label>Subject <input name="subject" value="` + html.EscapeString(subject) + `"></label>
<button type="submit" name="outcome" value="ok">Continue</button>
<button type="submit" name="outcome" value="cancel">Cancel</button>
<button type="submit" name="outcome" value="error">Provider error</button>
</form>
</body></html>`))
}
