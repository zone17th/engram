package httpx_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

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
		{name: "space_inside_quotes", headers: []string{`"a b"`}},
		{name: "padded_inside_quotes", headers: []string{`" ` + validTestVaultKeyID + `:1 "`}},
		{name: "leading_space_inside_quotes", headers: []string{`" ` + validTestVaultKeyID + `:1"`}},
		{name: "trailing_space_inside_quotes", headers: []string{`"` + validTestVaultKeyID + `:1 "`}},
		{name: "tab_inside_quotes", headers: []string{"\"\t" + validTestVaultKeyID + ":1\""}},
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

	// Các ký tự etagc hợp lệ theo RFC 9110 (%x21 / %x23-7E / %x80-FF, không gồm 0x20 và 0x22) vẫn được ParseStrongETag chấp nhận.
	if tag, ok := httpx.ParseStrongETag(`"etag:!#$%&'()*+,-./0123456789:;<=>?@AZ[\]^_` + "`" + `az{|}~"`); !ok || tag == "" {
		t.Fatalf("ParseStrongETag phải chấp nhận tập etagc RFC 9110 hợp lệ, got ok=%v tag=%q", ok, tag)
	}
	if _, ok := httpx.ParseStrongETag(`"a b"`); ok {
		t.Fatal(`ParseStrongETag("a b") phải từ chối khoảng trắng ASCII 0x20`)
	}

	invalid := []string{
		validTestVaultKeyID,                                              // thiếu :version
		validTestVaultKeyID + ":",                                        // thiếu version
		validTestVaultKeyID + ":0",                                       // version = 0
		validTestVaultKeyID + ":01",                                      // leading zero
		validTestVaultKeyID + ":-1",                                      // âm
		validTestVaultKeyID + ":abc",                                     // không phải số
		"vk:short:1",                                                     // sai độ dài vault_key_id
		"other:7f3a1c9e02b4d6f89012ab:1",                                 // sai prefix
		" " + validTestVaultKeyID + ":1",                                 // khoảng trắng đầu trên tag đã gỡ ngoặc
		validTestVaultKeyID + ":1 ",                                      // khoảng trắng cuối trên tag đã gỡ ngoặc
		" " + validTestVaultKeyID + ":1 ",                                // khoảng trắng hai đầu trên tag đã gỡ ngoặc
		`" ` + validTestVaultKeyID + `:1 "`,                              // khoảng trắng bên trong ngoặc kép
		"\t" + validTestVaultKeyID + ":1\t",                              // tab padding
		validTestVaultKeyID[:10] + " " + validTestVaultKeyID[11:] + ":1", // khoảng trắng giữa
	}
	for _, in := range invalid {
		if _, ok := httpx.ParseVaultIfMatch(in); ok {
			t.Errorf("ParseVaultIfMatch(%q) phải thất bại", in)
		}
	}

	// Kiểm cả ParseVaultIfMatchFromRequest (kể cả khi context bị gắn trực tiếp chuỗi có padding hoặc qua header):
	for _, badHeader := range []string{`" ` + validTestVaultKeyID + `:1 "`, `"a b"`} {
		req := httptest.NewRequest(http.MethodPut, "/vault/kek", nil)
		req.Header.Set("If-Match", badHeader)
		rec := httptest.NewRecorder()
		if _, ok := httpx.ParseVaultIfMatchFromRequest(rec, req); ok || rec.Code != http.StatusPreconditionRequired {
			t.Fatalf("ParseVaultIfMatchFromRequest(%q): ok=%v status=%d, muốn false và 428", badHeader, ok, rec.Code)
		}
	}
	reqPaddedCtx := httptest.NewRequest(http.MethodPut, "/vault/kek", nil)
	reqPaddedCtx = reqPaddedCtx.WithContext(httpx.WithIfMatch(reqPaddedCtx.Context(), " "+validTestVaultKeyID+":1 "))
	recPaddedCtx := httptest.NewRecorder()
	if _, ok := httpx.ParseVaultIfMatchFromRequest(recPaddedCtx, reqPaddedCtx); ok || recPaddedCtx.Code != http.StatusPreconditionRequired {
		t.Fatalf("ParseVaultIfMatchFromRequest với padded context tag: ok=%v status=%d, muốn false và 428", ok, recPaddedCtx.Code)
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

	// 5. Chứng minh LockAndVerifyVaultIfMatch thực sự giữ khóa hàng (SELECT ... FOR UPDATE):
	// Khi tx1 đang giữ lock sau khi LockAndVerifyVaultIfMatch thành công, một transaction thứ hai
	// chạy SELECT ... FOR UPDATE NOWAIT trên cùng hàng phải bị từ chối với lock_not_available (55P03).
	// Sau khi tx1 tăng version lên 4 và COMMIT, một request dùng validator cũ (:3) phải nhận 412 + current_version=4.
	lockAcquired := make(chan struct{})
	releaseLock := make(chan struct{})
	var releaseLockOnce sync.Once
	closeReleaseLock := func() { releaseLockOnce.Do(func() { close(releaseLock) }) }

	rLock := chi.NewRouter()
	rLock.Use(httpx.RequireIfMatch)
	rLock.Put("/api/v1/vault/kek", func(w http.ResponseWriter, r *http.Request) {
		tx, err := pool.Begin(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		v, ok := httpx.LockAndVerifyVaultIfMatch(r.Context(), w, r, gen.New(tx), userID)
		if !ok {
			return
		}
		close(lockAcquired)
		<-releaseLock
		updated, err := gen.New(tx).BumpVaultVersion(r.Context(), gen.BumpVaultVersionParams{
			UserID:          userID,
			ExpectedVersion: v.Version,
		})
		if err != nil {
			t.Error(err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"version": updated.Version})
	})

	reqLock1 := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqLock1.Header.Set("If-Match", `"`+validTestVaultKeyID+`:3"`)
	recLock1 := httptest.NewRecorder()
	lock1Done := make(chan struct{})
	go func() {
		defer close(lock1Done)
		rLock.ServeHTTP(recLock1, reqLock1)
	}()
	defer func() {
		closeReleaseLock()
		<-lock1Done
	}()

	select {
	case <-lockAcquired:
	case <-lock1Done:
		t.Fatalf("reqLock1 kết thúc sớm trước khi giữ lock: status=%d body=%s", recLock1.Code, recLock1.Body.String())
	case <-time.After(10 * time.Second):
		t.Fatal("timeout chờ LockAndVerifyVaultIfMatch giữ lock")
	}

	// Transaction thứ 2 thử khóa cùng hàng với FOR UPDATE NOWAIT -> phải lỗi 55P03 (lock_not_available).
	tx2, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()
	var dummyVer int32
	nowaitErr := tx2.QueryRow(ctx, `SELECT version FROM vault WHERE user_id = $1 FOR UPDATE NOWAIT`, userID).Scan(&dummyVer)
	var pgErr *pgconn.PgError
	if !errors.As(nowaitErr, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("FOR UPDATE NOWAIT khi LockAndVerifyVaultIfMatch đang giữ lock phải trả 55P03, got err=%v", nowaitErr)
	}
	_ = tx2.Rollback(ctx)

	// Giải phóng tx1 để nó commit version = 4.
	closeReleaseLock()
	<-lock1Done
	if recLock1.Code != http.StatusOK {
		t.Fatalf("reqLock1: status=%d body=%s, muốn 200", recLock1.Code, recLock1.Body.String())
	}

	// Gửi lại request với validator cũ (:3) sau khi tx1 đã commit version 4 -> 412 version_mismatch kèm current_version=4.
	reqStaleAfterCommit := httptest.NewRequest(http.MethodPut, "/api/v1/vault/kek", nil)
	reqStaleAfterCommit.Header.Set("If-Match", `"`+validTestVaultKeyID+`:3"`)
	recStaleAfterCommit := httptest.NewRecorder()
	h.ServeHTTP(recStaleAfterCommit, reqStaleAfterCommit)
	if recStaleAfterCommit.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale validator after commit: status=%d, muốn 412", recStaleAfterCommit.Code)
	}
	var bodyStale struct {
		httpx.Problem
		CurrentVersion int32 `json:"current_version"`
	}
	if err := json.Unmarshal(recStaleAfterCommit.Body.Bytes(), &bodyStale); err != nil {
		t.Fatal(err)
	}
	if bodyStale.Code != "version_mismatch" || bodyStale.CurrentVersion != 4 {
		t.Fatalf("stale validator after commit: code=%q current_version=%d, muốn version_mismatch và 4", bodyStale.Code, bodyStale.CurrentVersion)
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
	var seenDeleteBody []byte
	rP03 := chi.NewRouter()
	rP03.Use(httpx.RequireJSONContentExceptEmptyDelete)
	rP03.Delete("/api/v1/vault", func(w http.ResponseWriter, r *http.Request) {
		var err error
		seenDeleteBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read delete body: %v", err)
		}
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

	// 3. DELETE dạng streaming/chunked chỉ có terminal zero chunk (`0\r\n\r\n`), ContentLength == -1
	// và không có Content-Type -> body thực sự rỗng nên phải đi qua (204 No Content).
	rawEmptyChunked, err := http.ReadRequest(bufio.NewReader(strings.NewReader(
		"DELETE /api/v1/vault HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
	)))
	if err != nil {
		t.Fatalf("ReadRequest empty chunked DELETE: %v", err)
	}
	if rawEmptyChunked.ContentLength != -1 {
		t.Fatalf("expected ContentLength=-1 for chunked DELETE, got %d", rawEmptyChunked.ContentLength)
	}
	recEmptyChunked := httptest.NewRecorder()
	rP03.ServeHTTP(recEmptyChunked, rawEmptyChunked)
	if recEmptyChunked.Code != http.StatusNoContent {
		t.Fatalf("empty chunked DELETE without Content-Type: status=%d body=%s, muốn 204", recEmptyChunked.Code, recEmptyChunked.Body.String())
	}

	// 4. DELETE có body thực sự (cả chunked lẫn fixed-length) nhưng thiếu Content-Type -> phải bị 415.
	rawNonEmptyChunked, err := http.ReadRequest(bufio.NewReader(strings.NewReader(
		"DELETE /api/v1/vault HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
	)))
	if err != nil {
		t.Fatalf("ReadRequest non-empty chunked DELETE: %v", err)
	}
	recNonEmptyChunked := httptest.NewRecorder()
	rP03.ServeHTTP(recNonEmptyChunked, rawNonEmptyChunked)
	if recNonEmptyChunked.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-empty chunked DELETE without Content-Type: status=%d, muốn 415", recNonEmptyChunked.Code)
	}

	rawFixedBodyNoCT, err := http.ReadRequest(bufio.NewReader(strings.NewReader(
		"DELETE /api/v1/vault HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}",
	)))
	if err != nil {
		t.Fatalf("ReadRequest fixed-length DELETE: %v", err)
	}
	recFixedBodyNoCT := httptest.NewRecorder()
	rP03.ServeHTTP(recFixedBodyNoCT, rawFixedBodyNoCT)
	if recFixedBodyNoCT.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("fixed-length non-empty DELETE without Content-Type: status=%d, muốn 415", recFixedBodyNoCT.Code)
	}

	// 5. DELETE có body thực sự kèm Content-Type: application/json -> đi qua và giữ nguyên toàn bộ byte đã đọc.
	rawChunkedWithJSON, err := http.ReadRequest(bufio.NewReader(strings.NewReader(
		"DELETE /api/v1/vault HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
	)))
	if err != nil {
		t.Fatalf("ReadRequest chunked JSON DELETE: %v", err)
	}
	recChunkedWithJSON := httptest.NewRecorder()
	rP03.ServeHTTP(recChunkedWithJSON, rawChunkedWithJSON)
	if recChunkedWithJSON.Code != http.StatusNoContent || string(seenDeleteBody) != "{}" {
		t.Fatalf("chunked JSON DELETE: status=%d body=%q, muốn 204 và {}", recChunkedWithJSON.Code, string(seenDeleteBody))
	}

	reqPost := httptest.NewRequest(http.MethodPost, "/api/v1/vault", nil)
	recPost := httptest.NewRecorder()
	rP03.ServeHTTP(recPost, reqPost)
	if recPost.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("POST thiếu Content-Type qua RequireJSONContentExceptEmptyDelete: status = %d, muốn 415", recPost.Code)
	}
}
