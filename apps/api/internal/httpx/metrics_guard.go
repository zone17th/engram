package httpx

import (
	"net"
	"net/http"
	"net/netip"
)

// forwardingHeaders là các header mà proxy biên (nginx) gắn vào request đi từ
// Internet. Có bất kỳ header nào → request đã đi qua proxy → không phải nội bộ.
var forwardingHeaders = []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"}

// internalPrefixes là loopback và dải mạng riêng mà Docker dùng cho bridge/network
// nội bộ (scraper trên host đi qua gateway bridge 172.x, container khác cùng network).
var internalPrefixes = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("fc00::/7"),
}

// RequireInternalOrLoopback chỉ cho request đến TRỰC TIẾP từ loopback hoặc mạng
// Docker nội bộ, không mang header chuyển tiếp, đi tiếp. Mọi request khác (đi qua
// proxy biên, IP công khai, RemoteAddr không phân tích được) nhận `404 not_found`
// giống route không tồn tại, để không lộ sự tồn tại của endpoint.
//
// Cố ý dùng r.RemoteAddr thô, KHÔNG dùng IP client đã giải theo
// AUTH_TRUSTED_PROXY_CIDRS: proxy tin cậy chính là thứ phải bị chặn ở đây.
func RequireInternalOrLoopback(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isInternalDirect(r) {
			WriteProblem(w, r, http.StatusNotFound, "not_found", "Không có tài nguyên ở đường dẫn này.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isInternalDirect(r *http.Request) bool {
	for _, h := range forwardingHeaders {
		if _, ok := r.Header[http.CanonicalHeaderKey(h)]; ok {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, p := range internalPrefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
