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
	for _, want := range []string{
		"Mật khẩu đăng nhập engram của bạn vừa được đặt lại",
		"toàn bộ phiên đăng nhập đã bị thu hồi",
		"Google",
		"GitHub",
		"hãy đặt lại mật khẩu ngay",
	} {
		if !strings.Contains(viMsg, want) {
			t.Fatalf("vi notice missing %q in %q", want, viMsg)
		}
	}
	for _, forbidden := range []string{"Subject", "Body", "unlinked", "locale="} {
		if strings.Contains(viMsg, forbidden) {
			t.Fatalf("vi notice must not contain English/debug scaffolding %q: %q", forbidden, viMsg)
		}
	}

	enMsg := auth.FormatPasswordResetNoticeDetail("en", nil)
	for _, want := range []string{
		"Your engram login password was reset",
		"all sessions were signed out",
		"reset your password immediately",
	} {
		if !strings.Contains(enMsg, want) {
			t.Fatalf("en notice missing %q in %q", want, enMsg)
		}
	}
	for _, forbidden := range []string{"Subject:", "Body:", "unlinked", "locale=", "Google", "GitHub"} {
		if strings.Contains(enMsg, forbidden) {
			t.Fatalf("en notice without unlinked providers must not contain %q: %q", forbidden, enMsg)
		}
	}
}
