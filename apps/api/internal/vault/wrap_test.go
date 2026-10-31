package vault

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func seqBytes(n int, start byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func TestWrapSealOpenAndValidator(t *testing.T) {
	vk := seqBytes(VKBytes, 0x10)
	kek := seqBytes(VKBytes, 0x30)
	rkWrapKey := seqBytes(VKBytes, 0x50)
	pwk := seqBytes(VKBytes, 0x70)
	nonce := seqBytes(WrapNonceBytes, 0x90)

	xSeed := seqBytes(SeedBytes, 0xa0)
	edSeed := seqBytes(SeedBytes, 0xc0)
	privPlain, err := PackPrivateKeySeeds(xSeed, edSeed)
	if err != nil {
		t.Fatalf("PackPrivateKeySeeds: %v", err)
	}

	cases := []struct {
		name      string
		kind      WrapKind
		label     WrapLabel
		plaintext []byte
		key       []byte
		wantLen   int
	}{
		{
			name:      "KEK wrap (sabk.vk.kek.v1)",
			kind:      WrapKindKEK,
			label:     LabelWrapKEK,
			plaintext: vk,
			key:       kek,
			wantLen:   VKWrapBytes,
		},
		{
			name:      "RK wrap (sabk.vk.rk.v1)",
			kind:      WrapKindRK,
			label:     LabelWrapRK,
			plaintext: vk,
			key:       rkWrapKey,
			wantLen:   VKWrapBytes,
		},
		{
			name:      "PRF wrap (sabk.vk.prf.v1)",
			kind:      WrapKindPRF,
			label:     LabelWrapPRF,
			plaintext: vk,
			key:       pwk,
			wantLen:   VKWrapBytes,
		},
		{
			name:      "Private keys wrap (sabk.priv.v1)",
			kind:      WrapKindPriv,
			label:     LabelWrapPriv,
			plaintext: privPlain,
			key:       vk,
			wantLen:   PrivWrapBytes,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			aad := BuildWrapAAD(tc.label, WrapVersion)
			wantAAD := append(append([]byte(tc.label), 0x00), WrapVersion)
			if !bytes.Equal(aad, wantAAD) {
				t.Fatalf("AAD mismatch: got %x, want %x", aad, wantAAD)
			}

			sealed, err := SealWrap(tc.kind, tc.plaintext, tc.key, nonce)
			if err != nil {
				t.Fatalf("SealWrap: %v", err)
			}
			if len(sealed) != tc.wantLen {
				t.Fatalf("len(sealed) = %d, want %d", len(sealed), tc.wantLen)
			}
			if sealed[0] != WrapVersion {
				t.Fatalf("sealed[0] = 0x%02x, want 0x%02x", sealed[0], WrapVersion)
			}

			if err := ValidateWrapBytes(sealed, tc.kind); err != nil {
				t.Fatalf("ValidateWrapBytes: %v", err)
			}

			b64, err := SealWrapBase64URL(tc.kind, tc.plaintext, tc.key, nonce)
			if err != nil {
				t.Fatalf("SealWrapBase64URL: %v", err)
			}
			validated, err := ValidateWrapBase64URL(b64, tc.kind)
			if err != nil {
				t.Fatalf("ValidateWrapBase64URL: %v", err)
			}
			if !bytes.Equal(validated, sealed) {
				t.Fatalf("validated bytes mismatch")
			}

			opened, err := OpenWrapBase64URL(tc.kind, b64, tc.key)
			if err != nil {
				t.Fatalf("OpenWrapBase64URL: %v", err)
			}
			if !bytes.Equal(opened, tc.plaintext) {
				t.Fatalf("opened plaintext mismatch")
			}

			// Mutating the leading version byte must fail both the format validator and AEAD authentication.
			mutated := bytes.Clone(sealed)
			mutated[0] = 0x02
			if err := ValidateWrapBytes(mutated, tc.kind); !errors.Is(err, ErrWrapInvalid) {
				t.Fatalf("ValidateWrapBytes on version=0x02: got %v, want ErrWrapInvalid", err)
			}
			if _, err := OpenWrap(tc.kind, mutated, tc.key); !errors.Is(err, ErrAEADDecryptFailed) {
				t.Fatalf("OpenWrap on version=0x02: got %v, want ErrAEADDecryptFailed", err)
			}

			// Cross-label domain separation: opening with another kind's AAD must fail AEAD.
			for _, other := range cases {
				if other.kind == tc.kind || other.wantLen != tc.wantLen {
					continue
				}
				if _, err := OpenWrap(other.kind, sealed, tc.key); !errors.Is(err, ErrAEADDecryptFailed) {
					t.Fatalf("OpenWrap with wrong kind %s: got %v, want ErrAEADDecryptFailed", other.kind, err)
				}
			}
		})
	}
}

func TestStrictBase64URLAndWrapValidationRejectsInvalidInputs(t *testing.T) {
	vk := seqBytes(VKBytes, 0x01)
	key := seqBytes(VKBytes, 0x21)
	nonce := seqBytes(WrapNonceBytes, 0x41)

	validVKWrap, err := SealWrap(WrapKindKEK, vk, key, nonce)
	if err != nil {
		t.Fatalf("SealWrap: %v", err)
	}
	validB64 := EncodeBase64URL(validVKWrap)

	t.Run("rejects padding '='", func(t *testing.T) {
		padded := base64.URLEncoding.EncodeToString(validVKWrap)
		if !strings.HasSuffix(padded, "=") {
			padded += "="
		}
		if _, err := ValidateWrapBase64URL(padded, WrapKindKEK); !errors.Is(err, ErrWrapInvalid) || !errors.Is(err, ErrBase64URLInvalid) {
			t.Fatalf("expected ErrWrapInvalid/ErrBase64URLInvalid for padded input, got %v", err)
		}
	})

	t.Run("rejects standard base64 '+' and '/' characters", func(t *testing.T) {
		// Force bytes 0xfb, 0xff so standard base64 emits '+' and '/'.
		raw := bytes.Clone(validVKWrap)
		raw[1] = 0xfb
		raw[2] = 0xff
		raw[3] = 0xfe
		stdB64 := base64.RawStdEncoding.EncodeToString(raw)
		if !strings.ContainsAny(stdB64, "+/") {
			t.Fatalf("expected '+' or '/' in standard base64 string %q", stdB64)
		}
		if _, err := ValidateWrapBase64URL(stdB64, WrapKindKEK); !errors.Is(err, ErrBase64URLInvalid) {
			t.Fatalf("expected ErrBase64URLInvalid for std base64 chars, got %v", err)
		}
	})

	t.Run("rejects whitespace and non-ASCII characters", func(t *testing.T) {
		for _, bad := range []string{
			" " + validB64,
			validB64 + "\n",
			validB64[:10] + "\t" + validB64[11:],
			validB64[:10] + "é" + validB64[11:],
		} {
			if _, err := ValidateWrapBase64URL(bad, WrapKindKEK); !errors.Is(err, ErrBase64URLInvalid) {
				t.Fatalf("expected ErrBase64URLInvalid for %q, got %v", bad, err)
			}
		}
	})

	t.Run("rejects non-zero trailing bits in unpadded base64url", func(t *testing.T) {
		// 73 bytes -> 73 % 3 == 1 -> 98 base64url chars (rem == 2), last char has 4 trailing bits that must be 0.
		lastChar := validB64[len(validB64)-1]
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		idx := strings.IndexByte(alphabet, lastChar)
		if idx < 0 {
			t.Fatalf("lastChar not in alphabet")
		}
		nonCanonical := validB64[:len(validB64)-1] + string(alphabet[idx|1])
		if _, err := ValidateWrapBase64URL(nonCanonical, WrapKindKEK); !errors.Is(err, ErrBase64URLInvalid) {
			t.Fatalf("expected ErrBase64URLInvalid for non-zero trailing bits, got %v", err)
		}
	})

	t.Run("rejects wrong byte lengths (72, 74, 104, 106, cross-kind)", func(t *testing.T) {
		for _, n := range []int{0, 1, 72, 74, 105} {
			b64 := EncodeBase64URL(seqBytes(n, 0x01))
			if _, err := ValidateWrapBase64URL(b64, WrapKindKEK); !errors.Is(err, ErrWrapInvalid) {
				t.Fatalf("expected ErrWrapInvalid for KEK wrap len=%d, got %v", n, err)
			}
		}
		for _, n := range []int{0, 73, 104, 106} {
			b64 := EncodeBase64URL(seqBytes(n, 0x01))
			if _, err := ValidateWrapBase64URL(b64, WrapKindPriv); !errors.Is(err, ErrWrapInvalid) {
				t.Fatalf("expected ErrWrapInvalid for priv wrap len=%d, got %v", n, err)
			}
		}
	})
}
