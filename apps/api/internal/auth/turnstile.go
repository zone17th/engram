package auth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Captcha interface {
	Enabled() bool
	Verify(ctx context.Context, token, ip, hostname, action string) error
}

type NoCaptcha struct{}

func (NoCaptcha) Enabled() bool { return false }

func (NoCaptcha) Verify(context.Context, string, string, string, string) error { return nil }

type StaticCaptcha struct {
	Accept string
}

func (s StaticCaptcha) Enabled() bool { return true }

func (s StaticCaptcha) Verify(_ context.Context, token, _, _, _ string) error {
	if token == "" || token != s.Accept {
		return ErrCaptchaRequired
	}
	return nil
}

type Turnstile struct {
	secret   string
	hostname string
	action   string
	client   *http.Client
}

func NewTurnstile(secret, hostname, action string, client *http.Client) *Turnstile {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	if action == "" {
		action = "login"
	}
	return &Turnstile{secret: secret, hostname: hostname, action: action, client: client}
}

func (t *Turnstile) Enabled() bool { return t != nil && t.secret != "" }

type turnstileResp struct {
	Success    bool     `json:"success"`
	Hostname   string   `json:"hostname"`
	Action     string   `json:"action"`
	ErrorCodes []string `json:"error-codes"`
}

func (t *Turnstile) Verify(ctx context.Context, token, ip, hostname, action string) (err error) {
	if token == "" {
		return ErrCaptchaRequired
	}
	form := url.Values{}
	form.Set("secret", t.secret)
	form.Set("response", token)
	if ip != "" {
		form.Set("remoteip", ip)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(form.Encode()))
	if err != nil {
		return ErrCaptchaRequired
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.client.Do(req)
	if err != nil {
		return ErrCaptchaRequired
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil && err == nil {
			err = ErrCaptchaRequired
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return ErrCaptchaRequired
	}
	var out turnstileResp
	if json.Unmarshal(body, &out) != nil || !out.Success {
		return ErrCaptchaRequired
	}
	wantHost := hostname
	if wantHost == "" {
		wantHost = t.hostname
	}
	if wantHost != "" && !strings.EqualFold(out.Hostname, wantHost) {
		return ErrCaptchaRequired
	}
	wantAct := action
	if wantAct == "" {
		wantAct = t.action
	}
	if wantAct != "" && out.Action != "" && out.Action != wantAct {
		return ErrCaptchaRequired
	}
	return nil
}
