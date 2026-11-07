package export

import (
	"bytes"
	"encoding/binary"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/crypto/chacha20poly1305"
)

var updateFixtures = flag.Bool("update", false, "regenerate testdata fixtures")

var (
	testAtRestSecret = []byte("0123456789abcdef0123456789abcdef")
	testLayoutJobID  = uuid.MustParse("c9a2e8b4-3f1d-4e7a-9b2c-1d8e5f3a7c9e")
	testLayoutAttID  = uuid.MustParse("7e4b1c9a-8d2f-4a6e-b3c1-9f2e4d8a1b5c")
	testLayoutPrefix = []byte{0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f}
)

func deterministicLayoutPlaintext() []byte {
	// 2 frames: 65536 B (frame 0, flag=0x00) + 128 B (frame 1, flag=0x01).
	pt := make([]byte, AtRestFramePlainMax+128)
	for i := range pt {
		pt[i] = byte((i*31 + 17) & 0xff)
	}
	return pt
}

func encryptBytes(t *testing.T, secret []byte, jobID, attemptID uuid.UUID, pt []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	fw, err := NewFrameWriter(&buf, secret, jobID, attemptID)
	if err != nil {
		t.Fatalf("NewFrameWriter: %v", err)
	}
	if _, err := fw.Write(pt); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := fw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return buf.Bytes()
}

func decryptBytes(secret []byte, jobID, attemptID uuid.UUID, raw []byte) ([]byte, error) {
	fr, err := NewFrameReader(bytes.NewReader(raw), secret, jobID, attemptID)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(fr)
}

func TestAtRestENGX1(t *testing.T) {
	jobID := testLayoutJobID
	attemptID := testLayoutAttID

	t.Run("LayoutFixture2Frames", func(t *testing.T) {
		pt := deterministicLayoutPlaintext()
		var buf bytes.Buffer
		fw, err := newFrameWriterWithPrefix(&buf, testAtRestSecret, jobID, attemptID, testLayoutPrefix)
		if err != nil {
			t.Fatalf("newFrameWriterWithPrefix: %v", err)
		}
		if _, err := fw.Write(pt); err != nil {
			t.Fatalf("Write: %v", err)
		}
		if err := fw.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		got := buf.Bytes()
		if len(got) != AtRestHeaderLen+(5+AtRestFramePlainMax+16)+(5+128+16) {
			t.Fatalf("wire length = %d", len(got))
		}
		fixPath := filepath.Join("testdata", "engx1_layout.bin")
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
			t.Fatalf("engx1_layout.bin drift (%d vs %d B)", len(got), len(want))
		}
		opened, err := decryptBytes(testAtRestSecret, jobID, attemptID, want)
		if err != nil {
			t.Fatalf("decrypt fixture: %v", err)
		}
		if !bytes.Equal(opened, pt) {
			t.Fatalf("decrypted fixture mismatch")
		}
	})

	t.Run("EmptyLogicalFileSingleFinalZeroFrame", func(t *testing.T) {
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, nil)
		// 53 B header + 5 B frame header + 16 B tag = 74 B (1 final frame, 0 B plaintext).
		if len(raw) != AtRestHeaderLen+5+chacha20poly1305.Overhead {
			t.Fatalf("empty file len = %d, want %d", len(raw), AtRestHeaderLen+21)
		}
		if ctLen := binary.BigEndian.Uint32(raw[AtRestHeaderLen : AtRestHeaderLen+4]); ctLen != 16 {
			t.Fatalf("ct_len = %d, want 16", ctLen)
		}
		if raw[AtRestHeaderLen+4] != 0x01 {
			t.Fatalf("final_flag = 0x%02x, want 0x01", raw[AtRestHeaderLen+4])
		}
		pt, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw)
		if err != nil || len(pt) != 0 {
			t.Fatalf("decrypt empty: len=%d err=%v", len(pt), err)
		}
	})

	t.Run("ExactBoundary65536SingleFinalFrame", func(t *testing.T) {
		in := bytes.Repeat([]byte("A"), AtRestFramePlainMax)
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, in)
		if len(raw) != AtRestHeaderLen+5+AtRestFramePlainMax+16 {
			t.Fatalf("65536B wire len = %d", len(raw))
		}
		if raw[AtRestHeaderLen+4] != 0x01 {
			t.Fatalf("expected single final frame")
		}
		out, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw)
		if err != nil || !bytes.Equal(out, in) {
			t.Fatalf("round-trip 65536B failed: %v", err)
		}
	})

	t.Run("Boundary65537SplitsTwoFrames", func(t *testing.T) {
		in := bytes.Repeat([]byte("B"), AtRestFramePlainMax+1)
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, in)
		wantLen := AtRestHeaderLen + (5 + AtRestFramePlainMax + 16) + (5 + 1 + 16)
		if len(raw) != wantLen {
			t.Fatalf("65537B wire len = %d, want %d", len(raw), wantLen)
		}
		if raw[AtRestHeaderLen+4] != 0x00 {
			t.Fatalf("frame 0 flag = 0x%02x, want 0x00", raw[AtRestHeaderLen+4])
		}
		f1 := AtRestHeaderLen + 5 + AtRestFramePlainMax + 16
		if raw[f1+4] != 0x01 {
			t.Fatalf("frame 1 flag = 0x%02x, want 0x01", raw[f1+4])
		}
		out, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw)
		if err != nil || !bytes.Equal(out, in) {
			t.Fatalf("round-trip 65537B failed: %v", err)
		}
	})

	t.Run("RejectCtLen15And65553BeforeAlloc", func(t *testing.T) {
		for _, badLen := range []uint32{15, 65553} {
			raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, []byte("hello"))
			binary.BigEndian.PutUint32(raw[AtRestHeaderLen:AtRestHeaderLen+4], badLen)
			if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw); !errors.Is(err, ErrAtRestCorrupt) {
				t.Fatalf("ct_len=%d: got err=%v, want ErrAtRestCorrupt", badLen, err)
			}
		}
	})

	t.Run("RejectTruncateReorderAppend", func(t *testing.T) {
		in := bytes.Repeat([]byte("C"), AtRestFramePlainMax+500)
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, in)
		f0Start := AtRestHeaderLen
		f0Len := 5 + AtRestFramePlainMax + 16
		f1Start := f0Start + f0Len

		// Truncated after non-final frame 0 (EOF before final frame).
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw[:f1Start]); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("truncate frame 1: got %v", err)
		}
		// Truncated mid-ciphertext.
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, raw[:len(raw)-3]); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("truncate tail: got %v", err)
		}
		// Reordered frames (swap frame 0 and frame 1).
		reordered := append([]byte(nil), raw[:AtRestHeaderLen]...)
		reordered = append(reordered, raw[f1Start:]...)
		reordered = append(reordered, raw[f0Start:f1Start]...)
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, reordered); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("reordered frames: got %v", err)
		}
		// Appended byte after final frame.
		appended := append(append([]byte(nil), raw...), 0x00)
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, appended); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("appended byte: got %v", err)
		}
	})

	t.Run("RejectFlagTamperAndInvalidFlag", func(t *testing.T) {
		in := bytes.Repeat([]byte("D"), AtRestFramePlainMax+10)
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, in)

		// Flip 0 -> 1 on frame 0 (bound in AAD).
		f0Flip := append([]byte(nil), raw...)
		f0Flip[AtRestHeaderLen+4] = 0x01
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, f0Flip); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("flip 0->1: got %v", err)
		}
		// Flip 1 -> 0 on final frame.
		f1Flip := append([]byte(nil), raw...)
		f1Start := AtRestHeaderLen + 5 + AtRestFramePlainMax + 16
		f1Flip[f1Start+4] = 0x00
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, f1Flip); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("flip 1->0: got %v", err)
		}
		// Flag = 2.
		badFlag := append([]byte(nil), raw...)
		badFlag[AtRestHeaderLen+4] = 0x02
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, badFlag); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("flag=2: got %v", err)
		}
	})

	t.Run("RejectEmptyNonFinalFrame", func(t *testing.T) {
		// Craft a validly sealed 0-byte frame with flag=0x00 (more): reader must
		// reject ct_len==16 when flag==0x00 before opening.
		var buf bytes.Buffer
		fw, err := NewFrameWriter(&buf, testAtRestSecret, jobID, attemptID)
		if err != nil {
			t.Fatal(err)
		}
		if err := fw.seal(atRestFlagMore); err != nil {
			t.Fatal(err)
		}
		if err := fw.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, buf.Bytes()); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("empty non-final frame: got %v", err)
		}
	})

	t.Run("RejectWrongHeaderJobOrAttempt", func(t *testing.T) {
		raw := encryptBytes(t, testAtRestSecret, jobID, attemptID, []byte("payload"))

		badMagic := append([]byte(nil), raw...)
		badMagic[0] = 'X'
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, badMagic); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("bad magic: got %v", err)
		}
		badVer := append([]byte(nil), raw...)
		badVer[4] = 0x02
		if _, err := decryptBytes(testAtRestSecret, jobID, attemptID, badVer); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("bad version: got %v", err)
		}
		if _, err := decryptBytes(testAtRestSecret, uuid.New(), attemptID, raw); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("wrong job_id: got %v", err)
		}
		if _, err := decryptBytes(testAtRestSecret, jobID, uuid.New(), raw); !errors.Is(err, ErrAtRestCorrupt) {
			t.Fatalf("wrong attempt_id: got %v", err)
		}
	})

	t.Run("DistinctKeyAndNonceAcrossAttemptsSameJob", func(t *testing.T) {
		att1 := uuid.New()
		att2 := uuid.New()
		r1 := encryptBytes(t, testAtRestSecret, jobID, att1, []byte("same"))
		r2 := encryptBytes(t, testAtRestSecret, jobID, att2, []byte("same"))
		if bytes.Equal(r1[5:21], r2[5:21]) {
			t.Fatalf("nonce_prefix repeated across two attempts")
		}
		k1, _ := DeriveFileKey(testAtRestSecret, jobID, att1)
		k2, _ := DeriveFileKey(testAtRestSecret, jobID, att2)
		if bytes.Equal(k1, k2) {
			t.Fatalf("fileKey repeated across two attempts")
		}
	})
}
