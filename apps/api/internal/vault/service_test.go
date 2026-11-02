package vault_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func seqBytes(n int, start byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func makeValidWrapB64U(t *testing.T, kind vault.WrapKind, seed byte) string {
	t.Helper()
	ptLen, ok := kind.ExpectedPlaintextLen()
	if !ok {
		t.Fatalf("unknown kind %q", kind)
	}
	pt := seqBytes(ptLen, seed)
	key := seqBytes(vault.VKBytes, seed+0x10)
	nonce := seqBytes(vault.WrapNonceBytes, seed+0x20)
	s, err := vault.SealWrapBase64URL(kind, pt, key, nonce)
	if err != nil {
		t.Fatalf("SealWrapBase64URL(%s): %v", kind, err)
	}
	return s
}

func makeValidCreateInput(t *testing.T, hashSeed byte) vault.CreateVaultInput {
	t.Helper()
	salt := vault.EncodeBase64URL(seqBytes(16, hashSeed+1))
	kdfRaw := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt + `"}`)

	rks := make([]vault.RecoveryKeyUploadItem, 10)
	for i := range 10 {
		h := seqBytes(32, hashSeed+byte(i*3+1))
		h[0] = byte(i + 1)
		h[1] = hashSeed
		rks[i] = vault.RecoveryKeyUploadItem{
			Slot:       i + 1,
			LookupHash: vault.EncodeBase64URL(h),
			Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, hashSeed+byte(i+1)),
		}
	}

	return vault.CreateVaultInput{
		KDFRaw:               kdfRaw,
		VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, hashSeed),
		X25519Public:         vault.EncodeBase64URL(seqBytes(32, hashSeed+0x30)),
		Ed25519Public:        vault.EncodeBase64URL(seqBytes(32, hashSeed+0x50)),
		PrivateKeysWrapped:   makeValidWrapB64U(t, vault.WrapKindPriv, hashSeed+0x70),
		RecoveryKeys:         rks,
		IP:                   "127.0.0.1",
		UA:                   "vault-service-test",
	}
}

func TestGenerateAndValidateVaultKeyID(t *testing.T) {
	seen := make(map[string]struct{}, 32)
	for range 32 {
		id, err := vault.GenerateVaultKeyID()
		if err != nil {
			t.Fatalf("GenerateVaultKeyID: %v", err)
		}
		if !vault.ValidateVaultKeyID(id) {
			t.Fatalf("ValidateVaultKeyID(%q) = false", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate vault_key_id %q", id)
		}
		seen[id] = struct{}{}
	}

	invalidIDs := []string{
		"",
		"vk:",
		"sk:AAECAwQFBgcICQoLDA0ODw",
		"vk:short",
		"vk:AAECAwQFBgcICQoLDA0ODw==",
		"vk:AAECAwQFBgcICQoLDA0OD/",
	}
	for _, bad := range invalidIDs {
		if vault.ValidateVaultKeyID(bad) {
			t.Errorf("ValidateVaultKeyID(%q) = true, want false", bad)
		}
	}
}

func TestValidateKDFParamsAndRewrapRules(t *testing.T) {
	salt1 := vault.EncodeBase64URL(seqBytes(16, 0x01))
	salt2 := vault.EncodeBase64URL(seqBytes(16, 0x02))

	baseKDF := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt1 + `"}`)
	params, saltBytes, _, err := vault.ValidateKDFParamsForCreate(baseKDF)
	if err != nil {
		t.Fatalf("ValidateKDFParamsForCreate: %v", err)
	}
	if params.Ops != 3 || params.Mem != 67108864 || params.Parallelism != 1 || len(saltBytes) != 16 {
		t.Fatalf("unexpected params: %+v", params)
	}

	// Rewrap with fresh salt and same ops/mem succeeds (advisor-dec-004).
	nextSame := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt2 + `"}`)
	if _, _, err := vault.ValidateKDFParamsForRewrap(nextSame, baseKDF); err != nil {
		t.Fatalf("ValidateKDFParamsForRewrap(same ops/mem, new salt): %v", err)
	}

	// Rewrap with reused salt fails with ErrVaultKDFInvalid.
	if _, _, err := vault.ValidateKDFParamsForRewrap(baseKDF, baseKDF); !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("expected ErrVaultKDFInvalid on reused salt, got %v", err)
	}

	// Rewrap lowering ops or mem from a higher current KDF fails with ErrVaultKDFInvalid.
	higherKDF := []byte(`{"alg":"argon2id13","ops":4,"mem":134217728,"parallelism":1,"salt":"` + salt1 + `"}`)
	if _, _, err := vault.ValidateKDFParamsForRewrap(nextSame, higherKDF); !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("expected ErrVaultKDFInvalid on downgraded ops/mem, got %v", err)
	}

	// Duplicate JSON key (including escaped key) rejected.
	dupKeyKDF := []byte(`{"alg":"argon2id13","ops":3,"\u006fps":3,"mem":67108864,"parallelism":1,"salt":"` + salt1 + `"}`)
	if _, _, _, err := vault.ValidateKDFParamsRawJSON(dupKeyKDF); !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("expected ErrVaultKDFInvalid on duplicate key, got %v", err)
	}
}

func TestKillSwitchMiddlewareAndResetHook(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	// Disabled = false -> passes through.
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/vault", nil)
	rec1 := httptest.NewRecorder()
	vault.RequireKeyMutationsEnabled(false)(next).ServeHTTP(rec1, req1)
	if !called || rec1.Code != http.StatusOK {
		t.Fatalf("killSwitch(false) status = %d, called = %v", rec1.Code, called)
	}

	// Disabled = true -> 503 vault_mutations_disabled.
	called = false
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/vault", nil)
	rec2 := httptest.NewRecorder()
	vault.RequireKeyMutationsEnabled(true)(next).ServeHTTP(rec2, req2)
	if called || rec2.Code != http.StatusServiceUnavailable {
		t.Fatalf("killSwitch(true) status = %d, called = %v", rec2.Code, called)
	}
	var prob httpx.Problem
	if err := json.Unmarshal(rec2.Body.Bytes(), &prob); err != nil {
		t.Fatalf("unmarshal problem: %v", err)
	}
	if prob.Code != "vault_mutations_disabled" {
		t.Fatalf("problem.Code = %q, want vault_mutations_disabled", prob.Code)
	}

	// NoopResetHook returns nil.
	if err := vault.NoopResetHook(context.Background(), nil, uuid.New()); err != nil {
		t.Fatalf("NoopResetHook: %v", err)
	}
}

func TestVaultMetricsCountersAndADR0002Note(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := vault.NewMetrics(reg)
	m.IncRecoverTotal()
	m.IncRecoveryUnlockFailure()

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	found := map[string]float64{}
	for _, f := range families {
		switch f.GetName() {
		case "vault_recover_total":
			found["vault_recover_total"] = f.GetMetric()[0].GetCounter().GetValue()
		case "vault_unlock_failures_total":
			for _, metric := range f.GetMetric() {
				for _, lbl := range metric.GetLabel() {
					if lbl.GetName() == "method" && lbl.GetValue() == vault.UnlockMethodRecovery {
						found["vault_unlock_failures_total{recovery}"] = metric.GetCounter().GetValue()
					}
				}
			}
		}
	}
	if found["vault_recover_total"] != 1 {
		t.Fatalf("vault_recover_total = %v, want 1", found["vault_recover_total"])
	}
	if found["vault_unlock_failures_total{recovery}"] != 1 {
		t.Fatalf("vault_unlock_failures_total{recovery} = %v, want 1", found["vault_unlock_failures_total{recovery}"])
	}
}

func TestServiceCreateReadStatusAndLockIfMatch(t *testing.T) {
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

	var logBuf bytes.Buffer
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	_, obsMetrics := obs.NewRegistry()
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, vault.MetricsFromObs(obsMetrics), nil, nil)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}
	_ = logBuf

	q := gen.New(pool)
	userA, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "svc-a@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	userB, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "svc-b@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser B: %v", err)
	}
	pA := authctx.Principal{UserID: userA.ID, SessionID: uuid.New()}
	pB := authctx.Principal{UserID: userB.ID, SessionID: uuid.New()}

	// Before create: VaultStatus is absent; Get/GetRecoveryKeysStatus/ListPasskeys return ErrVaultAbsent.
	if st, err := svc.VaultStatus(ctx, userA.ID); err != nil || st != vault.StatusAbsent {
		t.Fatalf("VaultStatus before create = %q, %v", st, err)
	}
	if _, err := svc.Get(ctx, userA.ID); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("Get before create = %v, want ErrVaultAbsent", err)
	}
	if _, err := svc.GetRecoveryKeysStatus(ctx, userA.ID); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("GetRecoveryKeysStatus before create = %v, want ErrVaultAbsent", err)
	}
	if _, err := svc.ListPasskeys(ctx, userA.ID); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("ListPasskeys before create = %v, want ErrVaultAbsent", err)
	}

	// LockVaultAndCheckIfMatch when vault is absent returns ErrVaultAbsent (404 before 412).
	tx0, err := svc.BeginMutationTx(ctx)
	if err != nil {
		t.Fatalf("BeginMutationTx: %v", err)
	}
	_, lockErr := vault.LockVaultAndCheckIfMatch(ctx, q.WithTx(tx0), userA.ID, httpx.VaultIfMatch{
		VaultKeyID: "vk:AAECAwQFBgcICQoLDA0ODw",
		Version:    1,
	})
	_ = tx0.Rollback(ctx)
	if !errors.Is(lockErr, vault.ErrVaultAbsent) {
		t.Fatalf("LockVaultAndCheckIfMatch on absent vault = %v, want ErrVaultAbsent", lockErr)
	}

	// Create vault for user A.
	inA := makeValidCreateInput(t, 0x10)
	created, err := svc.Create(ctx, pA, inA)
	if err != nil {
		t.Fatalf("svc.Create(A): %v", err)
	}
	if !vault.ValidateVaultKeyID(created.VaultKeyID) || created.Version != 1 {
		t.Fatalf("created = %+v", created)
	}

	// After create: VaultStatus is present.
	if st, err := svc.VaultStatus(ctx, userA.ID); err != nil || st != vault.StatusPresent {
		t.Fatalf("VaultStatus after create = %q, %v", st, err)
	}

	// Second create for user A -> ErrVaultExists.
	inA2 := makeValidCreateInput(t, 0x40)
	if _, err := svc.Create(ctx, pA, inA2); !errors.Is(err, vault.ErrVaultExists) {
		t.Fatalf("second Create(A) = %v, want ErrVaultExists", err)
	}

	// Cross-user duplicate lookup_hash -> generic ErrRecoveryKeyConflict (no owner leak) and user B has no vault.
	inBConflict := makeValidCreateInput(t, 0x80)
	inBConflict.RecoveryKeys[4].LookupHash = inA.RecoveryKeys[0].LookupHash
	_, conflictErr := svc.Create(ctx, pB, inBConflict)
	if !errors.Is(conflictErr, vault.ErrRecoveryKeyConflict) {
		t.Fatalf("cross-user lookup_hash Create(B) = %v, want ErrRecoveryKeyConflict", conflictErr)
	}
	if strings.Contains(conflictErr.Error(), userA.ID.String()) || strings.Contains(conflictErr.Error(), "svc-a") {
		t.Fatalf("conflict error leaked owner info: %v", conflictErr)
	}
	if stB, _ := svc.VaultStatus(ctx, userB.ID); stB != vault.StatusAbsent {
		t.Fatalf("user B vault must remain absent after rollback, got %q", stB)
	}

	// LockVaultAndCheckIfMatch with wrong version -> version_mismatch with current_version=1.
	tx1, err := svc.BeginMutationTx(ctx)
	if err != nil {
		t.Fatalf("BeginMutationTx: %v", err)
	}
	_, mismatchErr := vault.LockVaultAndCheckIfMatch(ctx, q.WithTx(tx1), userA.ID, httpx.VaultIfMatch{
		VaultKeyID: created.VaultKeyID,
		Version:    2,
	})
	_ = tx1.Rollback(ctx)
	ve, ok := vault.AsError(mismatchErr)
	if !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 1 {
		t.Fatalf("expected version_mismatch with current_version=1, got %v (%+v)", mismatchErr, ve)
	}

	// Read state for user A.
	state, err := svc.Get(ctx, userA.ID)
	if err != nil {
		t.Fatalf("svc.Get(A): %v", err)
	}
	if state.VaultKeyID != created.VaultKeyID || state.Version != 1 || state.RecoveryKeysRemaining != 10 || len(state.Passkeys) != 0 {
		t.Fatalf("unexpected VaultState: %+v", state)
	}
	rkStatus, err := svc.GetRecoveryKeysStatus(ctx, userA.ID)
	if err != nil {
		t.Fatalf("svc.GetRecoveryKeysStatus(A): %v", err)
	}
	if rkStatus.Remaining != 10 || rkStatus.Slots != 10 || len(rkStatus.EmptySlots) != 0 {
		t.Fatalf("unexpected RecoveryKeysStatus: %+v", rkStatus)
	}
	pkList, err := svc.ListPasskeys(ctx, userA.ID)
	if err != nil {
		t.Fatalf("svc.ListPasskeys(A): %v", err)
	}
	if len(pkList.Items) != 0 {
		t.Fatalf("unexpected PasskeyList: %+v", pkList)
	}

	// Verify audit row `vault.create` exists for userA and has no secrets.
	var auditEvent string
	var auditMeta []byte
	if err := pool.QueryRow(ctx, `SELECT event, meta FROM audit_log WHERE user_id = $1`, userA.ID).Scan(&auditEvent, &auditMeta); err != nil {
		t.Fatalf("query audit_log: %v", err)
	}
	if auditEvent != vault.EventVaultCreate {
		t.Fatalf("audit event = %q, want %q", auditEvent, vault.EventVaultCreate)
	}
	for _, rk := range inA.RecoveryKeys {
		if bytes.Contains(auditMeta, []byte(rk.LookupHash)) || bytes.Contains(auditMeta, []byte(rk.Wrap)) {
			t.Fatalf("audit meta leaked RK hash/wrap: %s", auditMeta)
		}
	}
	if bytes.Contains(auditMeta, []byte(inA.VaultKeyWrappedByKEK)) || bytes.Contains(auditMeta, []byte(inA.PrivateKeysWrapped)) {
		t.Fatalf("audit meta leaked vault wrap: %s", auditMeta)
	}
	_ = pgx.ErrNoRows
}
