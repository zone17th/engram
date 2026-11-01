package itemhttp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
)

func decodeSummary(t testing.TB, raw string) item.Summary {
	t.Helper()
	var s item.Summary
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		t.Fatalf("decode ItemSummary from %s: %v", raw, err)
	}
	return s
}

func decodeListPage(t testing.TB, raw string) item.ListPage {
	t.Helper()
	var p item.ListPage
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("decode ItemList from %s: %v", raw, err)
	}
	return p
}

func decodeLookupResult(t testing.TB, raw string) item.LookupResult {
	t.Helper()
	var r item.LookupResult
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("decode ItemLookupResult from %s: %v", raw, err)
	}
	return r
}

func advanceRateLimitWindow(h *contenttest.Harness) {
	h.Clock.Advance(2 * time.Second)
}

func assertNoPlaintextInLogs(t testing.TB, logs *contenttest.SafeBuffer, forbidden ...string) {
	t.Helper()
	out := logs.String()
	for _, f := range forbidden {
		if f == "" {
			continue
		}
		if strings.Contains(out, f) {
			t.Fatalf("log output leaked forbidden plaintext %q:\n%s", f, out)
		}
	}
}

// TestDuplicateNamesCreateTwoItems kiểm tra:
//   - "name trùng tạo hai item (không unique)" (plan Task 4 bullet 2, SPEC §2.4).
//   - Cả hai item đều trả 201 với ID khác nhau, `tags: []` (mảng rỗng, không null), `version: 1`, `entry_count: 0`.
//   - `GET /items/{id}` cập nhật `last_used_at` theo throttle 5 phút (`TouchItemLastUsedAt`).
func TestDuplicateNamesCreateTwoItems(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("dup-items@example.com", "CorrectHorseBatteryStaple!1")

	secretName := "Mạng Wifi Văn Phòng Tầng 9"
	secretHint := "Gợi ý nhạy cảm không được vào log"

	resp1, body1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"name":%q,"hint":%q}`, secretName, secretHint), contenttest.ReqOptions{})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST /items status = %d, want 201 (body=%s)", resp1.StatusCode, body1)
	}
	if gotCC := resp1.Header.Get("Cache-Control"); gotCC != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", gotCC)
	}
	it1 := decodeSummary(t, body1)
	if it1.Name != secretName || it1.Hint == nil || *it1.Hint != secretHint {
		t.Fatalf("it1 mismatch: %+v", it1)
	}
	if it1.Version != 1 || it1.EntryCount != 0 || it1.Tags == nil || len(it1.Tags) != 0 {
		t.Fatalf("it1 initial fields mismatch: %+v", it1)
	}
	if !strings.Contains(body1, `"tags":[]`) {
		t.Fatalf("expected non-null empty tags array in JSON, got %s", body1)
	}

	// Tạo item thứ hai cùng tên (khác cách viết hoa và dấu câu bọc ngoài -> cùng name_normalized).
	resp2, body2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"name":%q}`, "  "+strings.ToUpper(secretName)+"!!! "), contenttest.ReqOptions{})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("second POST /items status = %d, want 201 (body=%s)", resp2.StatusCode, body2)
	}
	it2 := decodeSummary(t, body2)
	if it2.ID == it1.ID {
		t.Fatalf("duplicate name must create two distinct items, got same ID %s", it1.ID)
	}
	if it2.Hint != nil {
		t.Fatalf("expected nil hint when omitted, got %v", *it2.Hint)
	}

	// Kiểm tra GET /items/{id} và throttle 5 phút của last_used_at.
	// Đặt last_used_at của it1 về thời điểm hiện tại trên fake clock để kiểm tra rõ ràng trước/sau 5 phút.
	ctx := context.Background()
	t0 := h.Clock.Now().UTC()
	if _, err := h.Pool.Exec(ctx, `UPDATE item SET last_used_at = $1 WHERE id = $2 AND user_id = $3`, t0, it1.ID, userA.User.ID); err != nil {
		t.Fatalf("seed last_used_at: %v", err)
	}

	// Sau 4 phút (< 5 phút): GET /items/{id} KHÔNG cập nhật last_used_at.
	h.Clock.Advance(4 * time.Minute)
	getResp1, getBody1 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+it1.ID.String(), "", contenttest.ReqOptions{})
	if getResp1.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id} at +4m status = %d, body=%s", getResp1.StatusCode, getBody1)
	}
	got1 := decodeSummary(t, getBody1)
	if !got1.LastUsedAt.Equal(t0) {
		t.Fatalf("last_used_at at +4m must stay %v (throttled 5m), got %v", t0, got1.LastUsedAt)
	}

	// Thêm 2 phút nữa (tổng +6 phút > 5 phút): GET /items/{id} cập nhật last_used_at lên now().
	h.Clock.Advance(2 * time.Minute)
	wantT1 := h.Clock.Now().UTC()
	getResp2, getBody2 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+it1.ID.String(), "", contenttest.ReqOptions{})
	if getResp2.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id} at +6m status = %d, body=%s", getResp2.StatusCode, getBody2)
	}
	got2 := decodeSummary(t, getBody2)
	if !got2.LastUsedAt.Equal(wantT1) {
		t.Fatalf("last_used_at at +6m = %v, want %v", got2.LastUsedAt, wantT1)
	}

	assertNoPlaintextInLogs(t, h.Logs, secretName, secretHint)
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestLookupExactZeroOneTwoTwentyFivePaginationAndExcludesDeletedAndOtherUser kiểm tra:
//   - "lookup trả đủ 0/1/2/25 khớp với total đúng và phân trang không trùng/thiếu;
//     lookup không trả item đã xoá hay của user khác" (plan Task 4 bullet 2, mục 2.7).
func TestLookupExactZeroOneTwoTwentyFivePaginationAndExcludesDeletedAndOtherUser(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	// User B tạo một item cùng tên "wifi" — không bao giờ được xuất hiện trong lookup của User A.
	respB, bodyB := h.DoReq(jarB, http.MethodPost, "/api/v1/items", `{"name":"wifi"}`, contenttest.ReqOptions{})
	if respB.StatusCode != http.StatusCreated {
		t.Fatalf("user B POST /items status = %d, body=%s", respB.StatusCode, bodyB)
	}
	itemB := decodeSummary(t, bodyB)

	// 1. 0 matches -> {items: [], total: 0, next_cursor: null}
	look0Resp, look0Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items/lookup?name=wifi", "", contenttest.ReqOptions{})
	if look0Resp.StatusCode != http.StatusOK {
		t.Fatalf("lookup 0 status = %d, body=%s", look0Resp.StatusCode, look0Body)
	}
	res0 := decodeLookupResult(t, look0Body)
	if res0.Total != 0 || len(res0.Items) != 0 || res0.NextCursor != nil {
		t.Fatalf("lookup 0 got %+v, want empty items, total=0, next_cursor=nil", res0)
	}
	if !strings.Contains(look0Body, `"items":[]`) {
		t.Fatalf("lookup 0 must serialize empty array items:[], got %s", look0Body)
	}

	// 2. Tạo 1 item khớp "wifi" và 1 item khác tên "wifi-guest" (prefix nhưng không exact).
	rOther, bOther := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"wifi-guest"}`, contenttest.ReqOptions{})
	if rOther.StatusCode != http.StatusCreated {
		t.Fatalf("create wifi-guest status = %d, body=%s", rOther.StatusCode, bOther)
	}

	r1, b1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"WiFi"}`, contenttest.ReqOptions{})
	if r1.StatusCode != http.StatusCreated {
		t.Fatalf("create WiFi #1 status = %d, body=%s", r1.StatusCode, b1)
	}
	firstItem := decodeSummary(t, b1)

	look1Resp, look1Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items/lookup?name=++wifi!!", "", contenttest.ReqOptions{})
	if look1Resp.StatusCode != http.StatusOK {
		t.Fatalf("lookup 1 status = %d, body=%s", look1Resp.StatusCode, look1Body)
	}
	res1 := decodeLookupResult(t, look1Body)
	if res1.Total != 1 || len(res1.Items) != 1 || res1.Items[0].ID != firstItem.ID || res1.NextCursor != nil {
		t.Fatalf("lookup 1 mismatch: %+v", res1)
	}

	// 3. Tạo thêm item thứ 2 cùng normalized "wifi" -> 2 matches.
	r2, b2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"\"wifi\""}`, contenttest.ReqOptions{})
	if r2.StatusCode != http.StatusCreated {
		t.Fatalf("create WiFi #2 status = %d, body=%s", r2.StatusCode, b2)
	}
	secondItem := decodeSummary(t, b2)

	look2Resp, look2Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items/lookup?name=WIFI", "", contenttest.ReqOptions{})
	if look2Resp.StatusCode != http.StatusOK {
		t.Fatalf("lookup 2 status = %d, body=%s", look2Resp.StatusCode, look2Body)
	}
	res2 := decodeLookupResult(t, look2Body)
	if res2.Total != 2 || len(res2.Items) != 2 || res2.NextCursor != nil {
		t.Fatalf("lookup 2 mismatch: %+v", res2)
	}

	// Xoá mềm một item rồi tạo bù và tạo thêm cho đủ 25 item sống (cùng một vài mốc created_at trùng nhau
	// để kiểm tra keyset tie-breaker `(created_at DESC, id ASC)`).
	advanceRateLimitWindow(h)
	delResp, delBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+firstItem.ID.String(), "", contenttest.ReqOptions{})
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete firstItem status = %d, body=%s", delResp.StatusCode, delBody)
	}

	// Sau khi xoá firstItem, chỉ còn secondItem (total = 1).
	lookAfterDelResp, lookAfterDelBody := h.DoReq(jarA, http.MethodGet, "/api/v1/items/lookup?name=wifi", "", contenttest.ReqOptions{})
	if lookAfterDelResp.StatusCode != http.StatusOK {
		t.Fatalf("lookup after delete status = %d, body=%s", lookAfterDelResp.StatusCode, lookAfterDelBody)
	}
	resAfterDel := decodeLookupResult(t, lookAfterDelBody)
	if resAfterDel.Total != 1 || len(resAfterDel.Items) != 1 || resAfterDel.Items[0].ID != secondItem.ID {
		t.Fatalf("lookup after delete must exclude deleted item: %+v", resAfterDel)
	}

	// Tạo thêm 24 item sống qua API (nhịp 5 req rồi advance clock để không chạm rate limit 10 rps).
	liveIDs := map[uuid.UUID]bool{secondItem.ID: true}
	for i := range 24 {
		if i%5 == 0 {
			advanceRateLimitWindow(h)
		}
		crResp, crBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"wifi"}`, contenttest.ReqOptions{})
		if crResp.StatusCode != http.StatusCreated {
			t.Fatalf("create wifi #%d status = %d, body=%s", i+2, crResp.StatusCode, crBody)
		}
		created := decodeSummary(t, crBody)
		liveIDs[created.ID] = true
	}
	if len(liveIDs) != 25 {
		t.Fatalf("expected 25 live wifi items, got %d", len(liveIDs))
	}

	// Đặt created_at có cả các cặp trùng timestamp để kiểm chứng tie-breaker `(created_at DESC, id ASC)`.
	ctx := context.Background()
	baseTime := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	idx := 0
	for id := range liveIDs {
		bucket := idx / 3 // mỗi 3 item chia sẻ cùng 1 timestamp
		ts := baseTime.Add(time.Duration(bucket) * time.Minute)
		if _, err := h.Pool.Exec(ctx, `UPDATE item SET created_at = $1 WHERE id = $2 AND user_id = $3`, ts, id, userA.User.ID); err != nil {
			t.Fatalf("update created_at: %v", err)
		}
		idx++
	}

	// 4. Phân trang qua 25 item với limit=7 (4 trang: 7 + 7 + 7 + 4 = 25).
	seen := make(map[uuid.UUID]bool, 25)
	var ordered []item.Summary
	cursor := ""
	pages := 0
	for {
		pages++
		if pages > 10 {
			t.Fatal("pagination loop exceeded expected page count")
		}
		path := "/api/v1/items/lookup?name=wifi&limit=7"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		pResp, pBody := h.DoReq(jarA, http.MethodGet, path, "", contenttest.ReqOptions{})
		if pResp.StatusCode != http.StatusOK {
			t.Fatalf("lookup page %d status = %d, body=%s", pages, pResp.StatusCode, pBody)
		}
		page := decodeLookupResult(t, pBody)
		if page.Total != 25 {
			t.Fatalf("page %d total = %d, want 25", pages, page.Total)
		}
		for _, it := range page.Items {
			if it.ID == firstItem.ID {
				t.Fatalf("soft-deleted item %s appeared in lookup page %d", firstItem.ID, pages)
			}
			if it.ID == itemB.ID {
				t.Fatalf("other user's item %s appeared in lookup page %d", itemB.ID, pages)
			}
			if !liveIDs[it.ID] {
				t.Fatalf("unexpected item %s in lookup page %d", it.ID, pages)
			}
			if seen[it.ID] {
				t.Fatalf("duplicate item %s across lookup pages", it.ID)
			}
			seen[it.ID] = true
			ordered = append(ordered, it)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}

	if len(ordered) != 25 {
		t.Fatalf("paginated total items = %d, want 25", len(ordered))
	}
	for i := 1; i < len(ordered); i++ {
		prev := ordered[i-1]
		cur := ordered[i]
		if prev.CreatedAt.Before(cur.CreatedAt) {
			t.Fatalf("lookup order violated at %d: prev.CreatedAt=%v < cur.CreatedAt=%v", i, prev.CreatedAt, cur.CreatedAt)
		}
		if prev.CreatedAt.Equal(cur.CreatedAt) && strings.Compare(prev.ID.String(), cur.ID.String()) >= 0 {
			t.Fatalf("lookup tie-breaker order violated at %d: prev.ID=%s >= cur.ID=%s", i, prev.ID, cur.ID)
		}
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}

// TestItemsListQueryEscapesWildcardsRejects201RunesAndCursorSortMismatch kiểm tra:
//   - "`q` có `%`/`_` không thành wildcard"
//   - "`q`/`name` 201 rune -> `400 name_invalid`"
//   - "cursor đổi `sort` -> 400 (`invalid_request`)" (cũng kiểm đổi `q` và `tag_id`)
//     (plan Task 4 bullet 2, mục 2.3, 2.7).
func TestItemsListQueryEscapesWildcardsRejects201RunesAndCursorSortMismatch(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("list-query@example.com", "CorrectHorseBatteryStaple!1")

	// Tạo các item có chứa `%`, `_`, `\` ở giữa tên (vì đầu/cuối P* bị textnorm cắt)
	// và các item có ký tự thường ở cùng vị trí để chứng minh `%` và `_` không khớp đại diện.
	names := []string{
		"rate 100% max",
		"rate 100abc max",
		"env_prod_key",
		"envXprodYkey",
		`path\sub\dir`,
		`pathXsubYdir`,
	}
	for _, n := range names {
		bodyBytes, _ := json.Marshal(map[string]string{"name": n})
		resp, body := h.DoReq(jarA, http.MethodPost, "/api/v1/items", string(bodyBytes), contenttest.ReqOptions{})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create item %q status = %d, body=%s", n, resp.StatusCode, body)
		}
	}

	// 1. Tìm `q=rate 100%`: chỉ khớp "rate 100% max", KHÔNG khớp "rate 100abc max".
	qPct := url.QueryEscape("rate 100% m")
	respPct, bodyPct := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=alpha&q="+qPct, "", contenttest.ReqOptions{})
	if respPct.StatusCode != http.StatusOK {
		t.Fatalf("GET /items?q=rate 100%% m status = %d, body=%s", respPct.StatusCode, bodyPct)
	}
	pagePct := decodeListPage(t, bodyPct)
	if len(pagePct.Items) != 1 || pagePct.Items[0].Name != "rate 100% max" {
		t.Fatalf("expected only 'rate 100%% max', got %+v", pagePct.Items)
	}

	// 2. Tìm `q=env_prod`: chỉ khớp "env_prod_key", KHÔNG khớp "envXprodYkey".
	qUnd := url.QueryEscape("env_prod")
	respUnd, bodyUnd := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=alpha&q="+qUnd, "", contenttest.ReqOptions{})
	if respUnd.StatusCode != http.StatusOK {
		t.Fatalf("GET /items?q=env_prod status = %d, body=%s", respUnd.StatusCode, bodyUnd)
	}
	pageUnd := decodeListPage(t, bodyUnd)
	if len(pageUnd.Items) != 1 || pageUnd.Items[0].Name != "env_prod_key" {
		t.Fatalf("expected only 'env_prod_key', got %+v", pageUnd.Items)
	}

	// 3. Tìm `q=path\sub`: chỉ khớp `path\sub\dir`, KHÔNG khớp `pathXsubYdir`.
	qSlash := url.QueryEscape(`path\sub`)
	respSlash, bodySlash := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=alpha&q="+qSlash, "", contenttest.ReqOptions{})
	if respSlash.StatusCode != http.StatusOK {
		t.Fatalf("GET /items?q=path\\sub status = %d, body=%s", respSlash.StatusCode, bodySlash)
	}
	pageSlash := decodeListPage(t, bodySlash)
	if len(pageSlash.Items) != 1 || pageSlash.Items[0].Name != `path\sub\dir` {
		t.Fatalf("expected only 'path\\sub\\dir', got %+v", pageSlash.Items)
	}

	// 4. `q` và `name` 201 rune (cả ASCII và tiếng Việt có dấu) -> `400 name_invalid`.
	runes200 := strings.Repeat("ă", 200)
	runes201 := strings.Repeat("ă", 201)

	ok200Resp, ok200Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items?q="+url.QueryEscape(runes200), "", contenttest.ReqOptions{})
	if ok200Resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /items?q=200-runes status = %d, want 200 (body=%s)", ok200Resp.StatusCode, ok200Body)
	}

	q201Resp, q201Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items?q="+url.QueryEscape(runes201), "", contenttest.ReqOptions{})
	if q201Resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET /items?q=201-runes status = %d, want 400 (body=%s)", q201Resp.StatusCode, q201Body)
	}
	if prob := contenttest.DecodeProblem(t, q201Body); prob.Code != "name_invalid" {
		t.Fatalf("GET /items?q=201-runes code = %q, want name_invalid", prob.Code)
	}

	look201Resp, look201Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items/lookup?name="+url.QueryEscape(runes201), "", contenttest.ReqOptions{})
	if look201Resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET /items/lookup?name=201-runes status = %d, want 400 (body=%s)", look201Resp.StatusCode, look201Body)
	}
	if prob := contenttest.DecodeProblem(t, look201Body); prob.Code != "name_invalid" {
		t.Fatalf("GET /items/lookup?name=201-runes code = %q, want name_invalid", prob.Code)
	}

	post201Resp, post201Body := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"name":%q}`, runes201), contenttest.ReqOptions{})
	if post201Resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST /items 201-runes status = %d, want 400 (body=%s)", post201Resp.StatusCode, post201Body)
	}
	if prob := contenttest.DecodeProblem(t, post201Body); prob.Code != "name_invalid" {
		t.Fatalf("POST /items 201-runes code = %q, want name_invalid", prob.Code)
	}

	// Hint 121 rune -> 400 hint_invalid.
	hint121 := strings.Repeat("h", 121)
	hintResp, hintBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"name":"valid","hint":%q}`, hint121), contenttest.ReqOptions{})
	if hintResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST /items 121-rune hint status = %d, want 400 (body=%s)", hintResp.StatusCode, hintBody)
	}
	if prob := contenttest.DecodeProblem(t, hintBody); prob.Code != "hint_invalid" {
		t.Fatalf("POST /items 121-rune hint code = %q, want hint_invalid", prob.Code)
	}

	// 5. Cursor gắn chặt với `sort` / `q` / `tag_id`: lấy trang 1 với sort=recent&limit=2,
	// rồi gửi cursor đó với sort=alpha -> 400 invalid_request.
	p1Resp, p1Body := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=recent&limit=2", "", contenttest.ReqOptions{})
	if p1Resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /items page 1 status = %d, body=%s", p1Resp.StatusCode, p1Body)
	}
	p1 := decodeListPage(t, p1Body)
	if p1.NextCursor == nil || *p1.NextCursor == "" {
		t.Fatalf("expected non-empty next_cursor on page 1, got %+v", p1)
	}

	// Dùng cursor của sort=recent cho sort=alpha -> 400 invalid_request.
	badSortResp, badSortBody := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=alpha&limit=2&cursor="+url.QueryEscape(*p1.NextCursor), "", contenttest.ReqOptions{})
	if badSortResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("cursor with changed sort status = %d, want 400 (body=%s)", badSortResp.StatusCode, badSortBody)
	}
	if prob := contenttest.DecodeProblem(t, badSortBody); prob.Code != "invalid_request" {
		t.Fatalf("cursor with changed sort code = %q, want invalid_request", prob.Code)
	}

	// Dùng cursor không có q cho request có q=rate -> 400 invalid_request.
	badQResp, badQBody := h.DoReq(jarA, http.MethodGet, "/api/v1/items?sort=recent&q=rate&limit=2&cursor="+url.QueryEscape(*p1.NextCursor), "", contenttest.ReqOptions{})
	if badQResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("cursor with changed q status = %d, want 400 (body=%s)", badQResp.StatusCode, badQBody)
	}
	if prob := contenttest.DecodeProblem(t, badQBody); prob.Code != "invalid_request" {
		t.Fatalf("cursor with changed q code = %q, want invalid_request", prob.Code)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestClientIDConflictAndPatchVersionConcurrency kiểm tra:
//   - "`id` client trùng khác payload -> `409 item_id_conflict`" (cả cùng user, đã xoá, và của user khác mà không lộ chủ sở hữu).
//   - Retry cùng `Idempotency-Key` và cùng payload trả lại đúng 201 ban đầu.
//   - "PATCH version cũ -> `412 version_mismatch` + `current_version`, thiếu If-Match -> `428 precondition_required`".
//   - PATCH chỉ tăng `version` khi `name` hoặc `hint` thực sự đổi, `hint: null` xoá hint, và gọi embed hook khi đổi.
func TestClientIDConflictAndPatchVersionConcurrency(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	clientID := uuid.New()
	idemKey := "idem-item-create-" + uuid.NewString()
	createBody := fmt.Sprintf(`{"id":%q,"name":"SSH Server","hint":"port 2222"}`, clientID.String())

	// 1. Tạo item với client ID.
	resp1, body1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items", createBody, contenttest.ReqOptions{IdemKey: idemKey})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items with client ID status = %d, body=%s", resp1.StatusCode, body1)
	}
	created := decodeSummary(t, body1)
	if created.ID != clientID || created.Version != 1 {
		t.Fatalf("created item mismatch: %+v", created)
	}

	// Replay cùng Idempotency-Key + cùng body -> 201 nguyên bản.
	replayResp, replayBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", createBody, contenttest.ReqOptions{IdemKey: idemKey})
	if replayResp.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent replay status = %d, want 201 (body=%s)", replayResp.StatusCode, replayBody)
	}
	contenttest.AssertJSONEqual(t, body1, replayBody)

	// Cùng clientID nhưng request mới (Idempotency-Key mới, payload khác) của chính User A -> 409 item_id_conflict.
	conflictA, conflictABody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"id":%q,"name":"Other Name"}`, clientID.String()), contenttest.ReqOptions{})
	if conflictA.StatusCode != http.StatusConflict {
		t.Fatalf("same-user duplicate client id status = %d, want 409 (body=%s)", conflictA.StatusCode, conflictABody)
	}
	if prob := contenttest.DecodeProblem(t, conflictABody); prob.Code != "item_id_conflict" {
		t.Fatalf("same-user duplicate client id code = %q, want item_id_conflict", prob.Code)
	}

	// User B gửi POST /items với cùng clientID của User A -> 409 item_id_conflict (không lộ chủ sở hữu).
	conflictB, conflictBBody := h.DoReq(jarB, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"id":%q,"name":"User B Item"}`, clientID.String()), contenttest.ReqOptions{})
	if conflictB.StatusCode != http.StatusConflict {
		t.Fatalf("cross-user duplicate client id status = %d, want 409 (body=%s)", conflictB.StatusCode, conflictBBody)
	}
	probB := contenttest.DecodeProblem(t, conflictBBody)
	if probB.Code != "item_id_conflict" || strings.Contains(conflictBBody, userA.User.ID.String()) {
		t.Fatalf("cross-user duplicate client id problem = %+v (body=%s)", probB, conflictBBody)
	}

	// 2. PATCH thiếu If-Match -> 428 precondition_required.
	patchNoIfMatch, patchNoIfMatchBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{"name":"SSH Prod"}`, contenttest.ReqOptions{})
	if patchNoIfMatch.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("PATCH without If-Match status = %d, want 428 (body=%s)", patchNoIfMatch.StatusCode, patchNoIfMatchBody)
	}
	if prob := contenttest.DecodeProblem(t, patchNoIfMatchBody); prob.Code != "precondition_required" {
		t.Fatalf("PATCH without If-Match code = %q, want precondition_required", prob.Code)
	}

	// 3. PATCH với If-Match: "1" hợp lệ đổi tên + xoá hint (`"hint": null`) -> 200, version = 2, hint = null.
	patchOK, patchOKBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{"name":"SSH Prod","hint":null}`, contenttest.ReqOptions{
		IfMatch: `"1"`,
	})
	if patchOK.StatusCode != http.StatusOK {
		t.Fatalf("PATCH with If-Match \"1\" status = %d, want 200 (body=%s)", patchOK.StatusCode, patchOKBody)
	}
	updated := decodeSummary(t, patchOKBody)
	if updated.Version != 2 || updated.Name != "SSH Prod" || updated.Hint != nil {
		t.Fatalf("updated summary mismatch: %+v", updated)
	}

	// 4. PATCH gửi lại cùng giá trị không đổi với If-Match: "2" -> 200, version giữ nguyên 2 (chỉ tăng khi name/hint đổi).
	patchNoop, patchNoopBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{"name":"SSH Prod"}`, contenttest.ReqOptions{
		IfMatch: `"2"`,
	})
	if patchNoop.StatusCode != http.StatusOK {
		t.Fatalf("noop PATCH status = %d, want 200 (body=%s)", patchNoop.StatusCode, patchNoopBody)
	}
	noopSummary := decodeSummary(t, patchNoopBody)
	if noopSummary.Version != 2 {
		t.Fatalf("noop PATCH must not increment version: got %d, want 2", noopSummary.Version)
	}

	// 5. PATCH với version cũ If-Match: "1" -> 412 version_mismatch kèm current_version = 2.
	patchStale, patchStaleBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{"name":"Stale Write"}`, contenttest.ReqOptions{
		IfMatch: `"1"`,
	})
	if patchStale.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("stale PATCH status = %d, want 412 (body=%s)", patchStale.StatusCode, patchStaleBody)
	}
	var stalePayload struct {
		Code           string `json:"code"`
		Status         int    `json:"status"`
		CurrentVersion *int32 `json:"current_version"`
	}
	if err := json.Unmarshal([]byte(patchStaleBody), &stalePayload); err != nil {
		t.Fatalf("unmarshal stale 412 problem: %v", err)
	}
	if stalePayload.Code != "version_mismatch" || stalePayload.Status != http.StatusPreconditionFailed || stalePayload.CurrentVersion == nil || *stalePayload.CurrentVersion != 2 {
		t.Fatalf("stale 412 payload = %+v, want code=version_mismatch current_version=2", stalePayload)
	}

	// 6. Xoá mềm item: PATCH với version cũ trên item đã xoá phải trả 404 not_found (ưu tiên 404 trước 412).
	delResp, delBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+clientID.String(), "", contenttest.ReqOptions{})
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items/{id} status = %d, body=%s", delResp.StatusCode, delBody)
	}
	patchDeleted, patchDeletedBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{"name":"After Delete"}`, contenttest.ReqOptions{
		IfMatch: `"1"`,
	})
	if patchDeleted.StatusCode != http.StatusNotFound {
		t.Fatalf("PATCH on deleted item with stale version status = %d, want 404 before 412 (body=%s)", patchDeleted.StatusCode, patchDeletedBody)
	}
	if prob := contenttest.DecodeProblem(t, patchDeletedBody); prob.Code != "not_found" {
		t.Fatalf("PATCH on deleted item code = %q, want not_found", prob.Code)
	}

	// Client ID của item đã xoá vẫn chặn tạo mới với 409 item_id_conflict.
	conflictDeleted, conflictDeletedBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"id":%q,"name":"Reborn"}`, clientID.String()), contenttest.ReqOptions{})
	if conflictDeleted.StatusCode != http.StatusConflict {
		t.Fatalf("POST with soft-deleted item ID status = %d, want 409 (body=%s)", conflictDeleted.StatusCode, conflictDeletedBody)
	}
	if prob := contenttest.DecodeProblem(t, conflictDeletedBody); prob.Code != "item_id_conflict" {
		t.Fatalf("POST with soft-deleted item ID code = %q, want item_id_conflict", prob.Code)
	}

	// 7. Strict JSON decoding: unknown field hoặc duplicate key -> 400 invalid_request.
	advanceRateLimitWindow(h)
	unknownFieldResp, unknownFieldBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Valid","unknown_field":1}`, contenttest.ReqOptions{})
	if unknownFieldResp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, unknownFieldBody).Code != "invalid_request" {
		t.Fatalf("unknown field POST /items: status=%d body=%s, want 400 invalid_request", unknownFieldResp.StatusCode, unknownFieldBody)
	}
	dupKeyResp, dupKeyBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Valid","name":"Dup"}`, contenttest.ReqOptions{})
	if dupKeyResp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, dupKeyBody).Code != "invalid_request" {
		t.Fatalf("duplicate key POST /items: status=%d body=%s, want 400 invalid_request", dupKeyResp.StatusCode, dupKeyBody)
	}
	emptyPatchResp, emptyPatchBody := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+clientID.String(), `{}`, contenttest.ReqOptions{IfMatch: `"2"`})
	if emptyPatchResp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, emptyPatchBody).Code != "invalid_request" {
		t.Fatalf("empty PATCH /items/{id}: status=%d body=%s, want 400 invalid_request", emptyPatchResp.StatusCode, emptyPatchBody)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}

// TestDeleteAndRestoreItemProvenanceDoesNotResurrectIndividuallyDeletedEntry kiểm tra:
//   - "xoá item rồi restore khôi phục đúng entry bị xoá theo item, không khôi phục entry
//     đã xoá riêng trước đó (A8)" (plan Task 4 bullet 2, mục 2.8).
//   - Xoá lặp lại trả 204 không đổi gì; restore lặp lại trên item sống trả 200 không đổi gì.
func TestDeleteAndRestoreItemProvenanceDoesNotResurrectIndividuallyDeletedEntry(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("provenance-a8@example.com", "CorrectHorseBatteryStaple!1")

	crResp, crBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Server Config"}`, contenttest.ReqOptions{})
	if crResp.StatusCode != http.StatusCreated {
		t.Fatalf("create item status = %d, body=%s", crResp.StatusCode, crBody)
	}
	it := decodeSummary(t, crBody)

	ctx := context.Background()
	q := gen.New(h.Pool)
	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:1111111111111111111111","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)

	// Tạo 3 entry trên item qua gen.Queries (vì entry API thuộc lane entryapi):
	//   - eIndividual: bị xoá riêng (`deleted_via = 'entry'`) TRƯỚC khi xoá item.
	//   - eLive1, eLive2: đang sống lúc xoá item -> phải được gắn `deleted_via = 'item'` cùng `delete_batch`.
	insertTestEntry := func() uuid.UUID {
		e, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             userA.User.ID,
			ItemID:             it.ID,
			Type:               "text",
			Envelope:           validEnv,
			Ciphertext:         make([]byte, 32),
			PlaintextLenBucket: 256,
		})
		if err != nil {
			t.Fatalf("InsertEntry: %v", err)
		}
		if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
			Delta:  1,
			UserID: userA.User.ID,
			ID:     it.ID,
		}); err != nil {
			t.Fatalf("AddItemEntryCount: %v", err)
		}
		return e.ID
	}

	eIndividualID := insertTestEntry()
	eLive1ID := insertTestEntry()
	eLive2ID := insertTestEntry()

	// Xoá riêng eIndividual trước khi xoá item.
	if _, err := q.SoftDeleteEntry(ctx, gen.SoftDeleteEntryParams{
		UserID: userA.User.ID,
		ID:     eIndividualID,
	}); err != nil {
		t.Fatalf("SoftDeleteEntry eIndividual: %v", err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		Delta:  -1,
		UserID: userA.User.ID,
		ID:     it.ID,
	}); err != nil {
		t.Fatalf("decrement entry_count for eIndividual: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 1. DELETE /items/{id} -> 204.
	delResp, delBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+it.ID.String(), "", contenttest.ReqOptions{})
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items/{id} status = %d, want 204 (body=%s)", delResp.StatusCode, delBody)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// Repeat DELETE trên item đã xoá -> 204, không làm mất delete_batch của lần xoá đầu.
	delAgainResp, delAgainBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+it.ID.String(), "", contenttest.ReqOptions{})
	if delAgainResp.StatusCode != http.StatusNoContent {
		t.Fatalf("repeat DELETE /items/{id} status = %d, want 204 (body=%s)", delAgainResp.StatusCode, delAgainBody)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// GET /items/{id} khi đã xoá -> 404 not_found.
	getDelResp, _ := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+it.ID.String(), "", contenttest.ReqOptions{})
	if getDelResp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET deleted item status = %d, want 404", getDelResp.StatusCode)
	}

	// 2. POST /items/{id}/restore -> 200 ItemSummary với entry_count = 2.
	restResp, restBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+it.ID.String()+"/restore", `{}`, contenttest.ReqOptions{})
	if restResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /items/{id}/restore status = %d, want 200 (body=%s)", restResp.StatusCode, restBody)
	}
	restored := decodeSummary(t, restBody)
	if restored.EntryCount != 2 {
		t.Fatalf("restored item entry_count = %d, want 2 (only item-deleted entries)", restored.EntryCount)
	}

	// Kiểm tra trạng thái từng entry trong DB: eLive1 và eLive2 sống; eIndividual vẫn deleted_via='entry'.
	eIndRow, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: userA.User.ID, ID: eIndividualID})
	if err != nil {
		t.Fatalf("GetEntryByUserAndID eIndividual: %v", err)
	}
	if !eIndRow.DeletedAt.Valid || eIndRow.DeletedVia == nil || *eIndRow.DeletedVia != "entry" {
		t.Fatalf("individually deleted entry must remain deleted_via='entry', got %+v", eIndRow)
	}
	for _, liveID := range []uuid.UUID{eLive1ID, eLive2ID} {
		row, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: userA.User.ID, ID: liveID})
		if err != nil {
			t.Fatalf("GetEntryByUserAndID %s: %v", liveID, err)
		}
		if row.DeletedAt.Valid || row.DeletedVia != nil || row.DeleteBatch != nil {
			t.Fatalf("item-deleted entry %s must be restored clean, got %+v", liveID, row)
		}
	}

	// Repeat POST /items/{id}/restore trên item đang sống -> 200, không đổi gì.
	restAgainResp, restAgainBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+it.ID.String()+"/restore", `{}`, contenttest.ReqOptions{})
	if restAgainResp.StatusCode != http.StatusOK {
		t.Fatalf("repeat restore live item status = %d, want 200 (body=%s)", restAgainResp.StatusCode, restAgainBody)
	}
	restoredAgain := decodeSummary(t, restAgainBody)
	if restoredAgain.EntryCount != 2 {
		t.Fatalf("repeat restore entry_count = %d, want 2", restoredAgain.EntryCount)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestHistoryP4BE1_3ItemRestoreRejectsWhenLiveTagsExceed20 kiểm tra:
//   - "lịch sử P4BE1-3: item có T1…T20, xoá T1, gắn T21, xoá item, restore T1,
//     restore item -> `409 item_tag_limit`, item và entry vẫn xoá, counter đúng"
//     (plan Task 4 bullet 2, mục 2.8).
func TestHistoryP4BE1_3ItemRestoreRejectsWhenLiveTagsExceed20(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("p4be1-3@example.com", "CorrectHorseBatteryStaple!1")

	crResp, crBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Item P4BE1-3"}`, contenttest.ReqOptions{})
	if crResp.StatusCode != http.StatusCreated {
		t.Fatalf("create item status = %d, body=%s", crResp.StatusCode, crBody)
	}
	it := decodeSummary(t, crBody)

	ctx := context.Background()
	q := gen.New(h.Pool)
	nowPg := pgtype.Timestamptz{Time: h.Clock.Now().UTC(), Valid: true}

	// Tạo 1 entry sống trên item để xác nhận khi restore bị từ chối 409 thì entry vẫn ở trạng thái xoá.
	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:1111111111111111111111","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)
	entryRow, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             userA.User.ID,
		ItemID:             it.ID,
		Type:               "text",
		Envelope:           validEnv,
		Ciphertext:         make([]byte, 32),
		PlaintextLenBucket: 256,
	})
	if err != nil {
		t.Fatalf("InsertEntry: %v", err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{Delta: 1, UserID: userA.User.ID, ID: it.ID}); err != nil {
		t.Fatalf("AddItemEntryCount: %v", err)
	}

	// 1. Gắn T1…T20 cho item.
	tags := make([]gen.Tag, 21)
	first20IDs := make([]uuid.UUID, 20)
	for i := range 20 {
		disp := fmt.Sprintf("tag-%02d", i+1)
		tg, err := q.InsertTag(ctx, gen.InsertTagParams{
			UserID:     userA.User.ID,
			Display:    disp,
			Normalized: disp,
		})
		if err != nil {
			t.Fatalf("InsertTag %d: %v", i+1, err)
		}
		tags[i] = tg
		first20IDs[i] = tg.ID
	}
	if _, err := q.AssignItemTags(ctx, gen.AssignItemTagsParams{
		UserID: userA.User.ID,
		ItemID: it.ID,
		TagIds: first20IDs,
	}); err != nil {
		t.Fatalf("AssignItemTags T1..T20: %v", err)
	}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		Now:    nowPg,
		UserID: userA.User.ID,
		TagIds: first20IDs,
	}); err != nil {
		t.Fatalf("IncrementTagsItemCountAndTouch T1..T20: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2. Xoá mềm T1 -> số tag sống trên item còn 19.
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{
		UserID: userA.User.ID,
		ID:     tags[0].ID,
	}); err != nil {
		t.Fatalf("SoftDeleteTag T1: %v", err)
	}

	// 3. Tạo và gắn T21 -> số tag sống trên item là 20 (T2..T21 sống, T1 đã xoá).
	t21, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     userA.User.ID,
		Display:    "tag-21",
		Normalized: "tag-21",
	})
	if err != nil {
		t.Fatalf("InsertTag T21: %v", err)
	}
	tags[20] = t21
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{
		UserID: userA.User.ID,
		ItemID: it.ID,
		TagID:  t21.ID,
	}); err != nil {
		t.Fatalf("AssignItemTag T21: %v", err)
	}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		Now:    nowPg,
		UserID: userA.User.ID,
		TagIds: []uuid.UUID{t21.ID},
	}); err != nil {
		t.Fatalf("IncrementTagsItemCountAndTouch T21: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 4. Xoá item qua DELETE /api/v1/items/{id} -> 204; mọi T1..T21 có item_count = 0.
	delResp, delBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+it.ID.String(), "", contenttest.ReqOptions{})
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items/{id} status = %d, body=%s", delResp.StatusCode, delBody)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 5. Restore T1 (trong lúc item đang bị xoá, nên T1 chưa vi phạm trần trên item sống nào).
	if _, err := q.RestoreTag(ctx, gen.RestoreTagParams{
		UserID: userA.User.ID,
		ID:     tags[0].ID,
	}); err != nil {
		t.Fatalf("RestoreTag T1: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 6. Restore item qua POST /api/v1/items/{id}/restore -> hiện item gắn 21 tag sống (T1..T21)
	// nên phải bị từ chối với `409 item_tag_limit`, không khôi phục item hay entry, counter giữ nguyên 0.
	restResp, restBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+it.ID.String()+"/restore", `{}`, contenttest.ReqOptions{})
	if restResp.StatusCode != http.StatusConflict {
		t.Fatalf("POST /items/{id}/restore with 21 live tags status = %d, want 409 (body=%s)", restResp.StatusCode, restBody)
	}
	if prob := contenttest.DecodeProblem(t, restBody); prob.Code != "item_tag_limit" {
		t.Fatalf("POST /items/{id}/restore code = %q, want item_tag_limit", prob.Code)
	}

	// Xác minh item vẫn deleted_at != NULL, entry vẫn deleted_at != NULL, và mọi tag có item_count = 0.
	itemAfter, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: userA.User.ID, ID: it.ID})
	if err != nil {
		t.Fatalf("GetItemByUserAndID: %v", err)
	}
	if !itemAfter.DeletedAt.Valid || itemAfter.EntryCount != 0 {
		t.Fatalf("item must remain soft-deleted with entry_count=0, got %+v", itemAfter)
	}
	entryAfter, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: userA.User.ID, ID: entryRow.ID})
	if err != nil {
		t.Fatalf("GetEntryByUserAndID: %v", err)
	}
	if !entryAfter.DeletedAt.Valid {
		t.Fatalf("entry must remain soft-deleted after rejected item restore, got %+v", entryAfter)
	}
	for i, tg := range tags {
		tRow, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: userA.User.ID, ID: tg.ID})
		if err != nil {
			t.Fatalf("GetTagByUserAndID T%d: %v", i+1, err)
		}
		if tRow.ItemCount != 0 {
			t.Fatalf("T%d item_count = %d, want 0", i+1, tRow.ItemCount)
		}
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestHistoryP4BE1_4TagItemCountAcrossItemDeleteAndRestoreBothDirections kiểm tra:
//   - "lịch sử P4BE1-4: tag T có một item sống, xoá T, xoá item, restore T -> `item_count = 0`;
//     chiều ngược (xoá T, restore item, restore T) -> `item_count = 1`"
//     (plan Task 4 bullet 2, mục 2.1, 2.8).
func TestHistoryP4BE1_4TagItemCountAcrossItemDeleteAndRestoreBothDirections(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("p4be1-4@example.com", "CorrectHorseBatteryStaple!1")

	ctx := context.Background()
	q := gen.New(h.Pool)
	nowPg := pgtype.Timestamptz{Time: h.Clock.Now().UTC(), Valid: true}

	// Tạo item và gắn tag T (item_count = 1).
	crResp, crBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Item P4BE1-4"}`, contenttest.ReqOptions{})
	if crResp.StatusCode != http.StatusCreated {
		t.Fatalf("create item status = %d, body=%s", crResp.StatusCode, crBody)
	}
	it := decodeSummary(t, crBody)

	tagT, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     userA.User.ID,
		Display:    "finance",
		Normalized: "finance",
	})
	if err != nil {
		t.Fatalf("InsertTag T: %v", err)
	}
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{
		UserID: userA.User.ID,
		ItemID: it.ID,
		TagID:  tagT.ID,
	}); err != nil {
		t.Fatalf("AssignItemTag: %v", err)
	}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		Now:    nowPg,
		UserID: userA.User.ID,
		TagIds: []uuid.UUID{tagT.ID},
	}); err != nil {
		t.Fatalf("IncrementTagsItemCountAndTouch: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// Chiều 1: xoá T -> xoá item -> restore T => item_count = 0.
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{UserID: userA.User.ID, ID: tagT.ID}); err != nil {
		t.Fatalf("SoftDeleteTag T: %v", err)
	}
	delResp, delBody := h.DoReq(jarA, http.MethodDelete, "/api/v1/items/"+it.ID.String(), "", contenttest.ReqOptions{})
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /items/{id} status = %d, body=%s", delResp.StatusCode, delBody)
	}
	restoredT1, err := q.RestoreTag(ctx, gen.RestoreTagParams{UserID: userA.User.ID, ID: tagT.ID})
	if err != nil {
		t.Fatalf("RestoreTag T (direction 1): %v", err)
	}
	if restoredT1.ItemCount != 0 {
		t.Fatalf("direction 1 (delete T -> delete item -> restore T): item_count = %d, want 0", restoredT1.ItemCount)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// Chiều 2 (ngược lại): khi item đang xoá và T đang sống (item_count = 0),
	// xoá T -> restore item -> restore T => item_count = 1.
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{UserID: userA.User.ID, ID: tagT.ID}); err != nil {
		t.Fatalf("SoftDeleteTag T (direction 2): %v", err)
	}
	restItemResp, restItemBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+it.ID.String()+"/restore", `{}`, contenttest.ReqOptions{})
	if restItemResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /items/{id}/restore status = %d, body=%s", restItemResp.StatusCode, restItemBody)
	}
	restoredT2, err := q.RestoreTag(ctx, gen.RestoreTagParams{UserID: userA.User.ID, ID: tagT.ID})
	if err != nil {
		t.Fatalf("RestoreTag T (direction 2): %v", err)
	}
	if restoredT2.ItemCount != 1 {
		t.Fatalf("direction 2 (delete T -> restore item -> restore T): item_count = %d, want 1", restoredT2.ItemCount)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestCrossTenantIsolationUserB404OnEveryItemRoute kiểm tra:
//   - "user B nhận 404 trên mọi route với ID item của A (A1)" và không ghi/thay đổi dữ liệu của A
//     (plan Task 4 bullet 2, mục 3).
func TestCrossTenantIsolationUserB404OnEveryItemRoute(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	crResp, crBody := h.DoReq(jarA, http.MethodPost, "/api/v1/items", `{"name":"Alice Secret Item","hint":"Alice Hint"}`, contenttest.ReqOptions{})
	if crResp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice POST /items status = %d, body=%s", crResp.StatusCode, crBody)
	}
	aliceItem := decodeSummary(t, crBody)

	// Tạo một tag sống của Alice để kiểm tra User B lọc GET /items?tag_id=<AliceTag> cũng nhận 404 not_found.
	ctx := context.Background()
	q := gen.New(h.Pool)
	aliceTag, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     userA.User.ID,
		Display:    "alice-tag",
		Normalized: "alice-tag",
	})
	if err != nil {
		t.Fatalf("InsertTag alice: %v", err)
	}

	// 1. User B GET /items/{aliceID} -> 404 not_found.
	rGet, bGet := h.DoReq(jarB, http.MethodGet, "/api/v1/items/"+aliceItem.ID.String(), "", contenttest.ReqOptions{})
	if rGet.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bGet).Code != "not_found" {
		t.Fatalf("User B GET Alice item: status=%d body=%s, want 404 not_found", rGet.StatusCode, bGet)
	}

	// 2. User B PATCH /items/{aliceID} (kể cả với If-Match: "1" hay "99") -> 404 not_found (404 trước 412).
	rPatch, bPatch := h.DoReq(jarB, http.MethodPatch, "/api/v1/items/"+aliceItem.ID.String(), `{"name":"Hacked"}`, contenttest.ReqOptions{
		IfMatch: `"99"`,
	})
	if rPatch.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bPatch).Code != "not_found" {
		t.Fatalf("User B PATCH Alice item: status=%d body=%s, want 404 not_found", rPatch.StatusCode, bPatch)
	}

	// 3. User B DELETE /items/{aliceID} -> 404 not_found.
	rDel, bDel := h.DoReq(jarB, http.MethodDelete, "/api/v1/items/"+aliceItem.ID.String(), "", contenttest.ReqOptions{})
	if rDel.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bDel).Code != "not_found" {
		t.Fatalf("User B DELETE Alice item: status=%d body=%s, want 404 not_found", rDel.StatusCode, bDel)
	}

	// 4. User B POST /items/{aliceID}/restore -> 404 not_found.
	rRest, bRest := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+aliceItem.ID.String()+"/restore", `{}`, contenttest.ReqOptions{})
	if rRest.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bRest).Code != "not_found" {
		t.Fatalf("User B POST restore Alice item: status=%d body=%s, want 404 not_found", rRest.StatusCode, bRest)
	}

	// 5. User B GET /items?tag_id={aliceTagID} -> 404 not_found.
	rListTag, bListTag := h.DoReq(jarB, http.MethodGet, "/api/v1/items?tag_id="+aliceTag.ID.String(), "", contenttest.ReqOptions{})
	if rListTag.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bListTag).Code != "not_found" {
		t.Fatalf("User B GET /items?tag_id=aliceTag: status=%d body=%s, want 404 not_found", rListTag.StatusCode, bListTag)
	}

	// 6. User B GET /items không thấy item của Alice.
	rListB, bListB := h.DoReq(jarB, http.MethodGet, "/api/v1/items", "", contenttest.ReqOptions{})
	if rListB.StatusCode != http.StatusOK {
		t.Fatalf("User B GET /items status = %d, body=%s", rListB.StatusCode, bListB)
	}
	if pageB := decodeListPage(t, bListB); len(pageB.Items) != 0 {
		t.Fatalf("User B GET /items must be empty, got %+v", pageB.Items)
	}

	// Xác minh item của Alice còn nguyên vẹn (version=1, name="Alice Secret Item").
	rAliceGet, bAliceGet := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+aliceItem.ID.String(), "", contenttest.ReqOptions{})
	if rAliceGet.StatusCode != http.StatusOK {
		t.Fatalf("Alice GET own item status = %d, body=%s", rAliceGet.StatusCode, bAliceGet)
	}
	gotAlice := decodeSummary(t, bAliceGet)
	if gotAlice.Name != "Alice Secret Item" || gotAlice.Version != 1 || gotAlice.Hint == nil || *gotAlice.Hint != "Alice Hint" {
		t.Fatalf("Alice item was modified by User B attempts: %+v", gotAlice)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}
