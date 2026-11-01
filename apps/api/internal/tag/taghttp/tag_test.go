package taghttp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/tag"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
)

func newIdemKey() string {
	return "idem-t5-" + uuid.NewString()
}

func doWrite(
	h *contenttest.Harness,
	jar contenttest.CookieJar,
	method, path, body string,
) (contenttest.TestResponse, string) {
	h.T.Helper()
	return h.DoReq(jar, method, path, body, contenttest.ReqOptions{
		IdemKey: newIdemKey(),
	})
}

func decodeTag(t testing.TB, raw string) tag.Tag {
	t.Helper()
	var tg tag.Tag
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tg); err != nil {
		t.Fatalf("decode Tag from %s: %v", raw, err)
	}
	return tg
}

func decodeTagList(t testing.TB, raw string) tag.ListPage {
	t.Helper()
	var p tag.ListPage
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("decode TagList from %s: %v", raw, err)
	}
	return p
}

func decodeItemSummary(t testing.TB, raw string) item.Summary {
	t.Helper()
	var s item.Summary
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		t.Fatalf("decode ItemSummary from %s: %v", raw, err)
	}
	return s
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

func awaitUserContentLockWaiter(t testing.TB, h *contenttest.Harness, userID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		err := h.Pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_locks
			WHERE locktype = 'advisory'
			  AND classid = hashtext('engram.content')
			  AND objid = hashtext(($1::uuid)::text)
			  AND NOT granted
		`, userID).Scan(&waiting)
		if err == nil && waiting >= 1 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for pg_locks ungranted advisory lock waiter for user %s", userID)
}

// TestTagUpsertSameNormalizedParallelBarrierAndP4BE1_6 kiểm tra:
//   - `POST /tags {display}`: textnorm, 1–50 rune (`tag_display_invalid`); tạo mới -> 201,
//     upsert cùng normalized -> 200 trả cùng tag (không đổi `display`).
//   - Hai upsert song song cùng normalized chỉ tạo một hàng (barrier qua `pg_locks`).
//   - P4BE1-6: upsert song song với rename/xoá tag trùng normalized (barrier giữa hai bước của upsert)
//     -> kết quả là một tag sống hợp lệ hoặc 201 tag mới, không bao giờ 500, không bao giờ trả tag đã xoá/đổi tên;
//     vi phạm unique index `tag_user_norm_uq` (`23505`) map `503 dependency_unavailable` + `Retry-After: 1`.
type testBarrier struct {
	mode      int32
	enteredCh chan struct{}
	releaseCh chan struct{}
	once      sync.Once
}

func newTestBarrier(mode int32) *testBarrier {
	return &testBarrier{
		mode:      mode,
		enteredCh: make(chan struct{}, 4),
		releaseCh: make(chan struct{}),
	}
}

func (b *testBarrier) release() {
	if b == nil {
		return
	}
	b.once.Do(func() {
		close(b.releaseCh)
	})
}

func (b *testBarrier) enterAndWait(ctx context.Context) {
	b.enteredCh <- struct{}{}
	select {
	case <-b.releaseCh:
	case <-ctx.Done():
	}
}

func TestTagUpsertSameNormalizedParallelBarrierAndP4BE1_6(t *testing.T) {
	var currentBarrier atomic.Pointer[testBarrier]
	setBarrier := func(mode int32) *testBarrier {
		if old := currentBarrier.Swap(nil); old != nil {
			old.release()
		}
		if mode == 0 {
			return nil
		}
		b := newTestBarrier(mode)
		currentBarrier.Store(b)
		return b
	}

	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	t.Cleanup(func() {
		setBarrier(0)
	})

	taghttp.RegisterTestHooks(t, &taghttp.TestHooks{
		OnLockUserContent: func(ctx context.Context, _ uuid.UUID, op string) {
			if b := currentBarrier.Load(); b != nil && b.mode == 3 && (op == "tagDelete" || op == "tagRename") {
				b.enterAndWait(ctx)
			}
		},
		OnBetweenUpsertSteps: func(ctx context.Context, _ uuid.UUID, _ string, foundLive bool) {
			if b := currentBarrier.Load(); b != nil {
				if (b.mode == 1 && !foundLive) || (b.mode == 2 && foundLive) || (b.mode == 4 && !foundLive) {
					b.enterAndWait(ctx)
				}
			}
		},
	})
	jarA, userA := h.SignupUser("tag-upsert@example.com", "CorrectHorseBatteryStaple!1")

	// 1. Upsert mới -> 201 Created; upsert lại cùng normalized -> 200 OK giữ nguyên display gốc.
	secretDisplay := "Tài Chính Cá Nhân"
	idemFirst := newIdemKey()
	r1, b1 := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, secretDisplay), contenttest.ReqOptions{
		IdemKey: idemFirst,
	})
	if r1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST /tags status = %d, want 201 (body=%s)", r1.StatusCode, b1)
	}
	if gotCC := r1.Header.Get("Cache-Control"); gotCC != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", gotCC)
	}
	tag1 := decodeTag(t, b1)
	if tag1.Display != secretDisplay || tag1.ItemCount != 0 || tag1.ID == uuid.Nil {
		t.Fatalf("created tag mismatch: %+v", tag1)
	}

	// Replay cùng Idempotency-Key -> trả lại 201 gốc.
	rReplay, bReplay := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, secretDisplay), contenttest.ReqOptions{
		IdemKey: idemFirst,
	})
	if rReplay.StatusCode != http.StatusCreated {
		t.Fatalf("replay POST /tags status = %d, want 201 (body=%s)", rReplay.StatusCode, bReplay)
	}
	contenttest.AssertJSONEqual(t, b1, bReplay)

	// Upsert mới với biến thể chữ hoa + khoảng trắng + dấu câu bọc ngoài -> 200 OK, cùng ID và giữ nguyên display.
	r2, b2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"  #TÀI   CHÍNH CÁ NHÂN!! "}`)
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("second POST /tags same normalized status = %d, want 200 (body=%s)", r2.StatusCode, b2)
	}
	tag2 := decodeTag(t, b2)
	if tag2.ID != tag1.ID || tag2.Display != secretDisplay {
		t.Fatalf("second POST /tags got %+v, want id=%s display=%q", tag2, tag1.ID, secretDisplay)
	}

	// Kiểm tra giới hạn 1..50 rune và lỗi 400 tag_display_invalid / invalid_request.
	runes50 := strings.Repeat("đ", 50)
	runes51 := strings.Repeat("đ", 51)
	r50, b50 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, runes50))
	if r50.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tags 50-rune status = %d, want 201 (body=%s)", r50.StatusCode, b50)
	}
	r51, b51 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, runes51))
	if r51.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, b51).Code != "tag_display_invalid" {
		t.Fatalf("POST /tags 51-rune: status=%d body=%s, want 400 tag_display_invalid", r51.StatusCode, b51)
	}
	rPunct, bPunct := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"###!!!"}`)
	if rPunct.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, bPunct).Code != "tag_display_invalid" {
		t.Fatalf("POST /tags punct-only: status=%d body=%s, want 400 tag_display_invalid", rPunct.StatusCode, bPunct)
	}
	rUnknown, bUnknown := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"ok","extra":1}`)
	if rUnknown.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, bUnknown).Code != "invalid_request" {
		t.Fatalf("POST /tags unknown field: status=%d body=%s, want 400 invalid_request", rUnknown.StatusCode, bUnknown)
	}

	advanceRateLimitWindow(h)

	// 2. Hai upsert song song cùng normalized chỉ tạo một hàng (barrier giữa hai bước của upsert #1).
	bPar := setBarrier(1)
	type reqRes struct {
		resp contenttest.TestResponse
		body string
	}
	chPar1 := make(chan reqRes, 1)
	chPar2 := make(chan reqRes, 1)

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"Song Song"}`)
		chPar1 <- reqRes{resp: resp, body: body}
	}()

	select {
	case <-bPar.enteredCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for parallel upsert #1 to reach OnBetweenUpsertSteps barrier")
	}

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"  SONG SONG! "}`)
		chPar2 <- reqRes{resp: resp, body: body}
	}()

	awaitUserContentLockWaiter(t, h, userA.User.ID)
	setBarrier(0)

	resPar1 := <-chPar1
	resPar2 := <-chPar2
	if resPar1.resp.StatusCode != http.StatusCreated || resPar2.resp.StatusCode != http.StatusOK {
		t.Fatalf("parallel upserts: req1=%d (%s) req2=%d (%s), want 201 and 200",
			resPar1.resp.StatusCode, resPar1.body, resPar2.resp.StatusCode, resPar2.body)
	}
	tPar1 := decodeTag(t, resPar1.body)
	tPar2 := decodeTag(t, resPar2.body)
	if tPar1.ID != tPar2.ID || tPar2.Display != "Song Song" {
		t.Fatalf("parallel upserts returned different tags: %+v vs %+v", tPar1, tPar2)
	}

	var countSongSong int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM tag WHERE user_id = $1 AND normalized = 'song song'`,
		userA.User.ID,
	).Scan(&countSongSong); err != nil {
		t.Fatal(err)
	}
	if countSongSong != 1 {
		t.Fatalf("expected exactly 1 row for 'song song', got %d", countSongSong)
	}

	advanceRateLimitWindow(h)

	// 3. P4BE1-6 (a): Upsert đang ở barrier giữa bước SELECT (đã thấy `tPar1`) và trả về,
	// trong khi `PATCH /tags/{id}` (rename) chạy song song -> PATCH phải đợi `LockUserContent`
	// trên `pg_locks`, không thể xen vào giữa hai bước của upsert; cả hai trả kết quả hợp lệ.
	bRaceA := setBarrier(2)
	chUpsertRace := make(chan reqRes, 1)
	chRenameRace := make(chan reqRes, 1)

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"song song"}`)
		chUpsertRace <- reqRes{resp: resp, body: body}
	}()

	select {
	case <-bRaceA.enteredCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for upsert in P4BE1-6(a) to enter barrier")
	}

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tPar1.ID.String(), `{"display":"Đã Đổi Tên"}`)
		chRenameRace <- reqRes{resp: resp, body: body}
	}()

	awaitUserContentLockWaiter(t, h, userA.User.ID)
	setBarrier(0)

	resUpsertRace := <-chUpsertRace
	resRenameRace := <-chRenameRace
	if resUpsertRace.resp.StatusCode != http.StatusOK || resRenameRace.resp.StatusCode != http.StatusOK {
		t.Fatalf("P4BE1-6(a) statuses: upsert=%d (%s) rename=%d (%s), want 200 and 200",
			resUpsertRace.resp.StatusCode, resUpsertRace.body, resRenameRace.resp.StatusCode, resRenameRace.body)
	}

	// 4. P4BE1-6 (b): `DELETE /tags/{id}` giữ `LockUserContent` trong khi `POST /tags` (cùng normalized
	// `"đã đổi tên"`) chạy song song -> sau khi DELETE xong, `POST /tags` tạo tag sống mới (201),
	// không bao giờ trả về tag đã xoá hay 500.
	bRaceB := setBarrier(3)
	chDelRace := make(chan reqRes, 1)
	chUpsertAfterDel := make(chan reqRes, 1)

	go func() {
		resp, body := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tPar1.ID.String(), "")
		chDelRace <- reqRes{resp: resp, body: body}
	}()

	select {
	case <-bRaceB.enteredCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for DELETE /tags/{id} to enter LockUserContent barrier")
	}

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"Đã Đổi Tên"}`)
		chUpsertAfterDel <- reqRes{resp: resp, body: body}
	}()

	awaitUserContentLockWaiter(t, h, userA.User.ID)
	setBarrier(0)

	resDelRace := <-chDelRace
	resUpsertAfterDel := <-chUpsertAfterDel
	if resDelRace.resp.StatusCode != http.StatusNoContent {
		t.Fatalf("P4BE1-6(b) delete status = %d (%s), want 204", resDelRace.resp.StatusCode, resDelRace.body)
	}
	if resUpsertAfterDel.resp.StatusCode != http.StatusCreated {
		t.Fatalf("P4BE1-6(b) upsert status = %d (%s), want 201 new live tag", resUpsertAfterDel.resp.StatusCode, resUpsertAfterDel.body)
	}
	newLiveTag := decodeTag(t, resUpsertAfterDel.body)
	if newLiveTag.ID == tPar1.ID {
		t.Fatalf("P4BE1-6(b) upsert returned soft-deleted tag ID %s", tPar1.ID)
	}

	advanceRateLimitWindow(h)

	// 5. P4BE1-6 (c): Lưới an toàn unique index `tag_user_norm_uq` (`23505`) giữa hai bước của upsert ->
	// map `503 dependency_unavailable` + `Retry-After: 1` (không bao giờ 500), và retry cùng Idempotency-Key
	// trả `200 OK` với đúng tag sống đã chèn.
	b23505 := setBarrier(4)
	idem23505 := newIdemKey()
	ch23505 := make(chan reqRes, 1)

	go func() {
		resp, body := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", `{"display":"SafetyNetTag"}`, contenttest.ReqOptions{
			IdemKey: idem23505,
		})
		ch23505 <- reqRes{resp: resp, body: body}
	}()

	select {
	case <-b23505.enteredCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for 23505 safety-net upsert to reach barrier")
	}

	// Chèn trực tiếp một hàng sống có cùng `(user_id, normalized)` trước khi bước InsertTag của handler chạy.
	seededTag, err := gen.New(h.Pool).InsertTag(context.Background(), gen.InsertTagParams{
		UserID:     userA.User.ID,
		Display:    "SafetyNetTag",
		Normalized: "safetynettag",
	})
	if err != nil {
		t.Fatalf("seed conflicting tag for 23505 safety net: %v", err)
	}

	setBarrier(0)

	res23505 := <-ch23505
	if res23505.resp.StatusCode != http.StatusServiceUnavailable || res23505.resp.Header.Get("Retry-After") != "1" {
		t.Fatalf("23505 on tag_user_norm_uq: status=%d Retry-After=%q body=%s, want 503 with Retry-After=1",
			res23505.resp.StatusCode, res23505.resp.Header.Get("Retry-After"), res23505.body)
	}
	if prob := contenttest.DecodeProblem(t, res23505.body); prob.Code != "dependency_unavailable" {
		t.Fatalf("23505 problem code = %q, want dependency_unavailable", prob.Code)
	}

	// Retry cùng Idempotency-Key sau 503 -> 200 OK trả về đúng seededTag đang sống.
	rRetry, bRetry := h.DoReq(jarA, http.MethodPost, "/api/v1/tags", `{"display":"SafetyNetTag"}`, contenttest.ReqOptions{
		IdemKey: idem23505,
	})
	if rRetry.StatusCode != http.StatusOK {
		t.Fatalf("retry after 23505 status = %d (%s), want 200", rRetry.StatusCode, bRetry)
	}
	retriedTag := decodeTag(t, bRetry)
	if retriedTag.ID != seededTag.ID {
		t.Fatalf("retried tag ID = %s, want %s", retriedTag.ID, seededTag.ID)
	}

	assertNoPlaintextInLogs(t, h.Logs, secretDisplay, "Song Song", "Đã Đổi Tên")
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestTagRenameAndConflict kiểm tra:
//   - `PATCH /tags/{id} {display}` đổi display/normalized -> 200 Tag.
//   - Đổi cách viết hoa của chính tag đó (cùng normalized) -> 200 Tag.
//   - Normalized trùng với một tag sống khác của cùng user -> `409 tag_conflict`.
//   - Normalized trùng với tag đã soft-delete hoặc của user khác -> 200 Tag.
func TestTagRenameAndConflict(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	rA1, bA1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"work"}`)
	if rA1.StatusCode != http.StatusCreated {
		t.Fatalf("create tag work: %d %s", rA1.StatusCode, bA1)
	}
	tagWork := decodeTag(t, bA1)

	rA2, bA2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"home"}`)
	if rA2.StatusCode != http.StatusCreated {
		t.Fatalf("create tag home: %d %s", rA2.StatusCode, bA2)
	}
	tagHome := decodeTag(t, bA2)

	// User B tạo tag "shared-norm" -> không cản trở User A đổi tên sang "shared-norm".
	rB, bB := doWrite(h, jarB, http.MethodPost, "/api/v1/tags", `{"display":"shared-norm"}`)
	if rB.StatusCode != http.StatusCreated {
		t.Fatalf("user B create tag: %d %s", rB.StatusCode, bB)
	}

	// 1. Đổi tên sang normalized của tag sống khác (`tagWork` -> `"  HOME! "`) -> 409 tag_conflict.
	rConflict, bConflict := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tagWork.ID.String(), `{"display":"  HOME! "}`)
	if rConflict.StatusCode != http.StatusConflict {
		t.Fatalf("rename to existing live normalized status = %d, want 409 (body=%s)", rConflict.StatusCode, bConflict)
	}
	if prob := contenttest.DecodeProblem(t, bConflict); prob.Code != "tag_conflict" {
		t.Fatalf("rename conflict code = %q, want tag_conflict", prob.Code)
	}

	// 2. Đổi cách viết hoa của chính nó (`"work"` -> `"Work"`) -> 200 OK.
	rSelf, bSelf := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tagWork.ID.String(), `{"display":"Work"}`)
	if rSelf.StatusCode != http.StatusOK {
		t.Fatalf("self-case rename status = %d, want 200 (body=%s)", rSelf.StatusCode, bSelf)
	}
	if got := decodeTag(t, bSelf); got.Display != "Work" || got.ID != tagWork.ID {
		t.Fatalf("self-case rename got %+v", got)
	}

	// 3. Xoá mềm `tagHome`, sau đó đổi tên `tagWork` sang `"Home"` -> 200 OK (vì `tagHome` đã xoá).
	rDelHome, bDelHome := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tagHome.ID.String(), "")
	if rDelHome.StatusCode != http.StatusNoContent {
		t.Fatalf("delete tagHome status = %d, body=%s", rDelHome.StatusCode, bDelHome)
	}
	rToHome, bToHome := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tagWork.ID.String(), `{"display":"Home"}`)
	if rToHome.StatusCode != http.StatusOK {
		t.Fatalf("rename to soft-deleted normalized status = %d, want 200 (body=%s)", rToHome.StatusCode, bToHome)
	}
	if got := decodeTag(t, bToHome); got.Display != "Home" {
		t.Fatalf("expected display='Home', got %+v", got)
	}

	// 4. Đổi tên tag đã xoá (`tagHome`) -> 404 not_found.
	rRenDel, bRenDel := doWrite(h, jarA, http.MethodPatch, "/api/v1/tags/"+tagHome.ID.String(), `{"display":"ResurrectByRename"}`)
	if rRenDel.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bRenDel).Code != "not_found" {
		t.Fatalf("rename soft-deleted tag: status=%d body=%s, want 404 not_found", rRenDel.StatusCode, bRenDel)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}

// TestAssignItemTagsLimit20ParallelFrom19AndAdditiveSnapshot kiểm tra:
//   - Gán 20 tag ok, tag 21 -> `409 item_tag_limit`.
//   - Hai request gán song song từ 19 tag (mỗi request thêm 1 tag khác nhau) -> đúng một thành công, tổng 20 (A2).
//   - Gán cộng dồn từ snapshot cũ không gỡ tag thiết bị khác vừa thêm; `item_count` chỉ +1 cho cặp mới;
//     gán/gỡ tag không tăng `item.version`.
//   - `DELETE /items/{id}/tags/{tag_id}` -> 200 ItemSummary; gỡ cặp không tồn tại -> 200 không đổi gì.
func TestAssignItemTagsLimit20ParallelFrom19AndAdditiveSnapshot(t *testing.T) {
	var (
		parallelAssignBarrier atomic.Bool
		enteredCh             = make(chan struct{}, 2)
		releaseCh             = make(chan struct{})
		releaseOnce           sync.Once
	)
	closeRelease := func() {
		releaseOnce.Do(func() {
			close(releaseCh)
		})
	}
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	t.Cleanup(closeRelease)

	taghttp.RegisterTestHooks(t, &taghttp.TestHooks{
		OnLockUserContent: func(ctx context.Context, _ uuid.UUID, op string) {
			if parallelAssignBarrier.Load() && op == "itemTagsAdd" {
				enteredCh <- struct{}{}
				select {
				case <-releaseCh:
				case <-ctx.Done():
				}
			}
		},
	})

	jarA, userA := h.SignupUser("assign-tags@example.com", "CorrectHorseBatteryStaple!1")

	// Tạo 21 tag qua API (nhịp advance clock mỗi 5 lần ghi để không chạm rate limit 10 rps).
	tags := make([]tag.Tag, 21)
	for i := range 21 {
		if i%5 == 0 {
			advanceRateLimitWindow(h)
		}
		disp := fmt.Sprintf("tag-%02d", i+1)
		r, b := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, disp))
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create tag %d: status=%d body=%s", i+1, r.StatusCode, b)
		}
		tags[i] = decodeTag(t, b)
	}

	advanceRateLimitWindow(h)
	rItem1, bItem1 := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item 20 Tags"}`)
	if rItem1.StatusCode != http.StatusCreated {
		t.Fatalf("create item1: %d %s", rItem1.StatusCode, bItem1)
	}
	item1 := decodeItemSummary(t, bItem1)

	// 1. Gán 20 tag cùng lúc -> 200 OK, item.version giữ nguyên 1.
	first20IDs := make([]string, 20)
	for i := range 20 {
		first20IDs[i] = tags[i].ID.String()
	}
	req20Bytes, _ := json.Marshal(map[string]any{"tag_ids": first20IDs})
	rAssign20, bAssign20 := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item1.ID.String()+"/tags", string(req20Bytes))
	if rAssign20.StatusCode != http.StatusOK {
		t.Fatalf("assign 20 tags status = %d, want 200 (body=%s)", rAssign20.StatusCode, bAssign20)
	}
	sum20 := decodeItemSummary(t, bAssign20)
	if len(sum20.Tags) != 20 || sum20.Version != 1 {
		t.Fatalf("after assigning 20 tags: len(tags)=%d version=%d, want 20 and 1", len(sum20.Tags), sum20.Version)
	}

	// Gán tag thứ 21 -> 409 item_tag_limit.
	rAssign21, bAssign21 := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item1.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, tags[20].ID.String()))
	if rAssign21.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bAssign21).Code != "item_tag_limit" {
		t.Fatalf("assign 21st tag: status=%d body=%s, want 409 item_tag_limit", rAssign21.StatusCode, bAssign21)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2. Hai request gán song song từ 19 tag (mỗi request thêm 1 tag khác nhau) -> đúng 1 thành công, tổng 20 (A2).
	advanceRateLimitWindow(h)
	rItem2, bItem2 := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item Parallel 19->20"}`)
	if rItem2.StatusCode != http.StatusCreated {
		t.Fatalf("create item2: %d %s", rItem2.StatusCode, bItem2)
	}
	item2 := decodeItemSummary(t, bItem2)

	first19IDs := first20IDs[:19]
	req19Bytes, _ := json.Marshal(map[string]any{"tag_ids": first19IDs})
	rAssign19, bAssign19 := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item2.ID.String()+"/tags", string(req19Bytes))
	if rAssign19.StatusCode != http.StatusOK {
		t.Fatalf("assign 19 tags to item2: %d %s", rAssign19.StatusCode, bAssign19)
	}

	parallelAssignBarrier.Store(true)
	type reqRes struct {
		resp contenttest.TestResponse
		body string
	}
	chA := make(chan reqRes, 1)
	chB := make(chan reqRes, 1)

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item2.ID.String()+"/tags",
			fmt.Sprintf(`{"tag_ids":[%q]}`, tags[19].ID.String()))
		chA <- reqRes{resp: resp, body: body}
	}()

	select {
	case <-enteredCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for first parallel assign to acquire LockUserContent")
	}

	go func() {
		resp, body := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item2.ID.String()+"/tags",
			fmt.Sprintf(`{"tag_ids":[%q]}`, tags[20].ID.String()))
		chB <- reqRes{resp: resp, body: body}
	}()

	awaitUserContentLockWaiter(t, h, userA.User.ID)
	parallelAssignBarrier.Store(false)
	closeRelease()

	resA := <-chA
	resB := <-chB
	if !((resA.resp.StatusCode == http.StatusOK && resB.resp.StatusCode == http.StatusConflict) ||
		(resA.resp.StatusCode == http.StatusConflict && resB.resp.StatusCode == http.StatusOK)) {
		t.Fatalf("parallel assigns from 19 tags: A=%d (%s) B=%d (%s), want one 200 and one 409",
			resA.resp.StatusCode, resA.body, resB.resp.StatusCode, resB.body)
	}
	var winnerBody, loserBody string
	if resA.resp.StatusCode == http.StatusOK {
		winnerBody, loserBody = resA.body, resB.body
	} else {
		winnerBody, loserBody = resB.body, resA.body
	}
	if prob := contenttest.DecodeProblem(t, loserBody); prob.Code != "item_tag_limit" {
		t.Fatalf("losing parallel assign code = %q, want item_tag_limit", prob.Code)
	}
	winSum := decodeItemSummary(t, winnerBody)
	if len(winSum.Tags) != 20 {
		t.Fatalf("winning parallel assign tags len = %d, want 20", len(winSum.Tags))
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 3. Gán cộng dồn từ snapshot cũ không gỡ tag thiết bị khác vừa thêm;
	// cập nhật `item_count` (+1 chỉ cho cặp mới) và `last_used_at`.
	advanceRateLimitWindow(h)
	rItem3, bItem3 := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item Additive Snapshot"}`)
	if rItem3.StatusCode != http.StatusCreated {
		t.Fatalf("create item3: %d %s", rItem3.StatusCode, bItem3)
	}
	item3 := decodeItemSummary(t, bItem3)

	// Ban đầu gắn tags[0].
	rInit, bInit := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item3.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, tags[0].ID.String()))
	if rInit.StatusCode != http.StatusOK {
		t.Fatalf("attach tags[0] to item3: %d %s", rInit.StatusCode, bInit)
	}

	// Thiết bị B gắn thêm tags[1].
	rDevB, bDevB := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item3.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, tags[1].ID.String()))
	if rDevB.StatusCode != http.StatusOK {
		t.Fatalf("device B attach tags[1] to item3: %d %s", rDevB.StatusCode, bDevB)
	}

	// Thiết bị A (nhìn snapshot cũ chỉ có tags[0]) gửi `[tags[0], tags[2]]`.
	h.Clock.Advance(10 * time.Minute)
	wantTouchTime := h.Clock.Now().UTC()
	rDevA, bDevA := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item3.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q,%q]}`, tags[0].ID.String(), tags[2].ID.String()))
	if rDevA.StatusCode != http.StatusOK {
		t.Fatalf("device A additive attach [tags[0], tags[2]]: %d %s", rDevA.StatusCode, bDevA)
	}
	sumItem3 := decodeItemSummary(t, bDevA)
	if len(sumItem3.Tags) != 3 ||
		sumItem3.Tags[0].ID != tags[0].ID ||
		sumItem3.Tags[1].ID != tags[1].ID ||
		sumItem3.Tags[2].ID != tags[2].ID {
		t.Fatalf("additive assign must keep tags[1] and add tags[2], got %+v", sumItem3.Tags)
	}

	// Kiểm tra last_used_at của tags[2] đã được cập nhật lên wantTouchTime, và item_count của cả 3 tag đều bằng 3 (item1, item2, item3).
	t2Row, err := gen.New(h.Pool).GetTagByUserAndID(context.Background(), gen.GetTagByUserAndIDParams{
		UserID: userA.User.ID,
		ID:     tags[2].ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !t2Row.LastUsedAt.Time.UTC().Equal(wantTouchTime) || t2Row.ItemCount != 3 {
		t.Fatalf("tags[2] after additive assign: last_used_at=%v (want %v) item_count=%d (want 3)",
			t2Row.LastUsedAt.Time.UTC(), wantTouchTime, t2Row.ItemCount)
	}

	// 4. DELETE /items/{id}/tags/{tag_id} -> 200 ItemSummary; gỡ cặp không có -> vẫn 200 không đổi gì.
	advanceRateLimitWindow(h)
	rRem1, bRem1 := doWrite(h, jarA, http.MethodDelete, "/api/v1/items/"+item3.ID.String()+"/tags/"+tags[1].ID.String(), "")
	if rRem1.StatusCode != http.StatusOK {
		t.Fatalf("remove tags[1] from item3: %d %s", rRem1.StatusCode, bRem1)
	}
	sumAfterRem := decodeItemSummary(t, bRem1)
	if len(sumAfterRem.Tags) != 2 || sumAfterRem.Version != 1 {
		t.Fatalf("after removing tags[1]: len(tags)=%d version=%d, want 2 and 1", len(sumAfterRem.Tags), sumAfterRem.Version)
	}

	// Gỡ lại cùng cặp đã gỡ -> 200 OK, item_count của tags[1] không bị trừ lần hai.
	rRem2, bRem2 := doWrite(h, jarA, http.MethodDelete, "/api/v1/items/"+item3.ID.String()+"/tags/"+tags[1].ID.String(), "")
	if rRem2.StatusCode != http.StatusOK {
		t.Fatalf("repeat remove absent pair status = %d, want 200 (body=%s)", rRem2.StatusCode, bRem2)
	}

	// Validation: tag_ids rỗng hoặc trùng UUID trong cùng mảng -> 400 invalid_request.
	rEmptyArr, bEmptyArr := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item3.ID.String()+"/tags", `{"tag_ids":[]}`)
	if rEmptyArr.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, bEmptyArr).Code != "invalid_request" {
		t.Fatalf("empty tag_ids: status=%d body=%s, want 400 invalid_request", rEmptyArr.StatusCode, bEmptyArr)
	}
	rDupArr, bDupArr := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+item3.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q,%q]}`, tags[0].ID.String(), tags[0].ID.String()))
	if rDupArr.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, bDupArr).Code != "invalid_request" {
		t.Fatalf("duplicate tag_ids: status=%d body=%s, want 400 invalid_request", rDupArr.StatusCode, bDupArr)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestTagDeleteKeepsItemsAndRestoreConflictsAndLimits kiểm tra:
//   - Xoá tag không xoá item, item vẫn còn và `item_count` của tag khác không đổi;
//     `item_tag` giữ nguyên và `item_count` của chính tag bị xoá giữ nguyên; xoá lặp lại -> 204.
//   - Restore tag khi normalized đã bị chiếm bởi tag sống khác -> `409 tag_conflict`.
//   - Restore tag làm bất kỳ item sống nào vượt 20 tag sống -> `409 item_tag_limit`, không restore một phần.
//   - Restore tag đang sống -> 200 không đổi gì.
func TestTagDeleteKeepsItemsAndRestoreConflictsAndLimits(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA := h.SignupUser("delete-restore-tag@example.com", "CorrectHorseBatteryStaple!1")

	// Tạo 2 item sống: `itemPartial` và `itemFull`.
	rItP, bItP := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item Partial"}`)
	if rItP.StatusCode != http.StatusCreated {
		t.Fatalf("create itemPartial: %d %s", rItP.StatusCode, bItP)
	}
	itemPartial := decodeItemSummary(t, bItP)

	rItF, bItF := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Item Full"}`)
	if rItF.StatusCode != http.StatusCreated {
		t.Fatalf("create itemFull: %d %s", rItF.StatusCode, bItF)
	}
	itemFull := decodeItemSummary(t, bItF)

	// Tạo 21 tag T1..T21.
	tags := make([]tag.Tag, 21)
	for i := range 21 {
		if i%5 == 0 {
			advanceRateLimitWindow(h)
		}
		disp := fmt.Sprintf("restore-tag-%02d", i+1)
		r, b := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, disp))
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create tag %d: %d %s", i+1, r.StatusCode, b)
		}
		tags[i] = decodeTag(t, b)
	}

	advanceRateLimitWindow(h)

	// Gắn T1 và T2 cho `itemPartial`; gắn T1..T20 cho `itemFull`.
	rAddP, bAddP := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+itemPartial.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q,%q]}`, tags[0].ID.String(), tags[1].ID.String()))
	if rAddP.StatusCode != http.StatusOK {
		t.Fatalf("assign T1,T2 to itemPartial: %d %s", rAddP.StatusCode, bAddP)
	}

	first20IDs := make([]string, 20)
	for i := range 20 {
		first20IDs[i] = tags[i].ID.String()
	}
	req20Bytes, _ := json.Marshal(map[string]any{"tag_ids": first20IDs})
	rAddF, bAddF := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+itemFull.ID.String()+"/tags", string(req20Bytes))
	if rAddF.StatusCode != http.StatusOK {
		t.Fatalf("assign T1..T20 to itemFull: %d %s", rAddF.StatusCode, bAddF)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 1. Xoá mềm T1 -> 204; xoá lặp lại -> 204.
	rDelT1, bDelT1 := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tags[0].ID.String(), "")
	if rDelT1.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE T1 status = %d, want 204 (body=%s)", rDelT1.StatusCode, bDelT1)
	}
	rDelT1Again, bDelT1Again := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+tags[0].ID.String(), "")
	if rDelT1Again.StatusCode != http.StatusNoContent {
		t.Fatalf("repeat DELETE T1 status = %d, want 204 (body=%s)", rDelT1Again.StatusCode, bDelT1Again)
	}

	// Xác minh cả 2 item vẫn sống, `itemPartial` còn hiện T2, `T2.item_count` vẫn = 2, và `T1.item_count` trong DB vẫn = 2.
	rGetP, bGetP := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+itemPartial.ID.String(), "", contenttest.ReqOptions{})
	if rGetP.StatusCode != http.StatusOK {
		t.Fatalf("GET itemPartial after deleting T1: %d %s", rGetP.StatusCode, bGetP)
	}
	gotP := decodeItemSummary(t, bGetP)
	if len(gotP.Tags) != 1 || gotP.Tags[0].ID != tags[1].ID {
		t.Fatalf("itemPartial live tags after deleting T1 = %+v, want only T2", gotP.Tags)
	}
	q := gen.New(h.Pool)
	t1Row, err := q.GetTagByUserAndID(context.Background(), gen.GetTagByUserAndIDParams{UserID: userA.User.ID, ID: tags[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	t2Row, err := q.GetTagByUserAndID(context.Background(), gen.GetTagByUserAndIDParams{UserID: userA.User.ID, ID: tags[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	if !t1Row.DeletedAt.Valid || t1Row.ItemCount != 2 || t2Row.ItemCount != 2 {
		t.Fatalf("counters after T1 delete: T1=(deleted=%v, count=%d) T2=(count=%d), want true, 2, 2",
			t1Row.DeletedAt.Valid, t1Row.ItemCount, t2Row.ItemCount)
	}
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)

	// 2. Tạo một tag sống mới trùng normalized với T1 (`"restore-tag-01"`) -> 201 Created.
	// Khi đó restore T1 phải bị chặn với `409 tag_conflict`.
	advanceRateLimitWindow(h)
	rTakeNorm, bTakeNorm := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"RESTORE-TAG-01"}`)
	if rTakeNorm.StatusCode != http.StatusCreated {
		t.Fatalf("create conflicting live tag for T1: %d %s", rTakeNorm.StatusCode, bTakeNorm)
	}
	usurperTag := decodeTag(t, bTakeNorm)

	rRestConflict, bRestConflict := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tags[0].ID.String()+"/restore", `{}`)
	if rRestConflict.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bRestConflict).Code != "tag_conflict" {
		t.Fatalf("restore T1 while normalized is taken: status=%d body=%s, want 409 tag_conflict",
			rRestConflict.StatusCode, bRestConflict)
	}

	// Xoá mềm usurperTag để giải phóng normalized.
	rDelUsurper, bDelUsurper := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+usurperTag.ID.String(), "")
	if rDelUsurper.StatusCode != http.StatusNoContent {
		t.Fatalf("delete usurperTag: %d %s", rDelUsurper.StatusCode, bDelUsurper)
	}

	// 3. Gắn thêm T21 vào `itemFull` (hiện đang có 19 tag sống T2..T20 -> thành 20 tag sống).
	// Lúc này `itemPartial` chỉ có 1 tag sống (T2), nhưng `itemFull` đã có 20 tag sống.
	// Restore T1 phải bị từ chối với `409 item_tag_limit` và KHÔNG restore một phần (T1 vẫn xoá, `itemPartial` vẫn chỉ có 1 tag sống).
	rAddT21, bAddT21 := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+itemFull.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, tags[20].ID.String()))
	if rAddT21.StatusCode != http.StatusOK {
		t.Fatalf("attach T21 to itemFull: %d %s", rAddT21.StatusCode, bAddT21)
	}

	rRestLimit, bRestLimit := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tags[0].ID.String()+"/restore", `{}`)
	if rRestLimit.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, bRestLimit).Code != "item_tag_limit" {
		t.Fatalf("restore T1 when itemFull has 20 live tags: status=%d body=%s, want 409 item_tag_limit",
			rRestLimit.StatusCode, bRestLimit)
	}

	// Xác minh không có partial restore: T1 vẫn soft-deleted và `itemPartial` vẫn chỉ có 1 tag sống (T2).
	t1AfterReject, err := q.GetTagByUserAndID(context.Background(), gen.GetTagByUserAndIDParams{UserID: userA.User.ID, ID: tags[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if !t1AfterReject.DeletedAt.Valid {
		t.Fatalf("T1 must remain soft-deleted after 409 item_tag_limit, got %+v", t1AfterReject)
	}
	rGetPAfter, bGetPAfter := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+itemPartial.ID.String(), "", contenttest.ReqOptions{})
	if rGetPAfter.StatusCode != http.StatusOK {
		t.Fatalf("GET itemPartial after rejected restore: %d %s", rGetPAfter.StatusCode, bGetPAfter)
	}
	if got := decodeItemSummary(t, bGetPAfter); len(got.Tags) != 1 || got.Tags[0].ID != tags[1].ID {
		t.Fatalf("itemPartial must not partially see T1 after rejected restore: %+v", got.Tags)
	}

	// 4. Gỡ T21 khỏi `itemFull` (còn 19 tag sống) rồi restore T1 -> 200 OK, `item_count` = 2;
	// restore lặp lại trên T1 đang sống -> 200 OK không đổi gì.
	advanceRateLimitWindow(h)
	rRemT21, bRemT21 := doWrite(h, jarA, http.MethodDelete, "/api/v1/items/"+itemFull.ID.String()+"/tags/"+tags[20].ID.String(), "")
	if rRemT21.StatusCode != http.StatusOK {
		t.Fatalf("remove T21 from itemFull: %d %s", rRemT21.StatusCode, bRemT21)
	}

	rRestOK, bRestOK := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tags[0].ID.String()+"/restore", `{}`)
	if rRestOK.StatusCode != http.StatusOK {
		t.Fatalf("restore T1 after freeing slot: status=%d body=%s, want 200", rRestOK.StatusCode, bRestOK)
	}
	restoredT1 := decodeTag(t, bRestOK)
	if restoredT1.ID != tags[0].ID || restoredT1.ItemCount != 2 {
		t.Fatalf("restored T1 = %+v, want id=%s item_count=2", restoredT1, tags[0].ID)
	}

	rRestRepeat, bRestRepeat := doWrite(h, jarA, http.MethodPost, "/api/v1/tags/"+tags[0].ID.String()+"/restore", `{}`)
	if rRestRepeat.StatusCode != http.StatusOK {
		t.Fatalf("repeat restore live T1 status = %d, want 200 (body=%s)", rRestRepeat.StatusCode, bRestRepeat)
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
}

// TestTagsListPrefixQuerySortAndPagination kiểm tra:
//   - `GET /tags?q=nh` chỉ trả các tag sống của chính user bắt đầu bằng `nh`.
//   - `q` escape `%`, `_`, `\`; `q` > 50 rune hoặc rỗng sau chuẩn hoá -> `400 tag_display_invalid`.
//   - Phân trang keyset theo `sort=recent` và `sort=alpha`; cursor đổi `sort` hoặc `q` -> `400 invalid_request`.
func TestTagsListPrefixQuerySortAndPagination(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	// Danh sách rỗng ban đầu -> {items: [], next_cursor: null}.
	rEmpty, bEmpty := h.DoReq(jarA, http.MethodGet, "/api/v1/tags", "", contenttest.ReqOptions{})
	if rEmpty.StatusCode != http.StatusOK || !strings.Contains(bEmpty, `"items":[]`) {
		t.Fatalf("empty GET /tags: status=%d body=%s", rEmpty.StatusCode, bEmpty)
	}

	// User B tạo tag bắt đầu bằng "nh" -> không bao giờ xuất hiện trong kết quả của User A.
	rB, bB := doWrite(h, jarB, http.MethodPost, "/api/v1/tags", `{"display":"nhà của B"}`)
	if rB.StatusCode != http.StatusCreated {
		t.Fatalf("user B create tag: %d %s", rB.StatusCode, bB)
	}

	// User A tạo các tag để kiểm tra prefix `nh` và escape `%`, `_`, `\`.
	displays := []string{
		"nhà cửa",
		"Nha Khoa",
		"nhân sự",
		"nháp xoá",
		"công nghệ",
		"rate 100% max",
		"rate 100abc max",
		"env_prod",
		"envXprod",
		`path\sub`,
		`pathXsub`,
	}
	createdByDisplay := make(map[string]tag.Tag, len(displays))
	for i, d := range displays {
		if i%5 == 0 {
			advanceRateLimitWindow(h)
		}
		rawReq, _ := json.Marshal(map[string]string{"display": d})
		r, b := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", string(rawReq))
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create tag %q: %d %s", d, r.StatusCode, b)
		}
		createdByDisplay[d] = decodeTag(t, b)
	}

	// Xoá mềm tag "nháp xoá" -> không được xuất hiện trong `GET /tags?q=nh`.
	advanceRateLimitWindow(h)
	rDel, bDel := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+createdByDisplay["nháp xoá"].ID.String(), "")
	if rDel.StatusCode != http.StatusNoContent {
		t.Fatalf("delete 'nháp xoá': %d %s", rDel.StatusCode, bDel)
	}

	// 1. `GET /tags?q=nh&sort=alpha` -> chỉ trả 3 tag sống của User A bắt đầu bằng `nh`.
	rNH, bNH := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?q=nh&sort=alpha", "", contenttest.ReqOptions{})
	if rNH.StatusCode != http.StatusOK {
		t.Fatalf("GET /tags?q=nh status = %d, body=%s", rNH.StatusCode, bNH)
	}
	pageNH := decodeTagList(t, bNH)
	if len(pageNH.Items) != 3 {
		t.Fatalf("GET /tags?q=nh got %d items (%+v), want 3", len(pageNH.Items), pageNH.Items)
	}
	wantIDs := map[uuid.UUID]bool{
		createdByDisplay["nhà cửa"].ID:  true,
		createdByDisplay["Nha Khoa"].ID: true,
		createdByDisplay["nhân sự"].ID:  true,
	}
	for _, tg := range pageNH.Items {
		if !wantIDs[tg.ID] {
			t.Fatalf("unexpected tag in GET /tags?q=nh: %+v", tg)
		}
	}

	// 2. Escape `%`, `_`, `\`:
	for _, tc := range []struct {
		q    string
		want string
	}{
		{q: "rate 100% m", want: "rate 100% max"},
		{q: "env_prod", want: "env_prod"},
		{q: `path\sub`, want: `path\sub`},
	} {
		rEsc, bEsc := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?q="+url.QueryEscape(tc.q), "", contenttest.ReqOptions{})
		if rEsc.StatusCode != http.StatusOK {
			t.Fatalf("GET /tags?q=%q status = %d, body=%s", tc.q, rEsc.StatusCode, bEsc)
		}
		pEsc := decodeTagList(t, bEsc)
		if len(pEsc.Items) != 1 || pEsc.Items[0].Display != tc.want {
			t.Fatalf("GET /tags?q=%q got %+v, want only %q", tc.q, pEsc.Items, tc.want)
		}
	}

	// 3. Phân trang keyset `sort=recent` và `sort=alpha` + kiểm tra cursor gắn chặt tham số.
	p1Resp, p1Body := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?sort=recent&limit=3", "", contenttest.ReqOptions{})
	if p1Resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /tags page 1 status = %d, body=%s", p1Resp.StatusCode, p1Body)
	}
	p1 := decodeTagList(t, p1Body)
	if len(p1.Items) != 3 || p1.NextCursor == nil {
		t.Fatalf("expected 3 items and non-nil next_cursor, got %+v", p1)
	}

	// Đổi sort trên cursor của recent -> 400 invalid_request.
	badSortResp, badSortBody := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?sort=alpha&limit=3&cursor="+url.QueryEscape(*p1.NextCursor), "", contenttest.ReqOptions{})
	if badSortResp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, badSortBody).Code != "invalid_request" {
		t.Fatalf("cursor with changed sort: status=%d body=%s, want 400 invalid_request", badSortResp.StatusCode, badSortBody)
	}

	// Đổi q trên cursor không có q -> 400 invalid_request.
	badQResp, badQBody := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?sort=recent&q=nh&limit=3&cursor="+url.QueryEscape(*p1.NextCursor), "", contenttest.ReqOptions{})
	if badQResp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, badQBody).Code != "invalid_request" {
		t.Fatalf("cursor with changed q: status=%d body=%s, want 400 invalid_request", badQResp.StatusCode, badQBody)
	}

	// Duyệt hết tất cả các trang với `sort=alpha&limit=3` -> đủ 10 tag sống, không trùng.
	seen := map[uuid.UUID]bool{}
	cursor := ""
	for range 10 {
		path := "/api/v1/tags?sort=alpha&limit=3"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		pr, pb := h.DoReq(jarA, http.MethodGet, path, "", contenttest.ReqOptions{})
		if pr.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, pr.StatusCode, pb)
		}
		pg := decodeTagList(t, pb)
		for _, tg := range pg.Items {
			if seen[tg.ID] {
				t.Fatalf("duplicate tag %s across pages", tg.ID)
			}
			seen[tg.ID] = true
		}
		if pg.NextCursor == nil {
			break
		}
		cursor = *pg.NextCursor
	}
	if len(seen) != 10 {
		t.Fatalf("paginated live tags total = %d, want 10", len(seen))
	}

	// 4. `q` 51 rune hoặc chỉ dấu câu -> 400 tag_display_invalid.
	q51 := strings.Repeat("a", 51)
	rQ51, bQ51 := h.DoReq(jarA, http.MethodGet, "/api/v1/tags?q="+q51, "", contenttest.ReqOptions{})
	if rQ51.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, bQ51).Code != "tag_display_invalid" {
		t.Fatalf("GET /tags?q=51-runes: status=%d body=%s, want 400 tag_display_invalid", rQ51.StatusCode, bQ51)
	}

	assertNoPlaintextInLogs(t, h.Logs, "nhà cửa", "Nha Khoa", "nhân sự")
	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}

// TestCrossTenantIsolationUserB404OnEveryTagAndItemTagRoute kiểm tra:
//   - `tag_ids` chứa tag của User B -> `404 not_found` và không ghi cặp nào (A1).
//   - User B nhận `404 not_found` trên mọi route tag (`PATCH /tags/{id}`, `DELETE /tags/{id}`,
//     `POST /tags/{id}/restore`) và mọi route item-tag (`POST /items/{id}/tags`,
//     `DELETE /items/{id}/tags/{tag_id}`) với ID của User A.
func TestCrossTenantIsolationUserB404OnEveryTagAndItemTagRoute(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, userA, jarB, userB := h.SignupTwoUsers()

	// Alice tạo 1 item, 2 tag sống (`aliceTag1`, `aliceTag2`) và 1 tag đã xoá (`aliceDeletedTag`),
	// rồi gắn `aliceTag1` vào `aliceItem`.
	rItA, bItA := doWrite(h, jarA, http.MethodPost, "/api/v1/items", `{"name":"Alice Item"}`)
	if rItA.StatusCode != http.StatusCreated {
		t.Fatalf("Alice create item: %d %s", rItA.StatusCode, bItA)
	}
	aliceItem := decodeItemSummary(t, bItA)

	rTA1, bTA1 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"alice-tag-1"}`)
	if rTA1.StatusCode != http.StatusCreated {
		t.Fatalf("Alice create tag1: %d %s", rTA1.StatusCode, bTA1)
	}
	aliceTag1 := decodeTag(t, bTA1)

	rTA2, bTA2 := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"alice-tag-2"}`)
	if rTA2.StatusCode != http.StatusCreated {
		t.Fatalf("Alice create tag2: %d %s", rTA2.StatusCode, bTA2)
	}
	aliceTag2 := decodeTag(t, bTA2)

	rTADel, bTADel := doWrite(h, jarA, http.MethodPost, "/api/v1/tags", `{"display":"alice-tag-del"}`)
	if rTADel.StatusCode != http.StatusCreated {
		t.Fatalf("Alice create tag-del: %d %s", rTADel.StatusCode, bTADel)
	}
	aliceDeletedTag := decodeTag(t, bTADel)
	if r, b := doWrite(h, jarA, http.MethodDelete, "/api/v1/tags/"+aliceDeletedTag.ID.String(), ""); r.StatusCode != http.StatusNoContent {
		t.Fatalf("Alice delete tag-del: %d %s", r.StatusCode, b)
	}

	rLinkA, bLinkA := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+aliceItem.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q]}`, aliceTag1.ID.String()))
	if rLinkA.StatusCode != http.StatusOK {
		t.Fatalf("Alice attach tag1: %d %s", rLinkA.StatusCode, bLinkA)
	}

	// Bob tạo 1 item và 1 tag sống.
	rItB, bItB := doWrite(h, jarB, http.MethodPost, "/api/v1/items", `{"name":"Bob Item"}`)
	if rItB.StatusCode != http.StatusCreated {
		t.Fatalf("Bob create item: %d %s", rItB.StatusCode, bItB)
	}
	bobItem := decodeItemSummary(t, bItB)

	rTB, bTB := doWrite(h, jarB, http.MethodPost, "/api/v1/tags", `{"display":"bob-tag"}`)
	if rTB.StatusCode != http.StatusCreated {
		t.Fatalf("Bob create tag: %d %s", rTB.StatusCode, bTB)
	}
	bobTag := decodeTag(t, bTB)

	// 1. A1: Alice gửi `tag_ids` gồm `[aliceTag2, bobTag]` -> `404 not_found` cho cả request,
	// không ghi cặp `(aliceItem, aliceTag2)` hay `(aliceItem, bobTag)`, và `aliceTag2.item_count` vẫn = 0.
	advanceRateLimitWindow(h)
	rMixed, bMixed := doWrite(h, jarA, http.MethodPost, "/api/v1/items/"+aliceItem.ID.String()+"/tags",
		fmt.Sprintf(`{"tag_ids":[%q,%q]}`, aliceTag2.ID.String(), bobTag.ID.String()))
	if rMixed.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, bMixed).Code != "not_found" {
		t.Fatalf("Alice POST /items/{id}/tags with Bob's tag: status=%d body=%s, want 404 not_found", rMixed.StatusCode, bMixed)
	}
	rGetAlice, bGetAlice := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+aliceItem.ID.String(), "", contenttest.ReqOptions{})
	if rGetAlice.StatusCode != http.StatusOK {
		t.Fatalf("Alice GET item: %d %s", rGetAlice.StatusCode, bGetAlice)
	}
	gotAlice := decodeItemSummary(t, bGetAlice)
	if len(gotAlice.Tags) != 1 || gotAlice.Tags[0].ID != aliceTag1.ID {
		t.Fatalf("Alice item tags must remain only [aliceTag1] after rejected mixed assign, got %+v", gotAlice.Tags)
	}

	// 2. User B nhận 404 not_found trên mọi route tag và item-tag với ID của User A.
	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "PATCH Alice tag",
			method: http.MethodPatch,
			path:   "/api/v1/tags/" + aliceTag1.ID.String(),
			body:   `{"display":"hacked"}`,
		},
		{
			name:   "DELETE Alice tag",
			method: http.MethodDelete,
			path:   "/api/v1/tags/" + aliceTag1.ID.String(),
			body:   "",
		},
		{
			name:   "POST restore Alice live tag",
			method: http.MethodPost,
			path:   "/api/v1/tags/" + aliceTag1.ID.String() + "/restore",
			body:   `{}`,
		},
		{
			name:   "POST restore Alice deleted tag",
			method: http.MethodPost,
			path:   "/api/v1/tags/" + aliceDeletedTag.ID.String() + "/restore",
			body:   `{}`,
		},
		{
			name:   "POST add Bob tag to Alice item",
			method: http.MethodPost,
			path:   "/api/v1/items/" + aliceItem.ID.String() + "/tags",
			body:   fmt.Sprintf(`{"tag_ids":[%q]}`, bobTag.ID.String()),
		},
		{
			name:   "POST add Alice tag to Bob item",
			method: http.MethodPost,
			path:   "/api/v1/items/" + bobItem.ID.String() + "/tags",
			body:   fmt.Sprintf(`{"tag_ids":[%q]}`, aliceTag1.ID.String()),
		},
		{
			name:   "DELETE Alice tag from Alice item",
			method: http.MethodDelete,
			path:   "/api/v1/items/" + aliceItem.ID.String() + "/tags/" + aliceTag1.ID.String(),
			body:   "",
		},
	}

	for i, tc := range cases {
		if i%5 == 0 {
			advanceRateLimitWindow(h)
		}
		resp, body := doWrite(h, jarB, tc.method, tc.path, tc.body)
		if resp.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, body).Code != "not_found" {
			t.Fatalf("User B %s (%s %s): status=%d body=%s, want 404 not_found",
				tc.name, tc.method, tc.path, resp.StatusCode, body)
		}
	}

	contenttest.AssertInvariants(t, h.Pool, userA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, userB.User.ID)
}
