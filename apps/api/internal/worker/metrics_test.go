package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

func counterValue(t *testing.T, vec *prometheus.CounterVec, labelValues ...string) float64 {
	t.Helper()
	c, err := vec.GetMetricWithLabelValues(labelValues...)
	if err != nil {
		t.Fatalf("GetMetricWithLabelValues(%v): %v", labelValues, err)
	}
	var m dto.Metric
	if err := c.Write(&m); err != nil {
		t.Fatalf("Write metric: %v", err)
	}
	return m.GetCounter().GetValue()
}

// TestErrorClassMapping: chín mã lý do của plan mục 2.21 từ lỗi Go (ErrorClass)
// và từ chuỗi lỗi mà River lưu (ErrorClassFromMessage).
func TestErrorClassMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
		// skipMsg: lỗi Go không có chuỗi mang mã nên ErrorClassFromMessage không áp dụng.
		skipMsg bool
	}{
		{name: "timeout provider error", err: &embedding.ProviderError{Class: embedding.ClassTimeout, Detail: "request deadline exceeded"}, want: "provider_timeout"},
		{name: "timeout bare deadline", err: fmt.Errorf("embed: %w", context.DeadlineExceeded), want: "provider_timeout"},
		{name: "5xx", err: &embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503, Detail: "upstream server error"}, want: "provider_5xx"},
		{name: "429", err: &embedding.ProviderError{Class: embedding.Class429, HTTPStatus: 429, Detail: "rate limited by provider"}, want: "provider_429"},
		{name: "refused provider error", err: &embedding.ProviderError{Class: embedding.ClassRefused, Detail: "network error"}, want: "provider_refused"},
		{name: "refused unknown error", err: errors.New("boom"), want: "provider_refused"},
		{name: "bad_response provider error", err: &embedding.ProviderError{Class: embedding.ClassBadResponse, Detail: "vector contains NaN or Inf", Err: embedding.ErrBadResponse}, want: "provider_bad_response"},
		{name: "bad_response sentinel", err: fmt.Errorf("wrap: %w", embedding.ErrBadResponse), want: "provider_bad_response"},
		{name: "dims", err: fmt.Errorf("%w: got 3, want 4", store.ErrDimsMismatch), want: "dims_mismatch"},
		{name: "hash", err: fmt.Errorf("target changed: %w", ErrHashStale), want: "hash_stale"},
		{name: "not receiving", err: ErrGenerationNotReceiving, want: "generation_not_receiving"},
		{name: "generation not found", err: generation.ErrGenerationNotFound, want: "generation_not_receiving", skipMsg: true},
		{name: "unconfigured", err: ErrGenerationUnconfigured, want: "generation_unconfigured"},
		{name: "calibration missing", err: fmt.Errorf("boot: %w", generation.ErrCalibrationMissing), want: "generation_unconfigured", skipMsg: true},
	}
	allowed := []string{
		"provider_timeout", "provider_5xx", "provider_429", "provider_refused", "provider_bad_response",
		"dims_mismatch", "hash_stale", "generation_not_receiving", "generation_unconfigured",
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ErrorClass(tc.err)
			if got != tc.want {
				t.Fatalf("ErrorClass = %q, want %q", got, tc.want)
			}
			if !slices.Contains(allowed, got) {
				t.Fatalf("ErrorClass %q is not one of the nine plan 2.21 codes", got)
			}
			// River chỉ giữ chuỗi lỗi: cùng mã khi chỉ còn chuỗi.
			if !tc.skipMsg {
				if msgClass := ErrorClassFromMessage(tc.err.Error()); msgClass != tc.want {
					t.Fatalf("ErrorClassFromMessage(%q) = %q, want %q", tc.err.Error(), msgClass, tc.want)
				}
			}
		})
	}
	if got := ErrorClass(nil); got != "" {
		t.Fatalf("ErrorClass(nil) = %q, want empty", got)
	}
	if got := ErrorClassFromMessage(""); got != "" {
		t.Fatalf("ErrorClassFromMessage(\"\") = %q, want empty", got)
	}
	if got := ErrorClassFromMessage("context deadline exceeded"); got != "provider_timeout" {
		t.Fatalf("ErrorClassFromMessage(deadline) = %q, want provider_timeout", got)
	}
}

func httpDo(t *testing.T, method, url string) (int, string) {
	t.Helper()
	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true},
	}
	req, err := http.NewRequestWithContext(context.Background(), method, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			t.Errorf("close body: %v", err)
		}
	}()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, string(body)
}

// countingGatherer đếm số lần registry thực sự được gom.
type countingGatherer struct {
	inner prometheus.Gatherer
	calls atomic.Int64
}

func (g *countingGatherer) Gather() ([]*dto.MetricFamily, error) {
	g.calls.Add(1)
	return g.inner.Gather()
}

// TestWorkerMetricsListenerOnlyMetrics: chỉ GET /metrics, đường dẫn khác 404,
// addr rỗng không bind, registry worker có embedding_jobs_total (Task 5 khởi
// tạo trước mọi child, FS-40), gắn registry muộn, lỗi bind và dừng gọn.
func TestWorkerMetricsListenerOnlyMetrics(t *testing.T) {
	// Registry worker = đúng thứ worker.Run tạo bằng obs.NewRegistry().
	reg, _ := obs.NewRegistry()

	t.Run("empty addr does not bind", func(t *testing.T) {
		for _, addr := range []string{"", "   "} {
			l, err := StartMetricsListener(context.Background(), addr, reg, discardLogger())
			if err != nil {
				t.Fatalf("addr %q: unexpected error: %v", addr, err)
			}
			if l != nil {
				t.Fatalf("addr %q: listener created, want nil (no bind)", addr)
			}
		}
		// Phương thức trên con trỏ nil an toàn để cmd/worker gọi vô điều kiện.
		var none *MetricsListener
		none.SetGatherer(reg)
		if err := none.Wait(); err != nil {
			t.Fatalf("nil listener Wait: %v", err)
		}
	})

	t.Run("serves only GET /metrics and shuts down", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		l, err := StartMetricsListener(ctx, "127.0.0.1:0", reg, discardLogger())
		if err != nil {
			t.Fatalf("StartMetricsListener: %v", err)
		}
		base := "http://" + l.Addr()

		status, body := httpDo(t, http.MethodGet, base+"/metrics")
		if status != http.StatusOK {
			t.Fatalf("GET /metrics = %d, want 200", status)
		}
		if !strings.Contains(body, "embedding_jobs_total") {
			t.Fatal("GET /metrics body has no embedding_jobs_total (FS-40 pre-init)")
		}
		for _, path := range []string{"/", "/healthz", "/metrics/", "/metrics/x", "/debug/pprof/", "/api/v1/healthz"} {
			if status, _ := httpDo(t, http.MethodGet, base+path); status != http.StatusNotFound {
				t.Errorf("GET %s = %d, want 404", path, status)
			}
		}
		if status, _ := httpDo(t, http.MethodPost, base+"/metrics"); status == http.StatusOK {
			t.Error("POST /metrics = 200, want non-200 (GET only)")
		}

		// Cổng đã bị giữ → lỗi bind rõ ràng.
		if _, err := StartMetricsListener(context.Background(), l.Addr(), reg, discardLogger()); err == nil {
			t.Error("second bind on the same address succeeded, want error")
		}

		cancel()
		if err := l.Wait(); err != nil {
			t.Fatalf("Wait after cancel: %v", err)
		}
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, base+"/metrics", nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		if resp, err := client.Do(req); err == nil {
			_ = resp.Body.Close()
			t.Error("GET /metrics after shutdown succeeded, want connection error")
		}
	})

	t.Run("rejects every non-GET method before gathering", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cg := &countingGatherer{inner: reg}
		l, err := StartMetricsListener(ctx, "127.0.0.1:0", cg, discardLogger())
		if err != nil {
			t.Fatalf("StartMetricsListener: %v", err)
		}
		defer func() {
			cancel()
			if err := l.Wait(); err != nil {
				t.Errorf("Wait: %v", err)
			}
		}()
		url := "http://" + l.Addr() + "/metrics"
		for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodOptions} {
			status, body := httpDo(t, method, url)
			if status != http.StatusMethodNotAllowed {
				t.Errorf("%s /metrics = %d, want 405", method, status)
			}
			if strings.Contains(body, "embedding_jobs_total") {
				t.Errorf("%s /metrics leaked metrics body", method)
			}
		}
		if n := cg.calls.Load(); n != 0 {
			t.Fatalf("gatherer called %d times by rejected requests, want 0", n)
		}
		// GET vẫn tới gatherer đúng một lần.
		if status, _ := httpDo(t, http.MethodGet, url); status != http.StatusOK {
			t.Fatalf("GET /metrics = %d, want 200", status)
		}
		if n := cg.calls.Load(); n != 1 {
			t.Fatalf("gatherer calls after one GET = %d, want 1", n)
		}
	})

	t.Run("late gatherer", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		l, err := StartMetricsListener(ctx, "127.0.0.1:0", nil, discardLogger())
		if err != nil {
			t.Fatalf("StartMetricsListener: %v", err)
		}
		defer func() {
			cancel()
			if err := l.Wait(); err != nil {
				t.Errorf("Wait: %v", err)
			}
		}()
		url := "http://" + l.Addr() + "/metrics"
		if status, _ := httpDo(t, http.MethodGet, url); status != http.StatusServiceUnavailable {
			t.Fatalf("GET /metrics before SetGatherer = %d, want 503", status)
		}
		l.SetGatherer(reg)
		status, body := httpDo(t, http.MethodGet, url)
		if status != http.StatusOK || !strings.Contains(body, "embedding_jobs_total") {
			t.Fatalf("GET /metrics after SetGatherer = %d (jobs_total present: %v), want 200 + present", status, strings.Contains(body, "embedding_jobs_total"))
		}
	})
}

type fakeGaugeSource struct{}

func (fakeGaugeSource) JobLag(context.Context) ([]obs.JobLagSample, error) {
	return []obs.JobLagSample{{Corpus: "item", Role: "active", Seconds: 1}}, nil
}

func (fakeGaugeSource) DeadLetterJobs(context.Context) (float64, error) { return 1, nil }

func (fakeGaugeSource) Coverage(context.Context) ([]obs.GenerationCoverageSample, error) {
	return []obs.GenerationCoverageSample{{Generation: "1", Corpus: "item", Ratio: 1}}, nil
}

// allowedMetricLabels là toàn bộ tên nhãn được phép trên /metrics: tập hữu hạn
// (route pattern, outcome, corpus, id generation, ...) cộng nhãn hạ tầng của
// Prometheus/Go. Không có nhãn nào có thể mang user, query, tên item/tag.
var allowedMetricLabels = []string{
	"route", "method", "status", "type",
	"mode", "scope", "semantic", "corpus", "reason", "result", "path",
	"provider", "op", "outcome", "process", "kind", "generation", "role",
	"le", "quantile", "version",
}

var describeVariableLabels = regexp.MustCompile(`variableLabels: \{([^{}]*)\}\}$`)

// TestMetricsHaveNoUserOrQueryLabels quét registry kiểu API (NewRegistry +
// RegisterGauges) và registry worker: mọi tên nhãn (khai báo qua Describe và
// thực tế qua Gather) phải nằm trong allowlist.
func TestMetricsHaveNoUserOrQueryLabels(t *testing.T) {
	apiReg, apiMetrics := obs.NewRegistry()
	if err := obs.RegisterGauges(apiReg, fakeGaugeSource{}); err != nil {
		t.Fatalf("RegisterGauges: %v", err)
	}
	// Chạm các series nhãn động để chúng xuất hiện trong Gather.
	apiMetrics.RequestDuration.WithLabelValues("/api/v1/healthz", "GET", "200").Observe(0.01)
	apiMetrics.Embedding.CanaryMinCos.WithLabelValues("1").Set(1)
	apiMetrics.Embedding.CanaryDriftTotal.WithLabelValues("1").Inc()

	workerReg, workerMetrics := obs.NewRegistry()
	workerMetrics.Embedding.CanaryMinCos.WithLabelValues("1").Set(1)

	for name, reg := range map[string]*prometheus.Registry{"api": apiReg, "worker": workerReg} {
		descs := make(chan *prometheus.Desc, 512)
		go func() {
			reg.Describe(descs)
			close(descs)
		}()
		var declared int
		for d := range descs {
			m := describeVariableLabels.FindStringSubmatch(d.String())
			if m == nil {
				t.Fatalf("%s: cannot parse Desc %q", name, d.String())
			}
			declared++
			for label := range strings.SplitSeq(m[1], ",") {
				if label != "" && !slices.Contains(allowedMetricLabels, label) {
					t.Errorf("%s: declared label %q in %s is not allowlisted", name, label, d.String())
				}
			}
		}
		if declared == 0 {
			t.Fatalf("%s: registry described no metrics", name)
		}

		families, err := reg.Gather()
		if err != nil {
			t.Fatalf("%s: Gather: %v", name, err)
		}
		for _, f := range families {
			for _, metric := range f.GetMetric() {
				for _, lp := range metric.GetLabel() {
					if !slices.Contains(allowedMetricLabels, lp.GetName()) {
						t.Errorf("%s: series %s has label %q, not allowlisted", name, f.GetName(), lp.GetName())
					}
				}
			}
		}
	}

	// Registry API phải có đủ ba gauge DB sau RegisterGauges.
	families, err := apiReg.Gather()
	if err != nil {
		t.Fatalf("api Gather: %v", err)
	}
	have := map[string]bool{}
	for _, f := range families {
		have[f.GetName()] = true
	}
	for _, name := range []string{"embedding_job_lag_seconds", "embedding_dead_letter_jobs", "embedding_generation_coverage_ratio"} {
		if !have[name] {
			t.Errorf("api registry missing %s", name)
		}
	}
}

func failedEvent(kind string, state rivertype.JobState, errMsg string) *river.Event {
	job := &rivertype.JobRow{Kind: kind, State: state, Attempt: 1, MaxAttempts: 30}
	if errMsg != "" {
		job.Errors = []rivertype.AttemptError{{Attempt: 1, Error: errMsg}}
	}
	return &river.Event{Kind: river.EventKindJobFailed, Job: job}
}

// TestJobOutcomeRecorderCountsOnlyRetryAndDead: ánh xạ sự kiện → outcome mà
// không cần DB. Chỉ job_failed của embed_item/embed_tag đếm; discarded → dead;
// retryable/available → retry; mọi thứ khác (completed, snoozed, kind khác,
// running) không đếm.
func TestJobOutcomeRecorderCountsOnlyRetryAndDead(t *testing.T) {
	_, m := obs.NewRegistry()
	rec := &jobOutcomeRecorder{metrics: m.Embedding}

	rec.handle(failedEvent(jobargs.KindEmbedItem, rivertype.JobStateDiscarded, "embedding: provider_5xx (status=503)"))
	rec.handle(failedEvent(jobargs.KindEmbedTag, rivertype.JobStateRetryable, "embedding: provider_timeout"))
	rec.handle(failedEvent(jobargs.KindEmbedItem, rivertype.JobStateAvailable, "embedding: provider_429 (status=429)"))

	// Không đếm.
	rec.handle(failedEvent("noop", rivertype.JobStateDiscarded, ""))
	rec.handle(failedEvent(jobargs.KindEmbedItem, rivertype.JobStateRunning, ""))
	rec.handle(&river.Event{Kind: river.EventKindJobCompleted, Job: &rivertype.JobRow{Kind: jobargs.KindEmbedItem, State: rivertype.JobStateCompleted}})
	rec.handle(&river.Event{Kind: river.EventKindJobSnoozed, Job: &rivertype.JobRow{Kind: jobargs.KindEmbedItem, State: rivertype.JobStateScheduled}})
	rec.handle(&river.Event{Kind: river.EventKindJobCancelled, Job: &rivertype.JobRow{Kind: jobargs.KindEmbedItem, State: rivertype.JobStateCancelled}})
	rec.handle(&river.Event{Kind: river.EventKindJobFailed})
	rec.handle(nil)

	want := map[[2]string]float64{
		{"embed_item", "dead"}:  1,
		{"embed_item", "retry"}: 1,
		{"embed_tag", "retry"}:  1,
	}
	for _, kind := range obs.EmbeddingJobKinds {
		for _, outcome := range obs.JobOutcomes {
			got := counterValue(t, m.Embedding.JobsTotal, kind, outcome)
			if got != want[[2]string{kind, outcome}] {
				t.Errorf("embedding_jobs_total{%s,%s} = %v, want %v", kind, outcome, got, want[[2]string{kind, outcome}])
			}
		}
	}

	if got := jobErrorClass(failedEvent(jobargs.KindEmbedItem, rivertype.JobStateDiscarded, "embedding: provider_5xx (status=503)").Job); got != "provider_5xx" {
		t.Errorf("jobErrorClass = %q, want provider_5xx", got)
	}
	if got := jobErrorClass(nil); got != "" {
		t.Errorf("jobErrorClass(nil) = %q, want empty", got)
	}
}

// outcomeFailWorker luôn thất bại bằng lỗi provider 5xx. Lần thử 2 trở đi chờ
// `gate` (test thả sau khi kiểm sự kiện của lần 1) hoặc ctx bị huỷ, để không có
// cuộc đua giữa assertion của test và lần thất bại tiếp theo.
type outcomeFailWorker struct {
	river.WorkerDefaults[jobargs.EmbedItemArgs]
	gate <-chan struct{}
}

func (w outcomeFailWorker) Work(ctx context.Context, job *river.Job[jobargs.EmbedItemArgs]) error {
	if job.Attempt >= 2 {
		select {
		case <-w.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return &embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503, Detail: "upstream server error"}
}

// NextRetry rất gần để lần thử thứ hai tới ngay (không chờ 1 phút của worker thật).
func (outcomeFailWorker) NextRetry(*river.Job[jobargs.EmbedItemArgs]) time.Time {
	return time.Now().Add(20 * time.Millisecond)
}

// outcomeUpsertWorker đóng vai worker 11a: tự tăng `upserted` rồi trả nil.
type outcomeUpsertWorker struct {
	river.WorkerDefaults[jobargs.EmbedTagArgs]
	metrics *obs.EmbeddingMetrics
}

func (w outcomeUpsertWorker) Work(context.Context, *river.Job[jobargs.EmbedTagArgs]) error {
	w.metrics.JobsTotal.WithLabelValues(jobargs.KindEmbedTag, "upserted").Inc()
	return nil
}

func recvEvent(t *testing.T, ch <-chan *river.Event, what string) *river.Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(60 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		return nil
	}
}

// TestJobsTotalOutcomeSingleSource (FS-28): một job embed thất bại rồi chết:
// retry và dead mỗi cái tăng đúng một lần qua client.Subscribe; một job upsert
// chỉ tăng upserted (do worker), Subscribe không tăng gì cho nó.
func TestJobsTotalOutcomeSingleSource(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	_, metrics := obs.NewRegistry()

	gate := make(chan struct{})
	releaseGate := sync.OnceFunc(func() { close(gate) })
	workers := river.NewWorkers()
	river.AddWorker(workers, outcomeFailWorker{gate: gate})
	river.AddWorker(workers, outcomeUpsertWorker{metrics: metrics.Embedding})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:            discardLogger(),
		Queues:            map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 2}},
		Workers:           workers,
		FetchCooldown:     10 * time.Millisecond,
		FetchPollInterval: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}

	handled := make(chan *river.Event, 16)
	// Subscription đăng ký cleanup TRƯỚC client.Start: nếu Start lỗi thì goroutine
	// tiêu thụ vẫn được dừng. Cleanup chạy ngược thứ tự: Stop client trước, rồi mới
	// xả/đóng subscription.
	stopSub := startJobOutcomeSubscriber(client, metrics.Embedding, discardLogger(), func(ev *river.Event) { handled <- ev })
	t.Cleanup(stopSub)
	completed, cancelCompleted := client.Subscribe(river.EventKindJobCompleted)
	t.Cleanup(cancelCompleted)

	if err := client.Start(ctx); err != nil {
		t.Fatalf("client.Start: %v", err)
	}
	t.Cleanup(func() {
		releaseGate() // thả worker đang chờ gate để Stop không treo khi test dừng sớm
		stopCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := client.Stop(stopCtx); err != nil {
			t.Errorf("client.Stop: %v", err)
		}
	})

	const (
		userID   = "00000000-0000-0000-0000-000000000001"
		targetID = "00000000-0000-0000-0000-000000000002"
		hash     = "0000000000000000000000000000000000000000000000000000000000000000"
	)
	if _, err := client.Insert(ctx, jobargs.EmbedItemArgs{GenerationID: 1, UserID: userID, TargetID: targetID, InputHash: hash},
		&river.InsertOpts{MaxAttempts: 2}); err != nil {
		t.Fatalf("insert embed_item: %v", err)
	}

	// Lần thử 1 thất bại, còn lượt → retry.
	ev := recvEvent(t, handled, "first failure event")
	if ev.Job.Kind != jobargs.KindEmbedItem || (ev.Job.State != rivertype.JobStateAvailable && ev.Job.State != rivertype.JobStateRetryable) {
		t.Fatalf("first event kind=%s state=%s, want embed_item available|retryable", ev.Job.Kind, ev.Job.State)
	}
	if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_item", "retry"); got != 1 {
		t.Fatalf("after first failure retry = %v, want 1", got)
	}
	if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_item", "dead"); got != 0 {
		t.Fatalf("after first failure dead = %v, want 0", got)
	}

	// Lần thử 1 đã được kiểm xong: thả lần thử 2 (đang chờ gate), thất bại, hết
	// lượt → discarded → dead.
	releaseGate()
	ev = recvEvent(t, handled, "second failure event")
	if ev.Job.State != rivertype.JobStateDiscarded {
		t.Fatalf("second event state=%s, want discarded", ev.Job.State)
	}
	if got := jobErrorClass(ev.Job); got != "provider_5xx" {
		t.Fatalf("dead job error_class = %q, want provider_5xx", got)
	}
	if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_item", "retry"); got != 1 {
		t.Fatalf("after dead retry = %v, want exactly 1", got)
	}
	if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_item", "dead"); got != 1 {
		t.Fatalf("after dead dead = %v, want exactly 1", got)
	}

	// Job upsert: chỉ upserted tăng (do worker), Subscribe không đếm retry/dead.
	if _, err := client.Insert(ctx, jobargs.EmbedTagArgs{GenerationID: 1, UserID: userID, TargetID: targetID, InputHash: hash},
		&river.InsertOpts{MaxAttempts: 30}); err != nil {
		t.Fatalf("insert embed_tag: %v", err)
	}
	if done := recvEvent(t, completed, "embed_tag completion"); done.Job.Kind != jobargs.KindEmbedTag {
		t.Fatalf("completed event kind = %s, want embed_tag", done.Job.Kind)
	}
	for _, outcome := range obs.JobOutcomes {
		want := 0.0
		if outcome == "upserted" {
			want = 1
		}
		if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_tag", outcome); got != want {
			t.Errorf("embed_tag %s = %v, want %v", outcome, got, want)
		}
	}
	if got := counterValue(t, metrics.Embedding.JobsTotal, "embed_item", "upserted"); got != 0 {
		t.Errorf("embed_item upserted = %v, want 0", got)
	}
	if n := len(handled); n != 0 {
		t.Errorf("unexpected extra failure events: %d", n)
	}
}
