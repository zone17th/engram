package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	PurposePasswordReset          = "password_reset"
	PurposePasswordResetOAuthOnly = "password_reset_oauth_only"
	PurposePasswordResetNotice    = "password_reset_notice"
)

type SinkMailer struct {
	dir string
	mu  sync.Mutex
}

func NewSinkMailer(dir string) (*SinkMailer, error) {
	if dir == "" {
		return nil, ErrMailDeliveryUnavailable
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &SinkMailer{dir: dir}, nil
}

type SinkEntry struct {
	Recipient string `json:"recipient"`
	Purpose   string `json:"purpose"`
	Link      string `json:"link"`
}

func (m *SinkMailer) Send(_ context.Context, recipient, purpose, link string) (err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	name := hex.EncodeToString(nonce[:]) + ".json"
	path := filepath.Join(m.dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}()
	return json.NewEncoder(f).Encode(SinkEntry{Recipient: recipient, Purpose: purpose, Link: link})
}

func (m *SinkMailer) EntriesFor(recipient, purpose string) ([]SinkEntry, error) {
	ents, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	var out []SinkEntry
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.dir, e.Name()))
		if err != nil {
			continue
		}
		var m0 SinkEntry
		if json.Unmarshal(b, &m0) != nil {
			continue
		}
		if m0.Recipient == recipient && m0.Purpose == purpose {
			out = append(out, m0)
		}
	}
	return out, nil
}

func FormatPasswordResetNoticeDetail(locale string, unlinked []string) string {
	if locale != "vi" {
		locale = "en"
	}
	var names []string
	for _, p := range unlinked {
		switch p {
		case "google":
			names = append(names, "Google")
		case "github":
			names = append(names, "GitHub")
		}
	}
	if locale == "vi" {
		msg := "locale=vi | Subject: Mật khẩu đăng nhập engram của bạn vừa được đặt lại | Body: Mật khẩu tài khoản đăng nhập engram của bạn vừa được thay đổi và toàn bộ phiên đăng nhập đã bị thu hồi."
		if len(names) > 0 {
			msg += " Các phương thức đăng nhập đã ngắt liên kết: " + strings.Join(names, ", ") + " (unlinked:" + strings.Join(unlinked, ",") + ")."
		}
		msg += " Nếu bạn không thực hiện thao tác này, hãy đặt lại mật khẩu ngay."
		return msg
	}
	msg := "locale=en | Subject: Your engram login password was reset | Body: Your engram account login password was changed and all sessions were signed out."
	if len(names) > 0 {
		msg += " Unlinked sign-in providers: " + strings.Join(names, ", ") + " (unlinked:" + strings.Join(unlinked, ",") + ")."
	}
	msg += " If you did not perform this action, reset your password immediately."
	return msg
}
