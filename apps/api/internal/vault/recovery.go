package vault

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"math/bits"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/text/unicode/norm"
)

// Hằng số cho Recovery Key (ADR 0002 §7, SPEC §5.9, plan mục 2.2).
// Lưu ý: các hàm chuẩn hoá, sinh RK và băm BLAKE2b trong file này chỉ phục vụ
// kiểm thử chéo (cross-check) phía Go ở Task 6–7; server production không bao giờ
// nhận hay xử lý plaintext RK.
const (
	RKSlotMin      = 1
	RKSlotMax      = 10
	RKEntropyBytes = 16
	RKBodyLen      = 26
	RKHashBytes    = 32

	RKLookupDomain = "sabk.rk.lookup.v1"
	RKWrapDomain   = "sabk.rk.wrap.v1"

	crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
)

// ErrRecoveryKeyInvalid trả về khi chuỗi recovery key không qua được hàm chuẩn hoá 5 bước.
var ErrRecoveryKeyInvalid = errors.New("vault: invalid recovery key")

// recoveryKeyResult chứa kết quả sinh RK cho kiểm thử chéo.
type recoveryKeyResult struct {
	Slot       int
	Display    string
	Normalized string
}

// normalizeRecoveryKey thực hiện đúng một hàm chuẩn hoá 5 bước theo ADR 0002 §7 và plan mục 2.2
// (chỉ dùng cho kiểm thử chéo ở Go, implementation độc lập dùng `golang.org/x/text/unicode/norm`,
// `unicode.White_Space` và `unicode.Cf`):
//  1. Chuẩn hoá Unicode NFKC. Xoá mọi rune thuộc bảng `unicode.White_Space` (gồm U+00A0)
//     và mọi rune thuộc bảng `unicode.Cf` (gồm U+00AD, U+200B..U+200D, U+2060, U+FEFF).
//     Chuyển các dấu gạch Unicode U+2010..U+2015 và dấu trừ U+2212 thành `-` (U+002D).
//  2. Từ chối ngay nếu chuỗi còn bất kỳ rune nào ngoài ASCII (`> 0x7F`, ví dụ `ı`, `ß`, `İ`).
//  3. Tách và chuẩn hoá tiền tố `^rk(10|[1-9])[_-]` (không phân biệt hoa/thường cho `rk`,
//     không nhận số `0` đứng đầu như `rk01`, bắt buộc có `_` hoặc `-` ngay sau `n`) → `rk{n}_`.
//  4. Phần thân còn lại: xoá `-`, đổi chữ thường ASCII sang chữ hoa, ánh xạ `O->0`, `I/L->1`.
//     Ký tự `U` và mọi ký tự ngoài bảng Crockford 32 ký tự bị từ chối.
//  5. Từ chối nếu độ dài phần thân khác 26 hoặc ký tự đầu tiên nằm ngoài `'0'`..`'7'`.
func normalizeRecoveryKey(input string) (string, error) {
	if !utf8.ValidString(input) {
		return "", fmt.Errorf("%w: invalid UTF-8 string", ErrRecoveryKeyInvalid)
	}

	// Bước 1: NFKC + lọc White_Space / Cf + chuẩn hoá dấu gạch Unicode.
	nfkc := norm.NFKC.String(input)
	var step1 strings.Builder
	step1.Grow(len(nfkc))
	for _, r := range nfkc {
		if unicode.Is(unicode.White_Space, r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if (r >= 0x2010 && r <= 0x2015) || r == 0x2212 {
			step1.WriteByte('-')
			continue
		}
		step1.WriteRune(r)
	}
	cleaned := step1.String()

	// Bước 2: Kiểm tra chỉ còn ASCII (<= 0x7F).
	for i := range len(cleaned) {
		if cleaned[i] > 0x7f {
			return "", fmt.Errorf("%w: non-ASCII byte 0x%02x remaining after NFKC", ErrRecoveryKeyInvalid, cleaned[i])
		}
	}

	// Bước 3: Khớp tiền tố ^rk(10|[1-9])[_-] (case-insensitive cho "rk", không có số 0 đứng đầu).
	if len(cleaned) < 4 {
		return "", fmt.Errorf("%w: input too short for prefix", ErrRecoveryKeyInvalid)
	}
	if (cleaned[0] != 'r' && cleaned[0] != 'R') || (cleaned[1] != 'k' && cleaned[1] != 'K') {
		return "", fmt.Errorf("%w: missing rk prefix", ErrRecoveryKeyInvalid)
	}

	var (
		slot   int
		sepIdx int
	)
	if len(cleaned) >= 5 && cleaned[2] == '1' && cleaned[3] == '0' && (cleaned[4] == '_' || cleaned[4] == '-') {
		slot = 10
		sepIdx = 4
	} else if cleaned[2] >= '1' && cleaned[2] <= '9' && (cleaned[3] == '_' || cleaned[3] == '-') {
		slot = int(cleaned[2] - '0')
		sepIdx = 3
	} else {
		return "", fmt.Errorf("%w: invalid slot or separator in prefix", ErrRecoveryKeyInvalid)
	}

	rawBody := cleaned[sepIdx+1:]

	// Bước 4: Chuẩn hoá phần thân Crockford Base32 (xoá '-', ASCII toupper, O->0, I/L->1, từ chối U và ký tự lạ).
	var body [RKBodyLen]byte
	bodyLen := 0
	for i := range len(rawBody) {
		ch := rawBody[i]
		if ch == '-' {
			continue
		}
		if ch >= 'a' && ch <= 'z' {
			ch -= 'a' - 'A'
		}
		switch ch {
		case 'O':
			ch = '0'
		case 'I', 'L':
			ch = '1'
		case 'U':
			return "", fmt.Errorf("%w: forbidden Crockford character 'U'", ErrRecoveryKeyInvalid)
		}
		if !isCanonicalCrockfordChar(ch) {
			return "", fmt.Errorf("%w: invalid Crockford character %q", ErrRecoveryKeyInvalid, ch)
		}
		if bodyLen >= RKBodyLen {
			return "", fmt.Errorf("%w: body exceeds %d characters", ErrRecoveryKeyInvalid, RKBodyLen)
		}
		body[bodyLen] = ch
		bodyLen++
	}

	// Bước 5: Kiểm tra độ dài đúng 26 ký tự và ký tự đầu trong '0'..'7'.
	if bodyLen != RKBodyLen {
		return "", fmt.Errorf("%w: expected %d body characters, got %d", ErrRecoveryKeyInvalid, RKBodyLen, bodyLen)
	}
	if body[0] < '0' || body[0] > '7' {
		return "", fmt.Errorf("%w: first body character %q outside '0'..'7'", ErrRecoveryKeyInvalid, body[0])
	}

	return "rk" + strconv.Itoa(slot) + "_" + string(body[:]), nil
}

func isCanonicalCrockfordChar(c byte) bool {
	if c >= '0' && c <= '9' {
		return true
	}
	if c >= 'A' && c <= 'Z' {
		return c != 'I' && c != 'L' && c != 'O' && c != 'U'
	}
	return false
}

// formatRecoveryKeyDisplay định dạng 26 ký tự Crockford thành `rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`.
func formatRecoveryKeyDisplay(slot int, body26 string) (string, error) {
	if slot < RKSlotMin || slot > RKSlotMax {
		return "", fmt.Errorf("%w: slot %d outside 1..10", ErrRecoveryKeyInvalid, slot)
	}
	if len(body26) != RKBodyLen {
		return "", fmt.Errorf("%w: body must be %d chars", ErrRecoveryKeyInvalid, RKBodyLen)
	}
	raw := fmt.Sprintf("rk%d_%s-%s-%s-%s-%s-%s-%s",
		slot,
		body26[0:4],
		body26[4:8],
		body26[8:12],
		body26[12:16],
		body26[16:20],
		body26[20:24],
		body26[24:26],
	)
	// Đi qua đúng hàm chuẩn hoá duy nhất để kiểm chứng tính hợp lệ.
	if _, err := normalizeRecoveryKey(raw); err != nil {
		return "", err
	}
	return raw, nil
}

// generateRecoveryKey sinh RK từ 16 byte entropy (đọc big-endian 128-bit, đệm 2 bit 0 bên trái thành 130 bit,
// chia thành 26 nhóm 5-bit Crockford Base32) và chuẩn hoá bằng hàm duy nhất `normalizeRecoveryKey`.
func generateRecoveryKey(slot int, entropy []byte) (recoveryKeyResult, error) {
	if slot < RKSlotMin || slot > RKSlotMax {
		return recoveryKeyResult{}, fmt.Errorf("%w: slot %d outside 1..10", ErrRecoveryKeyInvalid, slot)
	}
	var raw [RKEntropyBytes]byte
	if entropy == nil {
		if _, err := rand.Read(raw[:]); err != nil {
			return recoveryKeyResult{}, fmt.Errorf("vault: read random RK entropy: %w", err)
		}
	} else {
		if len(entropy) != RKEntropyBytes {
			return recoveryKeyResult{}, fmt.Errorf("%w: entropy must be %d bytes, got %d", ErrRecoveryKeyInvalid, RKEntropyBytes, len(entropy))
		}
		copy(raw[:], entropy)
	}

	hi := binary.BigEndian.Uint64(raw[0:8])
	lo := binary.BigEndian.Uint64(raw[8:16])

	// 128-bit số nguyên không dấu (hi: 64 bit cao, lo: 64 bit thấp) được coi như 130-bit với 2 bit 0 ở đầu.
	// Trích từ phải sang trái 26 nhóm 5-bit (mỗi lần lấy `lo & 0x1f` rồi dịch phải 128-bit đi 5 bit).
	var chars [RKBodyLen]byte
	for i := RKBodyLen - 1; i >= 0; i-- {
		idx := lo & 0x1f
		chars[i] = crockfordAlphabet[idx]
		lo = (lo >> 5) | (hi << 59)
		hi >>= 5
	}
	_ = bits.LeadingZeros64(hi)

	display, err := formatRecoveryKeyDisplay(slot, string(chars[:]))
	if err != nil {
		return recoveryKeyResult{}, err
	}
	normStr, err := normalizeRecoveryKey(display)
	if err != nil {
		return recoveryKeyResult{}, err
	}
	return recoveryKeyResult{
		Slot:       slot,
		Display:    display,
		Normalized: normStr,
	}, nil
}

// deriveRecoveryLookupHash tính `BLAKE2b-256(UTF8("sabk.rk.lookup.v1") || UTF8(rk_norm))`
// sau khi chạy qua hàm chuẩn hoá duy nhất `normalizeRecoveryKey`.
func deriveRecoveryLookupHash(input string) ([RKHashBytes]byte, error) {
	normStr, err := normalizeRecoveryKey(input)
	if err != nil {
		return [RKHashBytes]byte{}, err
	}
	msg := make([]byte, 0, len(RKLookupDomain)+len(normStr))
	msg = append(msg, RKLookupDomain...)
	msg = append(msg, normStr...)
	return blake2b.Sum256(msg), nil
}

// deriveRecoveryWrapKey tính `BLAKE2b-256(UTF8("sabk.rk.wrap.v1") || UTF8(rk_norm))`
// sau khi chạy qua hàm chuẩn hoá duy nhất `normalizeRecoveryKey`.
func deriveRecoveryWrapKey(input string) ([RKHashBytes]byte, error) {
	normStr, err := normalizeRecoveryKey(input)
	if err != nil {
		return [RKHashBytes]byte{}, err
	}
	msg := make([]byte, 0, len(RKWrapDomain)+len(normStr))
	msg = append(msg, RKWrapDomain...)
	msg = append(msg, normStr...)
	return blake2b.Sum256(msg), nil
}
