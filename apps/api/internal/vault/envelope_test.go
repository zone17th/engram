package vault

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
)

const (
	testKeyID   = "vk:7f3a9b2c4d5e6f7a8b9c0d"
	testEntryID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
)

func testNonceB64() string {
	return EncodeBase64URL(bytes.Repeat([]byte{0x42}, WrapNonceBytes))
}

func TestEnvelopeValidatorAndDuplicateKeys(t *testing.T) {
	nonceB64 := testNonceB64()
	validRaw := fmt.Sprintf(
		`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
		testKeyID, nonceB64,
	)

	env, err := ValidateEntryEnvelopeString(validRaw)
	if err != nil {
		t.Fatalf("ValidateEntryEnvelopeString(valid): %v", err)
	}
	if env.V != 1 || env.Alg != EnvelopeAlg || env.KeyID != testKeyID || env.Nonce != nonceB64 || env.CtEnc != EnvelopeCtEnc {
		t.Fatalf("unexpected parsed envelope: %+v", env)
	}

	t.Run("missing ct_enc rejected and never auto-repaired", func(t *testing.T) {
		missingCtEnc := fmt.Sprintf(
			`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q}`,
			testKeyID, nonceB64,
		)
		if _, err := ValidateEntryEnvelopeString(missingCtEnc); !errors.Is(err, ErrEnvelopeInvalid) {
			t.Fatalf("expected ErrEnvelopeInvalid for missing ct_enc, got %v", err)
		}
	})

	t.Run("duplicate keys rejected including unicode-escaped duplicate keys", func(t *testing.T) {
		dupCases := []struct {
			name string
			raw  string
		}{
			{
				name: "direct duplicate ct_enc",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "escaped underscore ct\\u005fenc",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct\u005fenc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "escaped leading char \\u0063t_enc",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","\u0063t_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "escaped duplicate v vs \\u0076",
				raw: fmt.Sprintf(
					`{"v":1,"\u0076":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "escaped duplicate key_id",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"key\u005fid":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, testKeyID, nonceB64,
				),
			},
		}

		for _, tc := range dupCases {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := ValidateEntryEnvelopeString(tc.raw); !errors.Is(err, ErrEnvelopeInvalid) {
					t.Fatalf("expected ErrEnvelopeInvalid for %s, got %v", tc.name, err)
				}
			})
		}
	})

	t.Run("rejects extra fields, wrong types, float v, bad alg/key_id/nonce/ct_enc, and lone surrogates", func(t *testing.T) {
		badCases := []struct {
			name string
			raw  string
		}{
			{
				name: "extra field type",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","type":"text"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "float v 1.0",
				raw: fmt.Sprintf(
					`{"v":1.0,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "exponent v 1e0",
				raw: fmt.Sprintf(
					`{"v":1e0,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "v=2",
				raw: fmt.Sprintf(
					`{"v":2,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "string v",
				raw: fmt.Sprintf(
					`{"v":"1","alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "wrong alg",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"aes-256-gcm","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "wrong key_id prefix",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"pk:7f3a9b2c4d5e6f7a8b9c0d","nonce":%q,"ct_enc":"utf8"}`,
					nonceB64,
				),
			},
			{
				name: "short nonce 23 bytes",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, EncodeBase64URL(make([]byte, 23)),
				),
			},
			{
				name: "padded nonce",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
					testKeyID, nonceB64[:len(nonceB64)-1]+"=",
				),
			},
			{
				name: "wrong ct_enc",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"gzip"}`,
					testKeyID, nonceB64,
				),
			},
			{
				name: "lone high surrogate in string",
				raw: fmt.Sprintf(
					`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:\ud800a9b2c4d5e6f7a8b9c0d","nonce":%q,"ct_enc":"utf8"}`,
					nonceB64,
				),
			},
			{
				name: "trailing token after object",
				raw:  validRaw + " {}",
			},
		}

		for _, tc := range badCases {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := ValidateEntryEnvelopeString(tc.raw); !errors.Is(err, ErrEnvelopeInvalid) {
					t.Fatalf("expected ErrEnvelopeInvalid for %s, got %v", tc.name, err)
				}
			})
		}
	})
}

func TestEnvelopeFieldReorderAndTamperDetection(t *testing.T) {
	vk := seqBytes(VKBytes, 0x33)
	nonce := seqBytes(WrapNonceBytes, 0x55)
	plaintext := []byte(`{"wifi":"Abc123","nested":[{"port":8080,"big":9007199254740993}]}`)

	env, ct, err := SealEntry(testEntryID, testKeyID, plaintext, vk, nonce)
	if err != nil {
		t.Fatalf("SealEntry: %v", err)
	}

	// Reorder keys and add irregular whitespace: JCS must produce the exact same AAD and open cleanly.
	reorderedRaw := fmt.Sprintf(`{
		"nonce" : %q,
		"v" : 1,
		"ct_enc" : "utf8",
		"key_id" : %q,
		"alg" : "xchacha20poly1305-ietf"
	}`, env.Nonce, env.KeyID)

	openedEnv, openedPt, err := OpenEntry([]byte(reorderedRaw), testEntryID, ct, vk)
	if err != nil {
		t.Fatalf("OpenEntry(reordered): %v", err)
	}
	if openedEnv != env {
		t.Fatalf("openedEnv = %+v, want %+v", openedEnv, env)
	}
	if !bytes.Equal(openedPt, plaintext) {
		t.Fatalf("openedPt = %s, want %s", openedPt, plaintext)
	}

	// Changing entry_id (valid UUID, different value) must fail AEAD.
	otherEntryID := "00000000-0000-4000-8000-000000000001"
	if _, _, err := OpenEntry([]byte(reorderedRaw), otherEntryID, ct, vk); !errors.Is(err, ErrAEADDecryptFailed) {
		t.Fatalf("expected ErrAEADDecryptFailed on changed entry_id, got %v", err)
	}

	// Uppercase entry_id must fail validation.
	if _, _, err := OpenEntry([]byte(reorderedRaw), strings.ToUpper(testEntryID), ct, vk); !errors.Is(err, ErrEnvelopeInvalid) {
		t.Fatalf("expected ErrEnvelopeInvalid on uppercase entry_id, got %v", err)
	}

	// Changing key_id (valid format, different value) must fail AEAD because JCS(envelope) is in AAD.
	changedKeyIDRaw := fmt.Sprintf(
		`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:0000000000000000000000","nonce":%q,"ct_enc":"utf8"}`,
		env.Nonce,
	)
	if _, _, err := OpenEntry([]byte(changedKeyIDRaw), testEntryID, ct, vk); !errors.Is(err, ErrAEADDecryptFailed) {
		t.Fatalf("expected ErrAEADDecryptFailed on changed key_id, got %v", err)
	}

	// Changing nonce to another valid 24-byte nonce must fail AEAD.
	otherNonceB64 := EncodeBase64URL(seqBytes(WrapNonceBytes, 0x99))
	changedNonceRaw := fmt.Sprintf(
		`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
		env.KeyID, otherNonceB64,
	)
	if _, _, err := OpenEntry([]byte(changedNonceRaw), testEntryID, ct, vk); !errors.Is(err, ErrAEADDecryptFailed) {
		t.Fatalf("expected ErrAEADDecryptFailed on changed nonce, got %v", err)
	}
}

func TestEnvelopePostgresJSONBRoundTrip(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	conn := dbtest.Connect(t, dsn)
	ctx := context.Background()

	if _, err := conn.Exec(ctx, `
		CREATE TEMP TABLE test_entry_jsonb (
			id uuid PRIMARY KEY,
			envelope jsonb NOT NULL,
			ciphertext bytea NOT NULL
		)
	`); err != nil {
		t.Fatalf("create temp table: %v", err)
	}

	vk := seqBytes(VKBytes, 0x22)
	nonce := seqBytes(WrapNonceBytes, 0x77)
	plaintext := []byte("Nội dung bí mật qua Postgres jsonb round-trip (SPEC §5.5)")

	env, ct, err := SealEntry(testEntryID, testKeyID, plaintext, vk, nonce)
	if err != nil {
		t.Fatalf("SealEntry: %v", err)
	}

	// Insert envelope with non-canonical key order and whitespace into Postgres jsonb column.
	inputJSON := fmt.Sprintf(`{
		"ct_enc": %q,
		"nonce":  %q,
		"v":      %d,
		"key_id": %q,
		"alg":    %q
	}`, env.CtEnc, env.Nonce, env.V, env.KeyID, env.Alg)

	if _, err := conn.Exec(ctx,
		`INSERT INTO test_entry_jsonb (id, envelope, ciphertext) VALUES ($1, $2::jsonb, $3)`,
		testEntryID, inputJSON, ct,
	); err != nil {
		t.Fatalf("insert jsonb row: %v", err)
	}

	// Read back the raw text representation produced by Postgres jsonb (which reorders keys by length/name and adds spaces).
	var (
		storedID       string
		storedEnvelope []byte
		storedCT       []byte
	)
	if err := conn.QueryRow(ctx,
		`SELECT id::text, envelope::text, ciphertext FROM test_entry_jsonb WHERE id = $1`,
		testEntryID,
	).Scan(&storedID, &storedEnvelope, &storedCT); err != nil {
		t.Fatalf("select jsonb row: %v", err)
	}

	// Verify Postgres jsonb actually normalized/reformatted the raw JSON string.
	if string(storedEnvelope) == inputJSON {
		t.Fatalf("expected Postgres jsonb to reformat input JSON")
	}

	openedEnv, openedPt, err := OpenEntry(storedEnvelope, storedID, storedCT, vk)
	if err != nil {
		t.Fatalf("OpenEntry after Postgres jsonb round-trip failed: %v (raw jsonb=%s)", err, storedEnvelope)
	}
	if openedEnv != env {
		t.Fatalf("openedEnv = %+v, want %+v", openedEnv, env)
	}
	if !bytes.Equal(openedPt, plaintext) {
		t.Fatalf("openedPt = %q, want %q", openedPt, plaintext)
	}
}
