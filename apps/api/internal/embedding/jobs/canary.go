package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"

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

	q := gen.New(deps.Pool)
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
			encoded, err := json.Marshal(res.Vectors)
			if err != nil {
				return err
			}
			if _, err := q.SetEmbeddingGenerationCanary(ctx, gen.SetEmbeddingGenerationCanaryParams{
				ID:     int32(g.ID),
				Canary: encoded,
			}); err != nil {
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
