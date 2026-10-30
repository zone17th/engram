package vault

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type rkVectorSuiteV1 struct {
	Schema     string               `json:"schema"`
	Producer   string               `json:"producer"`
	Generation []rkGenerationVector `json:"generation"`
	Cases      []rkCaseVector       `json:"cases"`
}

type rkGenerationVector struct {
	ID             string `json:"id"`
	Slot           int    `json:"slot"`
	EntropyHex     string `json:"entropy_hex"`
	Display        string `json:"display"`
	RKNorm         string `json:"rk_norm"`
	LookupHashHex  string `json:"lookup_hash_hex"`
	LookupHashB64U string `json:"lookup_hash_b64u"`
	WrapKeyHex     string `json:"wrap_key_hex"`
	WrapKeyB64U    string `json:"wrap_key_b64u"`
}

type rkCaseVector struct {
	ID            string  `json:"id"`
	Description   string  `json:"description"`
	Input         string  `json:"input"`
	Valid         bool    `json:"valid"`
	RKNorm        *string `json:"rk_norm"`
	LookupHashHex *string `json:"lookup_hash_hex"`
	WrapKeyHex    *string `json:"wrap_key_hex"`
	ExpectedError *string `json:"expected_error"`
}

func loadRKVectors(t *testing.T) rkVectorSuiteV1 {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "crypto-vectors", "vectors", "rk-v1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var suite rkVectorSuiteV1
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatalf("unmarshal rk-v1.json: %v", err)
	}
	if suite.Schema != "engram-rk-vectors-v1" {
		t.Fatalf("unexpected schema %q", suite.Schema)
	}
	return suite
}

func TestRecoveryKeyCrossCheckVectors(t *testing.T) {
	suite := loadRKVectors(t)
	if len(suite.Generation) != 10 {
		t.Fatalf("expected 10 generation vectors, got %d", len(suite.Generation))
	}
	if len(suite.Cases) == 0 {
		t.Fatalf("expected non-empty RK cases")
	}

	t.Run("generation vectors (slots 1..10, display, rk_norm, lookup_hash, wrap_key)", func(t *testing.T) {
		for _, gv := range suite.Generation {
			t.Run(gv.ID, func(t *testing.T) {
				entropy, err := hex.DecodeString(gv.EntropyHex)
				if err != nil {
					t.Fatalf("decode entropy hex: %v", err)
				}
				gen, err := generateRecoveryKey(gv.Slot, entropy)
				if err != nil {
					t.Fatalf("generateRecoveryKey: %v", err)
				}
				if gen.Display != gv.Display {
					t.Fatalf("Display = %q, want %q", gen.Display, gv.Display)
				}
				if gen.Normalized != gv.RKNorm {
					t.Fatalf("Normalized = %q, want %q", gen.Normalized, gv.RKNorm)
				}

				lookupHash, err := deriveRecoveryLookupHash(gen.Display)
				if err != nil {
					t.Fatalf("deriveRecoveryLookupHash: %v", err)
				}
				if gotHex := hex.EncodeToString(lookupHash[:]); gotHex != gv.LookupHashHex {
					t.Fatalf("lookup_hash_hex = %s, want %s", gotHex, gv.LookupHashHex)
				}
				if gotB64 := EncodeBase64URL(lookupHash[:]); gotB64 != gv.LookupHashB64U {
					t.Fatalf("lookup_hash_b64u = %s, want %s", gotB64, gv.LookupHashB64U)
				}

				wrapKey, err := deriveRecoveryWrapKey(gen.Display)
				if err != nil {
					t.Fatalf("deriveRecoveryWrapKey: %v", err)
				}
				if gotHex := hex.EncodeToString(wrapKey[:]); gotHex != gv.WrapKeyHex {
					t.Fatalf("wrap_key_hex = %s, want %s", gotHex, gv.WrapKeyHex)
				}
				if gotB64 := EncodeBase64URL(wrapKey[:]); gotB64 != gv.WrapKeyB64U {
					t.Fatalf("wrap_key_b64u = %s, want %s", gotB64, gv.WrapKeyB64U)
				}

				// Onboarding display string and normalized string must produce the exact same lookup_hash and wrap_key.
				lookupFromNorm, err := deriveRecoveryLookupHash(gen.Normalized)
				if err != nil {
					t.Fatalf("deriveRecoveryLookupHash(normalized): %v", err)
				}
				if lookupFromNorm != lookupHash {
					t.Fatalf("lookup_hash from normalized differs from display")
				}
			})
		}
	})

	t.Run("normalization and hash cross-check cases (positive and negative)", func(t *testing.T) {
		for _, tc := range suite.Cases {
			t.Run(tc.ID, func(t *testing.T) {
				gotNorm, err := normalizeRecoveryKey(tc.Input)
				if tc.Valid {
					if err != nil {
						t.Fatalf("expected valid for %s (%s), got error: %v", tc.ID, tc.Description, err)
					}
					if tc.RKNorm == nil || gotNorm != *tc.RKNorm {
						t.Fatalf("rk_norm = %q, want %v", gotNorm, tc.RKNorm)
					}

					lookupHash, err := deriveRecoveryLookupHash(tc.Input)
					if err != nil {
						t.Fatalf("deriveRecoveryLookupHash: %v", err)
					}
					gotLookupHex := hex.EncodeToString(lookupHash[:])
					if tc.LookupHashHex == nil || gotLookupHex != *tc.LookupHashHex {
						t.Fatalf("lookup_hash_hex = %s, want %v", gotLookupHex, tc.LookupHashHex)
					}

					wrapKey, err := deriveRecoveryWrapKey(tc.Input)
					if err != nil {
						t.Fatalf("deriveRecoveryWrapKey: %v", err)
					}
					gotWrapHex := hex.EncodeToString(wrapKey[:])
					if tc.WrapKeyHex == nil || gotWrapHex != *tc.WrapKeyHex {
						t.Fatalf("wrap_key_hex = %s, want %v", gotWrapHex, tc.WrapKeyHex)
					}
				} else {
					if err == nil {
						t.Fatalf("expected validation error for %s (%s), got rk_norm=%q", tc.ID, tc.Description, gotNorm)
					}
					if !errors.Is(err, ErrRecoveryKeyInvalid) {
						t.Fatalf("expected ErrRecoveryKeyInvalid, got %v", err)
					}
					if tc.ExpectedError == nil || *tc.ExpectedError != "validation" {
						t.Fatalf("unexpected expected_error %v in vector %s", tc.ExpectedError, tc.ID)
					}
					if _, err := deriveRecoveryLookupHash(tc.Input); !errors.Is(err, ErrRecoveryKeyInvalid) {
						t.Fatalf("deriveRecoveryLookupHash on invalid input: got %v, want ErrRecoveryKeyInvalid", err)
					}
					if _, err := deriveRecoveryWrapKey(tc.Input); !errors.Is(err, ErrRecoveryKeyInvalid) {
						t.Fatalf("deriveRecoveryWrapKey on invalid input: got %v, want ErrRecoveryKeyInvalid", err)
					}
				}
			})
		}
	})
}
