// Package export implements the P06 encrypted backup (.sabk.json) pipeline:
// job service, River worker export_encrypted, at-rest ENGX1 file format,
// prune/cleanup jobs and decrypted-pages streaming (plan P06 mục 2.1–2.7).
package export

import (
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/google/uuid"
	"golang.org/x/crypto/chacha20poly1305"
)

// ENGX1 layout (plan mục 2.5.3). Header 53 B = magic ‖ version ‖ nonce_prefix
// ‖ job_id ‖ attempt_id; each frame = uint32_be(ct_len) ‖ final_flag ‖ ct.
const (
	AtRestMagic            = "ENGX"
	AtRestVersion     byte = 0x01
	AtRestHeaderLen        = 53
	AtRestNoncePrefix      = 16
	// AtRestFramePlainMax is the plaintext size of every non-final frame and the
	// maximum of the final frame. Non-final frames are always exactly this size,
	// which lets readers seek to a plaintext offset (decrypted pages cursor).
	AtRestFramePlainMax = 65536
	atRestTagLen        = chacha20poly1305.Overhead
	atRestFrameCTMin    = atRestTagLen
	atRestFrameCTMax    = AtRestFramePlainMax + atRestTagLen
	atRestFrameHdrLen   = 5
	atRestFrameMaxLen   = atRestFrameHdrLen + atRestFrameCTMax

	atRestFlagMore  byte = 0x00
	atRestFlagFinal byte = 0x01

	atRestHKDFInfo = "engram/export-at-rest/v1"
)

// ErrAtRestCorrupt is returned for any ENGX1 structural or authentication
// failure (header mismatch, truncation, reorder, append, flag tamper, bounds).
var ErrAtRestCorrupt = errors.New("export: at-rest file corrupt")

// DeriveFileKey returns fileKey = HKDF-SHA256(ikm=secret, salt=job_id‖attempt_id,
// info="engram/export-at-rest/v1") (32 B).
func DeriveFileKey(secret []byte, jobID, attemptID uuid.UUID) ([]byte, error) {
	if len(secret) < 32 {
		return nil, errors.New("export: at-rest secret too short")
	}
	salt := make([]byte, 0, 32)
	salt = append(salt, jobID[:]...)
	salt = append(salt, attemptID[:]...)
	return hkdf.Key(sha256.New, secret, salt, atRestHKDFInfo, chacha20poly1305.KeySize)
}

func buildHeader(prefix []byte, jobID, attemptID uuid.UUID) [AtRestHeaderLen]byte {
	var h [AtRestHeaderLen]byte
	copy(h[0:4], AtRestMagic)
	h[4] = AtRestVersion
	copy(h[5:21], prefix)
	copy(h[21:37], jobID[:])
	copy(h[37:53], attemptID[:])
	return h
}

func frameNonce(prefix []byte, counter uint64) []byte {
	n := make([]byte, chacha20poly1305.NonceSizeX)
	copy(n, prefix)
	binary.BigEndian.PutUint64(n[AtRestNoncePrefix:], counter)
	return n
}

func frameAAD(dst []byte, header *[AtRestHeaderLen]byte, counter uint64, flag byte) []byte {
	dst = append(dst[:0], header[:]...)
	dst = binary.BigEndian.AppendUint64(dst, counter)
	return append(dst, flag)
}

// FrameWriter encrypts a plaintext stream into ENGX1 frames. Close MUST be
// called to emit the final frame; a file without a final frame is rejected.
type FrameWriter struct {
	w       io.Writer
	aead    cipher.AEAD
	header  [AtRestHeaderLen]byte
	prefix  []byte
	counter uint64
	buf     []byte
	out     []byte
	aad     []byte
	written int64
	closed  bool
}

// NewFrameWriter writes the 53 B header with a fresh CSPRNG nonce prefix.
func NewFrameWriter(w io.Writer, secret []byte, jobID, attemptID uuid.UUID) (*FrameWriter, error) {
	prefix := make([]byte, AtRestNoncePrefix)
	if _, err := rand.Read(prefix); err != nil {
		return nil, fmt.Errorf("export: nonce prefix: %w", err)
	}
	return newFrameWriterWithPrefix(w, secret, jobID, attemptID, prefix)
}

func newFrameWriterWithPrefix(w io.Writer, secret []byte, jobID, attemptID uuid.UUID, prefix []byte) (*FrameWriter, error) {
	key, err := DeriveFileKey(secret, jobID, attemptID)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	clear(key)
	if err != nil {
		return nil, err
	}
	fw := &FrameWriter{
		w:      w,
		aead:   aead,
		header: buildHeader(prefix, jobID, attemptID),
		prefix: append([]byte(nil), prefix...),
		buf:    make([]byte, 0, AtRestFramePlainMax),
		out:    make([]byte, 0, atRestFrameMaxLen),
		aad:    make([]byte, 0, AtRestHeaderLen+9),
	}
	n, err := w.Write(fw.header[:])
	fw.written += int64(n)
	if err != nil {
		return nil, err
	}
	return fw, nil
}

// Write buffers plaintext; a full frame is sealed only once more data arrives,
// so the last chunk is always sealed as the final frame by Close.
func (fw *FrameWriter) Write(p []byte) (int, error) {
	if fw.closed {
		return 0, errors.New("export: write after close")
	}
	total := len(p)
	for len(p) > 0 {
		if len(fw.buf) == AtRestFramePlainMax {
			if err := fw.seal(atRestFlagMore); err != nil {
				return total - len(p), err
			}
		}
		n := copy(fw.buf[len(fw.buf):AtRestFramePlainMax], p)
		fw.buf = fw.buf[:len(fw.buf)+n]
		p = p[n:]
	}
	return total, nil
}

// WriteString avoids a []byte conversion copy for callers using io.StringWriter.
func (fw *FrameWriter) WriteString(s string) (int, error) {
	if fw.closed {
		return 0, errors.New("export: write after close")
	}
	total := len(s)
	for len(s) > 0 {
		if len(fw.buf) == AtRestFramePlainMax {
			if err := fw.seal(atRestFlagMore); err != nil {
				return total - len(s), err
			}
		}
		n := copy(fw.buf[len(fw.buf):AtRestFramePlainMax], s)
		fw.buf = fw.buf[:len(fw.buf)+n]
		s = s[n:]
	}
	return total, nil
}

func (fw *FrameWriter) seal(flag byte) error {
	fw.aad = frameAAD(fw.aad, &fw.header, fw.counter, flag)
	fw.out = fw.out[:atRestFrameHdrLen]
	binary.BigEndian.PutUint32(fw.out[0:4], uint32(len(fw.buf)+atRestTagLen))
	fw.out[4] = flag
	fw.out = fw.aead.Seal(fw.out, frameNonce(fw.prefix, fw.counter), fw.buf, fw.aad)
	n, err := fw.w.Write(fw.out)
	fw.written += int64(n)
	if err != nil {
		return err
	}
	fw.counter++
	fw.buf = fw.buf[:0]
	return nil
}

// Close seals the buffered tail as the final frame (0 B for an empty stream).
func (fw *FrameWriter) Close() error {
	if fw.closed {
		return nil
	}
	fw.closed = true
	return fw.seal(atRestFlagFinal)
}

// Written returns the number of ciphertext bytes written so far.
func (fw *FrameWriter) Written() int64 { return fw.written }

// FrameReader authenticates and decrypts an ENGX1 stream. It validates the
// header against the expected (job_id, attempt_id), bounds-checks ct_len before
// reading, enforces counter order via nonce+AAD, rejects empty non-final frames
// and requires EOF exactly after the final frame.
type FrameReader struct {
	r       io.Reader
	aead    cipher.AEAD
	header  [AtRestHeaderLen]byte
	prefix  []byte
	counter uint64
	frame   []byte
	plain   []byte
	pos     int
	aad     []byte
	done    bool
	err     error
}

// NewFrameReader reads and validates the header from r.
func NewFrameReader(r io.Reader, secret []byte, jobID, attemptID uuid.UUID) (*FrameReader, error) {
	var h [AtRestHeaderLen]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, ErrAtRestCorrupt
	}
	return newFrameReaderFromHeader(r, h, secret, jobID, attemptID, 0)
}

func newFrameReaderFromHeader(r io.Reader, h [AtRestHeaderLen]byte, secret []byte, jobID, attemptID uuid.UUID, counter uint64) (*FrameReader, error) {
	if string(h[0:4]) != AtRestMagic || h[4] != AtRestVersion {
		return nil, ErrAtRestCorrupt
	}
	if !uuidEqual(h[21:37], jobID) || !uuidEqual(h[37:53], attemptID) {
		return nil, ErrAtRestCorrupt
	}
	key, err := DeriveFileKey(secret, jobID, attemptID)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	clear(key)
	if err != nil {
		return nil, err
	}
	return &FrameReader{
		r:       r,
		aead:    aead,
		header:  h,
		prefix:  append([]byte(nil), h[5:21]...),
		counter: counter,
		frame:   make([]byte, atRestFrameCTMax),
		aad:     make([]byte, 0, AtRestHeaderLen+9),
	}, nil
}

func uuidEqual(b []byte, id uuid.UUID) bool {
	for i := range id {
		if b[i] != id[i] {
			return false
		}
	}
	return true
}

// Read returns decrypted plaintext; io.EOF only after a valid final frame.
func (fr *FrameReader) Read(p []byte) (int, error) {
	for fr.pos >= len(fr.plain) {
		if fr.err != nil {
			return 0, fr.err
		}
		if fr.done {
			return 0, io.EOF
		}
		if err := fr.next(); err != nil {
			fr.err = err
			return 0, err
		}
	}
	n := copy(p, fr.plain[fr.pos:])
	fr.pos += n
	return n, nil
}

func (fr *FrameReader) next() error {
	var fh [atRestFrameHdrLen]byte
	if _, err := io.ReadFull(fr.r, fh[:]); err != nil {
		return ErrAtRestCorrupt // EOF before a final frame = truncation
	}
	ctLen := binary.BigEndian.Uint32(fh[0:4])
	flag := fh[4]
	if ctLen < atRestFrameCTMin || ctLen > atRestFrameCTMax {
		return ErrAtRestCorrupt
	}
	if flag != atRestFlagMore && flag != atRestFlagFinal {
		return ErrAtRestCorrupt
	}
	if flag == atRestFlagMore && ctLen == atRestFrameCTMin {
		return ErrAtRestCorrupt // empty non-final frame
	}
	ct := fr.frame[:ctLen]
	if _, err := io.ReadFull(fr.r, ct); err != nil {
		return ErrAtRestCorrupt
	}
	fr.aad = frameAAD(fr.aad, &fr.header, fr.counter, flag)
	pt, err := fr.aead.Open(ct[:0], frameNonce(fr.prefix, fr.counter), ct, fr.aad)
	if err != nil {
		return ErrAtRestCorrupt
	}
	fr.counter++
	fr.plain = pt
	fr.pos = 0
	if flag == atRestFlagFinal {
		var one [1]byte
		if n, _ := io.ReadFull(fr.r, one[:]); n != 0 {
			return ErrAtRestCorrupt // bytes appended after the final frame
		}
		fr.done = true
	}
	return nil
}

// NewFrameReaderAt opens an ENGX1 stream positioned at plaintext offset off.
// Every non-final frame holds exactly AtRestFramePlainMax bytes, so frame k
// starts at AtRestHeaderLen + k*atRestFrameMaxLen. The counter of that frame is
// bound into nonce and AAD, so seeking cannot skip authentication.
func NewFrameReaderAt(ra io.ReaderAt, size int64, secret []byte, jobID, attemptID uuid.UUID, off int64) (*FrameReader, error) {
	if off < 0 {
		return nil, ErrAtRestCorrupt
	}
	var h [AtRestHeaderLen]byte
	if _, err := ra.ReadAt(h[:], 0); err != nil {
		return nil, ErrAtRestCorrupt
	}
	k := off / AtRestFramePlainMax
	start := int64(AtRestHeaderLen) + k*int64(atRestFrameMaxLen)
	if start > size {
		return nil, ErrAtRestCorrupt
	}
	fr, err := newFrameReaderFromHeader(io.NewSectionReader(ra, start, size-start), h, secret, jobID, attemptID, uint64(k))
	if err != nil {
		return nil, err
	}
	skip := int(off % AtRestFramePlainMax)
	if skip > 0 {
		if err := fr.next(); err != nil {
			return nil, err
		}
		if skip > len(fr.plain) {
			return nil, ErrAtRestCorrupt
		}
		fr.pos = skip
	}
	return fr, nil
}
