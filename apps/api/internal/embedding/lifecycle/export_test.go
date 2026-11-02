package lifecycle

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// Test-only exports of the recall internals (GL-2, GL-4).
var (
	SplitRecallQuota = splitRecallQuota
	ExactOracleSQL   = exactOracleSQL
)

// SampleTargetIDs returns the target ids the recall sampler picks for corpus
// (which holds n rows) at the given quota, in key order.
func SampleTargetIDs(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, corpus generation.Corpus, n int64, quota int) ([]uuid.UUID, error) {
	vs, err := sampleVectors(ctx, pool, g, corpus, n, quota)
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.targetID)
	}
	return out, nil
}
