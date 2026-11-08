package export

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Test-only bridge for package export_test, whose tests import compose (which
// imports export, so they cannot live in package export).
var (
	SetupExportTestDB    = setupExportTestDB
	SeedUserAndVault     = seedUserAndVault
	MakeRiverJob         = makeRiverJob
	ErrAttemptSuperseded = errAttemptSuperseded
)

func SetFinalizeLocked(w *ExportWorker, fn func(ctx context.Context, tx pgx.Tx)) {
	w.finalizeLocked = fn
}

func SetBeforeFinalize(w *ExportWorker, fn func(ctx context.Context, jobID, attemptID uuid.UUID)) {
	w.beforeFin = fn
}
