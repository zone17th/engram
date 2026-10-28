package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

const validTestVaultKeyID = "vk:7f3a1c9e02b4d6f89012ab"

func TestIfMatchMissingWildcardWeakAndListRejectedWith428(t *testing.T) {
	cases := []struct {
		name    string
		headers []string
	}{
		{name: "missing", headers: nil},
		{name: "empty", headers: []string{""}},
		{name: "wildcard", headers: []string{"*"}},
		{name: "unquoted", headers: []string{validTestVaultKeyID + ":1"}},
		{name: "empty_quotes", headers: []string{`""`}},
		{name: "weak_upper", headers: []string{`W/"` + validTestVaultKeyID + `:1"`}},
		{name: "weak_lower", headers: []string{`w/"` + validTestVaultKeyID + `:1"`}},
		{name: "list_single_header", headers: []string{`"` + validTestVaultKeyID + `:1", "` + validTestVaultKeyID + `:2"`}},
		{name: "list_multiple_headers", headers: []string{`"` + validTestVaultKeyID + `:1"`, `"` + validTestVaultKeyID + `:2"`}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := chi.NewRouter()
			r.Use(httpx.RequireIfMatch)
			r.Put("/vault/kek", func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("handler không được chạy khi If-Match không hợp lệ")
			})

			req := httptest.NewRequest(http.MethodPut, "/vault/kek", nil)
			for _, h := range tc.headers {
				req.Header.Add("If-Match", h)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusPreconditionRequired {
				t.Fatalf("%s: status = %d, muốn 428", tc.name, rec.Code)
			}
			var prob httpx.Problem
			if err := json.Unmarshal(rec.Body.Bytes(), &prob); err != nil {
				t.Fatalf("%s: decode problem: %v", tc.name, err)
			}
			if prob.Code != "precondition_required" {
				t.Fatalf("%s: code = %q, muốn precondition_required", tc.name, prob.Code)
			}
		})
	}
}

func TestParseVaultIfMatchSplitsAtLastColon(t *testing.T) {
	raw := `"` + validTestVaultKeyID + `:42"`
	got, ok := httpx.ParseVaultIfMatch(raw)
	if !ok {
		t.Fatalf("ParseVaultIfMatch(%q) thất bại", raw)
	}
	if got.VaultKeyID != validTestVaultKeyID {
		t.Fatalf("VaultKeyID = %q, muốn %q", got.VaultKeyID, validTestVaultKeyID)
	}
	if got.Version != 42 {
		t.Fatalf("Version = %d, muốn 42", got.Version)
	}

	invalid := []string{
		validTestVaultKeyID,              // thiếu :version
		validTestVaultKeyID + ":",        // thiếu version
		validTestVaultKeyID + ":0",       // version = 0
		validTestVaultKeyID + ":01",      // leading zero
		validTestVaultKeyID + ":-1",      // âm
		validTestVaultKeyID + ":abc",     // không phải số
		"vk:short:1",                     // sai độ dài vault_key_id
		"other:7f3a1c9e02b4d6f89012ab:1", // sai prefix
	}
	for _, in := range invalid {
		if _, ok := httpx.ParseVaultIfMatch(in); ok {
			t.Errorf("ParseVaultIfMatch(%q) phải thất bại", in)
		}
	}
}

func TestVaultIfMatchLockAndVerify404And412(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('ifmatch@example.com', 'en') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	makeHandler := func() http.Handler {
		r := chi.NewRouter()
		r.Use(httpx.RequireIfMatch)
		r.Put("/api/v1/vault/kek", func(w http.ResponseWriter, r *http.Request) {
			tx, err := pool.Begin(r.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			v, ok := httpx.LockAndVerifyVaultIfMatch(r.Context(), w, r, gen.New(tx), userID)
			if !ok {
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"version": v.Version})
		})
		return r
	}

	h := makeHandler()

	// 1. Khi user chưa có vault -> 404 vault_absent (ưu tiên hơn 412).
	reqAbsent := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqAbsent.Header.Set("If-Match", `"`+validTestVaultKeyID+`:1"`)
	recAbsent := httptest.NewRecorder()
	h.ServeHTTP(recAbsent, reqAbsent)
	if recAbsent.Code != http.StatusNotFound {
		t.Fatalf("no vault: status = %d, muốn 404", recAbsent.Code)
	}
	var probAbsent httpx.Problem
	if err := json.Unmarshal(recAbsent.Body.Bytes(), &probAbsent); err != nil {
		t.Fatal(err)
	}
	if probAbsent.Code != "vault_absent" {
		t.Fatalf("no vault: code = %q, muốn vault_absent", probAbsent.Code)
	}

	// Tạo vault với version = 3 và validTestVaultKeyID.
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
		VALUES ($1, 3, '{"alg":"argon2id13"}'::jsonb, $2, '\x01', '\x02', '\x03', '\x04')
	`, userID, validTestVaultKeyID); err != nil {
		t.Fatal(err)
	}

	// 2. Lệch vault_key_id (ví dụ tab cũ giữ vault_key_id trước khi reset) -> 412 version_mismatch + current_version=3.
	otherVaultKeyID := "vk:0000000000000000000000"
	reqKeyMismatch := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqKeyMismatch.Header.Set("If-Match", `"`+otherVaultKeyID+`:3"`)
	recKeyMismatch := httptest.NewRecorder()
	h.ServeHTTP(recKeyMismatch, reqKeyMismatch)
	if recKeyMismatch.Code != http.StatusPreconditionFailed {
		t.Fatalf("vault_key_id mismatch: status = %d, muốn 412", recKeyMismatch.Code)
	}
	var bodyKeyMismatch struct {
		httpx.Problem
		CurrentVersion int32 `json:"current_version"`
	}
	if err := json.Unmarshal(recKeyMismatch.Body.Bytes(), &bodyKeyMismatch); err != nil {
		t.Fatal(err)
	}
	if bodyKeyMismatch.Code != "version_mismatch" || bodyKeyMismatch.CurrentVersion != 3 {
		t.Fatalf("vault_key_id mismatch: code=%q current_version=%d, muốn version_mismatch và 3", bodyKeyMismatch.Code, bodyKeyMismatch.CurrentVersion)
	}

	// 3. Lệch version -> 412 version_mismatch + current_version=3.
	reqVerMismatch := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqVerMismatch.Header.Set("If-Match", `"`+validTestVaultKeyID+`:2"`)
	recVerMismatch := httptest.NewRecorder()
	h.ServeHTTP(recVerMismatch, reqVerMismatch)
	if recVerMismatch.Code != http.StatusPreconditionFailed {
		t.Fatalf("version mismatch: status = %d, muốn 412", recVerMismatch.Code)
	}
	var bodyVerMismatch struct {
		httpx.Problem
		CurrentVersion int32 `json:"current_version"`
	}
	if err := json.Unmarshal(recVerMismatch.Body.Bytes(), &bodyVerMismatch); err != nil {
		t.Fatal(err)
	}
	if bodyVerMismatch.Code != "version_mismatch" || bodyVerMismatch.CurrentVersion != 3 {
		t.Fatalf("version mismatch: code=%q current_version=%d, muốn version_mismatch và 3", bodyVerMismatch.Code, bodyVerMismatch.CurrentVersion)
	}

	// 4. Khớp cả vault_key_id và version -> 200 OK.
	reqOK := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqOK.Header.Set("If-Match", `"`+validTestVaultKeyID+`:3"`)
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("match: status = %d, muốn 200", recOK.Code)
	}
}

func TestDeleteWithoutBodyNotRejectedWith415(t *testing.T) {
	// 1. Chứng minh hành vi thực của P02 RequireJSONContent: từ chối DELETE không có Content-Type với 415.
	rP02 := chi.NewRouter()
	rP02.Use(httpx.RequireJSONContent)
	rP02.Delete("/api/v1/vault", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	reqP02 := httptest.NewRequest(http.MethodDelete, "/api/v1/vault", nil)
	recP02 := httptest.NewRecorder()
	rP02.ServeHTTP(recP02, reqP02)
	if recP02.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("P02 RequireJSONContent trên DELETE không header: status = %d, muốn 415", recP02.Code)
	}

	// 2. Với RequireJSONContentExceptEmptyDelete (hoặc không gắn RequireJSONContent cho DELETE không body):
	// DELETE không body, không Content-Type đi qua và trả 204, trong khi POST không Content-Type vẫn bị 415.
	rP03 := chi.NewRouter()
	rP03.Use(httpx.RequireJSONContentExceptEmptyDelete)
	rP03.Delete("/api/v1/vault", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	rP03.Post("/api/v1/vault", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	reqDel := httptest.NewRequest(http.MethodDelete, "/api/v1/vault", nil)
	recDel := httptest.NewRecorder()
	rP03.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusNoContent {
		t.Fatalf("DELETE không body qua RequireJSONContentExceptEmptyDelete: status = %d, muốn 204", recDel.Code)
	}

	reqPost := httptest.NewRequest(http.MethodPost, "/api/v1/vault", nil)
	recPost := httptest.NewRecorder()
	rP03.ServeHTTP(recPost, reqPost)
	if recPost.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("POST thiếu Content-Type qua RequireJSONContentExceptEmptyDelete: status = %d, muốn 415", recPost.Code)
	}
}
