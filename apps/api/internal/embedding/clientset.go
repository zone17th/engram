package embedding

import (
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

// ClientRole identifies whether a Client is the primary or shadow provider
// configuration in a ClientSet (plan P05 mục 2.12).
type ClientRole string

const (
	RolePrimary ClientRole = "primary"
	RoleShadow  ClientRole = "shadow"
)

// Client pairs a Provider with its full seven-field embedid.Identity and role
// (plan P05 mục 2.12, BE-1, M1).
type Client struct {
	Provider Provider
	Identity embedid.Identity
	Role     ClientRole
}

// NewClient constructs a Client for p with the given queryPrefix and docPrefix
// (Role defaults to RolePrimary). Identity is populated with all seven fields:
//   - Provider:      p.Name()
//   - Model:         p.Model()
//   - ModelVersion:  p.ModelVersion()
//   - Dims:          p.Dims()
//   - QueryPrefix:   queryPrefix
//   - DocPrefix:     docPrefix
//   - Preprocessing: Preprocessing ("v1")
func NewClient(p Provider, queryPrefix, docPrefix string) Client {
	return NewClientWithRole(p, queryPrefix, docPrefix, RolePrimary)
}

// NewClientWithRole constructs a Client for p with an explicit role
// (RolePrimary or RoleShadow).
func NewClientWithRole(p Provider, queryPrefix, docPrefix string, role ClientRole) Client {
	if p == nil {
		p = Noop{}
	}
	if role == "" {
		role = RolePrimary
	}
	return Client{
		Provider: p,
		Identity: embedid.Identity{
			Provider:      p.Name(),
			Model:         p.Model(),
			ModelVersion:  p.ModelVersion(),
			Dims:          p.Dims(),
			QueryPrefix:   queryPrefix,
			DocPrefix:     docPrefix,
			Preprocessing: Preprocessing,
		},
		Role: role,
	}
}

// ClientSet holds the configured primary Client and an optional shadow Client
// for zero-downtime generation cutover (plan P05 mục 2.12, 2.15, ADR 0007 §6).
type ClientSet struct {
	primary   Client
	shadow    Client
	hasShadow bool
}

// NewClientSet creates a ClientSet with a primary client and an optional shadow
// client (pass nil for shadow when EMBEDDING_SHADOW_PROVIDER is empty).
func NewClientSet(primary Client, shadow *Client) *ClientSet {
	primary.Role = RolePrimary
	cs := &ClientSet{
		primary: primary,
	}
	if shadow != nil && shadow.Provider != nil && shadow.Provider.Name() != "" && shadow.Provider.Name() != ProviderNoop {
		sc := *shadow
		sc.Role = RoleShadow
		cs.shadow = sc
		cs.hasShadow = true
	}
	return cs
}

// Primary returns the primary client.
func (s *ClientSet) Primary() Client {
	if s == nil {
		return NewClient(Noop{}, "", "")
	}
	return s.primary
}

// Shadow returns the shadow client and true if a non-noop shadow is configured.
func (s *ClientSet) Shadow() (Client, bool) {
	if s == nil || !s.hasShadow {
		return Client{}, false
	}
	return s.shadow, true
}

// Match returns the configured client (primary or shadow) whose full seven-field
// embedid.Identity matches id (client.Identity.Key() == id.Key()), checked
// before any network call (plan P05 mục 2.12 BE-1, M1). A noop client never
// matches any generation.
func (s *ClientSet) Match(id embedid.Identity) (Client, bool) {
	if s == nil || id.Provider == "" || id.Provider == ProviderNoop {
		return Client{}, false
	}
	wantKey := id.Key()
	if isMatchableClient(s.primary) && s.primary.Identity.Key() == wantKey {
		return s.primary, true
	}
	if s.hasShadow && isMatchableClient(s.shadow) && s.shadow.Identity.Key() == wantKey {
		return s.shadow, true
	}
	return Client{}, false
}

func isMatchableClient(c Client) bool {
	return c.Provider != nil &&
		c.Identity.Provider != "" &&
		c.Identity.Provider != ProviderNoop &&
		c.Identity.Dims > 0
}
