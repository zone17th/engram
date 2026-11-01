package compose_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

func TestNewVaultAndAuthVaultStatusIntegration(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	_, metrics := obs.NewRegistry()

	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, nil, clk, mail, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, pool, nil, clk, mail, metrics, nil, nil)
	if err != nil {
		t.Fatalf("compose.NewVault: %v", err)
	}
	if vaultSvc == nil || vaultAPI == nil {
		t.Fatal("vaultSvc hoặc vaultAPI nil")
	}

	// Verify MountAll mounts both auth and vault routes cleanly.
	authn, csrfv, reauth := compose.Adapters(authSvc)
	router := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           obs.NewLogger("error", "test"),
		Ready:            func(context.Context) error { return nil },
		Metrics:          http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI)),
	})

	// Unauthenticated GET /api/v1/vault returns 401 unauthenticated (proving route is mounted).
	req := httptest.NewRequest(http.MethodGet, "/api/v1/vault", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/v1/vault status = %d, want 401", rec.Code)
	}

	// Create user via authSvc.Signup -> Me.Vault.Status must be "absent".
	meBefore, issued, err := authSvc.Signup(ctx, auth.SignupInput{
		Email:    "compose-vault@example.com",
		Password: "correct-horse-battery-staple",
		Locale:   "en",
		IP:       "127.0.0.1",
		UA:       "compose-test",
	})
	if err != nil {
		t.Fatalf("authSvc.Signup: %v", err)
	}
	if meBefore.Vault.Status != vault.StatusAbsent {
		t.Fatalf("Me.Vault.Status before create = %q, want %q", meBefore.Vault.Status, vault.StatusAbsent)
	}

	// Insert a vault row directly or via vaultSvc -> BuildMe must report "present".
	q := gen.New(pool)
	vkID, err := vault.GenerateVaultKeyID()
	if err != nil {
		t.Fatalf("GenerateVaultKeyID: %v", err)
	}
	_, err = q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               issued.Principal.UserID,
		Kdf:                  []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAECAwQFBgcICQoLDA0ODw"}`),
		VaultKeyID:           vkID,
		VaultKeyWrappedByKek: make([]byte, vault.VKWrapBytes),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, vault.PrivWrapBytes),
	})
	if err != nil {
		t.Fatalf("InsertVault: %v", err)
	}

	meAfter, err := authSvc.BuildMe(ctx, issued.Principal.UserID)
	if err != nil {
		t.Fatalf("BuildMe after create: %v", err)
	}
	if meAfter.Vault.Status != vault.StatusPresent {
		t.Fatalf("Me.Vault.Status after create = %q, want %q", meAfter.Vault.Status, vault.StatusPresent)
	}

	// Non-existent user returns "absent".
	stUnknown, err := vaultSvc.VaultStatus(ctx, uuid.New())
	if err != nil {
		t.Fatalf("VaultStatus(unknown): %v", err)
	}
	if stUnknown != vault.StatusAbsent {
		t.Fatalf("VaultStatus(unknown) = %q, want %q", stUnknown, vault.StatusAbsent)
	}
}
