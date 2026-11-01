package entry_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func TestExpectedPlaintextLenBucketAndValidatePayload(t *testing.T) {
	id := uuid.NewString()
	vk := bytes.Repeat([]byte{0x42}, vault.VKBytes)
	nonce := bytes.Repeat([]byte{0x11}, vault.WrapNonceBytes)
	keyID := "vk:7f3a1c9e02b4d6f89012ab"

	env, ct1B, err := vault.SealEntry(id, keyID, []byte("a"), vk, nonce)
	if err != nil {
		t.Fatalf("SealEntry: %v", err)
	}
	envRaw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	ct1BB64 := vault.EncodeBase64URL(ct1B)

	// Valid 1 B plaintext -> 17 B ciphertext -> bucket 256.
	vp, code := entry.ValidatePayload(envRaw, ct1BB64, 256)
	if code != "" {
		t.Fatalf("ValidatePayload valid 1B = %q, want empty", code)
	}
	if vp.PlaintextLenBucket != 256 || len(vp.CiphertextBytes) != 17 {
		t.Fatalf("unexpected ValidatedPayload: bucket=%d len=%d", vp.PlaintextLenBucket, len(vp.CiphertextBytes))
	}

	// Bucket boundary checks: 255, 257, 0, 262400 -> entry_invalid.
	for _, badBucket := range []int32{0, 255, 257, 512, 262_400} {
		if _, code := entry.ValidatePayload(envRaw, ct1BB64, badBucket); code != "entry_invalid" {
			t.Fatalf("ValidatePayload(bucket=%d) = %q, want entry_invalid", badBucket, code)
		}
	}

	// Ciphertext 263,169 B -> entry_too_large.
	ctTooLarge := vault.EncodeBase64URL(make([]byte, entry.CiphertextMaxBytes+1))
	if _, code := entry.ValidatePayload(envRaw, ctTooLarge, 262_144); code != "entry_too_large" {
		t.Fatalf("ValidatePayload(ct=263169) = %q, want entry_too_large", code)
	}

	// Ciphertext 16 B (< 17 B) -> entry_invalid.
	ctTooShort := vault.EncodeBase64URL(make([]byte, 16))
	if _, code := entry.ValidatePayload(envRaw, ctTooShort, 256); code != "entry_invalid" {
		t.Fatalf("ValidatePayload(ct=16) = %q, want entry_invalid", code)
	}

	// 262,144 B plaintext -> 262,160 B ciphertext -> bucket 262,144.
	maxPlain := strings.Repeat("x", vault.EntryPlaintextMaxBytes)
	envMax, ctMax, err := vault.SealEntry(id, keyID, []byte(maxPlain), vk, nonce)
	if err != nil {
		t.Fatal(err)
	}
	envMaxRaw, _ := json.Marshal(envMax)
	if _, code := entry.ValidatePayload(envMaxRaw, vault.EncodeBase64URL(ctMax), 262_144); code != "" {
		t.Fatalf("ValidatePayload(262144 B) = %q, want empty", code)
	}
}

func TestListCursorRoundTripAndItemBinding(t *testing.T) {
	itemA := uuid.New()
	itemB := uuid.New()
	entryID := uuid.New()

	c := entry.EncodeListCursor(itemA, 42, entryID)
	pos, gotEntryID, ok := entry.DecodeListCursor(c, itemA)
	if !ok || pos != 42 || gotEntryID != entryID {
		t.Fatalf("DecodeListCursor = (%d, %s, %v), want (42, %s, true)", pos, gotEntryID, ok, entryID)
	}

	if _, _, ok := entry.DecodeListCursor(c, itemB); ok {
		t.Fatal("DecodeListCursor accepted cursor from a different item")
	}
	if _, _, ok := entry.DecodeListCursor("not-valid-base64url===", itemA); ok {
		t.Fatal("DecodeListCursor accepted padded/invalid base64url")
	}
}

func TestValidateReorderIDsAndMatchLiveEntrySet(t *testing.T) {
	id1 := uuid.New()
	id2 := uuid.New()
	id3 := uuid.New()

	// Empty slice -> valid (permitted when item has 0 live entries).
	parsedEmpty, code := entry.ValidateReorderIDs([]string{})
	if code != "" || len(parsedEmpty) != 0 {
		t.Fatalf("ValidateReorderIDs([]) = (%v, %q), want empty and \"\"", parsedEmpty, code)
	}
	if !entry.MatchLiveEntrySet(parsedEmpty, nil) {
		t.Fatal("MatchLiveEntrySet([], []) = false, want true")
	}
	if entry.MatchLiveEntrySet(parsedEmpty, []uuid.UUID{id1}) {
		t.Fatal("MatchLiveEntrySet([], [id1]) = true, want false")
	}

	// Valid permutation of 3 IDs.
	parsed, code := entry.ValidateReorderIDs([]string{id3.String(), id1.String(), id2.String()})
	if code != "" || len(parsed) != 3 {
		t.Fatalf("ValidateReorderIDs valid = (%v, %q), want 3 IDs and \"\"", parsed, code)
	}
	if !entry.MatchLiveEntrySet(parsed, []uuid.UUID{id1, id2, id3}) {
		t.Fatal("MatchLiveEntrySet valid permutation = false, want true")
	}

	// Missing, extra, or different ID -> MatchLiveEntrySet false.
	if entry.MatchLiveEntrySet(parsed[:2], []uuid.UUID{id1, id2, id3}) {
		t.Fatal("MatchLiveEntrySet missing ID = true, want false")
	}
	if entry.MatchLiveEntrySet(parsed, []uuid.UUID{id1, id2}) {
		t.Fatal("MatchLiveEntrySet extra ID = true, want false")
	}
	if entry.MatchLiveEntrySet([]uuid.UUID{id1, id2, uuid.New()}, []uuid.UUID{id1, id2, id3}) {
		t.Fatal("MatchLiveEntrySet wrong ID = true, want false")
	}

	// Duplicate ID -> 400 invalid_request.
	if _, code := entry.ValidateReorderIDs([]string{id1.String(), id1.String()}); code != "invalid_request" {
		t.Fatalf("ValidateReorderIDs duplicate = %q, want invalid_request", code)
	}

	// Non-lowercase or malformed UUID -> 400 invalid_request.
	if _, code := entry.ValidateReorderIDs([]string{strings.ToUpper(id1.String())}); code != "invalid_request" {
		t.Fatalf("ValidateReorderIDs uppercase UUID = %q, want invalid_request", code)
	}
	if _, code := entry.ValidateReorderIDs([]string{"not-a-uuid"}); code != "invalid_request" {
		t.Fatalf("ValidateReorderIDs malformed UUID = %q, want invalid_request", code)
	}

	// > 200 distinct IDs -> 409 reorder_mismatch.
	over200 := make([]string, 201)
	for i := range over200 {
		over200[i] = uuid.NewString()
	}
	if _, code := entry.ValidateReorderIDs(over200); code != "reorder_mismatch" {
		t.Fatalf("ValidateReorderIDs(201 IDs) = %q, want reorder_mismatch", code)
	}
}

func TestIsAllowedImportSource(t *testing.T) {
	if !entry.IsAllowedImportSource(entry.ImportSourcePaste) {
		t.Fatal("IsAllowedImportSource(paste) = false, want true")
	}
	if !entry.IsAllowedImportSource(entry.ImportSourceFile) {
		t.Fatal("IsAllowedImportSource(file) = false, want true")
	}
	for _, bad := range []string{"", "url", "clipboard", "PASTE", "FILE", "file.json"} {
		if entry.IsAllowedImportSource(bad) {
			t.Fatalf("IsAllowedImportSource(%q) = true, want false", bad)
		}
	}
}

func TestChangesCursorRoundTripAndBinding(t *testing.T) {
	userA := uuid.New()
	userB := uuid.New()
	entryID := uuid.New()
	since := time.Date(2026, 11, 1, 10, 0, 0, 123456000, time.UTC)
	watermark := time.Date(2026, 11, 1, 10, 5, 0, 789000000, time.UTC)
	curUpdated := time.Date(2026, 11, 1, 10, 2, 0, 456000000, time.UTC)

	cur := entry.EncodeChangesCursor(userA, since, watermark, curUpdated, entryID)
	decoded, ok := entry.DecodeChangesCursor(cur, userA, since)
	if !ok {
		t.Fatal("DecodeChangesCursor valid = false, want true")
	}
	if !decoded.Watermark.Equal(watermark) || !decoded.CursorUpdatedAt.Equal(curUpdated) || decoded.CursorID != entryID {
		t.Fatalf("DecodeChangesCursor = %+v, want wm=%v updated=%v id=%s", decoded, watermark, curUpdated, entryID)
	}

	// Same instant represented in a non-UTC zone should still match since.Equal.
	sincePlus7 := since.In(time.FixedZone("UTC+7", 7*3600))
	if _, ok := entry.DecodeChangesCursor(cur, userA, sincePlus7); !ok {
		t.Fatal("DecodeChangesCursor rejected equivalent instant in different timezone")
	}

	// Foreign user -> false.
	if _, ok := entry.DecodeChangesCursor(cur, userB, since); ok {
		t.Fatal("DecodeChangesCursor accepted foreign user cursor")
	}

	// Mismatched since -> false.
	if _, ok := entry.DecodeChangesCursor(cur, userA, since.Add(time.Nanosecond)); ok {
		t.Fatal("DecodeChangesCursor accepted mismatched since")
	}

	// Malformed or padded base64url -> false.
	for _, bad := range []string{"", "not-base64url===", "e30="} {
		if _, ok := entry.DecodeChangesCursor(bad, userA, since); ok {
			t.Fatalf("DecodeChangesCursor accepted invalid cursor %q", bad)
		}
	}
}
