package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// Mã lý do `error_class` (plan P05 mục 2.21, SPEC §6.6): giá trị của log
// `error_class`; phía người dùng mọi mã đều là `semantic_reason:"degraded"`.
const (
	ErrorClassProviderTimeout        = string(embedding.ClassTimeout)
	ErrorClassProvider5xx            = string(embedding.Class5xx)
	ErrorClassProvider429            = string(embedding.Class429)
	ErrorClassProviderRefused        = string(embedding.ClassRefused)
	ErrorClassProviderBadResponse    = string(embedding.ClassBadResponse)
	ErrorClassDimsMismatch           = "dims_mismatch"
	ErrorClassHashStale              = "hash_stale"
	ErrorClassGenerationNotReceiving = "generation_not_receiving"
	ErrorClassGenerationUnconfigured = "generation_unconfigured"
)

// Lỗi mang mã lý do không đến từ provider. Worker embed (Task 11a) xử lý các
// tình huống này bằng outcome (snooze/skip/discard) chứ không trả lỗi, nên các
// sentinel này dành cho code muốn nêu chúng như một lỗi và vẫn nhận đúng
// `error_class` qua ErrorClass.
var (
	ErrHashStale              = errors.New("worker: embedding input hash is stale")
	ErrGenerationNotReceiving = errors.New("worker: embedding generation is not receiving")
	ErrGenerationUnconfigured = errors.New("worker: embedding generation has no matching configured client")
)

// ErrorClass ánh xạ lỗi provider/job sang một trong chín mã lý do của plan
// mục 2.21; nil → "". Lỗi provider dùng lại logic của classifyBootProviderError
// (cùng nguồn với embedding.OutcomeForError): *ProviderError.Class, ErrBadResponse,
// timeout, còn lại là provider_refused.
func ErrorClass(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, store.ErrDimsMismatch):
		return ErrorClassDimsMismatch
	case errors.Is(err, ErrHashStale):
		return ErrorClassHashStale
	case errors.Is(err, ErrGenerationNotReceiving), errors.Is(err, generation.ErrGenerationNotFound):
		return ErrorClassGenerationNotReceiving
	case errors.Is(err, ErrGenerationUnconfigured), errors.Is(err, generation.ErrCalibrationMissing):
		return ErrorClassGenerationUnconfigured
	default:
		return classifyBootProviderError(err)
	}
}

// ErrorClassFromMessage là ErrorClass cho lỗi chỉ còn ở dạng chuỗi: River chỉ
// lưu `AttemptError.Error` (không giữ giá trị lỗi Go), nên Subscribe phải nhận
// mã từ chính các chuỗi lỗi an toàn của provider/store (không chứa input, URL,
// khoá hay body — xem embedding.ProviderError). Chuỗi không nhận ra → mặc định
// provider_refused, giống classifyBootProviderError/classifyJobError.
func ErrorClassFromMessage(msg string) string {
	switch {
	case msg == "":
		return ""
	case strings.Contains(msg, ErrorClassProviderTimeout),
		strings.Contains(msg, "deadline exceeded"),
		strings.Contains(msg, "i/o timeout"):
		return ErrorClassProviderTimeout
	case strings.Contains(msg, ErrorClassProvider5xx):
		return ErrorClassProvider5xx
	case strings.Contains(msg, ErrorClassProvider429):
		return ErrorClassProvider429
	case strings.Contains(msg, ErrorClassProviderBadResponse),
		strings.Contains(msg, embedding.ErrBadResponse.Error()):
		return ErrorClassProviderBadResponse
	case strings.Contains(msg, store.ErrDimsMismatch.Error()), strings.Contains(msg, ErrorClassDimsMismatch):
		return ErrorClassDimsMismatch
	case strings.Contains(msg, ErrorClassHashStale):
		return ErrorClassHashStale
	case strings.Contains(msg, ErrorClassGenerationNotReceiving):
		return ErrorClassGenerationNotReceiving
	case strings.Contains(msg, ErrorClassGenerationUnconfigured):
		return ErrorClassGenerationUnconfigured
	default:
		return ErrorClassProviderRefused
	}
}

// jobErrorClass lấy mã lý do từ lỗi của lần chạy gần nhất của job.
func jobErrorClass(job *rivertype.JobRow) string {
	if job == nil || len(job.Errors) == 0 {
		return ""
	}
	return ErrorClassFromMessage(job.Errors[len(job.Errors)-1].Error)
}

// Outcome do Task 20a sở hữu (FS-28): các outcome còn lại của
// embedding_jobs_total do worker embed của Task 11a tăng, không bao giờ ở đây.
const (
	outcomeRetry = "retry"
	outcomeDead  = "dead"
)

// jobOutcomeRecorder tăng embedding_jobs_total{kind, outcome=retry|dead} từ sự
// kiện River `job_failed` của job embed_item/embed_tag. River gửi cùng một loại
// sự kiện cho cả "lỗi, sẽ thử lại" và "lỗi lần cuối, bị discard"; phân biệt bằng
// `Job.State`: `discarded` → dead; `retryable` hoặc `available` (River đặt
// available khi giờ retry nằm trong khoảng scheduler) → retry. Mọi trạng thái
// khác (vd. `running` khi completer lỗi) không đếm.
type jobOutcomeRecorder struct {
	metrics *obs.EmbeddingMetrics
	logger  *slog.Logger
}

func isEmbedJobKind(kind string) bool {
	return kind == jobargs.KindEmbedItem || kind == jobargs.KindEmbedTag
}

func (r *jobOutcomeRecorder) handle(ev *river.Event) {
	if ev == nil || ev.Kind != river.EventKindJobFailed || ev.Job == nil {
		return
	}
	job := ev.Job
	if !isEmbedJobKind(job.Kind) {
		return
	}
	var outcome string
	switch job.State {
	case rivertype.JobStateDiscarded:
		outcome = outcomeDead
	case rivertype.JobStateRetryable, rivertype.JobStateAvailable:
		outcome = outcomeRetry
	default:
		return
	}
	if r.metrics != nil && r.metrics.JobsTotal != nil {
		r.metrics.JobsTotal.WithLabelValues(job.Kind, outcome).Inc()
	}
	if r.logger == nil {
		return
	}
	// Chỉ kind, attempt và error_class: không args (có UUID), không chuỗi lỗi thô.
	attrs := []slog.Attr{
		slog.String("kind", job.Kind),
		slog.String("outcome", outcome),
		slog.String("error_class", jobErrorClass(job)),
		slog.Int("attempt", job.Attempt),
		slog.Int("max_attempts", job.MaxAttempts),
	}
	if outcome == outcomeDead {
		r.logger.LogAttrs(context.Background(), slog.LevelError, "embedding job dead-lettered", attrs...)
		return
	}
	// Worker embed đã ghi dòng cảnh báo cho lần lỗi này; ở đây chỉ để debug.
	r.logger.LogAttrs(context.Background(), slog.LevelDebug, "embedding job will retry", attrs...)
}

// startJobOutcomeSubscriber đăng ký một subscription `job_failed` trên client và
// chạy goroutine tiêu thụ cho tới khi kênh đóng. Gọi trước client.Start để không
// lỡ sự kiện. stop huỷ subscription và đợi goroutine xả hết sự kiện còn đệm;
// gọi sau client.Stop (River cũng đóng kênh khi dừng, huỷ hai lần là an toàn).
// afterHandle (có thể nil) chỉ để test chờ xác định sau mỗi sự kiện đã xử lý.
func startJobOutcomeSubscriber(
	client *river.Client[pgx.Tx],
	metrics *obs.EmbeddingMetrics,
	logger *slog.Logger,
	afterHandle func(*river.Event),
) (stop func()) {
	if client == nil || metrics == nil {
		return func() {}
	}
	rec := &jobOutcomeRecorder{metrics: metrics, logger: logger}
	events, cancel := client.Subscribe(river.EventKindJobFailed)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range events {
			rec.handle(ev)
			if afterHandle != nil {
				afterHandle(ev)
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// Thời gian cho listener metrics của worker. Scrape chỉ gom registry trong bộ
// nhớ nên nhỏ là đủ; ReadHeaderTimeout chặn client chậm giữ kết nối.
const (
	metricsReadHeaderTimeout = 5 * time.Second
	metricsReadTimeout       = 10 * time.Second
	metricsWriteTimeout      = 30 * time.Second
	metricsIdleTimeout       = 60 * time.Second
	metricsMaxHeaderBytes    = 8 << 10
	metricsShutdownTimeout   = 5 * time.Second
)

// MetricsListener phục vụ đúng `GET /metrics` của registry worker trên
// WORKER_METRICS_ADDR (SPEC §10.3). Mọi đường dẫn khác trả 404.
//
// Listener được bind trước khi worker mở DB (lỗi bind → worker thoát sớm, không
// chạy mù không có metrics) trong khi registry do worker.Run tạo sau đó, nên
// gatherer được gắn muộn bằng SetGatherer (RunOptions.OnRegistry); trước khi gắn,
// /metrics trả 503.
type MetricsListener struct {
	ln     net.Listener
	srv    *http.Server
	logger *slog.Logger

	mu       sync.RWMutex
	gatherer prometheus.Gatherer

	done chan struct{}
	err  error
}

// StartMetricsListener bind addr và phục vụ /metrics trong nền. addr rỗng (hoặc
// toàn khoảng trắng) → (nil, nil): không bind gì. Dừng gọn khi ctx xong (đợi tối
// đa 5 s cho request đang chạy) — dùng Wait để chờ.
func StartMetricsListener(
	ctx context.Context,
	addr string,
	gatherer prometheus.Gatherer,
	logger *slog.Logger,
) (*MetricsListener, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil, nil
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("worker metrics listener: bind failed: %w", err)
	}

	l := &MetricsListener{ln: ln, logger: logger, gatherer: gatherer, done: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", l.serveMetrics)
	l.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: metricsReadHeaderTimeout,
		ReadTimeout:       metricsReadTimeout,
		WriteTimeout:      metricsWriteTimeout,
		IdleTimeout:       metricsIdleTimeout,
		MaxHeaderBytes:    metricsMaxHeaderBytes,
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- l.srv.Serve(ln) }()
	go func() {
		defer close(l.done)
		select {
		case err := <-serveErr:
			if !errors.Is(err, http.ErrServerClosed) {
				l.err = fmt.Errorf("worker metrics listener: serve: %w", err)
			}
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), metricsShutdownTimeout)
			defer cancel()
			if err := l.srv.Shutdown(shutdownCtx); err != nil {
				l.err = fmt.Errorf("worker metrics listener: shutdown: %w", err)
				if cerr := l.srv.Close(); cerr != nil {
					l.err = errors.Join(l.err, cerr)
				}
			}
			<-serveErr
		}
	}()
	return l, nil
}

// SetGatherer gắn registry sẽ được phục vụ. An toàn gọi đồng thời với scrape.
func (l *MetricsListener) SetGatherer(g prometheus.Gatherer) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.gatherer = g
	l.mu.Unlock()
}

// Addr là địa chỉ thực tế đã bind (hữu ích khi addr là cổng 0).
func (l *MetricsListener) Addr() string {
	if l == nil {
		return ""
	}
	return l.ln.Addr().String()
}

// Wait chờ listener dừng hẳn (sau khi ctx xong) và trả lỗi serve/shutdown nếu có.
func (l *MetricsListener) Wait() error {
	if l == nil {
		return nil
	}
	<-l.done
	return l.err
}

func (l *MetricsListener) serveMetrics(w http.ResponseWriter, r *http.Request) {
	l.mu.RLock()
	g := l.gatherer
	l.mu.RUnlock()
	if g == nil {
		http.Error(w, "metrics registry not ready", http.StatusServiceUnavailable)
		return
	}
	promhttp.HandlerFor(g, promhttp.HandlerOpts{}).ServeHTTP(w, r)
}
