package main

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// cleanupAgeRow answers the export_cleanup_pending_age_seconds query; other scans fail so their series are skipped.
type cleanupAgeRow struct{ sql string }

func (r cleanupAgeRow) Scan(dest ...any) error {
	if r.sql != obs.CleanupPendingAgeQuery || len(dest) != 1 {
		return errors.New("not used")
	}
	p, ok := dest[0].(*float64)
	if !ok {
		return errors.New("unexpected scan target")
	}
	*p = 42
	return nil
}

type cleanupAgeQuerier struct{}

func (cleanupAgeQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("not used")
}

func (cleanupAgeQuerier) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return cleanupAgeRow{sql: sql}
}

// The api must serve export_cleanup_pending_age_seconds: the production monitor treats its absence as CRIT and
// otherwise never sees an export-cleanup backlog (advisor-dec-P06-061).
func TestRegisterDBMetricsServesExportCleanupGauge(t *testing.T) {
	reg, _ := obs.NewRegistry()
	if err := registerDBMetrics(reg, cleanupAgeQuerier{}); err != nil {
		t.Fatalf("registerDBMetrics: %v", err)
	}
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() == "export_cleanup_pending_age_seconds" {
			if got := f.GetMetric()[0].GetGauge().GetValue(); got != 42 {
				t.Fatalf("export_cleanup_pending_age_seconds = %v, want 42", got)
			}
			return
		}
	}
	t.Fatal("export_cleanup_pending_age_seconds missing from the api registry")
}
