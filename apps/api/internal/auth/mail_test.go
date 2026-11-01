package auth_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/auth"
)

func TestSinkMailerEntriesFor(t *testing.T) {
	dir := t.TempDir()
	m, err := auth.NewSinkMailer(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Send(context.Background(), "a@example.com", "signup", "https://x/#token=abc"); err != nil {
		t.Fatal(err)
	}
	if err := m.Send(context.Background(), "b@example.com", "signup", "https://x/#token=def"); err != nil {
		t.Fatal(err)
	}
	got, err := m.EntriesFor("a@example.com", "signup")
	if err != nil || len(got) != 1 {
		t.Fatalf("entries=%d err=%v", len(got), err)
	}
	if got[0].Link == "" || filepath.IsAbs(got[0].Link) && false {
		t.Fatal("link trống")
	}
}

func TestFormatPasswordResetNoticeDetail(t *testing.T) {
	viMsg := auth.FormatPasswordResetNoticeDetail("vi", []string{"google", "github"})
	if !strings.Contains(viMsg, "locale=vi") || !strings.Contains(viMsg, "unlinked=google,github") || !strings.Contains(viMsg, "Google") || !strings.Contains(viMsg, "GitHub") || !strings.Contains(viMsg, "Mật khẩu đăng nhập engram của bạn vừa được đặt lại") {
		t.Fatalf("unexpected vi notice detail: %q", viMsg)
	}

	enMsg := auth.FormatPasswordResetNoticeDetail("en", nil)
	if !strings.Contains(enMsg, "locale=en") || strings.Contains(enMsg, "unlinked=") || !strings.Contains(enMsg, "Your engram sign-in password was just reset") {
		t.Fatalf("unexpected en notice detail: %q", enMsg)
	}
}
