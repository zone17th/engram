package httpx

// SetClaimRaceHookForTest gắn một callback chỉ dùng trong test để chặn ngay trước khi
// bước 6 (Claim) mở transaction INSERT ... ON CONFLICT DO UPDATE, giúp kiểm chứng
// tất định trường hợp thua race ở bước Claim rồi được phân loại lại.
func (m *Idempotency) SetClaimRaceHookForTest(fn func()) {
	m.onClaimRace = fn
}
