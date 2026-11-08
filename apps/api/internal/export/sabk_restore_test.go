package export

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/blake2b"

	"github.com/zone17th/engram/apps/api/internal/vault"
)

const canonicalSampleVaultKeyID = "vk:AAECAwQFBgcICQoLDA0ODw"

type jsVectorsFile struct {
	Inputs struct {
		VKB64U          string `json:"vk_b64u"`
		PassphraseUTF8  string `json:"passphrase_utf8"`
		RKSlot          int32  `json:"rk_slot"`
		RKNorm          string `json:"rk_norm"`
		PWKB64U         string `json:"pwk_b64u"`
		X25519PublicB64 string `json:"x25519_public_b64u"`
		Ed25519PubB64   string `json:"ed25519_public_b64u"`
		KDF             struct {
			Alg         string `json:"alg"`
			Ops         int    `json:"ops"`
			Mem         int    `json:"mem"`
			Parallelism int    `json:"parallelism"`
			Salt        string `json:"salt"`
		} `json:"kdf"`
		Entries struct {
			Text struct {
				EntryID       string `json:"entry_id"`
				NonceHex      string `json:"nonce_hex"`
				PlaintextUTF8 string `json:"plaintext_utf8"`
			} `json:"text"`
			JSON struct {
				EntryID       string `json:"entry_id"`
				NonceHex      string `json:"nonce_hex"`
				PlaintextUTF8 string `json:"plaintext_utf8"`
			} `json:"json"`
		} `json:"entries"`
	} `json:"inputs"`
	Derived struct {
		RKLookupHashB64 string `json:"rk_lookup_hash_b64u"`
		Wraps           struct {
			KEK struct {
				WrapB64U string `json:"wrap_b64u"`
			} `json:"kek"`
			RK struct {
				WrapB64U string `json:"wrap_b64u"`
			} `json:"rk"`
			PRF struct {
				WrapB64U string `json:"wrap_b64u"`
			} `json:"prf"`
			Priv struct {
				WrapB64U string `json:"wrap_b64u"`
			} `json:"priv"`
		} `json:"wraps"`
	} `json:"derived"`
}

func loadJSVectors(t *testing.T) jsVectorsFile {
	t.Helper()
	p := filepath.Join("..", "..", "..", "..", "packages", "crypto-vectors", "vectors", "js-v1.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	var v jsVectorsFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal js-v1.json: %v", err)
	}
	return v
}

func buildSampleSabkFromVectors(t *testing.T, vec jsVectorsFile) []byte {
	t.Helper()
	vk, err := vault.DecodeBase64URLStrict(vec.Inputs.VKB64U, 32)
	if err != nil {
		t.Fatalf("decode vk: %v", err)
	}
	textNonce, err := hex.DecodeString(vec.Inputs.Entries.Text.NonceHex)
	if err != nil {
		t.Fatal(err)
	}
	jsonNonce, err := hex.DecodeString(vec.Inputs.Entries.JSON.NonceHex)
	if err != nil {
		t.Fatal(err)
	}
	textEnv, textCT, err := vault.SealEntry(
		vec.Inputs.Entries.Text.EntryID,
		canonicalSampleVaultKeyID,
		[]byte(vec.Inputs.Entries.Text.PlaintextUTF8),
		vk,
		textNonce,
	)
	if err != nil {
		t.Fatalf("SealEntry(text): %v", err)
	}
	jsonEnv, jsonCT, err := vault.SealEntry(
		vec.Inputs.Entries.JSON.EntryID,
		canonicalSampleVaultKeyID,
		[]byte(vec.Inputs.Entries.JSON.PlaintextUTF8),
		vk,
		jsonNonce,
	)
	if err != nil {
		t.Fatalf("SealEntry(json): %v", err)
	}
	textEnvRaw, _ := json.Marshal(textEnv)
	jsonEnvRaw, _ := json.Marshal(jsonEnv)
	kdfRaw, _ := json.Marshal(vec.Inputs.KDF)

	tagID := uuid.MustParse("11111111-2222-4333-8444-555555555555")
	itemID := uuid.MustParse("22222222-3333-4444-8555-666666666666")
	passkeyID := uuid.MustParse("33333333-4444-4555-8666-777777777777")
	hint := "Tầng 2"
	delAt := "2026-11-02T00:00:00Z"
	delVia := "entry"

	doc := map[string]any{
		"format":      SabkFormat,
		"version":     SabkVersion,
		"exported_at": "2026-11-07T08:30:00Z",
		"snapshot": SabkSnapshot{
			Consistency:                 SabkConsistency,
			IncludesActive:              true,
			IncludesSoftDeletedUnpurged: true,
			ExcludesPurged:              true,
			SoftDeleteRetentionDays:     SabkRetentionDays,
			Counts:                      SabkCounts{Tags: 1, Items: 1, ItemTags: 1, Entries: 2},
		},
		"vault": SabkVault{
			VaultKeyID:           canonicalSampleVaultKeyID,
			Version:              3,
			KDF:                  kdfRaw,
			VaultKeyWrappedByKEK: vec.Derived.Wraps.KEK.WrapB64U,
			X25519Public:         vec.Inputs.X25519PublicB64,
			Ed25519Public:        vec.Inputs.Ed25519PubB64,
			PrivateKeysWrapped:   vec.Derived.Wraps.Priv.WrapB64U,
			RecoveryKeys: []SabkRecoveryKey{{
				Slot:       vec.Inputs.RKSlot,
				LookupHash: vec.Derived.RKLookupHashB64,
				Wrap:       vec.Derived.Wraps.RK.WrapB64U,
			}},
			Passkeys: []SabkPasskey{{
				ID:        passkeyID,
				Name:      "MacBook Touch ID",
				CredID:    vault.EncodeBase64URL(bytes.Repeat([]byte{0x42}, 32)),
				PRFSalt:   vault.EncodeBase64URL(bytes.Repeat([]byte{0x24}, 32)),
				VKWrap:    vec.Derived.Wraps.PRF.WrapB64U,
				Pubkey:    vault.EncodeBase64URL(bytes.Repeat([]byte{0x99}, 32)),
				AAGUID:    "adce0002-35bc-c60a-648b-0b25f1f05503",
				CreatedAt: "2026-10-29T10:00:00Z",
			}},
		},
		"tags": []SabkTag{{
			ID:         tagID,
			Display:    "wifi-khách",
			Normalized: "wifi-khách",
			ItemCount:  1,
			LastUsedAt: "2026-11-01T00:00:00Z",
			CreatedAt:  "2026-10-01T00:00:00Z",
			DeletedAt:  nil,
		}},
		"items": []SabkItem{{
			ID:             itemID,
			Name:           "wifi",
			NameNormalized: "wifi",
			Hint:           &hint,
			EntryCount:     1,
			Version:        1,
			LastUsedAt:     "2026-11-05T12:00:00Z",
			CreatedAt:      "2026-10-01T00:00:00Z",
			UpdatedAt:      "2026-11-05T12:00:00Z",
			DeletedAt:      nil,
			DeleteBatch:    nil,
		}},
		"item_tags": []SabkItemTag{{
			ItemID:    itemID,
			TagID:     tagID,
			CreatedAt: "2026-10-01T00:00:00Z",
		}},
		"entries": []SabkEntry{
			{
				ID:                 uuid.MustParse(vec.Inputs.Entries.Text.EntryID),
				ItemID:             itemID,
				Type:               "text",
				Position:           0,
				Version:            1,
				PlaintextLenBucket: 256,
				Envelope:           textEnvRaw,
				Ciphertext:         vault.EncodeBase64URL(textCT),
				CreatedAt:          "2026-10-01T00:05:00Z",
				UpdatedAt:          "2026-10-01T00:05:00Z",
				DeletedAt:          nil,
				DeletedVia:         nil,
				DeleteBatch:        nil,
			},
			{
				ID:                 uuid.MustParse(vec.Inputs.Entries.JSON.EntryID),
				ItemID:             itemID,
				Type:               "json",
				Position:           1,
				Version:            1,
				PlaintextLenBucket: 256,
				Envelope:           jsonEnvRaw,
				Ciphertext:         vault.EncodeBase64URL(jsonCT),
				CreatedAt:          "2026-10-01T00:06:00Z",
				UpdatedAt:          "2026-10-01T00:06:00Z",
				DeletedAt:          &delAt,
				DeletedVia:         &delVia,
				DeleteBatch:        nil,
			},
		},
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(out, '\n')
}

func TestGenSabkFixture(t *testing.T) {
	vec := loadJSVectors(t)
	got := buildSampleSabkFromVectors(t, vec)
	fixPath := filepath.Join("testdata", "sabk_v1_sample.sabk.json")
	if *updateFixtures {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(fixPath)
	if err != nil {
		t.Fatalf("read %s: %v", fixPath, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("sabk_v1_sample.sabk.json drift from js-v1.json")
	}
}

// TestSabkOfflineRestore proves (plan mục 2.1, P06-A2) that using ONLY the
// .sabk.json file + original passphrase (or original RK or PRF output), with no
// server/session/DB access — i.e. even after the live server rotated KEK,
// consumed the RK, revoked the passkey or deleted the account — the VK, private
// key seeds (105 B wrapP) and every entry's plaintext are fully recoverable and
// pass existing vault validators.
func TestSabkOfflineRestore(t *testing.T) {
	vec := loadJSVectors(t)
	raw, err := os.ReadFile(filepath.Join("testdata", "sabk_v1_sample.sabk.json"))
	if err != nil {
		t.Fatalf("read sample fixture: %v", err)
	}

	var parsed struct {
		Format  string      `json:"format"`
		Version int         `json:"version"`
		Vault   SabkVault   `json:"vault"`
		Entries []SabkEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal sabk: %v", err)
	}
	if parsed.Format != SabkFormat || parsed.Version != SabkVersion {
		t.Fatalf("header = %s v%d", parsed.Format, parsed.Version)
	}
	if !vault.ValidateVaultKeyID(parsed.Vault.VaultKeyID) {
		t.Fatalf("ValidateVaultKeyID(%q) = false", parsed.Vault.VaultKeyID)
	}
	privBytes, err := vault.ValidateWrapBase64URL(parsed.Vault.PrivateKeysWrapped, vault.WrapKindPriv)
	if err != nil || len(privBytes) != 105 {
		t.Fatalf("wrapP len=%d err=%v, want 105 B", len(privBytes), err)
	}

	// Path 1: Passphrase -> Argon2id KEK -> unwrap VK.
	var kdf vault.KDFParams
	if err := json.Unmarshal(parsed.Vault.KDF, &kdf); err != nil {
		t.Fatalf("unmarshal kdf: %v", err)
	}
	salt, err := vault.DecodeBase64URLStrict(kdf.Salt, vault.KDFSaltBytes)
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	kek := argon2.IDKey([]byte(vec.Inputs.PassphraseUTF8), salt, uint32(kdf.Ops), uint32(kdf.Mem/1024), uint8(kdf.Parallelism), 32)
	vkFromPass, err := vault.OpenWrapBase64URL(vault.WrapKindKEK, parsed.Vault.VaultKeyWrappedByKEK, kek)
	if err != nil {
		t.Fatalf("unwrap VK with passphrase KEK: %v", err)
	}

	// Path 2: Original Recovery Key -> BLAKE2b wrap key -> unwrap VK.
	rkLookup := blake2b.Sum256(append([]byte(vault.RKLookupDomain), []byte(vec.Inputs.RKNorm)...))
	var rkWrap string
	for _, rk := range parsed.Vault.RecoveryKeys {
		if rk.LookupHash == vault.EncodeBase64URL(rkLookup[:]) {
			rkWrap = rk.Wrap
			break
		}
	}
	if rkWrap == "" {
		t.Fatalf("recovery key slot not found by lookup_hash")
	}
	rkWrapKey := blake2b.Sum256(append([]byte(vault.RKWrapDomain), []byte(vec.Inputs.RKNorm)...))
	vkFromRK, err := vault.OpenWrapBase64URL(vault.WrapKindRK, rkWrap, rkWrapKey[:])
	if err != nil || !bytes.Equal(vkFromRK, vkFromPass) {
		t.Fatalf("unwrap VK with RK mismatch: err=%v", err)
	}

	// Path 3: Passkey PRF output (PWK) -> unwrap VK.
	pwk, err := vault.DecodeBase64URLStrict(vec.Inputs.PWKB64U, 32)
	if err != nil {
		t.Fatal(err)
	}
	vkFromPRF, err := vault.OpenWrapBase64URL(vault.WrapKindPRF, parsed.Vault.Passkeys[0].VKWrap, pwk)
	if err != nil || !bytes.Equal(vkFromPRF, vkFromPass) {
		t.Fatalf("unwrap VK with PRF mismatch: err=%v", err)
	}

	// Unwrap private key seeds (105 B wrapP -> 64 B seeds).
	privSeeds, err := vault.OpenWrapBase64URL(vault.WrapKindPriv, parsed.Vault.PrivateKeysWrapped, vkFromPass)
	if err != nil {
		t.Fatalf("OpenWrap(priv): %v", err)
	}
	if _, _, err := vault.UnpackPrivateKeySeeds(privSeeds); err != nil {
		t.Fatalf("UnpackPrivateKeySeeds: %v", err)
	}

	// Validate and decrypt every entry (active and soft-deleted) using existing vault helpers.
	wantPlain := map[string]string{
		vec.Inputs.Entries.Text.EntryID: vec.Inputs.Entries.Text.PlaintextUTF8,
		vec.Inputs.Entries.JSON.EntryID: vec.Inputs.Entries.JSON.PlaintextUTF8,
	}
	if len(parsed.Entries) != 2 {
		t.Fatalf("entries len = %d, want 2", len(parsed.Entries))
	}
	for _, e := range parsed.Entries {
		env, err := vault.ValidateEntryEnvelope(e.Envelope)
		if err != nil {
			t.Fatalf("ValidateEntryEnvelope(%s): %v", e.ID, err)
		}
		if err := vault.ValidateEnvelopeStruct(env); err != nil {
			t.Fatalf("ValidateEnvelopeStruct(%s): %v", e.ID, err)
		}
		_, pt, err := vault.OpenEntryBase64URL(e.Envelope, e.ID.String(), e.Ciphertext, vkFromPass)
		if err != nil {
			t.Fatalf("OpenEntryBase64URL(%s): %v", e.ID, err)
		}
		if string(pt) != wantPlain[e.ID.String()] {
			t.Fatalf("entry %s plaintext = %q, want %q", e.ID, pt, wantPlain[e.ID.String()])
		}
	}
}
