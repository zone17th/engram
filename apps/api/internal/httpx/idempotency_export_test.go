package httpx

// SetClaimRaceHookForTest gắn một callback chỉ dùng trong test để chặn ngay trước khi
// bước 6 (Claim) mở transaction INSERT ... ON CONFLICT DO UPDATE, giúp kiểm chứng
// tất định trường hợp thua race ở bước Claim rồi được phân loại lại.
func (m *Idempotency) SetClaimRaceHookForTest(fn func()) {
	m.onClaimRace = fn
}

// SetClaimRereadHookForTest gắn một callback chỉ dùng trong test chạy ngay trước khi
// request thua race ở bước 6 đọc lại hàng từ DB (giúp đồng bộ tất định tình huống
// request thắng race gặp lỗi trước COMMIT và release hàng trước khi request thua đọc lại).
func (m *Idempotency) SetClaimRereadHookForTest(fn func()) {
	m.onClaimReread = fn
}
