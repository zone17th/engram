package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"strings"

	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
)

// CanaryWorker runs the periodic embedding_canary drift check across every
// generation in R = {active} ∪ {pending} ∪ {retired with rollback_until > now()}
// that has a matching configured client in ClientSet (plan P05 mục 2.12, 2.17,
// Task 11a; ADR 0004).
//
// On the first run for a generation (stored canary is empty/null), it persists
// the 8 reference vectors via SetEmbeddingGenerationCanary. On subsequent runs,
// CheckCanary records embedding_canary_min_cos{generation} and (when minCos <
// 0.99) increments embedding_canary_drift_total{generation} and logs a warning.
// CanaryWorker never triggers an automatic generation cutover.
type CanaryWorker struct {
	river.WorkerDefaults[jobargs.CanaryArgs]
	deps Dependencies
}

// NewCanaryWorker constructs a CanaryWorker with the given dependencies.
func NewCanaryWorker(deps Dependencies) *CanaryWorker {
	return &CanaryWorker{deps: deps.withDefaults()}
}

// Work executes the canary drift check across all receiving generations.
func (w *CanaryWorker) Work(ctx context.Context, _ *river.Job[jobargs.CanaryArgs]) error {
	deps := w.deps.withDefaults()
	if deps.Pool == nil {
		return errors.New("jobs: nil database pool")
	}

	receiving, err := generation.ReceivingGenerations(ctx, deps.Pool)
	if err != nil {
		return err
	}

	for _, g := range receiving {
		if deps.ClientSet == nil {
			logCanarySkipped(ctx, deps.Logger, g.ID)
			continue
		}
		client, ok := deps.ClientSet.Match(g.Identity())
		if !ok {
			logCanarySkipped(ctx, deps.Logger, g.ID)
			continue
		}

		breaker := deps.breakerFor(g.Provider)
		var finishBreaker func(error)
		if breaker != nil {
			allowed, _, finish := breaker.Acquire()
			if !allowed {
				logCanarySkipped(ctx, deps.Logger, g.ID)
				continue
			}
			finishBreaker = finish
		}

		stored, err := decodeStoredCanary(g.Canary)
		if err != nil {
			if finishBreaker != nil {
				finishBreaker(nil)
			}
			return err
		}

		res, checkErr := embedding.CheckCanary(
			ctx,
			client,
			g.ID,
			stored,
			deps.Metrics,
			deps.Logger,
		)
		if finishBreaker != nil {
			finishBreaker(checkErr)
		}
		if checkErr != nil {
			logCanaryError(ctx, deps.Logger, g.ID, classifyJobError(checkErr))
			continue
		}

		if res.FirstRun && len(res.Vectors) > 0 {
			if deps.BeforeCanaryPersistTx != nil {
				deps.BeforeCanaryPersistTx(ctx, g.ID)
			}
			if err := persistOrCompareFirstCanary(ctx, deps, g.ID, client.Provider.Name(), res.Vectors); err != nil {
				return err
			}
		}
	}

	return nil
}

func decodeStoredCanary(raw []byte) ([][]float32, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var vecs [][]float32
	if err := json.Unmarshal(trimmed, &vecs); err != nil {
		return nil, err
	}
	return vecs, nil
}

// persistOrCompareFirstCanary makes initial canary baseline persistence
// write-once under a short generation-row FOR UPDATE lock (EJ2-4).
//
// The network embedding call has already completed outside any database
// transaction. In a short transaction we lock the generation row FOR UPDATE and
// re-read its canary column:
//   - If canary is still empty/null, we persist freshVectors as the baseline.
//   - If a concurrent first-run job already committed a baseline while we were
//     embedding, we retain the winner's baseline (never overwriting it) and
//     evaluate drift of freshVectors against the stored baseline after commit.
func persistOrCompareFirstCanary(
	ctx context.Context,
	deps Dependencies,
	generationID int,
	providerName string,
	freshVectors [][]float32,
) error {
	encoded, err := json.Marshal(freshVectors)
	if err != nil {
		return err
	}

	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	qtx := gen.New(tx)
	lockedRow, err := qtx.GetEmbeddingGenerationByIDForUpdate(ctx, int32(generationID))
	if err != nil {
		return err
	}

	existing, err := decodeStoredCanary(lockedRow.Canary)
	if err != nil {
		return err
	}
	if len(existing) == 0 {
		if _, err := qtx.SetEmbeddingGenerationCanary(ctx, gen.SetEmbeddingGenerationCanaryParams{
			ID:     int32(generationID),
			Canary: encoded,
		}); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return recordCanaryComparison(ctx, deps, generationID, providerName, freshVectors, existing)
}

func recordCanaryComparison(
	ctx context.Context,
	deps Dependencies,
	generationID int,
	providerName string,
	fresh [][]float32,
	stored [][]float32,
) error {
	if len(stored) != embedding.CanaryCount || len(fresh) != embedding.CanaryCount {
		return errors.New("jobs: stored canary vector count mismatch")
	}

	minCos := 1.0
	for i := range embedding.CanaryCount {
		cos, err := canaryCosineSimilarity(fresh[i], stored[i])
		if err != nil {
			return err
		}
		if i == 0 || cos < minCos {
			minCos = cos
		}
	}

	genLabel := "unknown"
	if generationID > 0 {
		genLabel = strings.TrimSpace(strconv.Itoa(generationID))
	}
	if deps.Metrics != nil && deps.Metrics.CanaryMinCos != nil {
		deps.Metrics.CanaryMinCos.WithLabelValues(genLabel).Set(minCos)
	}
	if minCos < embedding.CanaryThreshold {
		if deps.Metrics != nil && deps.Metrics.CanaryDriftTotal != nil {
			deps.Metrics.CanaryDriftTotal.WithLabelValues(genLabel).Inc()
		}
		if deps.Logger != nil {
			deps.Logger.LogAttrs(
				ctx,
				slog.LevelWarn,
				"embedding canary drift detected",
				slog.String("generation", genLabel),
				slog.String("provider", providerName),
				slog.Int("count", embedding.CanaryCount),
				slog.Float64("min_cos", minCos),
				slog.Float64("threshold", embedding.CanaryThreshold),
			)
		}
	}
	return nil
}

func canaryCosineSimilarity(a, b []float32) (float64, error) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, errors.New("jobs: canary vector dimension mismatch")
	}
	var dot, normA, normB float64
	for i := range a {
		fa := float64(a[i])
		fb := float64(b[i])
		if math.IsNaN(fa) || math.IsInf(fa, 0) || math.IsNaN(fb) || math.IsInf(fb, 0) {
			return 0, errors.New("jobs: canary vector contains NaN or Inf")
		}
		dot += fa * fb
		normA += fa * fa
		normB += fb * fb
	}
	if normA <= 0 || normB <= 0 {
		return 0, errors.New("jobs: canary vector has zero norm")
	}
	cos := dot / (math.Sqrt(normA) * math.Sqrt(normB))
	if cos > 1.0 {
		cos = 1.0
	} else if cos < -1.0 {
		cos = -1.0
	}
	return cos, nil
}

func logCanarySkipped(ctx context.Context, logger *slog.Logger, generationID int) {
	if logger == nil {
		return
	}
	logger.LogAttrs(
		ctx,
		slog.LevelDebug,
		"embedding canary skipped",
		slog.Int("generation_id", generationID),
	)
}

func logCanaryError(ctx context.Context, logger *slog.Logger, generationID int, errClass string) {
	if logger == nil {
		return
	}
	logger.LogAttrs(
		ctx,
		slog.LevelWarn,
		"embedding canary check failed",
		slog.Int("generation_id", generationID),
		slog.String("error_class", errClass),
	)
}
