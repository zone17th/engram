package webauthntest_test

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/vault/webauthntest"
)

func randomB64U(t *testing.T, n int) (string, []byte) {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), b
}

func TestVirtualAuthenticatorValidAndBrokenKnobs(t *testing.T) {
	va := webauthntest.New()
	rp := vault.WebAuthnRPConfig{
		RPID:     "localhost",
		RPOrigin: "http://localhost:3000",
		RPName:   "engram",
	}
	challengeB64, _ := randomB64U(t, 32)
	_, prfSalt := randomB64U(t, 32)

	// 1. Valid registration ceremony succeeds and extracts exact cred_id, pubkey, aaguid.
	res, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         rp.RPID,
		Origin:       rp.RPOrigin,
		ChallengeB64: challengeB64,
		PRFSalt:      prfSalt,
	})
	if err != nil {
		t.Fatalf("CreateCredential valid: %v", err)
	}
	if len(res.PRFOutput) != 32 {
		t.Fatalf("PRFOutput len = %d, want 32", len(res.PRFOutput))
	}
	evalAgain, err := va.EvaluatePRF(res.CredentialIDB64, prfSalt)
	if err != nil {
		t.Fatalf("EvaluatePRF: %v", err)
	}
	if !bytes.Equal(res.PRFOutput, evalAgain) {
		t.Fatal("EvaluatePRF must be deterministic for the same credential and salt")
	}

	gotChallenge, _, err := vault.ExtractClientDataChallenge(res.ClientDataJSONB64)
	if err != nil {
		t.Fatalf("ExtractClientDataChallenge: %v", err)
	}
	if gotChallenge != challengeB64 {
		t.Fatalf("challenge = %q, want %q", gotChallenge, challengeB64)
	}

	verified, err := vault.VerifyRegistrationAttestation(rp, res.ClientDataJSONB64, res.AttestationObjectB64, challengeB64)
	if err != nil {
		t.Fatalf("VerifyRegistrationAttestation valid: %v", err)
	}
	if !bytes.Equal(verified.CredID, res.CredentialID) {
		t.Fatal("CredID mismatch")
	}
	if !bytes.Equal(verified.PubKey, res.PublicKeyCOSE) {
		t.Fatal("PubKey mismatch")
	}
	if !bytes.Equal(verified.AAGUID, res.AAGUID) {
		t.Fatal("AAGUID mismatch")
	}

	// 2. Knobs that must break verification with ErrPasskeyAttestationInvalid.
	otherChallengeB64, _ := randomB64U(t, 32)
	brokenCases := []struct {
		name string
		opts webauthntest.RegistrationOptions
	}{
		{
			name: "wrong origin host",
			opts: webauthntest.RegistrationOptions{
				RPID:           rp.RPID,
				Origin:         rp.RPOrigin,
				ChallengeB64:   challengeB64,
				OverrideOrigin: "https://evil.example.com",
			},
		},
		{
			name: "same host wrong dev port",
			opts: webauthntest.RegistrationOptions{
				RPID:           rp.RPID,
				Origin:         rp.RPOrigin,
				ChallengeB64:   challengeB64,
				OverrideOrigin: "http://localhost:3001",
			},
		},
		{
			name: "wrong rpIdHash",
			opts: webauthntest.RegistrationOptions{
				RPID:                rp.RPID,
				Origin:              rp.RPOrigin,
				ChallengeB64:        challengeB64,
				OverrideRPIDForHash: "evil.example.com",
			},
		},
		{
			name: "UV flag off",
			opts: webauthntest.RegistrationOptions{
				RPID:                    rp.RPID,
				Origin:                  rp.RPOrigin,
				ChallengeB64:            challengeB64,
				DisableUserVerification: true,
			},
		},
		{
			name: "UP flag off",
			opts: webauthntest.RegistrationOptions{
				RPID:                rp.RPID,
				Origin:              rp.RPOrigin,
				ChallengeB64:        challengeB64,
				DisableUserPresence: true,
			},
		},
		{
			name: "wrong ceremony type webauthn.get",
			opts: webauthntest.RegistrationOptions{
				RPID:                 rp.RPID,
				Origin:               rp.RPOrigin,
				ChallengeB64:         challengeB64,
				OverrideCeremonyType: "webauthn.get",
			},
		},
		{
			name: "garbage CBOR attestationObject",
			opts: webauthntest.RegistrationOptions{
				RPID:                   rp.RPID,
				Origin:                 rp.RPOrigin,
				ChallengeB64:           challengeB64,
				CorruptAttestationCBOR: true,
			},
		},
		{
			name: "wrong challenge in clientDataJSON",
			opts: webauthntest.RegistrationOptions{
				RPID:                 rp.RPID,
				Origin:               rp.RPOrigin,
				ChallengeB64:         challengeB64,
				OverrideChallengeB64: otherChallengeB64,
			},
		},
	}

	for _, tc := range brokenCases {
		t.Run(tc.name, func(t *testing.T) {
			bad, err := va.CreateCredential(tc.opts)
			if err != nil {
				t.Fatalf("CreateCredential(%s): %v", tc.name, err)
			}
			_, err = vault.VerifyRegistrationAttestation(rp, bad.ClientDataJSONB64, bad.AttestationObjectB64, challengeB64)
			if !errors.Is(err, vault.ErrPasskeyAttestationInvalid) {
				t.Fatalf("VerifyRegistrationAttestation(%s) err = %v, want ErrPasskeyAttestationInvalid", tc.name, err)
			}
		})
	}
}
