package contenttest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

type failingBodyReader struct {
	prefix []byte
	offset int
}

func (r *failingBodyReader) Read(p []byte) (int, error) {
	if r.offset < len(r.prefix) {
		n := copy(p, r.prefix[r.offset:])
		r.offset += n
		return n, nil
	}
	return 0, errors.New("simulated read error mid-request")
}

type testItemRequest struct {
	ID   *uuid.UUID `json:"id,omitempty"`
	Name string     `json:"name"`
	Hint *string    `json:"hint,omitempty"`
}

type testItemResponse struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Version    int32     `json:"version"`
	EntryCount int32     `json:"entry_count"`
}

// newHarnessWithTestRoutes mounts test-only item/entry write handlers through the real
// `compose.Content` factory (`ChainItemTagWrite` and `ChainEntryWrite`) that insert/update
// real `item` rows via Task 2 sqlc queries under `LockUserContent`.
func newHarnessWithTestRoutes(
	t *testing.T,
	onLockHeld func(ctx context.Context, userID uuid.UUID),
	afterInsertTxHook func(ctx context.Context, userID uuid.UUID, tx pgx.Tx) error,
	lastEntryBody *[]byte,
	entryHandlerCalls *atomic.Int32,
) *contenttest.Harness {
	t.Helper()
	return contenttest.NewHarness(t, contenttest.HarnessOpts{
		ExtraMounts: []func(h *contenttest.Harness, v1 chi.Router, d httpx.Deps){
			func(h *contenttest.Harness, v1 chi.Router, d httpx.Deps) {
				// 1. POST /api/v1/__test/items (Item/Tag 16 KiB limit, S+C+I+R, no If-Match)
				v1.Method(http.MethodPost, "/__test/items", h.Content.ChainItemTagWrite(d, false, func(w http.ResponseWriter, r *http.Request) {
					p, ok := authctx.PrincipalFrom(r.Context())
					if !ok {
						httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
						return
					}
					var req testItemRequest
					if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
						httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Body không hợp lệ.")
						return
					}
					norm, err := textnorm.Normalize(req.Name)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusBadRequest, "name_invalid", "Tên mục không hợp lệ.")
						return
					}

					tx, err := httpx.BeginMutationTx(r.Context(), h.Pool)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
						return
					}
					defer func() { _ = tx.Rollback(r.Context()) }()

					q := gen.New(tx)
					if err := q.LockUserContent(r.Context(), p.UserID); err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi khoá nội dung.")
						return
					}
					if onLockHeld != nil {
						onLockHeld(r.Context(), p.UserID)
					}

					item, err := q.InsertItem(r.Context(), gen.InsertItemParams{
						ID:             req.ID,
						UserID:         p.UserID,
						Name:           strings.TrimSpace(req.Name),
						NameNormalized: norm,
						Hint:           req.Hint,
					})
					if err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không tạo được mục.")
						return
					}
					if afterInsertTxHook != nil {
						if hookErr := afterInsertTxHook(r.Context(), p.UserID, tx); hookErr != nil {
							if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, hookErr) {
								return
							}
							httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi hook kiểm thử.")
							return
						}
					}

					respBytes, err := json.Marshal(testItemResponse{
						ID:         item.ID,
						Name:       item.Name,
						Version:    item.Version,
						EntryCount: item.EntryCount,
					})
					if err != nil {
						t.Fatal(err)
					}
					if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, respBytes); err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không commit được.")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Cache-Control", "no-store")
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write(respBytes)
				}))
				// 2. PATCH /api/v1/__test/items/{id} (Item/Tag 16 KiB limit, S+C+I+R+M with version If-Match)
				v1.Method(http.MethodPatch, "/__test/items/{id}", h.Content.ChainItemTagWrite(d, true, func(w http.ResponseWriter, r *http.Request) {
					p, ok := authctx.PrincipalFrom(r.Context())
					if !ok {
						httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
						return
					}
					expectedVer, ok := httpx.ParseVersionIfMatchFromRequest(w, r)
					if !ok {
						return
					}
					itemID, err := uuid.Parse(chi.URLParam(r, "id"))
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy mục.")
						return
					}
					var req testItemRequest
					if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
						httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Body không hợp lệ.")
						return
					}
					norm, err := textnorm.Normalize(req.Name)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusBadRequest, "name_invalid", "Tên mục không hợp lệ.")
						return
					}

					tx, err := httpx.BeginMutationTx(r.Context(), h.Pool)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
						return
					}
					defer func() { _ = tx.Rollback(r.Context()) }()

					q := gen.New(tx)
					if err := q.LockUserContent(r.Context(), p.UserID); err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi khoá nội dung.")
						return
					}
					locked, err := q.LockItemForUpdate(r.Context(), gen.LockItemForUpdateParams{
						UserID: p.UserID,
						ID:     itemID,
					})
					if err != nil || locked.DeletedAt.Valid {
						httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy mục.")
						return
					}
					if locked.Version != expectedVer {
						httpx.WriteVersionMismatch(w, r, locked.Version)
						return
					}
					updated, err := q.UpdateItemNameAndHint(r.Context(), gen.UpdateItemNameAndHintParams{
						Name:            strings.TrimSpace(req.Name),
						NameNormalized:  norm,
						Hint:            req.Hint,
						UserID:          p.UserID,
						ID:              itemID,
						ExpectedVersion: expectedVer,
					})
					if err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không cập nhật được mục.")
						return
					}
					respBytes, err := json.Marshal(testItemResponse{
						ID:         updated.ID,
						Name:       updated.Name,
						Version:    updated.Version,
						EntryCount: updated.EntryCount,
					})
					if err != nil {
						t.Fatal(err)
					}
					if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, respBytes); err != nil {
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không commit được.")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Cache-Control", "no-store")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(respBytes)
				}))

				// 3. POST /api/v1/__test/items/{id}/entries (Entry 400 KiB limit, S+C+I+R)
				v1.Method(http.MethodPost, "/__test/items/{id}/entries", h.Content.ChainEntryWrite(d, false, func(w http.ResponseWriter, r *http.Request) {
					if entryHandlerCalls != nil {
						entryHandlerCalls.Add(1)
					}
					p, ok := authctx.PrincipalFrom(r.Context())
					if !ok {
						httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
						return
					}
					bodyBytes, err := io.ReadAll(r.Body)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
						return
					}
					if lastEntryBody != nil {
						*lastEntryBody = append((*lastEntryBody)[:0], bodyBytes...)
					}

					itemID, err := uuid.Parse(chi.URLParam(r, "id"))
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy mục.")
						return
					}

					tx, err := httpx.BeginMutationTx(r.Context(), h.Pool)
					if err != nil {
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
						return
					}
					defer func() { _ = tx.Rollback(r.Context()) }()

					q := gen.New(tx)
					if err := q.LockUserContent(r.Context(), p.UserID); err != nil {
						if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, err) {
							return
						}
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi khoá nội dung.")
						return
					}

					// Insert an item row if not yet present so we exercise Task 2 queries and AssertInvariants.
					_, err = q.GetLiveItemByUserAndID(r.Context(), gen.GetLiveItemByUserAndIDParams{
						UserID: p.UserID,
						ID:     itemID,
					})
					if err != nil {
						if _, insErr := q.InsertItem(r.Context(), gen.InsertItemParams{
							ID:             &itemID,
							UserID:         p.UserID,
							Name:           "entry-host",
							NameNormalized: "entry-host",
						}); insErr != nil {
							if httpx.WriteContentTxError(r.Context(), w, r, h.Pool, tx, insErr) {
								return
							}
							httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không tạo được mục.")
							return
						}
					}

					respBytes := []byte(`{"item_id":"` + itemID.String() + `","received_bytes":` + strconv.Itoa(len(bodyBytes)) + `}`)
					if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, respBytes); err != nil {
						httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Không commit được.")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Cache-Control", "no-store")
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write(respBytes)
				}))
			},
		},
	})
}

// TestContentRateLimit11thBlockedRetrySameKeyReplayConflictsAnd24hReclaim covers Task 3b bullets:
// - 11 writes within 1 second -> 11th is 429 + Retry-After;
// - retry with the same key after Retry-After creates exactly one row;
// - a replay is not counted toward rate limit;
// - same key different body -> 409 idempotency_conflict;
// - same key to another item path -> 409 idempotency_conflict;
// - an idempotency row older than 24 h is reclaimed (fake clock).
func TestContentRateLimit11thBlockedRetrySameKeyReplayConflictsAnd24hReclaim(t *testing.T) {
	var entryCalls atomic.Int32
	h := newHarnessWithTestRoutes(t, nil, nil, nil, &entryCalls)
	ctx := context.Background()
	jarA, meA, jarB, meB := h.SignupTwoUsers()

	// 1. Send 10 distinct writes within 1 second -> all 10 succeed (201).
	for i := 1; i <= 10; i++ {
		key := "idem_rate_write_00" + strconv.Itoa(10+i)
		body := `{"name":"Item ` + strconv.Itoa(i) + `"}`
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", body, contenttest.ReqOptions{
			IdemKey: key,
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("write %d: status=%d body=%s", i, resp.StatusCode, raw)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 2. Replay one of the committed writes while quota is exhausted (10/10 used in current 1s window):
	// Replay happens at step 2 (Lookup) BEFORE step 4 (RateLimit), so it succeeds (201) and is NOT counted.
	var rateEventsBeforeReplay int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1 AND scope = $2`, meA.User.ID, httpx.ScopeContentWrite).Scan(&rateEventsBeforeReplay); err != nil {
		t.Fatal(err)
	}
	respReplay, rawReplay := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", `{"name":"Item 1"}`, contenttest.ReqOptions{
		IdemKey: "idem_rate_write_0011",
	})
	if respReplay.StatusCode != http.StatusCreated {
		t.Fatalf("replay at exhausted quota: status=%d body=%s, want 201", respReplay.StatusCode, rawReplay)
	}
	var rateEventsAfterReplay int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1 AND scope = $2`, meA.User.ID, httpx.ScopeContentWrite).Scan(&rateEventsAfterReplay); err != nil {
		t.Fatal(err)
	}
	if rateEventsAfterReplay != rateEventsBeforeReplay {
		t.Fatalf("replay must not record rate_event: before=%d after=%d", rateEventsBeforeReplay, rateEventsAfterReplay)
	}

	// 3. 11th new write within the same 1 second -> 429 rate_limited + Retry-After, no claim and no item row created.
	key11 := "idem_rate_write_0021"
	body11 := `{"name":"Item Eleven"}`
	resp11, raw11 := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", body11, contenttest.ReqOptions{
		IdemKey: key11,
	})
	if resp11.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("11th write in 1s: status=%d body=%s, want 429", resp11.StatusCode, raw11)
	}
	retryHdr := resp11.Header.Get("Retry-After")
	retrySec, err := strconv.Atoi(retryHdr)
	if err != nil || retrySec < 1 {
		t.Fatalf("11th write Retry-After header = %q, want integer >= 1", retryHdr)
	}
	prob11 := contenttest.DecodeProblem(t, raw11)
	if prob11.Code != "rate_limited" || prob11.RetryAfter == nil || *prob11.RetryAfter != retrySec {
		t.Fatalf("11th write problem = %+v", prob11)
	}

	var idemCount11 int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, key11).Scan(&idemCount11); err != nil {
		t.Fatal(err)
	}
	if idemCount11 != 0 {
		t.Fatalf("429 before Claim must not create idempotency_key row, got %d", idemCount11)
	}

	// 4. Advance clock past Retry-After and retry with the exact same Idempotency-Key -> creates exactly 1 row.
	h.Clock.Advance(time.Duration(retrySec)*time.Second + 10*time.Millisecond)
	resp11Retry, raw11Retry := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", body11, contenttest.ReqOptions{
		IdemKey: key11,
	})
	if resp11Retry.StatusCode != http.StatusCreated {
		t.Fatalf("retry 11th write after Retry-After: status=%d body=%s, want 201", resp11Retry.StatusCode, raw11Retry)
	}
	// Replay once more with the same key -> returns identical response, still 1 row for "Item Eleven".
	resp11Replay, raw11Replay := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", body11, contenttest.ReqOptions{
		IdemKey: key11,
	})
	if resp11Replay.StatusCode != http.StatusCreated || raw11Replay != raw11Retry {
		t.Fatalf("replay of 11th write: status=%d body=%s, want %s", resp11Replay.StatusCode, raw11Replay, raw11Retry)
	}
	var itemElevenCount int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1 AND name = 'Item Eleven'`, meA.User.ID).Scan(&itemElevenCount); err != nil {
		t.Fatal(err)
	}
	if itemElevenCount != 1 {
		t.Fatalf("Item Eleven row count = %d, want 1", itemElevenCount)
	}

	// 5. Same key, different body -> 409 idempotency_conflict.
	respConflictBody, rawConflictBody := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", `{"name":"Different Body"}`, contenttest.ReqOptions{
		IdemKey: key11,
	})
	if respConflictBody.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawConflictBody).Code != "idempotency_conflict" {
		t.Fatalf("same key different body: status=%d body=%s, want 409 idempotency_conflict", respConflictBody.StatusCode, rawConflictBody)
	}

	// 6. Same key sent to another item path -> 409 idempotency_conflict.
	itemA := uuid.New()
	itemB := uuid.New()
	keyPath := "idem_item_path_conflict1"
	entryPayload := `{"type":"text"}`
	pathA := "/api/v1/__test/items/" + itemA.String() + "/entries"
	pathB := "/api/v1/__test/items/" + itemB.String() + "/entries"
	respPathA, rawPathA := h.DoReq(jarA, http.MethodPost, pathA, entryPayload, contenttest.ReqOptions{
		IdemKey: keyPath,
	})
	if respPathA.StatusCode != http.StatusCreated {
		t.Fatalf("POST itemA entries: status=%d body=%s", respPathA.StatusCode, rawPathA)
	}
	var origClaimedAt, origExpiresAt time.Time
	if err := h.Pool.QueryRow(ctx, `SELECT claimed_at, expires_at FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, keyPath).Scan(&origClaimedAt, &origExpiresAt); err != nil {
		t.Fatal(err)
	}
	respPathB, rawPathB := h.DoReq(jarA, http.MethodPost, pathB, entryPayload, contenttest.ReqOptions{
		IdemKey: keyPath,
	})
	if respPathB.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawPathB).Code != "idempotency_conflict" {
		t.Fatalf("same key on itemB path: status=%d body=%s, want 409 idempotency_conflict", respPathB.StatusCode, rawPathB)
	}

	// 7. Idempotency row older than 24 h is reclaimed (fake clock).
	// Access JWT has a 10m TTL while SessionTTL is 30d: after advancing 24h+1s, refresh the same
	// authenticated session through the real /api/v1/auth/refresh endpoint before sending the reclaim request.
	h.Clock.Advance(24*time.Hour + time.Second)
	h.RefreshSession(jarA)

	callsBeforeReclaim := entryCalls.Load()
	respReclaim, rawReclaim := h.DoReq(jarA, http.MethodPost, pathB, entryPayload, contenttest.ReqOptions{
		IdemKey: keyPath,
	})
	if respReclaim.StatusCode != http.StatusCreated {
		t.Fatalf("reclaim after 24h: status=%d body=%s, want 201", respReclaim.StatusCode, rawReclaim)
	}
	if !strings.Contains(rawReclaim, itemB.String()) {
		t.Fatalf("reclaimed response = %s, want itemB %s", rawReclaim, itemB)
	}
	if gotCalls := entryCalls.Load() - callsBeforeReclaim; gotCalls != 1 {
		t.Fatalf("entry handler calls on reclaim = %d, want 1", gotCalls)
	}

	// Assert the expired idempotency_key row was replaced with itemB's concrete path, fingerprint, and new expires_at.
	var newPath, newStatus string
	var newHash []byte
	var newClaimedAt, newExpiresAt time.Time
	if err := h.Pool.QueryRow(ctx, `SELECT path, request_hash, status, claimed_at, expires_at FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, keyPath).Scan(&newPath, &newHash, &newStatus, &newClaimedAt, &newExpiresAt); err != nil {
		t.Fatal(err)
	}
	wantPathBHash := httpx.ComputeIdempotencyFingerprint(http.MethodPost, pathB, []byte(entryPayload))
	if newPath != pathB || newStatus != "done" || !bytes.Equal(newHash, wantPathBHash) {
		t.Fatalf("reclaimed idempotency row: path=%q status=%q hash=%x, want path=%q status=\"done\" hash=%x", newPath, newStatus, newHash, pathB, wantPathBHash)
	}
	if !newClaimedAt.After(origExpiresAt) || !newExpiresAt.After(origExpiresAt.Add(24*time.Hour)) {
		t.Fatalf("reclaimed timestamps: claimed_at=%v expires_at=%v, orig expires_at=%v", newClaimedAt, newExpiresAt, origExpiresAt)
	}

	var itemBCount int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1 AND id = $2`, meA.User.ID, itemB).Scan(&itemBCount); err != nil {
		t.Fatal(err)
	}
	if itemBCount != 1 {
		t.Fatalf("itemB row count = %d, want 1", itemBCount)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
	_ = jarB
}

// TestContentIfMatchMissingWildcardWeakListLeadingZeroRejectedWith428 covers Task 3b bullet:
// If-Match missing / * / weak / W/"1" / list / "01" -> 428 precondition_required through the real chain.
func TestContentIfMatchMissingWildcardWeakListLeadingZeroRejectedWith428(t *testing.T) {
	h := newHarnessWithTestRoutes(t, nil, nil, nil, nil)
	jarA, meA := h.SignupUser("ifmatch-user@example.com", "correct-horse-battery-staple")

	respCreate, rawCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", `{"name":"Initial Name"}`, contenttest.ReqOptions{
		IdemKey: "idem_ifmatch_create_01",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create item: status=%d body=%s", respCreate.StatusCode, rawCreate)
	}
	var created testItemResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	badIfMatches := []string{
		"",
		"*",
		`W/"1"`,
		`w/"1"`,
		`"1", "2"`,
		`"01"`,
		`"0"`,
		`"-1"`,
		`"abc"`,
	}
	for i, ifm := range badIfMatches {
		key := "idem_ifmatch_bad_00" + strconv.Itoa(10+i)
		resp, raw := h.DoReq(jarA, http.MethodPatch, "/api/v1/__test/items/"+created.ID.String(), `{"name":"Updated Name"}`, contenttest.ReqOptions{
			IdemKey: key,
			IfMatch: ifm,
		})
		if resp.StatusCode != http.StatusPreconditionRequired {
			t.Fatalf("If-Match=%q: status=%d body=%s, want 428", ifm, resp.StatusCode, raw)
		}
		if prob := contenttest.DecodeProblem(t, raw); prob.Code != "precondition_required" {
			t.Fatalf("If-Match=%q: code=%q, want precondition_required", ifm, prob.Code)
		}
	}

	// The 1 initial POST + 9 invalid PATCHes above all pass through RateLimit (step 4, before RequireVersionIfMatch at step 5),
	// consuming all 10/10 events in the current 1-second window. Advance the fake clock past the 1s window before the valid control.
	h.Clock.Advance(time.Second + 10*time.Millisecond)

	// Valid If-Match "1" succeeds and increments version to 2.
	respOK, rawOK := h.DoReq(jarA, http.MethodPatch, "/api/v1/__test/items/"+created.ID.String(), `{"name":"Updated Name"}`, contenttest.ReqOptions{
		IdemKey: "idem_ifmatch_valid_001",
		IfMatch: `"1"`,
	})
	if respOK.StatusCode != http.StatusOK {
		t.Fatalf("valid If-Match \"1\": status=%d body=%s, want 200", respOK.StatusCode, rawOK)
	}
	var updated testItemResponse
	if err := json.Unmarshal([]byte(rawOK), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.Name != "Updated Name" {
		t.Fatalf("updated = %+v, want Version=2 Name=\"Updated Name\"", updated)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestContentBodyLimitsEntryItemAndP03VaultThroughRealChain covers Task 3b bullet:
//   - Entry route body 400 KiB + 1 and 512 KiB + 1 through the real chain, both with Content-Length and chunked
//     with unknown length -> 413 entry_too_large before claim, nothing written (no idempotency row, no content row);
//   - body exactly at the limit reaches the handler intact (fingerprint matches; replay works);
//   - read error midway -> 400 invalid_request;
//   - item route 16 KiB + 1 -> 413 invalid_request;
//   - a P03 vault route still answers 413 invalid_request as before.
func TestContentBodyLimitsEntryItemAndP03VaultThroughRealChain(t *testing.T) {
	var lastEntryBody []byte
	var entryCalls atomic.Int32
	h := newHarnessWithTestRoutes(t, nil, nil, &lastEntryBody, &entryCalls)
	ctx := context.Background()
	jarA, meA := h.SignupUser("limits-user@example.com", "correct-horse-battery-staple")

	countIdem := func(key string) int {
		var n int
		if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, key).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	countItems := func() int {
		var n int
		if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1`, meA.User.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	targetItemID := uuid.New()
	entryPath := "/api/v1/__test/items/" + targetItemID.String() + "/entries"

	// 1. Entry route: 400 KiB + 1 and 512 KiB + 1, both with Content-Length and chunked -> 413 entry_too_large, nothing written.
	for idx, sz := range []int{int(httpx.ContentEntryJSONLimit) + 1, httpx.IdempotencyMaxBodyBytes + 1} {
		oversized := `{"pad":"` + strings.Repeat("a", sz-10) + `"}`
		if len(oversized) != sz {
			t.Fatalf("constructed len = %d, want %d", len(oversized), sz)
		}
		for _, chunked := range []bool{false, true} {
			mode := "cl"
			if chunked {
				mode = "chunked"
			}
			key := "idem_entry_over_" + mode + "_" + strconv.Itoa(idx)
			resp, raw := h.DoReq(jarA, http.MethodPost, entryPath, oversized, contenttest.ReqOptions{
				IdemKey: key,
				Chunked: chunked,
			})
			if resp.StatusCode != http.StatusRequestEntityTooLarge {
				t.Fatalf("size=%d chunked=%v: status=%d body=%s, want 413", sz, chunked, resp.StatusCode, raw)
			}
			if prob := contenttest.DecodeProblem(t, raw); prob.Code != "entry_too_large" {
				t.Fatalf("size=%d chunked=%v: code=%q, want entry_too_large", sz, chunked, prob.Code)
			}
			if countIdem(key) != 0 || countItems() != 0 || entryCalls.Load() != 0 {
				t.Fatalf("size=%d chunked=%v: nothing must be written (idem=%d items=%d calls=%d)",
					sz, chunked, countIdem(key), countItems(), entryCalls.Load())
			}
		}
	}

	// 2. Entry route: body at exact 400 KiB limit reaches handler intact, fingerprint matches, and replay works.
	exactSize := int(httpx.ContentEntryJSONLimit)
	exactBody := `{"pad":"` + strings.Repeat("b", exactSize-10) + `"}`
	if len(exactBody) != exactSize {
		t.Fatalf("exactBody len = %d, want %d", len(exactBody), exactSize)
	}
	keyExact := "idem_entry_exact_400k_1"
	respExact, rawExact := h.DoReq(jarA, http.MethodPost, entryPath, exactBody, contenttest.ReqOptions{
		IdemKey: keyExact,
		Chunked: true,
	})
	if respExact.StatusCode != http.StatusCreated {
		t.Fatalf("exact 400 KiB: status=%d body=%s, want 201", respExact.StatusCode, rawExact)
	}
	if !bytes.Equal(lastEntryBody, []byte(exactBody)) {
		t.Fatalf("exact 400 KiB: handler received %d bytes, want exact %d bytes", len(lastEntryBody), len(exactBody))
	}
	var savedHash []byte
	if err := h.Pool.QueryRow(ctx, `SELECT request_hash FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, keyExact).Scan(&savedHash); err != nil {
		t.Fatal(err)
	}
	wantHash := httpx.ComputeIdempotencyFingerprint(http.MethodPost, entryPath, []byte(exactBody))
	if !bytes.Equal(savedHash, wantHash) {
		t.Fatalf("saved fingerprint mismatch: got %x want %x", savedHash, wantHash)
	}

	callsBeforeReplay := entryCalls.Load()
	respReplay, rawReplay := h.DoReq(jarA, http.MethodPost, entryPath, exactBody, contenttest.ReqOptions{
		IdemKey: keyExact,
	})
	if respReplay.StatusCode != http.StatusCreated || rawReplay != rawExact || entryCalls.Load() != callsBeforeReplay {
		t.Fatalf("replay exact 400 KiB: status=%d calls=%d (before=%d)", respReplay.StatusCode, entryCalls.Load(), callsBeforeReplay)
	}

	// 3. Read error midway -> 400 invalid_request (tested directly on the router handler so mid-stream error is delivered to middleware).
	keyMidway := "idem_entry_midway_err_1"
	reqMidway, err := http.NewRequest(http.MethodPost, h.Server.URL+entryPath, &failingBodyReader{prefix: []byte(`{"broken":`)})
	if err != nil {
		t.Fatal(err)
	}
	reqMidway.ContentLength = -1
	reqMidway.Header.Set("Origin", h.Origin)
	reqMidway.Header.Set("Content-Type", "application/json")
	jarA.Apply(reqMidway)
	reqMidway.Header.Set("X-CSRF-Token", jarA["sabk_csrf"].Value)
	reqMidway.Header.Set(httpx.HeaderIdempotencyKey, keyMidway)
	// Invoke server handler via httptest.ResponseRecorder to deterministically inject io.Reader error midway.
	recMidway := httptest.NewRecorder()
	reqMidway.RequestURI = entryPath
	h.Server.Config.Handler.ServeHTTP(recMidway, reqMidway)
	if recMidway.Code != http.StatusBadRequest || contenttest.DecodeProblem(t, recMidway.Body.String()).Code != "invalid_request" {
		t.Fatalf("read error midway: status=%d body=%s, want 400 invalid_request", recMidway.Code, recMidway.Body.String())
	}
	if countIdem(keyMidway) != 0 {
		t.Fatal("read error midway must not create idempotency row")
	}

	// 4. Item route 16 KiB + 1 -> 413 invalid_request, both with Content-Length and chunked.
	itemOverSize := int(httpx.ContentItemTagJSONLimit) + 1
	itemOverBody := `{"name":"` + strings.Repeat("c", itemOverSize-11) + `"}`
	for _, chunked := range []bool{false, true} {
		mode := "cl"
		if chunked {
			mode = "chunked"
		}
		keyItem := "idem_item_16k_over_" + mode
		respItem, rawItem := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", itemOverBody, contenttest.ReqOptions{
			IdemKey: keyItem,
			Chunked: chunked,
		})
		if respItem.StatusCode != http.StatusRequestEntityTooLarge || contenttest.DecodeProblem(t, rawItem).Code != "invalid_request" {
			t.Fatalf("item 16 KiB+1 (chunked=%v): status=%d body=%s, want 413 invalid_request", chunked, respItem.StatusCode, rawItem)
		}
		if countIdem(keyItem) != 0 {
			t.Fatalf("item 16 KiB+1 (chunked=%v) must not create idempotency row", chunked)
		}
	}

	// 5. P03 vault route (`POST /api/v1/vault`) still answers 413 invalid_request as before (both > 64 KiB at handler and > 512 KiB at Lookup).
	for _, vaultSz := range []int{64*1024 + 1, httpx.IdempotencyMaxBodyBytes + 1} {
		vaultOverBody := `{"kdf":"` + strings.Repeat("v", vaultSz-10) + `"}`
		keyVault := "idem_vault_over_" + strconv.Itoa(vaultSz)
		respVault, rawVault := h.DoReq(jarA, http.MethodPost, "/api/v1/vault", vaultOverBody, contenttest.ReqOptions{
			IdemKey: keyVault,
		})
		if respVault.StatusCode != http.StatusRequestEntityTooLarge || contenttest.DecodeProblem(t, rawVault).Code != "invalid_request" {
			t.Fatalf("vault route size=%d: status=%d body=%s, want 413 invalid_request", vaultSz, respVault.StatusCode, rawVault)
		}
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestContentLockUserContentSameUserSerialDifferentUsersParallelAndDeadlock503Retry covers Task 3b bullets:
//   - Two content transactions of the same user run serially (barrier: the second waits on LockUserContent;
//     observed via pg_locks and channel barrier);
//   - different users run in parallel;
//   - real backend deadlock (40P01) across two concurrent transactions locking two rows in opposite order ->
//     the aborted transaction returns 503 dependency_unavailable + Retry-After: 1 with its in-transaction
//     InsertItem rolled back and its idempotency claim released; retry with the same key runs once and replay
//     returns the stored response, leaving exactly one committed row per key.
func TestContentLockUserContentSameUserSerialDifferentUsersParallelAndDeadlock503Retry(t *testing.T) {
	userAEntered := make(chan struct{}, 4)
	releaseUserA := make(chan struct{}, 4)
	cancelUserABarrier := make(chan struct{})
	var closeUserAOnce sync.Once
	closeUserABarrier := func() { closeUserAOnce.Do(func() { close(cancelUserABarrier) }) }

	userBEntered := make(chan struct{}, 2)
	cancelUserBBarrier := make(chan struct{})
	var closeUserBOnce sync.Once
	closeUserBBarrier := func() { closeUserBOnce.Do(func() { close(cancelUserBBarrier) }) }

	dlStep1Done := make(chan struct{}, 2)
	dlProceedStep2 := make(chan struct{})
	var closeDLOnce sync.Once
	closeDLBarrier := func() { closeDLOnce.Do(func() { close(dlProceedStep2) }) }

	var userATarget uuid.UUID
	var userBTarget uuid.UUID
	var serialBarrierActive atomic.Bool
	var deadlockBarrierActive atomic.Bool
	var dlLockItem1 uuid.UUID
	var dlLockItem2 uuid.UUID

	h := newHarnessWithTestRoutes(
		t,
		func(reqCtx context.Context, uid uuid.UUID) {
			if !serialBarrierActive.Load() {
				return
			}
			switch uid {
			case userATarget:
				userAEntered <- struct{}{}
				select {
				case <-releaseUserA:
				case <-cancelUserABarrier:
				case <-reqCtx.Done():
				}
			case userBTarget:
				userBEntered <- struct{}{}
				select {
				case <-cancelUserBBarrier:
				case <-reqCtx.Done():
				}
			}
		},
		func(reqCtx context.Context, uid uuid.UUID, tx pgx.Tx) error {
			if !deadlockBarrierActive.Load() {
				return nil
			}
			// Deterministic two-transaction Postgres 40P01 deadlock after InsertItem has already executed in tx:
			// - User A locks dlLockItem1 FOR UPDATE, signals step 1, waits for both txs to hold step-1 locks, then locks dlLockItem2 FOR UPDATE.
			// - User B locks dlLockItem2 FOR UPDATE, signals step 1, waits for both txs to hold step-1 locks, then locks dlLockItem1 FOR UPDATE.
			firstID, secondID := dlLockItem1, dlLockItem2
			if uid == userBTarget {
				firstID, secondID = dlLockItem2, dlLockItem1
			}
			if _, err := tx.Exec(reqCtx, `SELECT 1 FROM item WHERE id = $1 FOR UPDATE`, firstID); err != nil {
				return err
			}
			dlStep1Done <- struct{}{}
			select {
			case <-dlProceedStep2:
			case <-reqCtx.Done():
				return reqCtx.Err()
			}
			_, err := tx.Exec(reqCtx, `SELECT 1 FROM item WHERE id = $1 FOR UPDATE`, secondID)
			return err
		},
		nil,
		nil,
	)

	// Register barrier release/cancel AFTER NewHarness (so LIFO t.Cleanup runs this BEFORE h.Server.Close)
	// and BEFORE launching any goroutines/requests.
	t.Cleanup(func() {
		serialBarrierActive.Store(false)
		deadlockBarrierActive.Store(false)
		closeUserABarrier()
		closeUserBBarrier()
		closeDLBarrier()
	})

	ctx := context.Background()
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	userATarget = meA.User.ID
	userBTarget = meB.User.ID

	// Part 1: Same user runs serially, different user runs in parallel while User A holds LockUserContent.
	serialBarrierActive.Store(true)

	type reqResult struct {
		resp contenttest.TestResponse
		raw  string
	}
	doneA1 := make(chan reqResult, 1)
	doneA2 := make(chan reqResult, 1)
	doneB1 := make(chan reqResult, 1)

	// Start User A tx 1 -> acquires LockUserContent(A) and waits on releaseUserA.
	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", `{"name":"A Serial 1"}`, contenttest.ReqOptions{
			IdemKey: "idem_serial_user_a_tx01",
		})
		doneA1 <- reqResult{resp: resp, raw: raw}
	}()

	select {
	case <-userAEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for User A tx 1 to acquire LockUserContent")
	}

	// Start User A tx 2 -> must block on pg_advisory_xact_lock BEFORE entering userAEntered.
	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", `{"name":"A Serial 2"}`, contenttest.ReqOptions{
			IdemKey: "idem_serial_user_a_tx02",
		})
		doneA2 <- reqResult{resp: resp, raw: raw}
	}()

	// Wait until Postgres pg_locks shows an ungranted advisory lock waiter for hashtext('engram.content').
	deadline := time.Now().Add(10 * time.Second)
	sawWaitingAdvisoryLock := false
	for time.Now().Before(deadline) {
		var waiting int
		err := h.Pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_locks
			WHERE locktype = 'advisory'
			  AND classid = hashtext('engram.content')
			  AND objid = hashtext(($1::uuid)::text)
			  AND NOT granted
		`, meA.User.ID).Scan(&waiting)
		if err == nil && waiting == 1 {
			sawWaitingAdvisoryLock = true
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !sawWaitingAdvisoryLock {
		t.Fatal("expected User A tx 2 to wait on ungranted advisory lock in pg_locks")
	}

	// Confirm User A tx 2 has NOT entered the critical section while tx 1 holds the lock.
	select {
	case <-userAEntered:
		t.Fatal("User A tx 2 entered critical section while User A tx 1 still held LockUserContent")
	default:
	}

	// Meanwhile, User B sends a write -> acquires LockUserContent(B) in parallel without waiting for User A!
	go func() {
		resp, raw := h.DoReq(jarB, http.MethodPost, "/api/v1/__test/items", `{"name":"B Parallel 1"}`, contenttest.ReqOptions{
			IdemKey: "idem_parallel_user_b_01",
		})
		doneB1 <- reqResult{resp: resp, raw: raw}
	}()

	select {
	case <-userBEntered:
		// User B entered while User A tx 1 is still holding LockUserContent(A) and tx 2 is waiting!
	case <-time.After(10 * time.Second):
		t.Fatal("User B transaction was blocked by User A LockUserContent")
	}
	closeUserBBarrier()

	var resB1 reqResult
	select {
	case resB1 = <-doneB1:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for User B tx 1 response")
	}

	// Now release User A tx 1 -> User A tx 2 must enter next, then complete.
	releaseUserA <- struct{}{}
	var resA1 reqResult
	select {
	case resA1 = <-doneA1:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for User A tx 1 response")
	}

	select {
	case <-userAEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for User A tx 2 to acquire LockUserContent after tx 1 released")
	}
	releaseUserA <- struct{}{}
	var resA2 reqResult
	select {
	case resA2 = <-doneA2:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for User A tx 2 response")
	}
	serialBarrierActive.Store(false)

	if resA1.resp.StatusCode != http.StatusCreated || resA2.resp.StatusCode != http.StatusCreated || resB1.resp.StatusCode != http.StatusCreated {
		t.Fatalf("statuses: A1=%d (%s) A2=%d (%s) B1=%d (%s), want all 201",
			resA1.resp.StatusCode, resA1.raw, resA2.resp.StatusCode, resA2.raw, resB1.resp.StatusCode, resB1.raw)
	}

	var itemA1 testItemResponse
	if err := json.Unmarshal([]byte(resA1.raw), &itemA1); err != nil {
		t.Fatal(err)
	}
	var itemB1 testItemResponse
	if err := json.Unmarshal([]byte(resB1.raw), &itemB1); err != nil {
		t.Fatal(err)
	}

	// Part 2: Real backend deadlock (SQLSTATE 40P01) through the real middleware + handler + Postgres chain.
	// Two concurrent requests (User A and User B) each insert a new item row inside their mutation transaction
	// and then lock (itemA1, itemB1) in opposite order after barrier synchronization.
	// Postgres detects the cycle and raises 40P01 on one transaction while the other succeeds (201).
	dlLockItem1 = itemA1.ID
	dlLockItem2 = itemB1.ID
	deadlockBarrierActive.Store(true)

	keyDLA := "idem_deadlock_real_a_001"
	bodyDLA := `{"name":"Deadlock Real A"}`
	keyDLB := "idem_deadlock_real_b_001"
	bodyDLB := `{"name":"Deadlock Real B"}`

	doneDLA := make(chan reqResult, 1)
	doneDLB := make(chan reqResult, 1)

	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__test/items", bodyDLA, contenttest.ReqOptions{
			IdemKey: keyDLA,
		})
		doneDLA <- reqResult{resp: resp, raw: raw}
	}()
	go func() {
		resp, raw := h.DoReq(jarB, http.MethodPost, "/api/v1/__test/items", bodyDLB, contenttest.ReqOptions{
			IdemKey: keyDLB,
		})
		doneDLB <- reqResult{resp: resp, raw: raw}
	}()

	// Wait for both transactions to acquire their first FOR UPDATE lock, then release both to request the opposite lock.
	for step := 1; step <= 2; step++ {
		select {
		case <-dlStep1Done:
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for deadlock participant %d to acquire first lock", step)
		}
	}
	closeDLBarrier()

	var resDLA, resDLB reqResult
	select {
	case resDLA = <-doneDLA:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for User A deadlock request to finish")
	}
	select {
	case resDLB = <-doneDLB:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for User B deadlock request to finish")
	}
	deadlockBarrierActive.Store(false)

	// Exactly one transaction must be aborted by Postgres with 40P01 -> 503 + Retry-After: 1,
	// and the other transaction must commit with 201 Created.
	var victimJar contenttest.CookieJar
	var victimUserID uuid.UUID
	var victimKey, victimBody, victimItemName string
	var victimRes, winnerRes reqResult
	var winnerUserID uuid.UUID
	var winnerKey, winnerItemName string

	switch {
	case resDLA.resp.StatusCode == http.StatusServiceUnavailable && resDLB.resp.StatusCode == http.StatusCreated:
		victimJar, victimUserID, victimKey, victimBody, victimItemName, victimRes = jarA, meA.User.ID, keyDLA, bodyDLA, "Deadlock Real A", resDLA
		winnerUserID, winnerKey, winnerItemName, winnerRes = meB.User.ID, keyDLB, "Deadlock Real B", resDLB
	case resDLB.resp.StatusCode == http.StatusServiceUnavailable && resDLA.resp.StatusCode == http.StatusCreated:
		victimJar, victimUserID, victimKey, victimBody, victimItemName, victimRes = jarB, meB.User.ID, keyDLB, bodyDLB, "Deadlock Real B", resDLB
		winnerUserID, winnerKey, winnerItemName, winnerRes = meA.User.ID, keyDLA, "Deadlock Real A", resDLA
	default:
		t.Fatalf("expected one 503 and one 201 from real deadlock, got A=%d (%s) B=%d (%s)",
			resDLA.resp.StatusCode, resDLA.raw, resDLB.resp.StatusCode, resDLB.raw)
	}

	if victimRes.resp.Header.Get("Retry-After") != "1" {
		t.Fatalf("real 40P01 Retry-After = %q, want \"1\"", victimRes.resp.Header.Get("Retry-After"))
	}
	probDL := contenttest.DecodeProblem(t, victimRes.raw)
	if probDL.Code != "dependency_unavailable" || probDL.RetryAfter == nil || *probDL.RetryAfter != 1 {
		t.Fatalf("real 40P01 problem = %+v", probDL)
	}

	// Verify the aborted transaction rolled back its in-transaction InsertItem AND released its idempotency claim.
	var victimIdemRows, victimItemRows int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, victimUserID, victimKey).Scan(&victimIdemRows); err != nil {
		t.Fatal(err)
	}
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1 AND name = $2`, victimUserID, victimItemName).Scan(&victimItemRows); err != nil {
		t.Fatal(err)
	}
	if victimIdemRows != 0 || victimItemRows != 0 {
		t.Fatalf("after real 40P01 rollback: victim idemRows=%d itemRows=%d, want 0 and 0", victimIdemRows, victimItemRows)
	}

	// Verify the winner committed exactly 1 item row and 1 done idempotency row.
	var winnerIdemRows, winnerItemRows int
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2 AND status = 'done'`, winnerUserID, winnerKey).Scan(&winnerIdemRows); err != nil {
		t.Fatal(err)
	}
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1 AND name = $2`, winnerUserID, winnerItemName).Scan(&winnerItemRows); err != nil {
		t.Fatal(err)
	}
	if winnerIdemRows != 1 || winnerItemRows != 1 || winnerRes.resp.StatusCode != http.StatusCreated {
		t.Fatalf("winner state: idemRows=%d itemRows=%d status=%d, want 1, 1, 201", winnerIdemRows, winnerItemRows, winnerRes.resp.StatusCode)
	}

	// Retry the aborted request with the exact same Idempotency-Key -> runs once, succeeds (201), and creates 1 row.
	respDLRetry, rawDLRetry := h.DoReq(victimJar, http.MethodPost, "/api/v1/__test/items", victimBody, contenttest.ReqOptions{
		IdemKey: victimKey,
	})
	if respDLRetry.StatusCode != http.StatusCreated {
		t.Fatalf("retry after real 40P01 with same key: status=%d body=%s, want 201", respDLRetry.StatusCode, rawDLRetry)
	}
	// Replay once more with the same key -> returns stored 201 response without creating a second item.
	respDLReplay, rawDLReplay := h.DoReq(victimJar, http.MethodPost, "/api/v1/__test/items", victimBody, contenttest.ReqOptions{
		IdemKey: victimKey,
	})
	if respDLReplay.StatusCode != http.StatusCreated || rawDLReplay != rawDLRetry {
		t.Fatalf("replay after real 40P01 recovery: status=%d body=%s, want %s", respDLReplay.StatusCode, rawDLReplay, rawDLRetry)
	}
	if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1 AND name = $2`, victimUserID, victimItemName).Scan(&victimItemRows); err != nil {
		t.Fatal(err)
	}
	if victimItemRows != 1 {
		t.Fatalf("victim item count after retry+replay = %d, want 1", victimItemRows)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
}
