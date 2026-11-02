package obs

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Tham số của nguồn gauge DB (plan P05 mục 2.21, Task 20a).
const (
	// GaugeCacheTTL là thời gian một lần đọc DB được dùng lại cho cả ba gauge.
	// Prometheus scrape mặc định 15 s nên mỗi chu kỳ chỉ tốn một lượt truy vấn,
	// kể cả khi nhiều scraper hoặc nhiều lần gọi `/metrics` đồng thời.
	GaugeCacheTTL = 15 * time.Second

	// JobLagWindow là cửa sổ trượt (theo `river_job.finalized_at`) của các job
	// nhúng đã hoàn tất dùng để tính `embedding_job_lag_seconds`.
	JobLagWindow = 15 * time.Minute

	// JobLagQuantile là phân vị của lag trong cửa sổ. Alert của runbook là
	// "lag p95 > 10 s trong 15 phút ngoài backfill" nên gauge chính là p95 của
	// 15 phút gần nhất; alert chỉ cần `embedding_job_lag_seconds > 10`.
	JobLagQuantile = 0.95

	minGenerationID = 1
	maxGenerationID = 9999
)

// DBQuerier là phần tối thiểu của pgx mà DBGaugeSource cần; `*pgxpool.Pool`
// thoả mãn. Dùng interface nhỏ để test chèn bộ đếm truy vấn và để package obs
// không phải import các package sqlc của `internal/db`.
type DBQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// DBGaugeSource cài đặt GaugeSource bằng truy vấn Postgres chỉ-đọc, tổng hợp,
// không chạm văn bản người dùng (chỉ đếm hàng, UUID không được trả ra, nhãn chỉ
// gồm corpus, vai trò và id generation).
//
// Cache: một snapshot duy nhất cho cả ba gauge, sống GaugeCacheTTL. Mutex bao
// quanh lần nạp nên các scrape đồng thời chỉ gây một lượt truy vấn (không
// stampede); lỗi của lần nạp cũng được giữ trong TTL để một DB chậm không bị
// truy vấn lại mỗi scrape. Ngoại lệ: lỗi do chính context của người gọi bị huỷ
// thì không cache, vì nó không phản ánh trạng thái DB.
//
// Chọn số liệu (SPEC §6.6, plan 2.21):
//   - lag: với mỗi generation chưa `dropped`, p95 của `embedded_at −
//     river_job.created_at` trên các job `embed_item`/`embed_tag` `completed`
//     có `finalized_at` trong JobLagWindow (15 phút), nối với hàng vector đúng
//     `(user_id, target_id, input_hash)` của job đó. Chỉ đếm lần ghi vector quy
//     được cho job: `created_at <= embedded_at <= finalized_at`. Cận dưới loại job
//     bỏ qua vì vector đã có từ trước (`skipped_fresh`, …); cận trên loại hàng
//     vector bị ghi lại SAU khi job kết thúc (vd. đổi tên A→B→A tạo job thứ hai
//     ghi lại cùng hash A, `store.Upsert` ghi đè `embedded_at`), nếu không job
//     cũ sẽ bị gán lag của lần ghi sau. Vì vậy gauge chỉ phủ các lần ghi còn quy
//     được cho job, không phải toàn bộ phân phối job đã hoàn tất: hàng vector
//     bị ghi đè thì mẫu của job cũ biến mất (không có bảng lịch sử bất biến).
//     Nhiều generation cùng vai trò → lấy max của các p95. Cửa sổ rỗng → phát 0 cho mọi cặp corpus × vai trò
//     (ba vai trò của GenerationRoles): hàng đợi rảnh nghĩa là không có gì trễ,
//     nên 0 là đúng nghĩa và series luôn có mặt trên `/metrics` (FS-40) thay vì
//     biến mất; alert `> 10` không bị kích hoạt khi rảnh.
//   - dead-letter: số hàng `river_job` kind embed_* ở trạng thái `discarded`
//     (River giữ discarded theo retention của nó, mặc định 7 ngày; chạy
//     `worker reembed deadletter retry` hoặc để nó hết hạn thì gauge giảm).
//   - coverage: `(mục/tag chưa xoá có hàng vector cùng model + model_version của
//     generation) ÷ (mục/tag chưa xoá)` cho từng generation chưa `dropped`.
//     Không có mục sống nào → 1 (rỗng thì đã phủ đủ, tránh alert coverage < 99 %
//     trên deployment mới). Chỉ so model/model_version, không so input_hash vì
//     hash cần JCS+SHA-256 phía ứng dụng; hash lệch do rename được
//     Reconcile/job xử lý riêng.
type DBGaugeSource struct {
	db  DBQuerier
	now func() time.Time

	mu   sync.Mutex
	snap *gaugeSnapshot
}

// gaugeSnapshot là kết quả một lần nạp; mỗi phần có lỗi riêng để một truy vấn
// hỏng không làm mất hai gauge còn lại.
type gaugeSnapshot struct {
	at      time.Time
	lag     []JobLagSample
	lagErr  error
	dead    float64
	deadErr error
	cov     []GenerationCoverageSample
	covErr  error
}

var _ GaugeSource = (*DBGaugeSource)(nil)

// NewDBGaugeSource dựng nguồn gauge DB dùng đồng hồ thật. Truyền `pool` của
// ứng dụng (`*pgxpool.Pool`).
func NewDBGaugeSource(db DBQuerier) *DBGaugeSource {
	return NewDBGaugeSourceWithClock(db, time.Now)
}

// NewDBGaugeSourceWithClock như NewDBGaugeSource nhưng cho phép chèn đồng hồ
// (chỉ để kiểm TTL cache 15 s trong test mà không ngủ).
func NewDBGaugeSourceWithClock(db DBQuerier, now func() time.Time) *DBGaugeSource {
	if now == nil {
		now = time.Now
	}
	return &DBGaugeSource{db: db, now: now}
}

// JobLag implements GaugeSource.
func (s *DBGaugeSource) JobLag(ctx context.Context) ([]JobLagSample, error) {
	snap, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return snap.lag, snap.lagErr
}

// DeadLetterJobs implements GaugeSource.
func (s *DBGaugeSource) DeadLetterJobs(ctx context.Context) (float64, error) {
	snap, err := s.snapshot(ctx)
	if err != nil {
		return 0, err
	}
	return snap.dead, snap.deadErr
}

// Coverage implements GaugeSource.
func (s *DBGaugeSource) Coverage(ctx context.Context) ([]GenerationCoverageSample, error) {
	snap, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return snap.cov, snap.covErr
}

func (s *DBGaugeSource) snapshot(ctx context.Context) (*gaugeSnapshot, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("obs: nil gauge database")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if s.snap != nil {
		if age := now.Sub(s.snap.at); age >= 0 && age < GaugeCacheTTL {
			return s.snap, nil
		}
	}

	snap := &gaugeSnapshot{at: now}
	gens, err := s.generations(ctx)
	if err != nil {
		snap.lagErr, snap.covErr = err, err
	} else {
		snap.lag, snap.lagErr = s.queryLag(ctx, gens)
		snap.cov, snap.covErr = s.queryCoverage(ctx, gens)
	}
	snap.dead, snap.deadErr = s.queryDeadLetter(ctx)

	// Lỗi do context của người gọi bị huỷ không phản ánh trạng thái DB: không cache.
	if ctx.Err() != nil && (snap.lagErr != nil || snap.deadErr != nil || snap.covErr != nil) {
		return nil, ctx.Err()
	}
	s.snap = snap
	return snap, nil
}

type gaugeGeneration struct {
	id           int
	role         string
	model        string
	modelVersion string
}

// generations đọc registry: mọi generation chưa dropped (vai trò = state).
func (s *DBGaugeSource) generations(ctx context.Context) ([]gaugeGeneration, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, state, model, model_version
		   FROM embedding_generation
		  WHERE state IN ('active', 'pending', 'retired')
		  ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("obs: list embedding generations: %w", err)
	}
	defer rows.Close()

	var out []gaugeGeneration
	for rows.Next() {
		var g gaugeGeneration
		if err := rows.Scan(&g.id, &g.role, &g.model, &g.modelVersion); err != nil {
			return nil, fmt.Errorf("obs: scan embedding generation: %w", err)
		}
		if g.id < minGenerationID || g.id > maxGenerationID {
			continue
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("obs: list embedding generations: %w", err)
	}
	return out, nil
}

// corpusSpec nối corpus với bảng nguồn, job kind và tiền tố bảng vector.
type corpusSpec struct {
	corpus string
	source string // bảng item/tag (hằng, không từ input)
	kind   string // river_job.kind
}

var gaugeCorpora = []corpusSpec{
	{corpus: "item", source: "item", kind: "embed_item"},
	{corpus: "tag", source: "tag", kind: "embed_tag"},
}

// vectorTable dựng định danh đã quote của bảng vector `<corpus>_embedding_g<id>`.
// id đã được giới hạn 1..9999 (CHECK ở DB + kiểm lại ở generations).
func vectorTable(corpus string, id int) string {
	return pgx.Identifier{corpus + "_embedding_g" + strconv.Itoa(id)}.Sanitize()
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func (s *DBGaugeSource) queryLag(ctx context.Context, gens []gaugeGeneration) ([]JobLagSample, error) {
	// max p95 theo (corpus, role); mặc định 0 cho mọi cặp (xem doc của kiểu).
	worst := make(map[[2]string]float64)
	for _, c := range gaugeCorpora {
		for _, role := range GenerationRoles {
			worst[[2]string{c.corpus, role}] = 0
		}
	}

	for _, g := range gens {
		for _, c := range gaugeCorpora {
			// #nosec G201 -- bảng đã quote bằng pgx.Identifier.Sanitize() từ id số nguyên 1..9999 và corpus hằng.
			q := fmt.Sprintf(`SELECT percentile_cont($1::float8) WITHIN GROUP (
			         ORDER BY EXTRACT(EPOCH FROM (e.embedded_at - j.created_at))::float8)
			    FROM river_job j
			    JOIN %s e
			      ON e.user_id = (j.args->>'user_id')::uuid
			     AND e.target_id = (j.args->>'target_id')::uuid
			     AND e.input_hash = decode(j.args->>'input_hash', 'hex')
			   WHERE j.kind = $2
			     AND j.state = 'completed'
			     AND (j.args->>'generation_id')::int = $3
			     AND j.finalized_at >= now() - make_interval(secs => $4::float8)
			     AND e.embedded_at >= j.created_at
			     AND e.embedded_at <= j.finalized_at`, vectorTable(c.corpus, g.id))

			var p95 *float64
			err := s.db.QueryRow(ctx, q, JobLagQuantile, c.kind, g.id, JobLagWindow.Seconds()).Scan(&p95)
			if err != nil {
				if isUndefinedTable(err) {
					continue // generation đang được tạo/drop: bỏ qua lượt này
				}
				return nil, fmt.Errorf("obs: embedding job lag: %w", err)
			}
			if p95 == nil || *p95 < 0 {
				continue
			}
			key := [2]string{c.corpus, g.role}
			if *p95 > worst[key] {
				worst[key] = *p95
			}
		}
	}

	out := make([]JobLagSample, 0, len(worst))
	for _, c := range gaugeCorpora {
		for _, role := range GenerationRoles {
			out = append(out, JobLagSample{Corpus: c.corpus, Role: role, Seconds: worst[[2]string{c.corpus, role}]})
		}
	}
	return out, nil
}

func (s *DBGaugeSource) queryDeadLetter(ctx context.Context) (float64, error) {
	var n int64
	err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM river_job WHERE kind = ANY($1::text[]) AND state = 'discarded'`,
		EmbeddingJobKinds,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("obs: embedding dead-letter count: %w", err)
	}
	return float64(n), nil
}

func (s *DBGaugeSource) queryCoverage(ctx context.Context, gens []gaugeGeneration) ([]GenerationCoverageSample, error) {
	var out []GenerationCoverageSample
	for _, g := range gens {
		for _, c := range gaugeCorpora {
			// #nosec G201 -- bảng nguồn là hằng; bảng vector đã quote từ id số nguyên 1..9999.
			q := fmt.Sprintf(`SELECT count(*) FILTER (WHERE e.target_id IS NOT NULL), count(*)
			    FROM %s s
			    LEFT JOIN %s e
			      ON e.user_id = s.user_id
			     AND e.target_id = s.id
			     AND e.model = $1
			     AND e.model_version = $2
			   WHERE s.deleted_at IS NULL`, pgx.Identifier{c.source}.Sanitize(), vectorTable(c.corpus, g.id))

			var covered, live int64
			if err := s.db.QueryRow(ctx, q, g.model, g.modelVersion).Scan(&covered, &live); err != nil {
				if isUndefinedTable(err) {
					continue
				}
				return nil, fmt.Errorf("obs: embedding coverage: %w", err)
			}
			ratio := 1.0
			if live > 0 {
				ratio = float64(covered) / float64(live)
			}
			if ratio > 1 {
				ratio = 1
			}
			out = append(out, GenerationCoverageSample{
				Generation: strconv.Itoa(g.id),
				Corpus:     c.corpus,
				Ratio:      ratio,
			})
		}
	}
	return out, nil
}
