package auth

import (
	"time"

	"github.com/google/uuid"
)

type Me struct {
	User       MeUser       `json:"user"`
	Settings   MeSettings   `json:"settings"`
	Identities []MeIdentity `json:"identities"`
	Features   MeFeatures   `json:"features"`
	Vault      MeVault      `json:"vault"`
}

type MeUser struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"email_verified"`
	CreatedAt     time.Time `json:"created_at"`
}

type MeSettings struct {
	Locale          string `json:"locale"`
	Theme           string `json:"theme"`
	AutoLockMinutes int    `json:"auto_lock_minutes"`
	SemanticSuggest bool   `json:"semantic_suggest"`
}

type MeIdentity struct {
	Provider string    `json:"provider"`
	LinkedAt time.Time `json:"linked_at"`
}

type MeFeatures struct {
	SemanticAvailable           bool     `json:"semantic_available"`
	EmailVerificationRequired   bool     `json:"email_verification_required"`
	OAuthProviders              []string `json:"oauth_providers"`
	OAuthReauthProviders        []string `json:"oauth_reauth_providers"`
	PasswordEnrollmentAvailable bool     `json:"password_enrollment_available"`
	CaptchaSiteKey              *string  `json:"captcha_site_key"`
}

type MeVault struct {
	Status string `json:"status"`
}

type AuthConfig struct {
	OAuthProviders            []string `json:"oauth_providers"`
	EmailVerificationRequired bool     `json:"email_verification_required"`
	CaptchaSiteKey            *string  `json:"captcha_site_key"`
	MailDeliveryAvailable     bool     `json:"mail_delivery_available"`
}

type SessionItem struct {
	ID          uuid.UUID `json:"id"`
	Current     bool      `json:"current"`
	DeviceLabel *string   `json:"device_label"`
	UserAgent   *string   `json:"user_agent"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type CursorPage[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type AuditItem struct {
	ID        string         `json:"id"`
	Event     string         `json:"event"`
	Result    string         `json:"result"`
	Actor     *string        `json:"actor"`
	CreatedAt time.Time      `json:"created_at"`
	Meta      map[string]any `json:"meta,omitempty"`
}

type NotificationItem struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Meta      map[string]any `json:"meta,omitempty"`
	ReadAt    *time.Time     `json:"read_at"`
	CreatedAt time.Time      `json:"created_at"`
}

type ReauthGrant struct {
	Grant     string    `json:"grant"`
	Action    string    `json:"action"`
	ExpiresAt time.Time `json:"expires_at"`
}
