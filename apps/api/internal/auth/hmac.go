package auth

import (
	"crypto/hmac"
	"crypto/sha256"
)

const (
	HMACDomainIP    = "sabk.auth.ip.v1"
	HMACDomainEmail = "sabk.auth.email.v1"
)

// HMAC32 băm HMAC-SHA256 với domain separator. Không log đầu vào.
func HMAC32(key []byte, domain, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(domain))
	mac.Write([]byte{0})
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func HashIP(pepper []byte, ip string) []byte {
	return HMAC32(pepper, HMACDomainIP, ip)
}

func HashEmailSubject(pepper []byte, email string) []byte {
	return HMAC32(pepper, HMACDomainEmail, EmailSubject(email))
}

func SHA256Bytes(raw []byte) []byte {
	sum := sha256.Sum256(raw)
	return sum[:]
}
