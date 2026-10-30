package vault

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
)

// Hằng số cho kiểm tra KDF Argon2id (ADR 0002 §4, plan mục 2.1).
const (
	kdfAlg         = "argon2id13"
	kdfOpsMin      = 3
	kdfOpsMax      = 10
	kdfMemMin      = 67_108_864  // 64 MiB
	kdfMemMax      = 268_435_456 // 256 MiB
	kdfParallelism = 1
	kdfSaltBytes   = 16
)

var errKDFParamsInvalid = errors.New("vault: invalid kdf params")

// cryptoVectorSuiteV1 khớp chính xác schema trong `packages/crypto-vectors/SCHEMA.md` §3.
type cryptoVectorSuiteV1 struct {
	Schema   string              `json:"schema"`
	Producer string              `json:"producer"`
	Inputs   vectorInputs        `json:"inputs"`
	Derived  vectorDerived       `json:"derived"`
	Negative vectorNegativeCases `json:"negative"`
}

type vectorInputs struct {
	VKHex            string            `json:"vk_hex"`
	VKB64U           string            `json:"vk_b64u"`
	VaultKeyID       string            `json:"vault_key_id"`
	PassphraseUTF8   string            `json:"passphrase_utf8"`
	PassphraseHex    string            `json:"passphrase_hex"`
	KDFSaltHex       string            `json:"kdf_salt_hex"`
	KDFSaltB64U      string            `json:"kdf_salt_b64u"`
	KDF              vectorKDFParams   `json:"kdf"`
	RKSlot           int               `json:"rk_slot"`
	RKEntropyHex     string            `json:"rk_entropy_hex"`
	RKDisplay        string            `json:"rk_display"`
	RKNorm           string            `json:"rk_norm"`
	PWKHex           string            `json:"pwk_hex"`
	PWKB64U          string            `json:"pwk_b64u"`
	X25519SeedHex    string            `json:"x25519_seed_hex"`
	X25519PublicHex  string            `json:"x25519_public_hex"`
	X25519PublicB64U string            `json:"x25519_public_b64u"`
	Ed25519SeedHex   string            `json:"ed25519_seed_hex"`
	Ed25519PubHex    string            `json:"ed25519_public_hex"`
	Ed25519PubB64U   string            `json:"ed25519_public_b64u"`
	Nonces           vectorWrapNonces  `json:"nonces"`
	Entries          vectorEntryInputs `json:"entries"`
}

type vectorKDFParams struct {
	Alg         string `json:"alg"`
	Ops         int    `json:"ops"`
	Mem         int    `json:"mem"`
	Parallelism int    `json:"parallelism"`
	Salt        string `json:"salt"`
}

type vectorWrapNonces struct {
	KEKWrapNonceHex  string `json:"kek_wrap_nonce_hex"`
	RKWrapNonceHex   string `json:"rk_wrap_nonce_hex"`
	PRFWrapNonceHex  string `json:"prf_wrap_nonce_hex"`
	PrivWrapNonceHex string `json:"priv_wrap_nonce_hex"`
}

type vectorEntryInputs struct {
	Text vectorEntryInputItem `json:"text"`
	JSON vectorEntryInputItem `json:"json"`
}

type vectorEntryInputItem struct {
	EntryID                  string          `json:"entry_id"`
	NonceHex                 string          `json:"nonce_hex"`
	NonceB64U                string          `json:"nonce_b64u"`
	PlaintextUTF8            string          `json:"plaintext_utf8"`
	PlaintextHex             string          `json:"plaintext_hex"`
	Envelope                 EntryEnvelopeV1 `json:"envelope"`
	ReorderedEnvelopeRawJSON []string        `json:"reordered_envelope_raw_json"`
}

type vectorDerived struct {
	KEKHex           string               `json:"kek_hex"`
	KEFB64U          string               `json:"kek_b64u"`
	RKLookupHashHex  string               `json:"rk_lookup_hash_hex"`
	RKLookupHashB64U string               `json:"rk_lookup_hash_b64u"`
	RKWrapKeyHex     string               `json:"rk_wrap_key_hex"`
	RKWrapKeyB64U    string               `json:"rk_wrap_key_b64u"`
	PrivPlaintextHex string               `json:"priv_plaintext_hex"`
	Wraps            vectorDerivedWraps   `json:"wraps"`
	Entries          vectorDerivedEntries `json:"entries"`
}

type vectorDerivedWraps struct {
	KEK  wrapVectorEntry `json:"kek"`
	RK   wrapVectorEntry `json:"rk"`
	PRF  wrapVectorEntry `json:"prf"`
	Priv wrapVectorEntry `json:"priv"`
}

type wrapVectorEntry struct {
	Kind        WrapKind  `json:"kind"`
	Label       WrapLabel `json:"label"`
	Version     int       `json:"version"`
	AADHex      string    `json:"aad_hex"`
	NonceHex    string    `json:"nonce_hex"`
	LengthBytes int       `json:"length_bytes"`
	WrapHex     string    `json:"wrap_hex"`
	WrapB64U    string    `json:"wrap_b64u"`
}

type vectorDerivedEntries struct {
	Text derivedEntryVector `json:"text"`
	JSON derivedEntryVector `json:"json"`
}

type derivedEntryVector struct {
	EntryID        string `json:"entry_id"`
	JCSUTF8        string `json:"jcs_utf8"`
	JCSHex         string `json:"jcs_hex"`
	AADHex         string `json:"aad_hex"`
	CiphertextHex  string `json:"ciphertext_hex"`
	CiphertextB64U string `json:"ciphertext_b64u"`
}

type vectorNegativeCases struct {
	Envelope []negativeEnvelopeCase `json:"envelope"`
	Wrap     []negativeWrapCase     `json:"wrap"`
	KDF      []negativeKDFCase      `json:"kdf"`
}

type negativeEnvelopeCase struct {
	ID             string `json:"id"`
	Description    string `json:"description"`
	RawJSON        string `json:"raw_json"`
	EntryID        string `json:"entry_id"`
	CiphertextB64U string `json:"ciphertext_b64u"`
	ExpectedError  string `json:"expected_error"`
}

type negativeWrapCase struct {
	ID             string   `json:"id"`
	Description    string   `json:"description"`
	Kind           WrapKind `json:"kind"`
	WrapB64U       string   `json:"wrap_b64u"`
	KeyHex         string   `json:"key_hex"`
	ValidatorError *string  `json:"validator_error"`
	OpenError      string   `json:"open_error"`
}

type negativeKDFCase struct {
	ID            string `json:"id"`
	Description   string `json:"description"`
	RawJSON       string `json:"raw_json"`
	ExpectedError string `json:"expected_error"`
}

// deriveX25519PublicFromSeed thực hiện đúng thuật toán `crypto_box_seed_keypair` của libsodium
// (ADR 0002 §2, plan Task 6 bullet 6):
//  1. Băm `SHA-512(seed32)` lấy 32 byte đầu làm scalar.
//  2. Clamping Curve25519 (`scalar[0] &= 248`, `scalar[31] &= 127`, `scalar[31] |= 64`).
//  3. Nhân vô hướng `curve25519.X25519(scalar, curve25519.Basepoint)`.
func deriveX25519PublicFromSeed(seed []byte) ([]byte, error) {
	if len(seed) != SeedBytes {
		return nil, fmt.Errorf("%w: x25519 seed must be 32 bytes", ErrKeyPairSeedInvalid)
	}
	digest := sha512.Sum512(seed)
	scalar := make([]byte, 32)
	copy(scalar, digest[:32])
	scalar[0] &= 248
	scalar[31] &= 127
	scalar[31] |= 64
	return curve25519.X25519(scalar, curve25519.Basepoint)
}

// deriveEd25519PublicFromSeed suy public key Ed25519 từ seed 32 byte bằng `ed25519.NewKeyFromSeed`
// (tương đương `crypto_sign_seed_keypair` của libsodium, ADR 0002 §2).
func deriveEd25519PublicFromSeed(seed []byte) ([]byte, error) {
	if len(seed) != SeedBytes {
		return nil, fmt.Errorf("%w: ed25519 seed must be 32 bytes", ErrKeyPairSeedInvalid)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := make([]byte, ed25519.PublicKeySize)
	copy(pub, priv[ed25519.SeedSize:])
	return pub, nil
}

// deriveKEKArgon2id dẫn xuất KEK 32 byte bằng `golang.org/x/crypto/argon2.IDKey`
// (tương đương `crypto_pwhash` ALG_ARGON2ID13 của libsodium; `argon2.IDKey` nhận bộ nhớ tính bằng KiB).
func deriveKEKArgon2id(passphrase, salt []byte, ops, memBytes, parallelism int) []byte {
	memKiB := uint32(memBytes / 1024)
	return argon2.IDKey(passphrase, salt, uint32(ops), memKiB, uint8(parallelism), VKBytes)
}

// validateKDFParamsRawJSON kiểm tra nghiêm ngặt raw JSON của `vault.kdf` (ADR 0002 §4, plan mục 2.1):
//   - Đúng 5 trường bắt buộc (`alg`, `ops`, `mem`, `parallelism`, `salt`), không thiếu/thừa, không trùng khoá.
//   - `alg == "argon2id13"`, `3 <= ops <= 10`, `67108864 <= mem <= 268435456`, `parallelism == 1` (số nguyên JSON).
//   - `salt` là chuỗi base64url không padding giải mã ra đúng 16 byte.
func validateKDFParamsRawJSON(rawJSON []byte) (vectorKDFParams, []byte, error) {
	var zero vectorKDFParams
	if !utf8.Valid(rawJSON) {
		return zero, nil, fmt.Errorf("%w: invalid UTF-8", errKDFParamsInvalid)
	}
	if err := rejectLoneUTF16SurrogateEscapes(rawJSON); err != nil {
		return zero, nil, fmt.Errorf("%w: %v", errKDFParamsInvalid, err)
	}

	dec := json.NewDecoder(bytes.NewReader(rawJSON))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return zero, nil, fmt.Errorf("%w: %v", errKDFParamsInvalid, err)
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return zero, nil, fmt.Errorf("%w: kdf must be a JSON object", errKDFParamsInvalid)
	}

	seen := make(map[string]struct{}, 5)
	var params vectorKDFParams

	for dec.More() {
		kTok, err := dec.Token()
		if err != nil {
			return zero, nil, fmt.Errorf("%w: %v", errKDFParamsInvalid, err)
		}
		key, ok := kTok.(string)
		if !ok {
			return zero, nil, fmt.Errorf("%w: expected string key", errKDFParamsInvalid)
		}
		if _, dup := seen[key]; dup {
			return zero, nil, fmt.Errorf("%w: duplicate key %q", errKDFParamsInvalid, key)
		}
		seen[key] = struct{}{}

		vTok, err := dec.Token()
		if err != nil {
			return zero, nil, fmt.Errorf("%w: %v", errKDFParamsInvalid, err)
		}
		if _, isDelim := vTok.(json.Delim); isDelim {
			return zero, nil, fmt.Errorf("%w: nested container in kdf field %q", errKDFParamsInvalid, key)
		}

		switch key {
		case "alg":
			s, ok := vTok.(string)
			if !ok || s != kdfAlg {
				return zero, nil, fmt.Errorf("%w: invalid alg", errKDFParamsInvalid)
			}
			params.Alg = s
		case "ops":
			n, err := parseStrictJSONInt(vTok)
			if err != nil || n < kdfOpsMin || n > kdfOpsMax {
				return zero, nil, fmt.Errorf("%w: ops out of range", errKDFParamsInvalid)
			}
			params.Ops = n
		case "mem":
			n, err := parseStrictJSONInt(vTok)
			if err != nil || n < kdfMemMin || n > kdfMemMax {
				return zero, nil, fmt.Errorf("%w: mem out of range", errKDFParamsInvalid)
			}
			params.Mem = n
		case "parallelism":
			n, err := parseStrictJSONInt(vTok)
			if err != nil || n != kdfParallelism {
				return zero, nil, fmt.Errorf("%w: invalid parallelism", errKDFParamsInvalid)
			}
			params.Parallelism = n
		case "salt":
			s, ok := vTok.(string)
			if !ok {
				return zero, nil, fmt.Errorf("%w: salt must be string", errKDFParamsInvalid)
			}
			params.Salt = s
		default:
			return zero, nil, fmt.Errorf("%w: unexpected field %q", errKDFParamsInvalid, key)
		}
	}

	endTok, err := dec.Token()
	if err != nil {
		return zero, nil, fmt.Errorf("%w: %v", errKDFParamsInvalid, err)
	}
	if endDelim, ok := endTok.(json.Delim); !ok || endDelim != '}' {
		return zero, nil, fmt.Errorf("%w: expected '}'", errKDFParamsInvalid)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return zero, nil, fmt.Errorf("%w: trailing token", errKDFParamsInvalid)
	}
	if len(seen) != 5 {
		return zero, nil, fmt.Errorf("%w: expected 5 kdf fields, got %d", errKDFParamsInvalid, len(seen))
	}

	saltBytes, err := DecodeBase64URLStrict(params.Salt, kdfSaltBytes)
	if err != nil {
		return zero, nil, fmt.Errorf("%w: invalid salt: %v", errKDFParamsInvalid, err)
	}
	return params, saltBytes, nil
}

func parseStrictJSONInt(tok any) (int, error) {
	num, ok := tok.(json.Number)
	if !ok {
		return 0, errors.New("not a number")
	}
	s := num.String()
	if strings.ContainsAny(s, ".eE") {
		return 0, errors.New("float or exponent not allowed")
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0, err
	}
	return v, nil
}

func mustDecodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("decode hex %q: %v", s, err)
	}
	return b
}

// buildDeterministicGoVectorSuite dựng bộ vector tất định phía Go (`go-v1.json`)
// với các giá trị cố định độc lập với `js-v1.json`.
func buildDeterministicGoVectorSuite(t *testing.T) cryptoVectorSuiteV1 {
	t.Helper()

	vk := seqBytes(VKBytes, 0x21)
	vaultKeyID := "vk:" + EncodeBase64URL(seqBytes(16, 0x51))
	passphrase := "engram-go-vector-passphrase-2026!"
	passphraseBytes := []byte(passphrase)
	kdfSalt := seqBytes(kdfSaltBytes, 0x61)

	rkSlot := 3
	rkEntropy := seqBytes(RKEntropyBytes, 0x71)
	rkGen, err := generateRecoveryKey(rkSlot, rkEntropy)
	if err != nil {
		t.Fatalf("generateRecoveryKey: %v", err)
	}
	rkLookupHash, err := deriveRecoveryLookupHash(rkGen.Display)
	if err != nil {
		t.Fatalf("deriveRecoveryLookupHash: %v", err)
	}
	rkWrapKey, err := deriveRecoveryWrapKey(rkGen.Display)
	if err != nil {
		t.Fatalf("deriveRecoveryWrapKey: %v", err)
	}

	pwk := seqBytes(VKBytes, 0x81)
	xSeed := seqBytes(SeedBytes, 0x91)
	edSeed := seqBytes(SeedBytes, 0xb1)

	xPub, err := deriveX25519PublicFromSeed(xSeed)
	if err != nil {
		t.Fatalf("deriveX25519PublicFromSeed: %v", err)
	}
	edPub, err := deriveEd25519PublicFromSeed(edSeed)
	if err != nil {
		t.Fatalf("deriveEd25519PublicFromSeed: %v", err)
	}

	kekWrapNonce := seqBytes(WrapNonceBytes, 0x11)
	rkWrapNonce := seqBytes(WrapNonceBytes, 0x22)
	prfWrapNonce := seqBytes(WrapNonceBytes, 0x33)
	privWrapNonce := seqBytes(WrapNonceBytes, 0x44)

	kdfParams := vectorKDFParams{
		Alg:         kdfAlg,
		Ops:         kdfOpsMin,
		Mem:         kdfMemMin,
		Parallelism: kdfParallelism,
		Salt:        EncodeBase64URL(kdfSalt),
	}
	kek := deriveKEKArgon2id(passphraseBytes, kdfSalt, kdfParams.Ops, kdfParams.Mem, kdfParams.Parallelism)

	privPlaintext, err := PackPrivateKeySeeds(xSeed, edSeed)
	if err != nil {
		t.Fatalf("PackPrivateKeySeeds: %v", err)
	}

	makeWrapVec := func(kind WrapKind, label WrapLabel, pt, key, nonce []byte, wantLen int) wrapVectorEntry {
		aad := BuildWrapAAD(label, WrapVersion)
		sealed, err := SealWrap(kind, pt, key, nonce)
		if err != nil {
			t.Fatalf("SealWrap(%s): %v", kind, err)
		}
		return wrapVectorEntry{
			Kind:        kind,
			Label:       label,
			Version:     int(WrapVersion),
			AADHex:      hex.EncodeToString(aad),
			NonceHex:    hex.EncodeToString(nonce),
			LengthBytes: wantLen,
			WrapHex:     hex.EncodeToString(sealed),
			WrapB64U:    EncodeBase64URL(sealed),
		}
	}

	kekWrapVec := makeWrapVec(WrapKindKEK, LabelWrapKEK, vk, kek, kekWrapNonce, VKWrapBytes)
	rkWrapVec := makeWrapVec(WrapKindRK, LabelWrapRK, vk, rkWrapKey[:], rkWrapNonce, VKWrapBytes)
	prfWrapVec := makeWrapVec(WrapKindPRF, LabelWrapPRF, vk, pwk, prfWrapNonce, VKWrapBytes)
	privWrapVec := makeWrapVec(WrapKindPriv, LabelWrapPriv, privPlaintext, vk, privWrapNonce, PrivWrapBytes)

	// Text entry
	textEntryID := "b12c4e60-8a9b-4c1d-9e2f-3a4b5c6d7e8f"
	textNonce := seqBytes(WrapNonceBytes, 0x55)
	textPlain := "Ghi chú mật mã tiếng Việt từ Go vector generator — dòng 1\nDòng 2: 100% E2E"
	textEnv, textCT, err := SealEntry(textEntryID, vaultKeyID, []byte(textPlain), vk, textNonce)
	if err != nil {
		t.Fatalf("SealEntry(text): %v", err)
	}
	textJCS, err := CanonicalizeEnvelopeJCS(textEnv)
	if err != nil {
		t.Fatalf("CanonicalizeEnvelopeJCS(text): %v", err)
	}
	textAAD, err := BuildEntryAAD(textEnv, textEntryID)
	if err != nil {
		t.Fatalf("BuildEntryAAD(text): %v", err)
	}

	// JSON entry (body JSON is NOT canonicalized via JCS per SPEC §3.7 / §5.5; whitespace/order preserved)
	jsonEntryID := "c23d5f71-9b0c-4d2e-8f3a-4b5c6d7e8f90"
	jsonNonce := seqBytes(WrapNonceBytes, 0x66)
	jsonPlain := "{\n  \"service\": \"postgres-primary\",\n  \"port\": 5432,\n  \"tags\": [\"db\", \"prod\"]\n}"
	jsonEnv, jsonCT, err := SealEntry(jsonEntryID, vaultKeyID, []byte(jsonPlain), vk, jsonNonce)
	if err != nil {
		t.Fatalf("SealEntry(json): %v", err)
	}
	jsonJCS, err := CanonicalizeEnvelopeJCS(jsonEnv)
	if err != nil {
		t.Fatalf("CanonicalizeEnvelopeJCS(json): %v", err)
	}
	jsonAAD, err := BuildEntryAAD(jsonEnv, jsonEntryID)
	if err != nil {
		t.Fatalf("BuildEntryAAD(json): %v", err)
	}

	textReordered := []string{
		fmt.Sprintf(`{"nonce":%q,"ct_enc":"utf8","key_id":%q,"alg":"xchacha20poly1305-ietf","v":1}`, textEnv.Nonce, textEnv.KeyID),
		fmt.Sprintf("{\n  \"v\": 1,\n  \"key_id\": %q,\n  \"nonce\": %q,\n  \"alg\": \"xchacha20poly1305-ietf\",\n  \"ct_enc\": \"utf8\"\n}", textEnv.KeyID, textEnv.Nonce),
	}
	jsonReordered := []string{
		fmt.Sprintf(`{"ct_enc":"utf8","v":1,"nonce":%q,"alg":"xchacha20poly1305-ietf","key_id":%q}`, jsonEnv.Nonce, jsonEnv.KeyID),
		fmt.Sprintf("{\t\"alg\" : \"xchacha20poly1305-ietf\" , \"ct_enc\" : \"utf8\" , \"key_id\" : %q , \"nonce\" : %q , \"v\" : 1 }", jsonEnv.KeyID, jsonEnv.Nonce),
	}

	textCTB64 := EncodeBase64URL(textCT)

	// Negative envelope cases
	negEnv := []negativeEnvelopeCase{
		{
			ID:             "go-env-missing-ct-enc",
			Description:    "Missing required field ct_enc must be rejected without auto-filling",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-duplicate-key-direct",
			Description:    "Duplicate key ct_enc in raw JSON",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct_enc":"utf8"}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-duplicate-key-unicode-escaped",
			Description:    "Unicode-escaped duplicate key ct\\u005fenc alongside ct_enc",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct\u005fenc":"utf8"}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-duplicate-key-escaped-first-char",
			Description:    "Unicode-escaped duplicate key \\u0063t_enc alongside ct_enc",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","\u0063t_enc":"utf8"}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-extra-field",
			Description:    "Extra field type in envelope object",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","type":"text"}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-float-version",
			Description:    "Floating-point version v=1.0 rejected",
			RawJSON:        fmt.Sprintf(`{"v":1.0,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, vaultKeyID, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "validation",
		},
		{
			ID:             "go-env-tampered-entry-id",
			Description:    "Valid envelope but tampered entry_id causes AEAD authentication failure",
			RawJSON:        string(textJCS),
			EntryID:        "00000000-0000-4000-8000-000000000099",
			CiphertextB64U: textCTB64,
			ExpectedError:  "aead",
		},
		{
			ID:             "go-env-tampered-key-id",
			Description:    "Valid envelope format with different key_id causes AEAD authentication failure",
			RawJSON:        fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:AAAAAAAAAAAAAAAAAAAAAA","nonce":%q,"ct_enc":"utf8"}`, textEnv.Nonce),
			EntryID:        textEntryID,
			CiphertextB64U: textCTB64,
			ExpectedError:  "aead",
		},
	}

	// Negative wrap cases
	kekWrapBytes := mustDecodeHex(t, kekWrapVec.WrapHex)
	mutatedVersionWrap := bytes.Clone(kekWrapBytes)
	mutatedVersionWrap[0] = 0x02

	mutatedTagWrap := bytes.Clone(kekWrapBytes)
	mutatedTagWrap[len(mutatedTagWrap)-1] ^= 0x01

	valErrStr := "validation"
	negWrap := []negativeWrapCase{
		{
			ID:             "go-wrap-version-byte-0x02",
			Description:    "Leading version byte changed from 0x01 to 0x02 fails validator with validation and openWrap with aead",
			Kind:           WrapKindKEK,
			WrapB64U:       EncodeBase64URL(mutatedVersionWrap),
			KeyHex:         hex.EncodeToString(kek),
			ValidatorError: &valErrStr,
			OpenError:      "aead",
		},
		{
			ID:             "go-wrap-tampered-tag",
			Description:    "Valid 73-byte header but flipped last tag bit fails AEAD",
			Kind:           WrapKindKEK,
			WrapB64U:       EncodeBase64URL(mutatedTagWrap),
			KeyHex:         hex.EncodeToString(kek),
			ValidatorError: nil,
			OpenError:      "aead",
		},
		{
			ID:             "go-wrap-wrong-label-rk-as-prf",
			Description:    "Opening an RK wrap under PRF kind/label fails AEAD due to AAD domain separation",
			Kind:           WrapKindPRF,
			WrapB64U:       rkWrapVec.WrapB64U,
			KeyHex:         hex.EncodeToString(rkWrapKey[:]),
			ValidatorError: nil,
			OpenError:      "aead",
		},
		{
			ID:             "go-wrap-wrong-length-72",
			Description:    "72-byte wrap rejected for 73-byte KEK wrap kind",
			Kind:           WrapKindKEK,
			WrapB64U:       EncodeBase64URL(kekWrapBytes[:72]),
			KeyHex:         hex.EncodeToString(kek),
			ValidatorError: &valErrStr,
			OpenError:      "validation",
		},
		{
			ID:             "go-wrap-base64url-padding",
			Description:    "Base64url string with '=' padding rejected",
			Kind:           WrapKindKEK,
			WrapB64U:       kekWrapVec.WrapB64U + "=",
			KeyHex:         hex.EncodeToString(kek),
			ValidatorError: &valErrStr,
			OpenError:      "validation",
		},
	}

	// Negative KDF cases
	negKDF := []negativeKDFCase{
		{
			ID:            "go-kdf-ops-below-min",
			Description:   "ops=2 below minimum 3",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":2,"mem":67108864,"parallelism":1,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
		{
			ID:            "go-kdf-ops-above-max",
			Description:   "ops=11 above maximum 10",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":11,"mem":67108864,"parallelism":1,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
		{
			ID:            "go-kdf-mem-below-64mib",
			Description:   "mem=67108863 below 64 MiB floor",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":3,"mem":67108863,"parallelism":1,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
		{
			ID:            "go-kdf-mem-above-256mib",
			Description:   "mem=268435457 above 256 MiB cap",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":3,"mem":268435457,"parallelism":1,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
		{
			ID:            "go-kdf-parallelism-not-1",
			Description:   "parallelism=2 rejected",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":2,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
		{
			ID:            "go-kdf-duplicate-key-escaped",
			Description:   "Duplicate key ops vs \\u006fps in vault.kdf JSON",
			RawJSON:       fmt.Sprintf(`{"alg":"argon2id13","ops":3,"\u006fps":3,"mem":67108864,"parallelism":1,"salt":%q}`, kdfParams.Salt),
			ExpectedError: "kdf_params",
		},
	}

	return cryptoVectorSuiteV1{
		Schema:   "engram-crypto-vectors-v1",
		Producer: "go",
		Inputs: vectorInputs{
			VKHex:            hex.EncodeToString(vk),
			VKB64U:           EncodeBase64URL(vk),
			VaultKeyID:       vaultKeyID,
			PassphraseUTF8:   passphrase,
			PassphraseHex:    hex.EncodeToString(passphraseBytes),
			KDFSaltHex:       hex.EncodeToString(kdfSalt),
			KDFSaltB64U:      EncodeBase64URL(kdfSalt),
			KDF:              kdfParams,
			RKSlot:           rkSlot,
			RKEntropyHex:     hex.EncodeToString(rkEntropy),
			RKDisplay:        rkGen.Display,
			RKNorm:           rkGen.Normalized,
			PWKHex:           hex.EncodeToString(pwk),
			PWKB64U:          EncodeBase64URL(pwk),
			X25519SeedHex:    hex.EncodeToString(xSeed),
			X25519PublicHex:  hex.EncodeToString(xPub),
			X25519PublicB64U: EncodeBase64URL(xPub),
			Ed25519SeedHex:   hex.EncodeToString(edSeed),
			Ed25519PubHex:    hex.EncodeToString(edPub),
			Ed25519PubB64U:   EncodeBase64URL(edPub),
			Nonces: vectorWrapNonces{
				KEKWrapNonceHex:  hex.EncodeToString(kekWrapNonce),
				RKWrapNonceHex:   hex.EncodeToString(rkWrapNonce),
				PRFWrapNonceHex:  hex.EncodeToString(prfWrapNonce),
				PrivWrapNonceHex: hex.EncodeToString(privWrapNonce),
			},
			Entries: vectorEntryInputs{
				Text: vectorEntryInputItem{
					EntryID:                  textEntryID,
					NonceHex:                 hex.EncodeToString(textNonce),
					NonceB64U:                EncodeBase64URL(textNonce),
					PlaintextUTF8:            textPlain,
					PlaintextHex:             hex.EncodeToString([]byte(textPlain)),
					Envelope:                 textEnv,
					ReorderedEnvelopeRawJSON: textReordered,
				},
				JSON: vectorEntryInputItem{
					EntryID:                  jsonEntryID,
					NonceHex:                 hex.EncodeToString(jsonNonce),
					NonceB64U:                EncodeBase64URL(jsonNonce),
					PlaintextUTF8:            jsonPlain,
					PlaintextHex:             hex.EncodeToString([]byte(jsonPlain)),
					Envelope:                 jsonEnv,
					ReorderedEnvelopeRawJSON: jsonReordered,
				},
			},
		},
		Derived: vectorDerived{
			KEKHex:           hex.EncodeToString(kek),
			KEFB64U:          EncodeBase64URL(kek),
			RKLookupHashHex:  hex.EncodeToString(rkLookupHash[:]),
			RKLookupHashB64U: EncodeBase64URL(rkLookupHash[:]),
			RKWrapKeyHex:     hex.EncodeToString(rkWrapKey[:]),
			RKWrapKeyB64U:    EncodeBase64URL(rkWrapKey[:]),
			PrivPlaintextHex: hex.EncodeToString(privPlaintext),
			Wraps: vectorDerivedWraps{
				KEK:  kekWrapVec,
				RK:   rkWrapVec,
				PRF:  prfWrapVec,
				Priv: privWrapVec,
			},
			Entries: vectorDerivedEntries{
				Text: derivedEntryVector{
					EntryID:        textEntryID,
					JCSUTF8:        string(textJCS),
					JCSHex:         hex.EncodeToString(textJCS),
					AADHex:         hex.EncodeToString(textAAD),
					CiphertextHex:  hex.EncodeToString(textCT),
					CiphertextB64U: EncodeBase64URL(textCT),
				},
				JSON: derivedEntryVector{
					EntryID:        jsonEntryID,
					JCSUTF8:        string(jsonJCS),
					JCSHex:         hex.EncodeToString(jsonJCS),
					AADHex:         hex.EncodeToString(jsonAAD),
					CiphertextHex:  hex.EncodeToString(jsonCT),
					CiphertextB64U: EncodeBase64URL(jsonCT),
				},
			},
		},
		Negative: vectorNegativeCases{
			Envelope: negEnv,
			Wrap:     negWrap,
			KDF:      negKDF,
		},
	}
}

func serializeVectorSuiteJSON(t *testing.T, suite cryptoVectorSuiteV1) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(suite); err != nil {
		t.Fatalf("encode vector suite: %v", err)
	}
	return buf.Bytes()
}

// verifyCryptoVectorSuite kiểm chứng toàn bộ một file vector (`js-v1.json` hoặc `go-v1.json`)
// bằng implementation độc lập dựa trên `golang.org/x/crypto` (`argon2.IDKey`, `chacha20poly1305.NewX`,
// `blake2b.Sum256`, `curve25519.X25519`, `ed25519.NewKeyFromSeed`) và `github.com/gowebpki/jcs` + validators của `internal/vault`.
func verifyCryptoVectorSuite(t *testing.T, suite cryptoVectorSuiteV1) {
	t.Helper()

	if suite.Schema != "engram-crypto-vectors-v1" {
		t.Fatalf("unexpected schema %q", suite.Schema)
	}

	vk := mustDecodeHex(t, suite.Inputs.VKHex)
	if got := EncodeBase64URL(vk); got != suite.Inputs.VKB64U {
		t.Fatalf("vk_b64u = %s, want %s", got, suite.Inputs.VKB64U)
	}

	passphrase := mustDecodeHex(t, suite.Inputs.PassphraseHex)
	if string(passphrase) != suite.Inputs.PassphraseUTF8 {
		t.Fatalf("passphrase_hex does not match passphrase_utf8")
	}

	// 1. Validate KDF params and independently derive KEK via golang.org/x/crypto/argon2.IDKey.
	kdfRaw, err := json.Marshal(suite.Inputs.KDF)
	if err != nil {
		t.Fatalf("marshal kdf: %v", err)
	}
	validKDF, saltBytes, err := validateKDFParamsRawJSON(kdfRaw)
	if err != nil {
		t.Fatalf("validateKDFParamsRawJSON: %v", err)
	}
	if !bytes.Equal(saltBytes, mustDecodeHex(t, suite.Inputs.KDFSaltHex)) {
		t.Fatalf("kdf salt bytes mismatch")
	}
	kek := deriveKEKArgon2id(passphrase, saltBytes, validKDF.Ops, validKDF.Mem, validKDF.Parallelism)
	if gotHex := hex.EncodeToString(kek); gotHex != suite.Derived.KEKHex {
		t.Fatalf("Argon2id KEK mismatch: got %s, want %s", gotHex, suite.Derived.KEKHex)
	}
	if gotB64 := EncodeBase64URL(kek); gotB64 != suite.Derived.KEFB64U {
		t.Fatalf("kek_b64u = %s, want %s", gotB64, suite.Derived.KEFB64U)
	}

	// 2. Independently verify RK generation, normalization, and BLAKE2b-256 lookup_hash & wrap_key.
	rkEntropy := mustDecodeHex(t, suite.Inputs.RKEntropyHex)
	rkGen, err := generateRecoveryKey(suite.Inputs.RKSlot, rkEntropy)
	if err != nil {
		t.Fatalf("generateRecoveryKey: %v", err)
	}
	if rkGen.Display != suite.Inputs.RKDisplay {
		t.Fatalf("rk_display = %q, want %q", rkGen.Display, suite.Inputs.RKDisplay)
	}
	if rkGen.Normalized != suite.Inputs.RKNorm {
		t.Fatalf("rk_norm = %q, want %q", rkGen.Normalized, suite.Inputs.RKNorm)
	}
	rkLookup := blake2b.Sum256(append([]byte(RKLookupDomain), []byte(rkGen.Normalized)...))
	if got := hex.EncodeToString(rkLookup[:]); got != suite.Derived.RKLookupHashHex {
		t.Fatalf("rk_lookup_hash_hex = %s, want %s", got, suite.Derived.RKLookupHashHex)
	}
	rkWrapKey := blake2b.Sum256(append([]byte(RKWrapDomain), []byte(rkGen.Normalized)...))
	if got := hex.EncodeToString(rkWrapKey[:]); got != suite.Derived.RKWrapKeyHex {
		t.Fatalf("rk_wrap_key_hex = %s, want %s", got, suite.Derived.RKWrapKeyHex)
	}

	// 3. Independently derive X25519 and Ed25519 public keys from seeds.
	xSeed := mustDecodeHex(t, suite.Inputs.X25519SeedHex)
	xPub, err := deriveX25519PublicFromSeed(xSeed)
	if err != nil {
		t.Fatalf("deriveX25519PublicFromSeed: %v", err)
	}
	if got := hex.EncodeToString(xPub); got != suite.Inputs.X25519PublicHex {
		t.Fatalf("x25519_public_hex = %s, want %s", got, suite.Inputs.X25519PublicHex)
	}
	if got := EncodeBase64URL(xPub); got != suite.Inputs.X25519PublicB64U {
		t.Fatalf("x25519_public_b64u = %s, want %s", got, suite.Inputs.X25519PublicB64U)
	}

	edSeed := mustDecodeHex(t, suite.Inputs.Ed25519SeedHex)
	edPub, err := deriveEd25519PublicFromSeed(edSeed)
	if err != nil {
		t.Fatalf("deriveEd25519PublicFromSeed: %v", err)
	}
	if got := hex.EncodeToString(edPub); got != suite.Inputs.Ed25519PubHex {
		t.Fatalf("ed25519_public_hex = %s, want %s", got, suite.Inputs.Ed25519PubHex)
	}
	if got := EncodeBase64URL(edPub); got != suite.Inputs.Ed25519PubB64U {
		t.Fatalf("ed25519_public_b64u = %s, want %s", got, suite.Inputs.Ed25519PubB64U)
	}

	privPlain, err := PackPrivateKeySeeds(xSeed, edSeed)
	if err != nil {
		t.Fatalf("PackPrivateKeySeeds: %v", err)
	}
	if got := hex.EncodeToString(privPlain); got != suite.Derived.PrivPlaintextHex {
		t.Fatalf("priv_plaintext_hex = %s, want %s", got, suite.Derived.PrivPlaintextHex)
	}

	// 4. Open and re-seal all 4 wraps using both internal/vault helpers and raw chacha20poly1305.NewX.
	pwk := mustDecodeHex(t, suite.Inputs.PWKHex)
	wrapChecks := []struct {
		vec       wrapVectorEntry
		key       []byte
		wantPlain []byte
		wantLen   int
	}{
		{suite.Derived.Wraps.KEK, kek, vk, VKWrapBytes},
		{suite.Derived.Wraps.RK, rkWrapKey[:], vk, VKWrapBytes},
		{suite.Derived.Wraps.PRF, pwk, vk, VKWrapBytes},
		{suite.Derived.Wraps.Priv, vk, privPlain, PrivWrapBytes},
	}

	for _, wc := range wrapChecks {
		t.Run("wrap_"+string(wc.vec.Kind), func(t *testing.T) {
			if wc.vec.LengthBytes != wc.wantLen {
				t.Fatalf("length_bytes = %d, want %d", wc.vec.LengthBytes, wc.wantLen)
			}
			validated, err := ValidateWrapBase64URL(wc.vec.WrapB64U, wc.vec.Kind)
			if err != nil {
				t.Fatalf("ValidateWrapBase64URL(%s): %v", wc.vec.Kind, err)
			}
			if gotHex := hex.EncodeToString(validated); gotHex != wc.vec.WrapHex {
				t.Fatalf("wrap_hex mismatch: got %s, want %s", gotHex, wc.vec.WrapHex)
			}

			aad := BuildWrapAAD(wc.vec.Label, WrapVersion)
			if gotAAD := hex.EncodeToString(aad); gotAAD != wc.vec.AADHex {
				t.Fatalf("aad_hex = %s, want %s", gotAAD, wc.vec.AADHex)
			}

			// Independent XChaCha20-Poly1305 open
			aead, err := chacha20poly1305.NewX(wc.key)
			if err != nil {
				t.Fatalf("chacha20poly1305.NewX: %v", err)
			}
			rawPt, err := aead.Open(nil, validated[1:1+WrapNonceBytes], validated[1+WrapNonceBytes:], aad)
			if err != nil {
				t.Fatalf("independent aead.Open(%s): %v", wc.vec.Kind, err)
			}
			if !bytes.Equal(rawPt, wc.wantPlain) {
				t.Fatalf("independent decrypted plaintext mismatch for %s", wc.vec.Kind)
			}

			// Vault helper open & deterministic re-seal
			opened, err := OpenWrapBase64URL(wc.vec.Kind, wc.vec.WrapB64U, wc.key)
			if err != nil {
				t.Fatalf("OpenWrapBase64URL(%s): %v", wc.vec.Kind, err)
			}
			if !bytes.Equal(opened, wc.wantPlain) {
				t.Fatalf("OpenWrapBase64URL plaintext mismatch for %s", wc.vec.Kind)
			}
			nonce := mustDecodeHex(t, wc.vec.NonceHex)
			resealed, err := SealWrap(wc.vec.Kind, wc.wantPlain, wc.key, nonce)
			if err != nil {
				t.Fatalf("SealWrap(%s): %v", wc.vec.Kind, err)
			}
			if !bytes.Equal(resealed, validated) {
				t.Fatalf("SealWrap deterministic output mismatch for %s", wc.vec.Kind)
			}
		})
	}

	// 5. Verify both text and json entries (JCS, AAD, ciphertext, reordered raw JSON envelopes).
	entryChecks := []struct {
		name string
		in   vectorEntryInputItem
		der  derivedEntryVector
	}{
		{"entry_text", suite.Inputs.Entries.Text, suite.Derived.Entries.Text},
		{"entry_json", suite.Inputs.Entries.JSON, suite.Derived.Entries.JSON},
	}

	for _, ec := range entryChecks {
		t.Run(ec.name, func(t *testing.T) {
			rawEnv, err := json.Marshal(ec.in.Envelope)
			if err != nil {
				t.Fatalf("marshal envelope: %v", err)
			}
			validatedEnv, jcsBytes, err := CanonicalizeRawEnvelopeJCS(rawEnv)
			if err != nil {
				t.Fatalf("CanonicalizeRawEnvelopeJCS: %v", err)
			}
			if string(jcsBytes) != ec.der.JCSUTF8 {
				t.Fatalf("jcs_utf8 = %s, want %s", jcsBytes, ec.der.JCSUTF8)
			}
			if gotHex := hex.EncodeToString(jcsBytes); gotHex != ec.der.JCSHex {
				t.Fatalf("jcs_hex = %s, want %s", gotHex, ec.der.JCSHex)
			}

			aad, err := BuildEntryAAD(validatedEnv, ec.in.EntryID)
			if err != nil {
				t.Fatalf("BuildEntryAAD: %v", err)
			}
			if gotAAD := hex.EncodeToString(aad); gotAAD != ec.der.AADHex {
				t.Fatalf("aad_hex = %s, want %s", gotAAD, ec.der.AADHex)
			}

			_, openedPt, err := OpenEntryBase64URL(rawEnv, ec.in.EntryID, ec.der.CiphertextB64U, vk)
			if err != nil {
				t.Fatalf("OpenEntryBase64URL: %v", err)
			}
			if string(openedPt) != ec.in.PlaintextUTF8 {
				t.Fatalf("opened plaintext = %q, want %q", openedPt, ec.in.PlaintextUTF8)
			}

			// Every reordered raw JSON representation must canonicalize to the exact same JCS and open cleanly.
			for idx, reordered := range ec.in.ReorderedEnvelopeRawJSON {
				_, reorderedJCS, err := CanonicalizeRawEnvelopeJCS([]byte(reordered))
				if err != nil {
					t.Fatalf("CanonicalizeRawEnvelopeJCS(reordered[%d]): %v", idx, err)
				}
				if !bytes.Equal(reorderedJCS, jcsBytes) {
					t.Fatalf("reordered[%d] JCS = %s, want %s", idx, reorderedJCS, jcsBytes)
				}
				_, pt2, err := OpenEntryBase64URL([]byte(reordered), ec.in.EntryID, ec.der.CiphertextB64U, vk)
				if err != nil {
					t.Fatalf("OpenEntryBase64URL(reordered[%d]): %v", idx, err)
				}
				if string(pt2) != ec.in.PlaintextUTF8 {
					t.Fatalf("reordered[%d] plaintext mismatch", idx)
				}
			}
		})
	}

	// 6. Verify negative cases: Go validator/decryptor verdict must equal expected_error on every case.
	for _, nc := range suite.Negative.Envelope {
		t.Run("neg_envelope_"+nc.ID, func(t *testing.T) {
			_, _, err := OpenEntryBase64URL([]byte(nc.RawJSON), nc.EntryID, nc.CiphertextB64U, vk)
			if err == nil {
				t.Fatalf("expected error %q for %s (%s), got nil", nc.ExpectedError, nc.ID, nc.Description)
			}
			var gotClass string
			switch {
			case errors.Is(err, ErrEnvelopeInvalid):
				gotClass = "validation"
			case errors.Is(err, ErrAEADDecryptFailed):
				gotClass = "aead"
			default:
				t.Fatalf("unexpected error type for %s: %v", nc.ID, err)
			}
			if gotClass != nc.ExpectedError {
				t.Fatalf("case %s: got error class %q (%v), want %q", nc.ID, gotClass, err, nc.ExpectedError)
			}
		})
	}

	for _, nw := range suite.Negative.Wrap {
		t.Run("neg_wrap_"+nw.ID, func(t *testing.T) {
			_, valErr := ValidateWrapBase64URL(nw.WrapB64U, nw.Kind)
			if nw.ValidatorError == nil {
				if valErr != nil {
					t.Fatalf("case %s: expected validator to pass, got %v", nw.ID, valErr)
				}
			} else {
				if !errors.Is(valErr, ErrWrapInvalid) {
					t.Fatalf("case %s: expected validator ErrWrapInvalid, got %v", nw.ID, valErr)
				}
			}

			key := mustDecodeHex(t, nw.KeyHex)
			_, openErr := OpenWrapBase64URL(nw.Kind, nw.WrapB64U, key)
			if openErr == nil {
				t.Fatalf("case %s: expected open error %q, got nil", nw.ID, nw.OpenError)
			}
			var gotOpenClass string
			switch {
			case errors.Is(openErr, ErrWrapInvalid):
				gotOpenClass = "validation"
			case errors.Is(openErr, ErrAEADDecryptFailed):
				gotOpenClass = "aead"
			default:
				t.Fatalf("case %s: unexpected open error %v", nw.ID, openErr)
			}
			if gotOpenClass != nw.OpenError {
				t.Fatalf("case %s: got open_error %q (%v), want %q", nw.ID, gotOpenClass, openErr, nw.OpenError)
			}
		})
	}

	for _, nk := range suite.Negative.KDF {
		t.Run("neg_kdf_"+nk.ID, func(t *testing.T) {
			_, _, err := validateKDFParamsRawJSON([]byte(nk.RawJSON))
			if !errors.Is(err, errKDFParamsInvalid) {
				t.Fatalf("case %s (%s): expected errKDFParamsInvalid, got %v", nk.ID, nk.Description, err)
			}
		})
	}
}

func goVectorsFilePath() string {
	return filepath.Join("..", "..", "..", "..", "packages", "crypto-vectors", "vectors", "go-v1.json")
}

func jsVectorsFilePath() string {
	return filepath.Join("..", "..", "..", "..", "packages", "crypto-vectors", "vectors", "js-v1.json")
}

// TestGenerateAndVerifyGoVectors kiểm tra tính tất định của `go-v1.json` (hoặc ghi ra đĩa khi
// biến môi trường `GEN_CRYPTO_VECTORS=1` được bật, không bao giờ tự ghi trong lúc chạy test thường).
func TestGenerateAndVerifyGoVectors(t *testing.T) {
	suite := buildDeterministicGoVectorSuite(t)
	generatedBytes := serializeVectorSuiteJSON(t, suite)

	path := goVectorsFilePath()
	if os.Getenv("GEN_CRYPTO_VECTORS") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir vectors dir: %v", err)
		}
		if err := os.WriteFile(path, generatedBytes, 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	committedBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read committed %s: %v", path, err)
	}
	if !bytes.Equal(committedBytes, generatedBytes) {
		t.Fatalf("committed go-v1.json is not byte-identical to deterministic generator output")
	}

	var parsed cryptoVectorSuiteV1
	if err := json.Unmarshal(committedBytes, &parsed); err != nil {
		t.Fatalf("unmarshal go-v1.json: %v", err)
	}
	verifyCryptoVectorSuite(t, parsed)
}

// TestCrossCheckJSVectors đọc `packages/crypto-vectors/vectors/js-v1.json` do phía TS sinh ra
// và kiểm chứng toàn bộ các giá trị dẫn xuất, 4 bản wrap, JCS/AAD/entry và mọi ca âm tính.
func TestCrossCheckJSVectors(t *testing.T) {
	path := jsVectorsFilePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var suite cryptoVectorSuiteV1
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatalf("unmarshal js-v1.json: %v", err)
	}
	if suite.Producer != "js" {
		t.Fatalf("expected producer=\"js\", got %q", suite.Producer)
	}
	verifyCryptoVectorSuite(t, suite)
}
