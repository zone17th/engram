//go:build searchbench

package searchbench

import "fmt"

// Markdown of the Task 23 additions. Case ids, class names, index names, timings
// and counts only: query strings never appear.

func planCells(p LexPlanInfo) string {
	seq := "no"
	if p.SeqScan {
		seq = "**yes**"
	}
	return fmt.Sprintf("%s | %s | %.2f | %d / %d", mdCell(p.Label()), seq, p.ExecMs, p.SharedHit, p.SharedRead)
}

// renderLexicalPlan renders the "Lexical plan (FU-SL-1)" section.
func renderLexicalPlan(w func(string, ...any), p *LexPlanReport) {
	w("## Lexical plan (FU-SL-1)\n\n")
	w("Exact lexical SQL of the server on the default planner at real volume, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, warm run. Tenants: ")
	for i, t := range p.Tenants {
		if i > 0 {
			w(", ")
		}
		w("%s (%d items, %d tags)", t.Class, t.Items, t.Tags)
	}
	w(". Fetch limit %d. Index classes: `per-user` = migration 0008 per-user lexical indexes, `global-trgm` = `item_name_trgm` / `tag_norm_trgm` (the 0010 candidates).\n\n", p.FetchLimit)
	w("| Case | Default: indexes | seq scan | ms | shared hit / read | After 0010 (simulated): indexes | seq scan | ms | shared hit / read |\n|---|---|---|---|---|---|---|---|---|\n")
	var defGlobal, defSeq, afterSeq int
	var defMs, afterMs float64
	for _, r := range p.Rows {
		after := "- | - | - | -"
		if r.After0010 != nil {
			after = planCells(*r.After0010)
			if r.After0010.SeqScan {
				afterSeq++
			}
			afterMs += r.After0010.ExecMs
		}
		w("| %s | %s | %s |\n", mdCell(r.ID), planCells(r.Default), after)
		if r.Default.UsesGlobal {
			defGlobal++
		}
		if r.Default.SeqScan {
			defSeq++
		}
		defMs += r.Default.ExecMs
	}
	w("\n- Default planner: the global trigram index is used in **%d of %d** cases; a sequential scan of item/tag in %d. Sum of execution times %.1f ms (default) vs %.1f ms (after 0010, simulated; %d sequential scans).\n", defGlobal, len(p.Rows), defSeq, defMs, afterMs, afterSeq)
	w("- Global trigram indexes restored after the rolled-back simulation: %v.\n", p.IndexesRestored)
	for _, n := range p.Notes {
		w("- %s\n", mdCell(n))
	}
	w("\n")
}

// renderConnectProbe renders the connect-cost probe section.
func renderConnectProbe(w func(string, ...any), p *ConnectProbeReport) {
	w("## Connect-cost probe (FU-SB-2b)\n\n")
	w("N = %d new backends per shape on a fresh pool (not the measured pool). p50 / p95 / max ms. Not part of any target.\n\n", p.N)
	w("| Shape | n | connect | BEGIN + SET LOCAL | first query | second query | first-query 50 ms timeouts | second-query 50 ms timeouts |\n|---|---|---|---|---|---|---|---|\n")
	for _, s := range p.Shapes {
		w("| %s | %d | %s | %s | %s | %s | %d | %d |\n", mdCell(s.Shape), s.N, msTriple(s.Connect), msTriple(s.Setup), msTriple(s.First), msTriple(s.Second), s.FirstTimeouts, s.SecondTimeouts)
	}
	w("\n")
	for _, n := range p.Notes {
		w("- %s\n", mdCell(n))
	}
	w("\n")
}

// renderTask23Summary renders the full-volume timing summary: HNSW build per
// partition next to the flip/rollback coverage scan and the Reconcile time.
func renderTask23Summary(w func(string, ...any), r *Report) {
	rows := Task23SummaryRows(r)
	if len(rows) == 0 {
		return
	}
	w("## Task 23 summary - full-volume timings\n\n| Metric | Value |\n|---|---|\n")
	for _, row := range rows {
		w("| %s | %s |\n", mdCell(row.Metric), mdCell(row.Value))
	}
	if f := r.Extras; f != nil && f.FlipCost != nil {
		w("\n- %s\n", mdCell(f.FlipCost.Note))
	}
	if f := r.Extras; f != nil && f.Reconcile != nil {
		w("- %s\n", mdCell(f.Reconcile.Note))
	}
	w("\n")
}
