// Package secevent là DTO trung lập giữa auth và audit/notification.
package secevent

import "github.com/google/uuid"

const (
	ResultSuccess = "success"
	ResultFailure = "failure"

	EventSignup              = "auth.signup"
	EventLoginSuccess        = "auth.login.success"
	EventLoginFailure        = "auth.login.failure"
	EventLogout              = "auth.logout"
	EventRefreshReuse        = "auth.refresh.reuse"
	EventSessionRevoke       = "auth.session.revoke"
	EventSessionRevokeOthers = "auth.session.revoke_others"
	EventPasswordChange      = "auth.password.change"
	EventPasswordEnroll      = "auth.password.enroll"
	EventEmailChangeRequest  = "auth.email.change_request"
	EventEmailChangeConfirm  = "auth.email.change_confirm"
	EventEmailVerify         = "auth.email.verify"
	EventIdentityLink        = "auth.identity.link"
	EventIdentityUnlink      = "auth.identity.unlink"
	EventSettingsChange      = "auth.settings.change"
	EventOAuthLogin          = "auth.oauth.login"
	EventReauth              = "auth.reauth"

	NoticeSecurity = "security"

	ProviderPassword = "password"
	ProviderGoogle   = "google"
	ProviderGitHub   = "github"

	FieldLocale          = "locale"
	FieldTheme           = "theme"
	FieldAutoLock        = "auto_lock_minutes"
	FieldSemanticSuggest = "semantic_suggest"

	ReasonReuse      = "reuse"
	ReasonInvalid    = "invalid"
	ReasonExpired    = "expired"
	ReasonRevoked    = "revoked"
	ReasonLastMethod = "last_method"
	ReasonCollision  = "collision"
	ReasonUnverified = "unverified"

	EventEntryImport = "entry.import"

	ImportSourcePaste = "paste"
	ImportSourceFile  = "file"
)

var providers = map[string]struct{}{
	ProviderPassword: {}, ProviderGoogle: {}, ProviderGitHub: {},
}

var fields = map[string]struct{}{
	FieldLocale: {}, FieldTheme: {}, FieldAutoLock: {}, FieldSemanticSuggest: {},
}

var reasons = map[string]struct{}{
	ReasonReuse: {}, ReasonInvalid: {}, ReasonExpired: {}, ReasonRevoked: {},
	ReasonLastMethod: {}, ReasonCollision: {}, ReasonUnverified: {},
}

var importSources = map[string]struct{}{
	ImportSourcePaste: {}, ImportSourceFile: {},
}

// Meta chỉ chứa enum đã whitelist — không map tự do.
type Meta struct {
	Provider string   `json:"provider,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Fields   []string `json:"fields,omitempty"`
	Count    int      `json:"count,omitempty"`

	ImportSource string `json:"import_source,omitempty"`
}

func (m Meta) Sanitize() Meta {
	out := Meta{Count: m.Count}
	if _, ok := providers[m.Provider]; ok {
		out.Provider = m.Provider
	}
	if _, ok := reasons[m.Reason]; ok {
		out.Reason = m.Reason
	}
	for _, f := range m.Fields {
		if _, ok := fields[f]; ok {
			out.Fields = append(out.Fields, f)
		}
	}
	if _, ok := importSources[m.ImportSource]; ok {
		out.ImportSource = m.ImportSource
	}
	return out
}

type Record struct {
	UserID    *uuid.UUID
	SessionID *uuid.UUID
	Event     string
	Result    string
	Actor     string
	IPHash    []byte
	UserAgent string
	Meta      Meta
}

type Notice struct {
	UserID       uuid.UUID
	Kind         string
	Meta         Meta
	EmailTargets []string
}
