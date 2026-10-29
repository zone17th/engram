package vault

import (
	"context"
	"encoding/json"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RewrapInput là đầu vào cho `PUT /vault/kek` (`vaultRewrap`, plan Task 9).
type RewrapInput struct {
	KDFRaw               json.RawMessage `json:"kdf"`
	VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
	IfMatch              httpx.VaultIfMatch
	IP                   string
	UA                   string
}

// Rewrap đổi passphrase mã hoá vault (`PUT /vault/kek`).
// TODO(P03-T9): implement PUT /vault/kek rewrap + audit vault.rewrap + notice/mail.
func (s *Service) Rewrap(_ context.Context, _ authctx.Principal, _ RewrapInput) (VaultVersionResponse, error) {
	return VaultVersionResponse{}, errCode("dependency_unavailable")
}
