package export

import (
	"bytes"
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

// Decrypted export pagination constants (plan mục 2.5, 2.7.2, 3).
const (
	SectionTags     = "tags"
	SectionItems    = "items"
	SectionItemTags = "item_tags"
	SectionEntries  = "entries"

	DecryptedPageMaxBytes      = 1 << 20 // 1 MiB
	cursorHKDFInfo             = "engram/export-cursor/v1"
	cursorVersion         byte = 1
	cursorMACLen               = 32
	cursorPayloadLen           = 1 + 1 + 8 + 8 + 4 + cursorMACLen
)

// DecryptedPage matches OpenAPI DecryptedExportPage (plan mục 3).
type DecryptedPage struct {
	SourceExportID uuid.UUID         `json:"source_export_id"`
	VaultKeyID     string            `json:"vault_key_id"`
	TotalEntries   int               `json:"total_entries"`
	Section        string            `json:"section"`
	Items          []json.RawMessage `json:"items"`
	NextCursor     *string           `json:"next_cursor"`
}

type pageTagRow struct {
	ID         uuid.UUID `json:"id"`
	Display    string    `json:"display"`
	ItemCount  int32     `json:"item_count"`
	LastUsedAt string    `json:"last_used_at"`
	CreatedAt  string    `json:"created_at"`
}

type pageItemRow struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Hint       *string   `json:"hint"`
	EntryCount int32     `json:"entry_count"`
	Version    int32     `json:"version"`
	LastUsedAt string    `json:"last_used_at"`
	CreatedAt  string    `json:"created_at"`
	UpdatedAt  string    `json:"updated_at"`
}

type pageEntryRow struct {
	ID                 uuid.UUID       `json:"id"`
	ItemID             uuid.UUID       `json:"item_id"`
	Type               string          `json:"type"`
	Position           int32           `json:"position"`
	Version            int32           `json:"version"`
	PlaintextLenBucket int32           `json:"plaintext_len_bucket"`
	CreatedAt          string          `json:"created_at"`
	UpdatedAt          string          `json:"updated_at"`
	Envelope           json.RawMessage `json:"envelope"`
	Ciphertext         string          `json:"ciphertext"`
}

type pageCursor struct {
	section      string
	ordinal      uint64
	offset       int64
	totalEntries int
}

var sectionOrder = [4]string{SectionTags, SectionItems, SectionItemTags, SectionEntries}

func sectionIndex(s string) (byte, bool) {
	for i, name := range sectionOrder {
		if name == s {
			return byte(i), true
		}
	}
	return 0, false
}

func deriveCursorKey(secret []byte) ([]byte, error) {
	if len(secret) < 32 {
		return nil, errors.New("export: cursor secret too short")
	}
	return hkdf.Key(sha256.New, secret, nil, cursorHKDFInfo, 32)
}

func encodeCursor(secret []byte, userID, jobID, attemptID uuid.UUID, c pageCursor) (string, error) {
	secIdx, ok := sectionIndex(c.section)
	if !ok || c.offset < 0 || c.totalEntries < 0 {
		return "", ErrInvalidCursor
	}
	key, err := deriveCursorKey(secret)
	if err != nil {
		return "", err
	}
	defer clear(key)

	var buf [cursorPayloadLen]byte
	buf[0] = cursorVersion
	buf[1] = secIdx
	binary.BigEndian.PutUint64(buf[2:10], c.ordinal)
	binary.BigEndian.PutUint64(buf[10:18], uint64(c.offset))
	binary.BigEndian.PutUint32(buf[18:22], uint32(c.totalEntries))

	mac := computeCursorMAC(key, userID, jobID, attemptID, buf[:22])
	copy(buf[22:], mac[:])
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func decodeCursor(secret []byte, userID, jobID, attemptID uuid.UUID, raw string) (pageCursor, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(b) != cursorPayloadLen || b[0] != cursorVersion || int(b[1]) >= len(sectionOrder) {
		return pageCursor{}, ErrInvalidCursor
	}
	key, err := deriveCursorKey(secret)
	if err != nil {
		return pageCursor{}, err
	}
	defer clear(key)

	want := computeCursorMAC(key, userID, jobID, attemptID, b[:22])
	if !hmac.Equal(b[22:], want[:]) {
		return pageCursor{}, ErrInvalidCursor
	}
	off := int64(binary.BigEndian.Uint64(b[10:18]))
	if off < 0 {
		return pageCursor{}, ErrInvalidCursor
	}
	return pageCursor{
		section:      sectionOrder[b[1]],
		ordinal:      binary.BigEndian.Uint64(b[2:10]),
		offset:       off,
		totalEntries: int(binary.BigEndian.Uint32(b[18:22])),
	}, nil
}

func computeCursorMAC(key []byte, userID, jobID, attemptID uuid.UUID, body []byte) [cursorMACLen]byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(userID[:])
	_, _ = h.Write(jobID[:])
	_, _ = h.Write(attemptID[:])
	_, _ = h.Write(body)
	var out [cursorMACLen]byte
	copy(out[:], h.Sum(nil))
	return out
}

// DecryptedPages streams one ≤ budget page of active records from the ready
// .sabk.enc file of jobID (plan mục 2.7.2, R1-06, R2-02). The database is
// queried ONLY for the export_job row (owner/status/attempt/expiry); all
// content comes from the immutable ENGX1 file.
func (s *Service) DecryptedPages(ctx context.Context, userID, jobID uuid.UUID, cursor string, budget int) (DecryptedPage, error) {
	if budget <= 0 || budget > DecryptedPageMaxBytes {
		budget = DecryptedPageMaxBytes
	}
	row, err := s.q.GetExportJobForOwner(ctx, gen.GetExportJobForOwnerParams{
		ID:     jobID,
		UserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return DecryptedPage{}, ErrNotFound
	}
	if err != nil {
		return DecryptedPage{}, err
	}
	now := s.clk.Now()
	if row.Status == StatusExpired || (row.Status == StatusReady && row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(now)) {
		return DecryptedPage{}, ErrExpired
	}
	if row.Status != StatusReady || row.AttemptID == nil || row.FileName == nil {
		return DecryptedPage{}, ErrNotReady
	}
	attemptID := *row.AttemptID

	sec := s.secretBytes()
	defer clear(sec)

	var cur pageCursor
	hasCursor := cursor != ""
	if hasCursor {
		cur, err = decodeCursor(sec, userID, jobID, attemptID, cursor)
		if err != nil {
			return DecryptedPage{}, ErrInvalidCursor
		}
	}

	path, err := joinSafePath(s.storageDir, *row.FileName)
	if err != nil {
		return DecryptedPage{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return DecryptedPage{}, err
	}
	defer func() { _ = f.Close() }()

	if !hasCursor {
		return s.scanDecryptedPageFromStart(ctx, f, sec, userID, jobID, attemptID, row.SnapshotVaultKeyID, budget)
	}
	if cur.offset > 0 {
		if page, ok, err := s.readDecryptedPageAtOffset(f, sec, userID, jobID, attemptID, row.SnapshotVaultKeyID, cur, budget); err != nil {
			return DecryptedPage{}, err
		} else if ok {
			return page, nil
		}
	}
	return s.scanDecryptedPageByToken(ctx, f, sec, userID, jobID, attemptID, row.SnapshotVaultKeyID, cur, budget)
}

func (s *Service) scanDecryptedPageFromStart(ctx context.Context, f *os.File, sec []byte, userID, jobID, attemptID uuid.UUID, snapKey *string, budget int) (DecryptedPage, error) {
	totalEntries, tagsOff, vaultKeyID, err := inspectSabkForFirstPage(ctx, f, sec, jobID, attemptID)
	if err != nil {
		return DecryptedPage{}, err
	}
	if snapKey != nil && *snapKey != "" {
		vaultKeyID = *snapKey
	}
	cur := pageCursor{
		section:      SectionTags,
		ordinal:      0,
		offset:       tagsOff,
		totalEntries: totalEntries,
	}
	if tagsOff > 0 {
		if page, ok, err := s.readDecryptedPageAtOffset(f, sec, userID, jobID, attemptID, &vaultKeyID, cur, budget); err != nil {
			return DecryptedPage{}, err
		} else if ok {
			return page, nil
		}
	}
	cur.offset = 0
	return s.scanDecryptedPageByToken(ctx, f, sec, userID, jobID, attemptID, &vaultKeyID, cur, budget)
}

// inspectSabkForFirstPage streams the file once through json.Decoder.Token to
// validate the JSON structure, extract vault.vault_key_id, record the plaintext
// byte offset of the `"tags": [` line, and count active entries (deleted_at == nil).
func inspectSabkForFirstPage(ctx context.Context, f *os.File, sec []byte, jobID, attemptID uuid.UUID) (totalEntries int, tagsOff int64, vaultKeyID string, err error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, 0, "", err
	}
	fr, err := NewFrameReader(f, sec, jobID, attemptID)
	if err != nil {
		return 0, 0, "", err
	}
	cr := &countingLineReader{r: fr, wantMarker: []byte("\n\"tags\": [\n")}
	dec := json.NewDecoder(cr)
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return 0, 0, "", ErrAtRestCorrupt
	}
	for dec.More() {
		if err := ctx.Err(); err != nil {
			return 0, 0, "", err
		}
		kTok, err := dec.Token()
		if err != nil {
			return 0, 0, "", ErrAtRestCorrupt
		}
		key, _ := kTok.(string)
		switch key {
		case "vault":
			var v struct {
				VaultKeyID string `json:"vault_key_id"`
			}
			if err := dec.Decode(&v); err != nil {
				return 0, 0, "", ErrAtRestCorrupt
			}
			vaultKeyID = v.VaultKeyID
		case SectionEntries:
			t, err := dec.Token()
			if err != nil || t != json.Delim('[') {
				return 0, 0, "", ErrAtRestCorrupt
			}
			for dec.More() {
				if err := ctx.Err(); err != nil {
					return 0, 0, "", err
				}
				deleted, err := entryIsDeleted(dec)
				if err != nil {
					return 0, 0, "", ErrAtRestCorrupt
				}
				if !deleted {
					totalEntries++
				}
			}
			if _, err := dec.Token(); err != nil {
				return 0, 0, "", ErrAtRestCorrupt
			}
		default:
			if err := skipJSONValue(dec); err != nil {
				return 0, 0, "", ErrAtRestCorrupt
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return 0, 0, "", ErrAtRestCorrupt
	}
	// Drain to EOF so FrameReader verifies the final frame and trailing-byte check.
	if _, err := io.Copy(io.Discard, fr); err != nil {
		return 0, 0, "", err
	}
	return totalEntries, cr.markerAfter, vaultKeyID, nil
}

// entryIsDeleted consumes one entry object and reports whether deleted_at is a
// non-null value, decoding each member value only when it is deleted_at and
// token-skipping everything else so large ciphertexts never materialize
// (review r1 R1-01).
func entryIsDeleted(dec *json.Decoder) (bool, error) {
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return false, errors.New("entry not object")
	}
	deleted := false
	for dec.More() {
		kTok, err := dec.Token()
		if err != nil {
			return false, err
		}
		if k, _ := kTok.(string); k == "deleted_at" {
			var v json.RawMessage
			if err := dec.Decode(&v); err != nil {
				return false, err
			}
			deleted = !bytes.Equal(bytes.TrimSpace(v), []byte("null"))
			continue
		}
		if err := skipJSONValue(dec); err != nil {
			return false, err
		}
	}
	if _, err := dec.Token(); err != nil {
		return false, err
	}
	return deleted, nil
}

type countingLineReader struct {
	r           io.Reader
	total       int64
	tail        []byte
	wantMarker  []byte
	markerAfter int64
}

func (c *countingLineReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		if c.markerAfter == 0 && len(c.wantMarker) > 0 {
			prevLen := len(c.tail)
			c.tail = append(c.tail, p[:n]...)
			if idx := bytes.Index(c.tail, c.wantMarker); idx >= 0 {
				start := (c.total - int64(prevLen)) + int64(idx)
				c.markerAfter = start + int64(len(c.wantMarker))
			}
			if len(c.tail) > len(c.wantMarker) {
				c.tail = append(c.tail[:0], c.tail[len(c.tail)-len(c.wantMarker):]...)
			}
		}
		c.total += int64(n)
	}
	return n, err
}

// readDecryptedPageAtOffset seeks directly to the ENGX1 frame containing
// cur.offset and reads line-delimited elements written by writeSnapshotFile.
func (s *Service) readDecryptedPageAtOffset(f *os.File, sec []byte, userID, jobID, attemptID uuid.UUID, snapKey *string, cur pageCursor, budget int) (DecryptedPage, bool, error) {
	st, err := f.Stat()
	if err != nil {
		return DecryptedPage{}, false, err
	}
	fr, err := NewFrameReaderAt(f, st.Size(), sec, jobID, attemptID, cur.offset)
	if err != nil {
		return DecryptedPage{}, false, err
	}
	lr := newOffsetLineReader(fr, cur.offset)

	secName := cur.section
	ord := cur.ordinal
	outSection := ""
	items := make([]json.RawMessage, 0)
	const overhead = 256
	used := overhead

	for {
		lineStart := lr.offset
		line, err := lr.readLine()
		if errors.Is(err, io.EOF) && len(line) == 0 {
			break
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return DecryptedPage{}, false, err
		}
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("}")) {
			continue
		}
		if nextSec, ok := parseSectionClosingLine(trimmed); ok {
			if nextSec == "" {
				// Closing `]` of entries: end of file.
				secName = SectionEntries
				break
			}
			if len(items) > 0 {
				nextCur, err := encodeCursor(sec, userID, jobID, attemptID, pageCursor{
					section:      nextSec,
					ordinal:      0,
					offset:       lr.offset,
					totalEntries: cur.totalEntries,
				})
				if err != nil {
					return DecryptedPage{}, false, err
				}
				return buildDecryptedPage(jobID, snapKey, cur.totalEntries, outSection, items, &nextCur), true, nil
			}
			secName = nextSec
			ord = 0
			continue
		}
		rawElem := bytes.TrimSuffix(trimmed, []byte(","))
		proj, active, ok := projectSectionRow(secName, rawElem)
		if !ok {
			// File was not written in canonical line-per-element layout; fall back
			// to full token scan from start.
			return DecryptedPage{}, false, nil
		}
		if !active {
			ord++
			continue
		}
		addBytes := len(proj) + 1
		if len(items) > 0 && used+addBytes > budget {
			nextCur, err := encodeCursor(sec, userID, jobID, attemptID, pageCursor{
				section:      secName,
				ordinal:      ord,
				offset:       lineStart,
				totalEntries: cur.totalEntries,
			})
			if err != nil {
				return DecryptedPage{}, false, err
			}
			return buildDecryptedPage(jobID, snapKey, cur.totalEntries, outSection, items, &nextCur), true, nil
		}
		if outSection == "" {
			outSection = secName
		}
		items = append(items, proj)
		used += addBytes
		ord++
	}
	if outSection == "" {
		outSection = secName
	}
	return buildDecryptedPage(jobID, snapKey, cur.totalEntries, outSection, items, nil), true, nil
}

func parseSectionClosingLine(trimmed []byte) (nextSection string, isCloser bool) {
	switch string(trimmed) {
	case `],`, `]`:
		if string(trimmed) == `]` {
			return "", true
		}
		return "", false
	case `],"items": [`:
		return SectionItems, true
	case `],"item_tags": [`:
		return SectionItemTags, true
	case `],"entries": [`:
		return SectionEntries, true
	}
	return "", false
}

type offsetLineReader struct {
	r      io.Reader
	buf    []byte
	pos    int
	offset int64
	eof    bool
}

func newOffsetLineReader(r io.Reader, start int64) *offsetLineReader {
	return &offsetLineReader{r: r, buf: make([]byte, 0, 8192), offset: start}
}

func (l *offsetLineReader) readLine() ([]byte, error) {
	var out []byte
	for {
		if l.pos < len(l.buf) {
			idx := bytes.IndexByte(l.buf[l.pos:], '\n')
			if idx >= 0 {
				end := l.pos + idx + 1
				out = append(out, l.buf[l.pos:end]...)
				l.offset += int64(end - l.pos)
				l.pos = end
				if bytes.Equal(bytes.TrimSpace(out), []byte("],")) && (l.pos < len(l.buf) || !l.eof) {
					// Merge `],\n"items": [\n` split across two lines into one closer token.
					next, err := l.readLine()
					if len(next) > 0 {
						merged := append(bytes.TrimSpace(out), bytes.TrimSpace(next)...)
						return merged, err
					}
				}
				return out, nil
			}
			out = append(out, l.buf[l.pos:]...)
			l.offset += int64(len(l.buf) - l.pos)
			l.pos = len(l.buf)
		}
		if l.eof {
			if len(out) == 0 {
				return nil, io.EOF
			}
			return out, io.EOF
		}
		var tmp [8192]byte
		n, err := l.r.Read(tmp[:])
		if n > 0 {
			l.buf = append(l.buf[:0], tmp[:n]...)
			l.pos = 0
		}
		if errors.Is(err, io.EOF) {
			l.eof = true
		} else if err != nil {
			return nil, err
		}
	}
}

func projectSectionRow(section string, raw []byte) (json.RawMessage, bool, bool) {
	switch section {
	case SectionTags:
		var t SabkTag
		if err := json.Unmarshal(raw, &t); err != nil {
			return nil, false, false
		}
		if t.DeletedAt != nil {
			return nil, false, true
		}
		b, err := json.Marshal(pageTagRow{
			ID:         t.ID,
			Display:    t.Display,
			ItemCount:  t.ItemCount,
			LastUsedAt: t.LastUsedAt,
			CreatedAt:  t.CreatedAt,
		})
		return b, err == nil, err == nil
	case SectionItems:
		var it SabkItem
		if err := json.Unmarshal(raw, &it); err != nil {
			return nil, false, false
		}
		if it.DeletedAt != nil {
			return nil, false, true
		}
		b, err := json.Marshal(pageItemRow{
			ID:         it.ID,
			Name:       it.Name,
			Hint:       it.Hint,
			EntryCount: it.EntryCount,
			Version:    it.Version,
			LastUsedAt: it.LastUsedAt,
			CreatedAt:  it.CreatedAt,
			UpdatedAt:  it.UpdatedAt,
		})
		return b, err == nil, err == nil
	case SectionItemTags:
		var it SabkItemTag
		if err := json.Unmarshal(raw, &it); err != nil {
			return nil, false, false
		}
		b, err := json.Marshal(it)
		return b, err == nil, err == nil
	case SectionEntries:
		var e SabkEntry
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, false, false
		}
		if e.DeletedAt != nil {
			return nil, false, true
		}
		b, err := json.Marshal(pageEntryRow{
			ID:                 e.ID,
			ItemID:             e.ItemID,
			Type:               e.Type,
			Position:           e.Position,
			Version:            e.Version,
			PlaintextLenBucket: e.PlaintextLenBucket,
			CreatedAt:          e.CreatedAt,
			UpdatedAt:          e.UpdatedAt,
			Envelope:           e.Envelope,
			Ciphertext:         e.Ciphertext,
		})
		return b, err == nil, err == nil
	}
	return nil, false, false
}

// scanDecryptedPageByToken is the general json.Decoder.Token fallback when a
// cursor has offset == 0 or the file layout differs from line-per-element.
func (s *Service) scanDecryptedPageByToken(ctx context.Context, f *os.File, sec []byte, userID, jobID, attemptID uuid.UUID, snapKey *string, cur pageCursor, budget int) (DecryptedPage, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return DecryptedPage{}, err
	}
	fr, err := NewFrameReader(f, sec, jobID, attemptID)
	if err != nil {
		return DecryptedPage{}, err
	}
	dec := json.NewDecoder(fr)
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return DecryptedPage{}, ErrAtRestCorrupt
	}
	startIdx, _ := sectionIndex(cur.section)
	vaultKeyID := ""
	if snapKey != nil {
		vaultKeyID = *snapKey
	}
	outSection := ""
	items := make([]json.RawMessage, 0)
	used := 256
	var nextCursor *string

	for dec.More() {
		kTok, err := dec.Token()
		if err != nil {
			return DecryptedPage{}, ErrAtRestCorrupt
		}
		key, _ := kTok.(string)
		if key == "vault" && vaultKeyID == "" {
			var v struct {
				VaultKeyID string `json:"vault_key_id"`
			}
			if err := dec.Decode(&v); err != nil {
				return DecryptedPage{}, ErrAtRestCorrupt
			}
			vaultKeyID = v.VaultKeyID
			continue
		}
		secIdx, isSection := sectionIndex(key)
		if !isSection || secIdx < startIdx || nextCursor != nil {
			if err := skipJSONValue(dec); err != nil {
				return DecryptedPage{}, ErrAtRestCorrupt
			}
			continue
		}
		t, err := dec.Token()
		if err != nil || t != json.Delim('[') {
			return DecryptedPage{}, ErrAtRestCorrupt
		}
		var ord uint64
		for dec.More() {
			if err := ctx.Err(); err != nil {
				return DecryptedPage{}, err
			}
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return DecryptedPage{}, ErrAtRestCorrupt
			}
			if secIdx == startIdx && ord < cur.ordinal {
				ord++
				continue
			}
			if outSection != "" && outSection != key {
				nc, err := encodeCursor(sec, userID, jobID, attemptID, pageCursor{
					section:      key,
					ordinal:      ord,
					offset:       0,
					totalEntries: cur.totalEntries,
				})
				if err != nil {
					return DecryptedPage{}, err
				}
				nextCursor = &nc
				break
			}
			proj, active, ok := projectSectionRow(key, raw)
			if !ok {
				return DecryptedPage{}, ErrAtRestCorrupt
			}
			if !active {
				ord++
				continue
			}
			if len(items) > 0 && used+len(proj)+1 > budget {
				nc, err := encodeCursor(sec, userID, jobID, attemptID, pageCursor{
					section:      key,
					ordinal:      ord,
					offset:       0,
					totalEntries: cur.totalEntries,
				})
				if err != nil {
					return DecryptedPage{}, err
				}
				nextCursor = &nc
				break
			}
			if outSection == "" {
				outSection = key
			}
			items = append(items, proj)
			used += len(proj) + 1
			ord++
		}
		for dec.More() {
			if err := skipJSONValue(dec); err != nil {
				return DecryptedPage{}, ErrAtRestCorrupt
			}
		}
		if _, err := dec.Token(); err != nil {
			return DecryptedPage{}, ErrAtRestCorrupt
		}
	}
	if _, err := io.Copy(io.Discard, fr); err != nil {
		return DecryptedPage{}, err
	}
	if outSection == "" {
		outSection = cur.section
	}
	return buildDecryptedPage(jobID, &vaultKeyID, cur.totalEntries, outSection, items, nextCursor), nil
}

func buildDecryptedPage(jobID uuid.UUID, snapKey *string, totalEntries int, section string, items []json.RawMessage, next *string) DecryptedPage {
	vk := ""
	if snapKey != nil {
		vk = *snapKey
	}
	if items == nil {
		items = []json.RawMessage{}
	}
	return DecryptedPage{
		SourceExportID: jobID,
		VaultKeyID:     vk,
		TotalEntries:   totalEntries,
		Section:        section,
		Items:          items,
		NextCursor:     next,
	}
}

// skipJSONValue consumes exactly one complete JSON value (object, array or
// scalar) using only Decoder.Token(), never materializing it. It bounds
// live memory to the decoder's stack depth rather than the section's size
// (review r1 R1-01).
func skipJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch tok {
	case json.Delim('{'):
		for dec.More() {
			if _, err := dec.Token(); err != nil {
				return err
			}
			if err := skipJSONValue(dec); err != nil {
				return err
			}
		}
	case json.Delim('['):
		for dec.More() {
			if err := skipJSONValue(dec); err != nil {
				return err
			}
		}
	default:
		return nil
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	return nil
}
