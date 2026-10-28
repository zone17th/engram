package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"time"
)

type Identity struct {
	Provider      string
	UID           string
	Email         string
	EmailVerified bool
	AuthTime      *time.Time
}

type AuthRequest struct {
	State         string
	RedirectURI   string
	CodeChallenge string
	Nonce         string
	PromptLogin   bool
}

type ExchangeRequest struct {
	Code         string
	CodeVerifier string
	RedirectURI  string
	Nonce        string
}

type Provider interface {
	Name() string
	SupportsReauth() bool
	AuthorizationURL(in AuthRequest) (string, error)
	Exchange(ctx context.Context, in ExchangeRequest) (Identity, error)
}

func PKCEChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func NewPKCEVerifier() (string, error) {
	raw := make([]byte, 32)
	if _, err := readRand(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func CallbackStatus(status string) bool {
	switch status {
	case "login_ready", "linked", "reauth_ready", "cancelled",
		"identity_conflict", "invalid_flow", "provider_error", "reauth_unavailable":
		return true
	default:
		return false
	}
}

func WebCallback(origin, provider, status string) string {
	u, err := url.Parse(origin)
	if err != nil {
		return "/app/auth/callback/" + provider + "?status=invalid_flow"
	}
	if !CallbackStatus(status) {
		status = "invalid_flow"
	}
	u.Path = "/app/auth/callback/" + provider
	q := u.Query()
	q.Set("status", status)
	u.RawQuery = q.Encode()
	return u.String()
}
