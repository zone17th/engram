package vault_test

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/vault/webauthntest"
)

func TestExtractClientDataChallengeAndVerifyRegistrationAttestation(t *testing.T) {
	va := webauthntest.New()
	rp := vault.WebAuthnRPConfig{
		RPID:     "engram.zone17.click",
		RPOrigin: "https://engram.zone17.click",
		RPName:   "engram",
	}

	rawChal := make([]byte, 32)
	if _, err := rand.Read(rawChal); err != nil {
		t.Fatal(err)
	}
	chalB64 := base64.RawURLEncoding.EncodeToString(rawChal)

	res, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: chalB64,
	})
	if err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	gotChal, _, err := vault.ExtractClientDataChallenge(res.ClientDataJSONB64)
	if err != nil {
		t.Fatalf("ExtractClientDataChallenge: %v", err)
	}
	if gotChal != chalB64 {
		t.Fatalf("got challenge %q, want %q", gotChal, chalB64)
	}

	verified, err := vault.VerifyRegistrationAttestation(rp, res.ClientDataJSONB64, res.AttestationObjectB64, chalB64)
	if err != nil {
		t.Fatalf("VerifyRegistrationAttestation: %v", err)
	}
	if len(verified.CredID) != 32 || len(verified.PubKey) == 0 || len(verified.AAGUID) != 16 {
		t.Fatalf("unexpected verified fields: credID=%d pubKey=%d aaguid=%d", len(verified.CredID), len(verified.PubKey), len(verified.AAGUID))
	}

	// Non-base64url padding on client_data_json rejected.
	if _, _, err := vault.ExtractClientDataChallenge(res.ClientDataJSONB64 + "="); !errors.Is(err, vault.ErrPasskeyAttestationInvalid) {
		t.Fatalf("expected ErrPasskeyAttestationInvalid for padded client_data_json, got %v", err)
	}

	// Wrong length challenge (16 bytes instead of 32 bytes) in clientDataJSON rejected with ErrPasskeyChallengeInvalid.
	shortChalB64 := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	shortRes, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: shortChalB64,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := vault.ExtractClientDataChallenge(shortRes.ClientDataJSONB64); !errors.Is(err, vault.ErrPasskeyChallengeInvalid) {
		t.Fatalf("expected ErrPasskeyChallengeInvalid for 16-byte challenge, got %v", err)
	}
}
