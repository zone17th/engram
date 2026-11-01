// Package entry cung cấp domain types và các hàm kiểm tra hợp lệ cho entry P04
// (SPEC §5.5, §8, §9.1–§9.3; plan mục 2.3, 2.5, 2.6, 3, Task 6a).
//
// Ràng buộc bảo mật (user-dec-016):
//   - Server chỉ nhận, kiểm tra và lưu envelope + ciphertext + metadata kích thước làm tròn.
//   - Không bao giờ nhận, parse, giải mã hay log nội dung plaintext body.
//   - Không bao giờ log hay đưa vào thông báo lỗi / metric / audit: ciphertext, các trường
//     envelope (nonce, ct_enc, key_id), raw request body, hoặc tên mục (item.name).
package entry

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// Các hằng giới hạn của entry P04 (SPEC §5.5, §8, §9.1; plan mục 2.3, 2.6, 3).
const (
	TypeText = "text"
	TypeJSON = "json"

	CiphertextMinBytes = 1 + vault.WrapTagBytes   // 17 B (>= 1 byte plaintext + 16 B tag)
	CiphertextMaxBytes = vault.EntryCiphertextMax // 263_168 B (256 KiB + AEAD slack)

	PlaintextBucketStep int32 = 256
	PlaintextBucketMin  int32 = 256
	PlaintextBucketMax  int32 = vault.EntryPlaintextMaxBytes // 262_144

	MaxLiveEntriesPerItem int32 = 200

	DefaultListLimit = 200
	MinListLimit     = 1
	MaxListLimit     = 200
)

// Meta là DTO `EntryMeta` theo OpenAPI (chỉ metadata, không có envelope hay ciphertext).
type Meta struct {
	ID                 string `json:"id"`
	ItemID             string `json:"item_id"`
	Type               string `json:"type"`
	Position           int32  `json:"position"`
	Version            int32  `json:"version"`
	PlaintextLenBucket int32  `json:"plaintext_len_bucket"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

// Entry là DTO `Entry` theo OpenAPI (`EntryMeta` kèm `envelope` và `ciphertext` base64url).
type Entry struct {
	ID                 string                `json:"id"`
	ItemID             string                `json:"item_id"`
	Type               string                `json:"type"`
	Position           int32                 `json:"position"`
	Version            int32                 `json:"version"`
	PlaintextLenBucket int32                 `json:"plaintext_len_bucket"`
	CreatedAt          string                `json:"created_at"`
	UpdatedAt          string                `json:"updated_at"`
	Envelope           vault.EntryEnvelopeV1 `json:"envelope"`
	Ciphertext         string                `json:"ciphertext"`
}

// MetaList là DTO `EntryMetaList` theo OpenAPI (`{items, next_cursor}`).
type MetaList struct {
	Items      []Meta  `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// ValidatedPayload giữ dữ liệu envelope + ciphertext + bucket đã qua kiểm tra hợp lệ trước khi mở transaction.
type ValidatedPayload struct {
	Envelope           vault.EntryEnvelopeV1
	EnvelopeBytes      []byte
	CiphertextBytes    []byte
	PlaintextLenBucket int32
}

// IsAllowedCreateType kiểm tra `type` gửi qua API tạo entry chỉ nhận `text` hoặc `json` (plan mục 2.1, 2.6).
func IsAllowedCreateType(t string) bool {
	return t == TypeText || t == TypeJSON
}

// ExpectedPlaintextLenBucket tính `ceil((ciphertextLen - 16) / 256) * 256` (SPEC §5.5, plan mục 2.3, 2.6).
// Yêu cầu `ciphertextLen >= CiphertextMinBytes` (17).
func ExpectedPlaintextLenBucket(ciphertextLen int) (int32, bool) {
	ptLen := ciphertextLen - vault.WrapTagBytes
	if ptLen < 1 || ptLen > int(PlaintextBucketMax) {
		return 0, false
	}
	bucket := ((ptLen + int(PlaintextBucketStep) - 1) / int(PlaintextBucketStep)) * int(PlaintextBucketStep)
	if bucket < int(PlaintextBucketMin) || bucket > int(PlaintextBucketMax) {
		return 0, false
	}
	return int32(bucket), true
}

// ValidatePayload kiểm tra nghiêm ngặt `envelope` (raw JSON), `ciphertext` (strict base64url không padding,
// 17..263168 B) và `plaintext_len_bucket` (bội số 256, 256..262144, khớp đúng độ dài ciphertext)
// trước khi mở transaction ghi DB (plan mục 2.3, 2.6).
//
// Khi không hợp lệ, trả mã lỗi problem (`entry_invalid` hoặc `entry_too_large`) cùng thông báo tĩnh
// không chứa dữ liệu nhạy cảm.
func ValidatePayload(rawEnvelope json.RawMessage, ciphertextB64 string, bucket int32) (ValidatedPayload, string) {
	var zero ValidatedPayload
	if len(rawEnvelope) == 0 {
		return zero, "entry_invalid"
	}
	env, envJCS, err := vault.CanonicalizeRawEnvelopeJCS(rawEnvelope)
	if err != nil {
		return zero, "entry_invalid"
	}

	if ciphertextB64 == "" {
		return zero, "entry_invalid"
	}
	ctBytes, err := vault.DecodeBase64URLStrict(ciphertextB64, 0)
	if err != nil {
		return zero, "entry_invalid"
	}
	if len(ctBytes) > CiphertextMaxBytes {
		return zero, "entry_too_large"
	}
	if len(ctBytes) < CiphertextMinBytes {
		return zero, "entry_invalid"
	}

	if bucket < PlaintextBucketMin || bucket > PlaintextBucketMax || bucket%PlaintextBucketStep != 0 {
		return zero, "entry_invalid"
	}
	expectedBucket, ok := ExpectedPlaintextLenBucket(len(ctBytes))
	if !ok || bucket != expectedBucket {
		return zero, "entry_invalid"
	}

	return ValidatedPayload{
		Envelope:           env,
		EnvelopeBytes:      envJCS,
		CiphertextBytes:    ctBytes,
		PlaintextLenBucket: bucket,
	}, ""
}

// ParseEntryUUID kiểm tra chuỗi UUID entry chữ thường `8-4-4-4-12` theo `vault.ValidateEntryID`
// và chuyển sang `uuid.UUID`.
func ParseEntryUUID(raw string) (uuid.UUID, bool) {
	if err := vault.ValidateEntryID(raw); err != nil {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// EncodeListCursor mã hoá keyset cursor `(item_id, position, id)` thành chuỗi opaque base64url không padding.
func EncodeListCursor(itemID uuid.UUID, position int32, entryID uuid.UUID) string {
	raw := fmt.Sprintf("v1:%s:%d:%s", itemID.String(), position, entryID.String())
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// DecodeListCursor giải mã và kiểm tra cursor của `GET /items/{id}/entries` khớp đúng `expectedItemID`.
func DecodeListCursor(raw string, expectedItemID uuid.UUID) (int32, uuid.UUID, bool) {
	b, err := vault.DecodeBase64URLStrict(raw, 0)
	if err != nil {
		return 0, uuid.Nil, false
	}
	parts := strings.Split(string(b), ":")
	if len(parts) != 4 || parts[0] != "v1" {
		return 0, uuid.Nil, false
	}
	itemID, err := uuid.Parse(parts[1])
	if err != nil || itemID != expectedItemID {
		return 0, uuid.Nil, false
	}
	pos64, err := strconv.ParseInt(parts[2], 10, 32)
	if err != nil || pos64 < 0 {
		return 0, uuid.Nil, false
	}
	entryID, err := uuid.Parse(parts[3])
	if err != nil {
		return 0, uuid.Nil, false
	}
	return int32(pos64), entryID, true
}

func formatTimestamp(ts pgtype.Timestamptz) string {
	if !ts.Valid {
		return ""
	}
	return ts.Time.UTC().Format(time.RFC3339Nano)
}

// MetaFromInsertRow chuyển dòng trả về của `InsertEntry` thành DTO `Meta`.
func MetaFromInsertRow(r gen.InsertEntryRow) Meta {
	return Meta{
		ID:                 r.ID.String(),
		ItemID:             r.ItemID.String(),
		Type:               r.Type,
		Position:           r.Position,
		Version:            r.Version,
		PlaintextLenBucket: r.PlaintextLenBucket,
		CreatedAt:          formatTimestamp(r.CreatedAt),
		UpdatedAt:          formatTimestamp(r.UpdatedAt),
	}
}

// MetaFromListRow chuyển dòng trả về của `ListLiveEntryMetadataByItem` thành DTO `Meta`.
func MetaFromListRow(r gen.ListLiveEntryMetadataByItemRow) Meta {
	return Meta{
		ID:                 r.ID.String(),
		ItemID:             r.ItemID.String(),
		Type:               r.Type,
		Position:           r.Position,
		Version:            r.Version,
		PlaintextLenBucket: r.PlaintextLenBucket,
		CreatedAt:          formatTimestamp(r.CreatedAt),
		UpdatedAt:          formatTimestamp(r.UpdatedAt),
	}
}

// MetaFromUpdateRow chuyển dòng trả về của `UpdateEntryBody` thành DTO `Meta`.
func MetaFromUpdateRow(r gen.UpdateEntryBodyRow) Meta {
	return Meta{
		ID:                 r.ID.String(),
		ItemID:             r.ItemID.String(),
		Type:               r.Type,
		Position:           r.Position,
		Version:            r.Version,
		PlaintextLenBucket: r.PlaintextLenBucket,
		CreatedAt:          formatTimestamp(r.CreatedAt),
		UpdatedAt:          formatTimestamp(r.UpdatedAt),
	}
}

// EntryFromModel chuyển dòng `gen.Entry` thành DTO `Entry` kèm envelope đã kiểm tra và ciphertext base64url.
func EntryFromModel(m gen.Entry) (Entry, error) {
	env, err := vault.ValidateEntryEnvelope(m.Envelope)
	if err != nil {
		return Entry{}, err
	}
	return Entry{
		ID:                 m.ID.String(),
		ItemID:             m.ItemID.String(),
		Type:               m.Type,
		Position:           m.Position,
		Version:            m.Version,
		PlaintextLenBucket: m.PlaintextLenBucket,
		CreatedAt:          formatTimestamp(m.CreatedAt),
		UpdatedAt:          formatTimestamp(m.UpdatedAt),
		Envelope:           env,
		Ciphertext:         vault.EncodeBase64URL(m.Ciphertext),
	}, nil
}
