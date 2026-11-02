package store

import (
	"context"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// DeleteTarget deletes the vector for (userID, targetID) in corpus kind across
// EVERY generation whose tables still exist (state <> 'dropped'), including
// retired generations past their rollback window (plan P05 mục 2.15, 2.17;
// ADR 0007 §3).
//
// Locking contract (OQ-16): callers in mutation transactions that delete or
// enqueue vectors should acquire generation.LockGenerationSetShared(ctx, tx)
// before calling DeleteTarget.
func DeleteTarget(
	ctx context.Context,
	tx gen.DBTX,
	kind generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
) error {
	if tx == nil {
		return ErrNilDB
	}
	if !kind.Valid() {
		return generation.ErrInvalidCorpus
	}

	gens, err := generation.ExistingGenerations(ctx, tx)
	if err != nil {
		return err
	}
	for _, g := range gens {
		tbl, err := resolveTableSQL(g, kind)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM `+tbl+` WHERE user_id = $1 AND target_id = $2`,
			userID, targetID,
		); err != nil {
			return err
		}
	}
	return nil
}

// DeleteTargetInGeneration deletes the vector for (userID, targetID) in a
// single generation g's corpus table (used by Reconcile when cleaning up a
// specific generation's orphan vectors).
func DeleteTargetInGeneration(
	ctx context.Context,
	tx gen.DBTX,
	g generation.Generation,
	kind generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
) error {
	if tx == nil {
		return ErrNilDB
	}
	tbl, err := resolveTableSQL(g, kind)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`DELETE FROM `+tbl+` WHERE user_id = $1 AND target_id = $2`,
		userID, targetID,
	)
	return err
}

// DeleteUserExternal deletes all item and tag vectors belonging to userID
// across EVERY generation with state <> 'dropped' and provider = 'openai_compat'
// (including pending and retired generations past their rollback window), while
// keeping vectors in 'tei' generations intact (plan P05 mục 2.15, 2.18, Task 6;
// BE-3, ADR 0007 §9).
//
// Locking contract (OQ-16): callers in mutation transactions (such as PATCH
// /me/settings turning semantic_suggest off, or Reconcile) should hold the user
// lock and/or generation.LockGenerationSetShared(ctx, tx) as appropriate.
func DeleteUserExternal(
	ctx context.Context,
	tx gen.DBTX,
	userID uuid.UUID,
) error {
	if tx == nil {
		return ErrNilDB
	}

	extGens, err := generation.ExistingExternalGenerations(ctx, tx)
	if err != nil {
		return err
	}
	for _, g := range extGens {
		for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
			tbl, err := resolveTableSQL(g, kind)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`DELETE FROM `+tbl+` WHERE user_id = $1`,
				userID,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

// DeleteUserInGeneration deletes all item and tag vectors belonging to userID
// in a single generation g (used by Reconcile when cleaning up a specific
// openai_compat generation for a user with semantic_suggest=false).
func DeleteUserInGeneration(
	ctx context.Context,
	tx gen.DBTX,
	g generation.Generation,
	userID uuid.UUID,
) error {
	if tx == nil {
		return ErrNilDB
	}
	for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		tbl, err := resolveTableSQL(g, kind)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM `+tbl+` WHERE user_id = $1`,
			userID,
		); err != nil {
			return err
		}
	}
	return nil
}
