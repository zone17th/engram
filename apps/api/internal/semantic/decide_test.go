package semantic_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/semantic/semantictest"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

func counterValue(t *testing.T, c prometheus.Counter) float64 {
	t.Helper()
	var m dto.Metric
	if err := c.Write(&m); err != nil {
		t.Fatalf("Counter.Write: %v", err)
	}
	return m.GetCounter().GetValue()
}

// TestDecideRows4To10 verifies plan P05 mục 2.18 rows 4–10 and strict decision
// precedence (deployment -> generation -> user -> request -> breaker -> length):
//   - Row 4: active `tei`, user on, breaker closed, q >= 3 -> semantic: true,
//     semantic_reason: nil, generation: &1; provider called on miss, 0 on cache hit;
//     VectorSearch called for item + tag.
//   - Row 5: active `tei`, user off -> semantic: false, semantic_reason: "disabled_user";
//     0 provider calls, 0 VectorSearch calls.
//   - Row 6: active `openai_compat`, user on, q >= 3 -> semantic: true,
//     semantic_reason: nil, generation: &1; provider called on miss, cached on hit;
//     VectorSearch called.
//   - Row 7: active `openai_compat`, user off -> semantic: false,
//     semantic_reason: "disabled_user"; 0 provider calls, 0 VectorSearch calls.
//   - Row 8: provider matched, user on, API breaker open -> semantic: false,
//     semantic_reason: "degraded"; 0 provider calls, 0 VectorSearch calls.
//   - Row 9: enabled, `semantic=0` -> semantic: false,
//     semantic_reason: "request_lexical"; 0 provider calls, 0 VectorSearch calls.
//   - Row 10: enabled, q < 3 runes (including 2-rune Vietnamese UTF-8 "đà") ->
//     semantic: false, semantic_reason: "short_query"; 0 provider calls,
//     0 VectorSearch calls.
func TestDecideRows4To10(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

	type rowCase struct {
		name          string
		identity      embedid.Identity
		userOn        bool
		semanticParam bool
		tripBreaker   bool
		qn            string
		wantSemantic  bool
		wantReason    string // "" means nil on wire
		wantMetric    string
		wantProvMiss  int64
		wantVecCalls  int64
	}

	cases := []rowCase{
		{
			name:          "row4_tei_user_on_breaker_closed_q_ge_3",
			identity:      testTEIIdentity(),
			userOn:        true,
			semanticParam: true,
			qn:            "mạng wifi",
			wantSemantic:  true,
			wantReason:    "",
			wantMetric:    semantic.MetricDecisionRan,
			wantProvMiss:  1,
			wantVecCalls:  2, // item + tag for scope=all
		},
		{
			name:          "row5_tei_user_off",
			identity:      testTEIIdentity(),
			userOn:        false,
			semanticParam: true,
			qn:            "mạng wifi",
			wantSemantic:  false,
			wantReason:    suggest.ReasonDisabledUser,
			wantMetric:    suggest.ReasonDisabledUser,
			wantProvMiss:  0,
			wantVecCalls:  0,
		},
		{
			name:          "row6_openai_compat_user_on_q_ge_3",
			identity:      testOpenAIIdentity(),
			userOn:        true,
			semanticParam: true,
			qn:            "router nhà",
			wantSemantic:  true,
			wantReason:    "",
			wantMetric:    semantic.MetricDecisionRan,
			wantProvMiss:  1,
			wantVecCalls:  2,
		},
		{
			name:          "row7_openai_compat_user_off",
			identity:      testOpenAIIdentity(),
			userOn:        false,
			semanticParam: true,
			qn:            "router nhà",
			wantSemantic:  false,
			wantReason:    suggest.ReasonDisabledUser,
			wantMetric:    suggest.ReasonDisabledUser,
			wantProvMiss:  0,
			wantVecCalls:  0,
		},
		{
			name:          "row8_breaker_open",
			identity:      testOpenAIIdentity(),
			userOn:        true,
			semanticParam: true,
			tripBreaker:   true,
			qn:            "router nhà",
			wantSemantic:  false,
			wantReason:    suggest.ReasonDegraded,
			wantMetric:    suggest.ReasonDegraded,
			wantProvMiss:  0,
			wantVecCalls:  0,
		},
		{
			name:          "row9_semantic_param_false",
			identity:      testTEIIdentity(),
			userOn:        true,
			semanticParam: false,
			qn:            "mạng wifi",
			wantSemantic:  false,
			wantReason:    suggest.ReasonRequestLexical,
			wantMetric:    suggest.ReasonRequestLexical,
			wantProvMiss:  0,
			wantVecCalls:  0,
		},
		{
			name:          "row10_short_query_under_3_runes",
			identity:      testTEIIdentity(),
			userOn:        true,
			semanticParam: true,
			qn:            "đà", // 2 runes, 4 UTF-8 bytes
			wantSemantic:  false,
			wantReason:    suggest.ReasonShortQuery,
			wantMetric:    suggest.ReasonShortQuery,
			wantProvMiss:  0,
			wantVecCalls:  0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clk := clock.NewFixed(ts)
			_, metrics := obs.NewRegistry()

			spyProv := semantictest.NewSpyProvider(tc.identity)
			client := embedding.NewClient(spyProv, tc.identity.QueryPrefix, tc.identity.DocPrefix)
			cs := embedding.NewClientSet(client, nil)
			pin := testPinForIdentity(1, tc.identity)
			pinner := semantictest.NewSpyPinner(pin, true)
			searcher := &semantictest.SpyVectorSearcher{
				ItemHits: []semantic.VectorHit{
					{
						ID:         uuid.MustParse("00000000-0001-4000-8000-000000000001"),
						Cos:        0.88,
						Name:       "wifi router",
						Count:      3,
						LastUsedAt: ts,
						CreatedAt:  ts,
					},
				},
			}
			settings := &semantictest.StaticSettingsReader{Default: tc.userOn}

			rt := semantic.NewRuntime(semantic.RuntimeConfig{
				Enabled:        true,
				Provider:       tc.identity.Provider,
				ClientSet:      cs,
				Pinner:         pinner,
				Calibration:    matchingCalibration(tc.identity),
				VectorSearcher: searcher,
				SettingsReader: settings,
				Metrics:        metrics,
				Clock:          clk,
			})

			if tc.tripBreaker {
				_, _, finish := rt.Breaker().Acquire()
				finish(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503})
			}

			// Verify unit Decide() directly as well as end-to-end NearSource.Near().
			dec := rt.Decide(ctx, userID, semantic.UserSettings{SemanticSuggest: tc.userOn}, semantic.DecideRequest{
				QN:            tc.qn,
				Scope:         suggest.ScopeAll,
				SemanticParam: tc.semanticParam,
			})
			if dec.Effective != tc.wantSemantic {
				t.Fatalf("Decide.Effective = %v, want %v (reason=%q)", dec.Effective, tc.wantSemantic, dec.Reason)
			}
			if dec.Reason != tc.wantReason {
				t.Fatalf("Decide.Reason = %q, want %q", dec.Reason, tc.wantReason)
			}

			// Reset pinner counter before exercising full NearSource.Near().
			pinner.ResetCalls()
			spyProv.ResetQueryCalls()
			searcher.ResetCalls()

			res, err := rt.NearSource().Near(ctx, suggest.NearRequest{
				UserID:        userID,
				QN:            tc.qn,
				Scope:         suggest.ScopeAll,
				Limit:         8,
				Cap:           2,
				SemanticParam: tc.semanticParam,
			})
			if err != nil {
				t.Fatalf("Near unexpected error: %v", err)
			}
			if res.Semantic != tc.wantSemantic {
				t.Fatalf("Near.Semantic = %v, want %v", res.Semantic, tc.wantSemantic)
			}
			if tc.wantSemantic {
				if res.SemanticReason != nil {
					t.Fatalf("Near.SemanticReason = %q, want nil", *res.SemanticReason)
				}
				if res.Generation == nil || *res.Generation != 1 {
					t.Fatalf("Near.Generation = %v, want 1", res.Generation)
				}
			} else {
				if res.SemanticReason == nil || *res.SemanticReason != tc.wantReason {
					t.Fatalf("Near.SemanticReason = %v, want %q", res.SemanticReason, tc.wantReason)
				}
				if res.Generation != nil {
					t.Fatalf("Near.Generation = %v, want nil when semantic=false", *res.Generation)
				}
				if len(res.Near) != 0 {
					t.Fatalf("Near.Near len = %d, want 0 when semantic=false", len(res.Near))
				}
			}

			if spyProv.QueryCalls() != tc.wantProvMiss {
				t.Fatalf("provider QueryCalls = %d, want %d", spyProv.QueryCalls(), tc.wantProvMiss)
			}
			if searcher.TotalCalls() != tc.wantVecCalls {
				t.Fatalf("VectorSearch TotalCalls = %d, want %d", searcher.TotalCalls(), tc.wantVecCalls)
			}
			if pinner.Calls() != 1 {
				t.Fatalf("ActivePin calls per request = %d, want 1 (BE-1/BE-13)", pinner.Calls())
			}

			gotMetric := counterValue(t, metrics.Search.SemanticDecisionsTotal.WithLabelValues(tc.wantMetric))
			if gotMetric != 1 {
				t.Fatalf("semantic_decisions_total{%s} = %v, want 1", tc.wantMetric, gotMetric)
			}

			// For rows 4 and 6 (where semantic ran), a second request with the same
			// (user, generation, qn) hits the query cache -> 0 new provider calls,
			// while VectorSearch still runs.
			if tc.wantSemantic {
				resHit, err := rt.NearSource().Near(ctx, suggest.NearRequest{
					UserID:        userID,
					QN:            tc.qn,
					Scope:         suggest.ScopeAll,
					Limit:         8,
					Cap:           2,
					SemanticParam: tc.semanticParam,
				})
				if err != nil {
					t.Fatalf("Near cache hit unexpected error: %v", err)
				}
				if !resHit.Semantic {
					t.Fatalf("expected Near cache hit Semantic=true")
				}
				if spyProv.QueryCalls() != tc.wantProvMiss {
					t.Fatalf("cache hit must not call provider again: got %d, want %d", spyProv.QueryCalls(), tc.wantProvMiss)
				}
				if searcher.TotalCalls() != tc.wantVecCalls*2 {
					t.Fatalf("VectorSearch calls after cache hit = %d, want %d", searcher.TotalCalls(), tc.wantVecCalls*2)
				}
			}
		})
	}
}

// TestDecidePrecedenceOrder verifies that when multiple disabling conditions are
// true simultaneously, Decide returns the earliest reason in the order:
// deployment -> generation -> user -> request -> breaker -> length (SPEC §6.4, §6.10).
func TestDecidePrecedenceOrder(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	teiID := testTEIIdentity()
	teiSpy := semantictest.NewSpyProvider(teiID)
	teiClient := embedding.NewClient(teiSpy, teiID.QueryPrefix, teiID.DocPrefix)
	teiCS := embedding.NewClientSet(teiClient, nil)
	pin := testPinForIdentity(1, teiID)

	// Trip breaker, set user=false, request=false, q="a" (<3 runes).
	// Precedence:
	//   - deployment off beats everything -> disabled_server
	//   - user=false beats request=false, breaker=open, length<3 -> disabled_user
	//   - user=true, request=false beats breaker=open, length<3 -> request_lexical
	//   - user=true, request=true, breaker=open beats length<3 -> degraded
	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:     true,
		Provider:    embedding.ProviderTEI,
		ClientSet:   teiCS,
		Pinner:      semantictest.NewSpyPinner(pin, true),
		Calibration: matchingCalibration(teiID),
	})
	_, _, finish := rt.Breaker().Acquire()
	finish(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 500})

	// 1. User off + request=0 + breaker open + short query -> disabled_user wins.
	d1 := rt.Decide(ctx, userID, semantic.UserSettings{SemanticSuggest: false}, semantic.DecideRequest{
		QN:            "a",
		Scope:         suggest.ScopeAll,
		SemanticParam: false,
	})
	if d1.Reason != suggest.ReasonDisabledUser {
		t.Fatalf("user=false + req=false + breaker=open + q='a': got %q, want %q", d1.Reason, suggest.ReasonDisabledUser)
	}

	// 2. User on + request=0 + breaker open + short query -> request_lexical wins.
	d2 := rt.Decide(ctx, userID, semantic.UserSettings{SemanticSuggest: true}, semantic.DecideRequest{
		QN:            "a",
		Scope:         suggest.ReasonRequestLexical,
		SemanticParam: false,
	})
	if d2.Reason != suggest.ReasonRequestLexical {
		t.Fatalf("user=true + req=false + breaker=open + q='a': got %q, want %q", d2.Reason, suggest.ReasonRequestLexical)
	}

	// 3. User on + request=1 + breaker open + short query -> degraded wins over short_query.
	d3 := rt.Decide(ctx, userID, semantic.UserSettings{SemanticSuggest: true}, semantic.DecideRequest{
		QN:            "a",
		Scope:         suggest.ScopeAll,
		SemanticParam: true,
	})
	if d3.Reason != suggest.ReasonDegraded {
		t.Fatalf("user=true + req=true + breaker=open + q='a': got %q, want %q", d3.Reason, suggest.ReasonDegraded)
	}
}

// TestPinClientIdentityMismatchDegrades verifies plan P05 Task 12 (BE-1, BE-13, M1):
//   - When the active generation Pin shares the same provider, model ID, and dims
//     as the configured client, but differs in `model_version`, `doc_prefix`,
//     `query_prefix`, or `preprocessing`, `ClientSet.Match(pin.Identity)` rejects
//     it before any network call:
//   - response is `semantic: false, semantic_reason: "degraded"`
//   - `embedding_generation_mismatch_total{reason="unconfigured"}` increments
//   - 0 provider calls and 0 VectorSearch calls are made
//   - ActivePin is read exactly once per request
//   - When a non-empty `doc_prefix` (and all other 6 fields) on the active generation
//     Pin matches the configured client's identity:
//   - semantic runs (`semantic: true, semantic_reason: nil, generation: 1`)
//   - ActivePin is read at most once per request (never re-read between Decide and Candidates).
func TestPinClientIdentityMismatchDegrades(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

	configuredID := embedid.Identity{
		Provider:      embedding.ProviderTEI,
		Model:         embedding.FakeEmbedModel,
		ModelVersion:  embedding.FakeEmbedModelSHA + ";qp=11111111;dp=22222222",
		Dims:          8,
		QueryPrefix:   "query: ",
		DocPrefix:     "passage: ",
		Preprocessing: embedding.Preprocessing,
	}

	mismatches := []struct {
		name   string
		mutate func(id *embedid.Identity)
	}{
		{
			name: "different_model_version",
			mutate: func(id *embedid.Identity) {
				id.ModelVersion = embedding.FakeEmbedModelSHA + ";qp=11111111;dp=99999999"
			},
		},
		{
			name: "different_doc_prefix",
			mutate: func(id *embedid.Identity) {
				id.DocPrefix = "document: "
			},
		},
		{
			name: "different_query_prefix",
			mutate: func(id *embedid.Identity) {
				id.QueryPrefix = "search_query: "
			},
		},
		{
			name: "different_preprocessing",
			mutate: func(id *embedid.Identity) {
				id.Preprocessing = "v2"
			},
		},
	}

	for _, tc := range mismatches {
		t.Run(tc.name, func(t *testing.T) {
			_, metrics := obs.NewRegistry()
			spyProv := semantictest.NewSpyProvider(configuredID)
			client := embedding.NewClient(spyProv, configuredID.QueryPrefix, configuredID.DocPrefix)
			cs := embedding.NewClientSet(client, nil)

			pinID := configuredID
			tc.mutate(&pinID)
			pin := testPinForIdentity(1, pinID)
			pinner := semantictest.NewSpyPinner(pin, true)
			searcher := &semantictest.SpyVectorSearcher{}

			rt := semantic.NewRuntime(semantic.RuntimeConfig{
				Enabled:        true,
				Provider:       embedding.ProviderTEI,
				ClientSet:      cs,
				Pinner:         pinner,
				Calibration:    func(embedid.Identity) (float64, string, bool) { return 0.62, "report.json", true },
				VectorSearcher: searcher,
				SettingsReader: &semantictest.StaticSettingsReader{Default: true},
				Metrics:        metrics,
				Clock:          clock.NewFixed(ts),
			})

			res, err := rt.NearSource().Near(ctx, suggest.NearRequest{
				UserID:        userID,
				QN:            "ngân hàng",
				Scope:         suggest.ScopeAll,
				Limit:         8,
				Cap:           2,
				SemanticParam: true,
			})
			if err != nil {
				t.Fatalf("Near unexpected error: %v", err)
			}
			if res.Semantic || res.SemanticReason == nil || *res.SemanticReason != suggest.ReasonDegraded {
				t.Fatalf("Near = %+v, want Semantic=false SemanticReason=degraded", res)
			}
			if spyProv.QueryCalls() != 0 {
				t.Fatalf("expected 0 provider calls on identity mismatch, got %d", spyProv.QueryCalls())
			}
			if searcher.TotalCalls() != 0 {
				t.Fatalf("expected 0 VectorSearch calls on identity mismatch, got %d", searcher.TotalCalls())
			}
			if pinner.Calls() != 1 {
				t.Fatalf("expected exactly 1 ActivePin read per request, got %d", pinner.Calls())
			}

			mismatchCount := counterValue(t, metrics.Embedding.GenerationMismatchTotal.WithLabelValues(semantic.MismatchReasonUnconfigured))
			if mismatchCount != 1 {
				t.Fatalf("embedding_generation_mismatch_total{reason=unconfigured} = %v, want 1", mismatchCount)
			}
		})
	}

	t.Run("non_empty_doc_prefix_matching_runs_semantic_with_single_pin_read", func(t *testing.T) {
		_, metrics := obs.NewRegistry()
		spyProv := semantictest.NewSpyProvider(configuredID)
		client := embedding.NewClient(spyProv, configuredID.QueryPrefix, configuredID.DocPrefix)
		cs := embedding.NewClientSet(client, nil)

		pin := testPinForIdentity(1, configuredID)
		pinner := semantictest.NewSpyPinner(pin, true)
		searcher := &semantictest.SpyVectorSearcher{
			ItemHits: []semantic.VectorHit{
				{
					ID:         uuid.MustParse("00000000-0001-4000-8000-000000000011"),
					Cos:        0.91,
					Name:       "tài khoản ngân hàng",
					Count:      2,
					LastUsedAt: ts,
					CreatedAt:  ts,
				},
			},
		}

		rt := semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:        true,
			Provider:       embedding.ProviderTEI,
			ClientSet:      cs,
			Pinner:         pinner,
			Calibration:    matchingCalibration(configuredID),
			VectorSearcher: searcher,
			SettingsReader: &semantictest.StaticSettingsReader{Default: true},
			Metrics:        metrics,
			Clock:          clock.NewFixed(ts),
		})

		res, err := rt.NearSource().Near(ctx, suggest.NearRequest{
			UserID:        userID,
			QN:            "ngân hàng",
			Scope:         suggest.ScopeAll,
			Limit:         8,
			Cap:           2,
			SemanticParam: true,
		})
		if err != nil {
			t.Fatalf("Near unexpected error: %v", err)
		}
		if !res.Semantic || res.SemanticReason != nil || res.Generation == nil || *res.Generation != 1 {
			t.Fatalf("Near = %+v, want Semantic=true SemanticReason=nil Generation=1", res)
		}
		if len(res.Near) != 1 {
			t.Fatalf("len(res.Near) = %d, want 1", len(res.Near))
		}
		if spyProv.QueryCalls() != 1 {
			t.Fatalf("expected 1 provider call, got %d", spyProv.QueryCalls())
		}
		if searcher.TotalCalls() != 2 {
			t.Fatalf("expected 2 VectorSearch calls (item + tag), got %d", searcher.TotalCalls())
		}
		if pinner.Calls() != 1 {
			t.Fatalf("BE-1/BE-13: expected exactly 1 ActivePin read across the entire request, got %d", pinner.Calls())
		}
	})
}

// TestSQLTimeoutDegradesWithoutOpeningBreaker verifies plan P05 mục 2.19, Task 12:
//   - When a VectorSearch branch times out (`PathStats{TimedOut: true}` or
//     `context.DeadlineExceeded`), the request degrades (`semantic: false,
//     semantic_reason: "degraded"`),
//   - The API circuit breaker is NOT opened (`rt.IsBreakerOpen() == false`),
//   - The next request continues to run semantic normally.
func TestSQLTimeoutDegradesWithoutOpeningBreaker(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)
	pin := testPinForIdentity(1, teiID)
	pinner := semantictest.NewSpyPinner(pin, true)

	// First request: item branch reports TimedOut=true (simulating statement_timeout 57014).
	var observedDeadline time.Time
	searcher := &semantictest.SpyVectorSearcher{
		ItemStats: semantic.VectorPathStats{Path: "exact", TimedOut: true},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clock.NewFixed(ts),
	})

	res1, err := rt.NearSource().Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "mật khẩu wifi",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("Near on SQL timeout unexpected error: %v", err)
	}
	if res1.Semantic || res1.SemanticReason == nil || *res1.SemanticReason != suggest.ReasonDegraded {
		t.Fatalf("Near on SQL timeout = %+v, want Semantic=false Reason=degraded", res1)
	}
	if rt.IsBreakerOpen() {
		t.Fatal("SQL branch timeout must NEVER open the provider circuit breaker")
	}

	// Second request: SQL recovers -> semantic succeeds because breaker stayed closed.
	// Also verify RV-T12-BE-2: even when r.clk is fixed in the past (2026-10-25),
	// the deadline passed to VectorSearch is derived from real branchCtx.Deadline()
	// (in the future relative to real time.Now()), never from the injected fake clock.
	searcher.SearchFn = func(
		branchCtx context.Context,
		_ generation.Pin,
		_ uuid.UUID,
		corpus generation.Corpus,
		_ []float32,
		_ int,
		deadline time.Time,
		_ semantic.VectorSearchKnobs,
	) ([]semantic.VectorHit, semantic.VectorPathStats, error) {
		observedDeadline = deadline
		ctxDeadline, ok := branchCtx.Deadline()
		if !ok || !deadline.Equal(ctxDeadline) {
			t.Errorf("VectorSearch deadline = %v, want branchCtx.Deadline() %v (ok=%v)", deadline, ctxDeadline, ok)
		}
		if !deadline.After(time.Now().Add(-5 * time.Second)) {
			t.Errorf("VectorSearch deadline %v is in the past (must use real context deadline, not fake clock)", deadline)
		}
		if corpus == generation.CorpusItem {
			return []semantic.VectorHit{
				{
					ID:         uuid.MustParse("00000000-0001-4000-8000-000000000099"),
					Cos:        0.85,
					Name:       "wifi nhà",
					Count:      4,
					LastUsedAt: ts,
					CreatedAt:  ts,
				},
			}, semantic.VectorPathStats{Path: "exact"}, nil
		}
		return nil, semantic.VectorPathStats{Path: "exact"}, nil
	}
	res2, err := rt.NearSource().Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "truy vấn mới",
		Scope:         suggest.ScopeItem,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("Near after SQL timeout recovery unexpected error: %v", err)
	}
	if !res2.Semantic || res2.SemanticReason != nil || len(res2.Near) != 1 {
		t.Fatalf("Near after SQL timeout recovery = %+v, want Semantic=true len(Near)=1", res2)
	}
	if observedDeadline.IsZero() {
		t.Fatal("expected VectorSearch to observe non-zero branch deadline")
	}
	if searcher.ItemCalls() != 2 || searcher.TagCalls() != 1 {
		t.Fatalf("scope=item on second call should only query item corpus: itemCalls=%d tagCalls=%d",
			searcher.ItemCalls(), searcher.TagCalls())
	}
}

// TestCanceledHalfOpenProbeDoesNotStrandRecovery verifies RV-T12-BE-1:
//   - Trip the API circuit breaker via a provider 503 failure.
//   - Advance the clock by 60 s so the open window expires.
//   - Cancel the first recovery query (caller context.Canceled) -> finish(context.Canceled)
//     leaves the breaker HalfOpen with trialInFlight=false.
//   - Without advancing the clock again, a replacement cache-miss query reaches the
//     provider, and when multiple replacement queries race concurrently in HalfOpen,
//     Acquire() admits exactly ONE probe while the others degrade cleanly with 0
//     extra provider calls.
//   - Once the admitted replacement probe completes successfully, the circuit closes
//     and subsequent queries succeed.
func TestCanceledHalfOpenProbeDoesNotStrandRecovery(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)
	_, metrics := obs.NewRegistry()

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)
	pin := testPinForIdentity(1, teiID)
	pinner := semantictest.NewSpyPinner(pin, true)
	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000077"),
				Cos:        0.89,
				Name:       "router chính",
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Metrics:        metrics,
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	// 1. First query fails with provider 503 -> trips the API circuit breaker for 60 s.
	spyProv.EmbedQueryFn = func(context.Context, string) ([]float32, error) {
		return nil, &embedding.ProviderError{
			Class:      embedding.Class5xx,
			HTTPStatus: 503,
			Detail:     "service unavailable",
		}
	}
	resTrip, err := nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "trip query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("trip Near unexpected error: %v", err)
	}
	if resTrip.Semantic || resTrip.SemanticReason == nil || *resTrip.SemanticReason != suggest.ReasonDegraded {
		t.Fatalf("trip Near = %+v, want Semantic=false Reason=degraded", resTrip)
	}
	if !rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == true immediately after provider 503")
	}
	if spyProv.QueryCalls() != 1 {
		t.Fatalf("expected 1 provider call on trip, got %d", spyProv.QueryCalls())
	}

	// 2. Advance clock 60 s so the open window expires.
	clk.Advance(embedding.BreakerOpenWindow)

	// 3. First recovery query is canceled by the caller inside EmbedQuery.
	cancelCtx, cancelFirst := context.WithCancel(ctx)
	spyProv.EmbedQueryFn = func(callCtx context.Context, _ string) ([]float32, error) {
		cancelFirst()
		return nil, callCtx.Err()
	}
	_, err = nearSrc.Near(cancelCtx, suggest.NearRequest{
		UserID:        userID,
		QN:            "canceled probe query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled probe Near error = %v, want context.Canceled", err)
	}
	if spyProv.QueryCalls() != 2 {
		t.Fatalf("expected 2 total provider calls after canceled probe, got %d", spyProv.QueryCalls())
	}
	// Breaker remains HalfOpen (unhealthy for PATCH IsBreakerOpen, but idle for a replacement probe).
	if rt.Breaker().State() != embedding.BreakerStateHalfOpen {
		t.Fatalf("breaker state after canceled probe = %v, want HalfOpen", rt.Breaker().State())
	}
	if !rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == true while HalfOpen before a replacement probe succeeds")
	}

	// 4. Without advancing the clock again, launch concurrent replacement cache-miss
	// queries. Hold the admitted replacement probe inside EmbedQuery until the
	// contenders have completed so the test is deterministic (no sleeps).
	probeEntered := make(chan struct{})
	releaseProbe := make(chan struct{})
	var enterOnce sync.Once
	spyProv.EmbedQueryFn = func(context.Context, string) ([]float32, error) {
		enterOnce.Do(func() { close(probeEntered) })
		<-releaseProbe
		return []float32{1, 0, 0, 0, 0, 0, 0, 0}, nil
	}

	const contenders = 4
	type callOutcome struct {
		res suggest.NearResult
		err error
	}
	outcomes := make([]callOutcome, contenders)

	// Launch the replacement probe first and wait until it holds the HalfOpen trial slot.
	var probeWG sync.WaitGroup
	probeWG.Add(1)
	go func() {
		defer probeWG.Done()
		r, e := nearSrc.Near(ctx, suggest.NearRequest{
			UserID:        userID,
			QN:            "replacement probe 0",
			Scope:         suggest.ScopeAll,
			Limit:         8,
			Cap:           2,
			SemanticParam: true,
		})
		outcomes[0] = callOutcome{res: r, err: e}
	}()

	<-probeEntered

	// While replacement probe 0 is in flight, concurrent replacement queries 1..3
	// must be rejected by Acquire() and degrade without calling the provider.
	var contenderWG sync.WaitGroup
	for i := 1; i < contenders; i++ {
		contenderWG.Add(1)
		go func(idx int) {
			defer contenderWG.Done()
			r, e := nearSrc.Near(ctx, suggest.NearRequest{
				UserID:        userID,
				QN:            fmt.Sprintf("replacement probe %d", idx),
				Scope:         suggest.ScopeAll,
				Limit:         8,
				Cap:           2,
				SemanticParam: true,
			})
			outcomes[idx] = callOutcome{res: r, err: e}
		}(i)
	}
	contenderWG.Wait()

	// Release the single admitted replacement probe and wait for it to finish.
	close(releaseProbe)
	probeWG.Wait()

	// Exactly 1 replacement query called the provider (total QueryCalls: 2 -> 3).
	if spyProv.QueryCalls() != 3 {
		t.Fatalf("expected exactly 1 replacement probe to reach provider (total 3), got %d", spyProv.QueryCalls())
	}
	if outcomes[0].err != nil || !outcomes[0].res.Semantic || outcomes[0].res.SemanticReason != nil {
		t.Fatalf("admitted replacement probe outcome = %+v (err=%v), want Semantic=true", outcomes[0].res, outcomes[0].err)
	}
	for i := 1; i < contenders; i++ {
		if outcomes[i].err != nil {
			t.Fatalf("contender %d unexpected error: %v", i, outcomes[i].err)
		}
		if outcomes[i].res.Semantic || outcomes[i].res.SemanticReason == nil || *outcomes[i].res.SemanticReason != suggest.ReasonDegraded {
			t.Fatalf("contender %d outcome = %+v, want Semantic=false Reason=degraded", i, outcomes[i].res)
		}
	}

	// 5. Breaker is now Closed and subsequent cache-miss queries succeed normally.
	if rt.Breaker().State() != embedding.BreakerStateClosed {
		t.Fatalf("breaker state after replacement probe success = %v, want Closed", rt.Breaker().State())
	}
	if rt.IsBreakerOpen() {
		t.Fatal("expected IsBreakerOpen() == false after replacement probe succeeded")
	}
	resAfter, err := nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            "post recovery query",
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	if err != nil || !resAfter.Semantic {
		t.Fatalf("post-recovery Near = %+v (err=%v), want Semantic=true", resAfter, err)
	}
	if spyProv.QueryCalls() != 4 {
		t.Fatalf("expected post-recovery cache miss to reach provider (total 4), got %d", spyProv.QueryCalls())
	}
}

// TestActiveGenerationNoProviderCall verifies advisor-dec-290 / dec-294 (Task 12):
//   - NearSource.ActiveGeneration returns the pinned active generation ID from
//     Pinner.ActivePin with 0 provider calls and 0 VectorSearch calls.
//   - Returns (nil, nil) when no generation is active (ErrNoActiveGeneration)
//     or when the runtime has no pinner / is nil.
//   - Is NOT gated on user setting (`semantic_suggest=false`), request `semantic=0`,
//     ClientSet.Match, or static availability (`SEARCH_SEMANTIC_ENABLED=false` /
//     `provider="noop"`), because `/search` cursors bind `gen` on lexical requests too.
//   - Propagates non-ErrNoActiveGeneration Pinner errors so `/search` maps them
//     to HTTP 500 `internal_error`.
func TestActiveGenerationNoProviderCall(t *testing.T) {
	ctx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)
	pin7 := testPinForIdentity(7, teiID)
	pinner := semantictest.NewSpyPinner(pin7, true)
	searcher := &semantictest.SpyVectorSearcher{}
	settings := &semantictest.StaticSettingsReader{Default: false} // user off

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: settings,
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	// 1. Active generation = 7 with user setting off -> returns &7, 0 provider/vector calls.
	reqCtx1, cancel1 := context.WithCancel(ctx)
	gotGen, err := nearSrc.ActiveGeneration(reqCtx1, userID)
	cancel1()
	if err != nil {
		t.Fatalf("ActiveGeneration unexpected error: %v", err)
	}
	if gotGen == nil || *gotGen != 7 {
		t.Fatalf("ActiveGeneration = %v, want 7", gotGen)
	}
	if spyProv.QueryCalls() != 0 {
		t.Fatalf("ActiveGeneration must make 0 provider calls, got %d", spyProv.QueryCalls())
	}
	if searcher.TotalCalls() != 0 {
		t.Fatalf("ActiveGeneration must make 0 VectorSearch calls, got %d", searcher.TotalCalls())
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActiveGeneration Pinner.Calls() = %d, want 1", pinner.Calls())
	}

	// 2. Not gated on static availability, ClientSet.Match, or request semantic=0:
	// Even when Enabled=false, Provider=noop, ClientSet=nil, Calibration=nil, and
	// Near() is called with SemanticParam=false (lexical request), ActiveGeneration
	// still returns &7 from the pinner while Near returns Semantic=false, Generation=nil.
	unconfiguredRT := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        false,
		Provider:       embedding.ProviderNoop,
		ClientSet:      nil,
		Pinner:         pinner,
		Calibration:    nil,
		VectorSearcher: searcher,
		SettingsReader: settings,
		Clock:          clk,
	})
	unconfiguredNear := unconfiguredRT.NearSource()
	pinner.ResetCalls()
	reqCtx2, cancel2 := context.WithCancel(ctx)
	gotGenLex, err := unconfiguredNear.ActiveGeneration(reqCtx2, userID)
	if err != nil {
		cancel2()
		t.Fatalf("ActiveGeneration on disabled/unconfigured server unexpected error: %v", err)
	}
	if gotGenLex == nil || *gotGenLex != 7 {
		cancel2()
		t.Fatalf("ActiveGeneration on disabled/unconfigured server = %v, want 7", gotGenLex)
	}
	nearResLex, err := unconfiguredNear.Near(reqCtx2, suggest.NearRequest{
		UserID:        userID,
		QN:            "mạng wifi",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: false,
	})
	cancel2()
	if err != nil {
		t.Fatalf("Near(semantic=0) unexpected error: %v", err)
	}
	if nearResLex.Semantic || nearResLex.Generation != nil {
		t.Fatalf("Near(semantic=0) = %+v, want Semantic=false Generation=nil", nearResLex)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActiveGeneration + Near in same request must read ActivePin once, got %d", pinner.Calls())
	}

	// 3. No active generation (ErrNoActiveGeneration) -> returns (nil, nil).
	pinner.SetPin(generation.Pin{}, false)
	pinner.ResetCalls()
	reqCtx3, cancel3 := context.WithCancel(ctx)
	gotNil, err := nearSrc.ActiveGeneration(reqCtx3, userID)
	cancel3()
	if err != nil {
		t.Fatalf("ActiveGeneration (no active gen) unexpected error: %v", err)
	}
	if gotNil != nil {
		t.Fatalf("ActiveGeneration (no active gen) = %v, want nil", gotNil)
	}

	// 4. Disabled deployment with nil pinner (or nil Runtime) -> returns (nil, nil).
	noPinnerRT := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:  false,
		Provider: embedding.ProviderNoop,
		Pinner:   nil,
		Clock:    clk,
	})
	gotNoPinner, err := noPinnerRT.NearSource().ActiveGeneration(ctx, userID)
	if err != nil || gotNoPinner != nil {
		t.Fatalf("ActiveGeneration (nil pinner) = (%v, %v), want (nil, nil)", gotNoPinner, err)
	}
	var nilRT *semantic.Runtime
	gotNilRT, err := nilRT.NearSource().ActiveGeneration(ctx, userID)
	if err != nil || gotNilRT != nil {
		t.Fatalf("ActiveGeneration (nil Runtime) = (%v, %v), want (nil, nil)", gotNilRT, err)
	}

	// 5. Pinner error (non-ErrNoActiveGeneration) -> returns (nil, err), 0 provider/vector calls.
	dbBoom := errors.New("pinner db failure")
	pinner.SetError(dbBoom)
	gotErrGen, err := nearSrc.ActiveGeneration(ctx, userID)
	if !errors.Is(err, dbBoom) || gotErrGen != nil {
		t.Fatalf("ActiveGeneration (pinner error) = (%v, %v), want (nil, %v)", gotErrGen, err, dbBoom)
	}
	if spyProv.QueryCalls() != 0 || searcher.TotalCalls() != 0 {
		t.Fatalf("provider=%d vector=%d, want 0 and 0", spyProv.QueryCalls(), searcher.TotalCalls())
	}
}

// TestActiveGenerationAndNearShareSinglePinAcrossFlip verifies advisor-dec-290 / dec-294:
//   - Task 4's `/search` page-1 handler calls `ActiveGeneration(ctx, userID)`
//     (`internal/suggest/search.go:101`) and then `Near(ctx, req)`
//     (`internal/suggest/search.go:240`) within the same request context.
//   - Even if the active generation flips from g1 to g2 (or to nil) between
//     `ActiveGeneration` and `Near`, `Near` reuses the exact `Pin` captured by
//     `ActiveGeneration`: `Pinner.ActivePin` is called only ONCE for the request,
//     `VectorSearch` receives `pin.GenID == 1`, and `NearResult.Generation` is `1`
//     (matching `cursor.gen == 1`).
//   - A subsequent new request (with a fresh request context) observes the flipped
//     generation `g2` (`2`).
func TestActiveGenerationAndNearShareSinglePinAcrossFlip(t *testing.T) {
	baseCtx := context.Background()
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)

	pin1 := testPinForIdentity(1, teiID)
	pin2 := testPinForIdentity(2, teiID)
	pinner := semantictest.NewSpyPinner(pin1, true)

	var observedVectorGenIDs []int
	var vecMu sync.Mutex
	searcher := &semantictest.SpyVectorSearcher{
		SearchFn: func(
			_ context.Context,
			pin generation.Pin,
			_ uuid.UUID,
			corpus generation.Corpus,
			_ []float32,
			_ int,
			_ time.Time,
			_ semantic.VectorSearchKnobs,
		) ([]semantic.VectorHit, semantic.VectorPathStats, error) {
			vecMu.Lock()
			observedVectorGenIDs = append(observedVectorGenIDs, pin.GenID)
			vecMu.Unlock()
			if corpus == generation.CorpusItem {
				return []semantic.VectorHit{
					{
						ID:         uuid.MustParse("00000000-0001-4000-8000-000000000055"),
						Cos:        0.90,
						Name:       "wifi tầng 1",
						Count:      3,
						LastUsedAt: ts,
						CreatedAt:  ts,
					},
				}, semantic.VectorPathStats{Corpus: corpus, Path: semantic.VectorPathExact}, nil
			}
			return nil, semantic.VectorPathStats{Corpus: corpus, Path: semantic.VectorPathExact}, nil
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	// Request 1: page-1 /search calls ActiveGeneration first, then a flip to g2
	// happens mid-request before Near is called.
	reqCtx1, cancel1 := context.WithCancel(semantic.WithRequestScope(baseCtx))
	defer cancel1()

	activeGen1, err := nearSrc.ActiveGeneration(reqCtx1, userID)
	if err != nil {
		t.Fatalf("req1 ActiveGeneration error: %v", err)
	}
	if activeGen1 == nil || *activeGen1 != 1 {
		t.Fatalf("req1 ActiveGeneration = %v, want 1", activeGen1)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("req1 ActivePin calls after ActiveGeneration = %d, want 1", pinner.Calls())
	}

	// Simulate concurrent generation flip g1 -> g2 + NOTIFY between ActiveGeneration and Near.
	pinner.SetPin(pin2, true)
	pinner.Notify()

	nearRes1, err := nearSrc.Near(reqCtx1, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil {
		t.Fatalf("req1 Near error: %v", err)
	}
	if !nearRes1.Semantic || nearRes1.Generation == nil {
		t.Fatalf("req1 Near = %+v, want Semantic=true with non-nil Generation", nearRes1)
	}
	if *nearRes1.Generation != *activeGen1 || *nearRes1.Generation != 1 {
		t.Fatalf("req1 Near.Generation = %d, cursor ActiveGeneration = %d; want both == 1", *nearRes1.Generation, *activeGen1)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("req1 total ActivePin calls across ActiveGeneration + Near = %d, want 1", pinner.Calls())
	}
	vecMu.Lock()
	if len(observedVectorGenIDs) != 2 || observedVectorGenIDs[0] != 1 || observedVectorGenIDs[1] != 1 {
		t.Fatalf("req1 VectorSearch observed GenIDs = %v, want [1 1]", observedVectorGenIDs)
	}
	observedVectorGenIDs = nil
	vecMu.Unlock()

	// Request 2: fresh request context after the flip observes g2 (2) consistently
	// across both ActiveGeneration and Near, again with 1 ActivePin read.
	pinner.ResetCalls()
	reqCtx2, cancel2 := context.WithCancel(semantic.WithRequestScope(baseCtx))
	defer cancel2()

	activeGen2, err := nearSrc.ActiveGeneration(reqCtx2, userID)
	if err != nil || activeGen2 == nil || *activeGen2 != 2 {
		t.Fatalf("req2 ActiveGeneration = (%v, %v), want 2", activeGen2, err)
	}
	nearRes2, err := nearSrc.Near(reqCtx2, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearRes2.Semantic || nearRes2.Generation == nil || *nearRes2.Generation != 2 {
		t.Fatalf("req2 Near = %+v (err=%v), want Generation=2", nearRes2, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("req2 total ActivePin calls across ActiveGeneration + Near = %d, want 1", pinner.Calls())
	}
}

// TestRequestScopeSharedParentNoCollision verifies RV-T12-BE-10:
//   - Two same-user requests derived from a single cancellable parent context,
//     each wrapped with its own semantic.WithRequestScope, never collide when
//     interleaved across a generation flip (g1 -> g2):
//     1. reqA calls ActiveGeneration -> resolves g1 (1).
//     2. Active generation flips to g2 (2) + NOTIFY.
//     3. reqB calls ActiveGeneration -> resolves g2 (2).
//     4. reqA calls Near -> reuses reqA's g1 (1) without a second ActivePin read.
//     5. reqB calls Near -> reuses reqB's g2 (2) without a second ActivePin read.
func TestRequestScopeSharedParentNoCollision(t *testing.T) {
	sharedParent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()

	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)

	pin1 := testPinForIdentity(1, teiID)
	pin2 := testPinForIdentity(2, teiID)
	pinner := semantictest.NewSpyPinner(pin1, true)

	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000055"),
				Cos:        0.90,
				Name:       "wifi tầng 1",
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	// Both requests derive from the SAME cancellable parent andthus share ctx.Done(),
	// but each installs its own request scope.
	reqCtxA := semantic.WithRequestScope(sharedParent)
	reqCtxB := semantic.WithRequestScope(sharedParent)
	if reqCtxA.Done() != reqCtxB.Done() || reqCtxA.Done() == nil {
		t.Fatalf("expected reqCtxA and reqCtxB to share non-nil Done channel")
	}

	// 1. reqA resolves ActiveGeneration while g1 is active.
	genA, err := nearSrc.ActiveGeneration(reqCtxA, userID)
	if err != nil || genA == nil || *genA != 1 {
		t.Fatalf("reqA ActiveGeneration = (%v, %v), want 1", genA, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActivePin calls after reqA ActiveGeneration = %d, want 1", pinner.Calls())
	}

	// 2. Flip g1 -> g2 + NOTIFY.
	pinner.SetPin(pin2, true)
	pinner.Notify()

	// 3. reqB (same user, same parent Done channel, own WithRequestScope) resolves ActiveGeneration -> g2.
	genB, err := nearSrc.ActiveGeneration(reqCtxB, userID)
	if err != nil || genB == nil || *genB != 2 {
		t.Fatalf("reqB ActiveGeneration = (%v, %v), want 2", genB, err)
	}
	if pinner.Calls() != 2 {
		t.Fatalf("ActivePin calls after reqB ActiveGeneration = %d, want 2", pinner.Calls())
	}

	// 4. reqA runs Near -> must still see its own Pin (g1 == 1), NOT reqB's g2.
	nearA, err := nearSrc.Near(reqCtxA, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearA.Semantic || nearA.Generation == nil || *nearA.Generation != 1 {
		t.Fatalf("reqA Near = %+v (err=%v), want Generation=1", nearA, err)
	}

	// 5. reqB runs Near -> sees its own Pin (g2 == 2).
	nearB, err := nearSrc.Near(reqCtxB, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearB.Semantic || nearB.Generation == nil || *nearB.Generation != 2 {
		t.Fatalf("reqB Near = %+v (err=%v), want Generation=2", nearB, err)
	}
	if pinner.Calls() != 2 {
		t.Fatalf("total ActivePin calls across interleaved reqA + reqB = %d, want 2", pinner.Calls())
	}
}

// TestRequestScopeInheritedByChildContexts verifies RV-T12-BE-10:
//   - Child contexts derived via context.WithValue, context.WithCancel, and
//     context.WithTimeout inherit the parent's request-scoped Pin carrier.
//   - Also verifies negative Pin caching (no-active -> active flip within a
//     scoped request keeps Near consistent with ActiveGeneration == nil).
func TestRequestScopeInheritedByChildContexts(t *testing.T) {
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)

	pin1 := testPinForIdentity(1, teiID)
	pin2 := testPinForIdentity(2, teiID)
	pinner := semantictest.NewSpyPinner(pin1, true)

	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000055"),
				Cos:        0.90,
				Name:       "wifi tầng 1",
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	type ctxKey string
	scopedRoot := semantic.WithRequestScope(context.Background())
	valChild := context.WithValue(scopedRoot, ctxKey("k"), "v")
	cancelChild, cancel := context.WithCancel(valChild)
	defer cancel()
	timeoutChild, cancelTimeout := context.WithTimeout(cancelChild, time.Minute)
	defer cancelTimeout()

	// Call ActiveGeneration on valChild (sees g1), flip to g2, then call Near on timeoutChild.
	gen, err := nearSrc.ActiveGeneration(valChild, userID)
	if err != nil || gen == nil || *gen != 1 {
		t.Fatalf("ActiveGeneration on valChild = (%v, %v), want 1", gen, err)
	}
	pinner.SetPin(pin2, true)
	pinner.Notify()

	nearRes, err := nearSrc.Near(timeoutChild, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearRes.Semantic || nearRes.Generation == nil || *nearRes.Generation != 1 {
		t.Fatalf("Near on timeoutChild = %+v (err=%v), want Generation=1", nearRes, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActivePin calls across valChild + timeoutChild = %d, want 1", pinner.Calls())
	}

	// Also verify no-active -> active flip within a scoped request reuses the negative resolution.
	pinner.SetPin(generation.Pin{}, false)
	pinner.ResetCalls()
	noActiveScope := semantic.WithRequestScope(context.Background())
	genNil, err := nearSrc.ActiveGeneration(noActiveScope, userID)
	if err != nil || genNil != nil {
		t.Fatalf("ActiveGeneration (no active) = (%v, %v), want (nil, nil)", genNil, err)
	}
	// Flip to active g2 mid-request; Near must still observe no-active (disabled_server, Generation=nil) with 0 extra reads.
	pinner.SetPin(pin2, true)
	pinner.Notify()
	nearNil, err := nearSrc.Near(noActiveScope, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || nearNil.Semantic || nearNil.Generation != nil || nearNil.SemanticReason == nil || *nearNil.SemanticReason != suggest.ReasonDisabledServer {
		t.Fatalf("Near after no-active->active flip = %+v (err=%v), want disabled_server and Generation=nil", nearNil, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActivePin calls for no-active->active flip = %d, want 1", pinner.Calls())
	}
}

// TestRequestScopeUserMismatchNoReuse verifies RV-T12-BE-10:
//   - When a carrier in ctx was resolved for userA, a call with userB on the
//     same carrier does NOT reuse userA's cached Pin and does NOT overwrite
//     userA's cached Pin; userB reads fresh from Pinner.ActivePin while a
//     subsequent call for userA still reuses userA's original Pin.
func TestRequestScopeUserMismatchNoReuse(t *testing.T) {
	userA := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	userB := uuid.MustParse("22222222-2222-4000-8000-000000000002")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)

	pin1 := testPinForIdentity(1, teiID)
	pin2 := testPinForIdentity(2, teiID)
	pinner := semantictest.NewSpyPinner(pin1, true)

	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000055"),
				Cos:        0.90,
				Name:       "wifi tầng 1",
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	scopedCtx := semantic.WithRequestScope(context.Background())

	// userA resolves g1 (1).
	genA, err := nearSrc.ActiveGeneration(scopedCtx, userA)
	if err != nil || genA == nil || *genA != 1 {
		t.Fatalf("userA ActiveGeneration = (%v, %v), want 1", genA, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActivePin calls after userA = %d, want 1", pinner.Calls())
	}

	// Flip to g2 (2).
	pinner.SetPin(pin2, true)
	pinner.Notify()

	// userB on the same scopedCtx must NOT reuse userA's g1; it reads fresh -> g2 (2).
	nearB, err := nearSrc.Near(scopedCtx, suggest.NearRequest{
		UserID:        userB,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearB.Semantic || nearB.Generation == nil || *nearB.Generation != 2 {
		t.Fatalf("userB Near = %+v (err=%v), want Generation=2 (fresh read)", nearB, err)
	}
	if pinner.Calls() != 2 {
		t.Fatalf("ActivePin calls after userB mismatch Near = %d, want 2", pinner.Calls())
	}

	// userA's slot was NOT overwritten by userB; userA Near still reuses g1 (1) with 0 extra reads.
	nearA, err := nearSrc.Near(scopedCtx, suggest.NearRequest{
		UserID:        userA,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearA.Semantic || nearA.Generation == nil || *nearA.Generation != 1 {
		t.Fatalf("userA Near = %+v (err=%v), want Generation=1 (preserved)", nearA, err)
	}
	if pinner.Calls() != 2 {
		t.Fatalf("ActivePin calls after userA Near = %d, want 2", pinner.Calls())
	}
}

// TestNoRequestScopeFallsBackToFreshReads verifies RV-T12-BE-10:
//   - Without a request-scoped carrier in ctx, ActiveGeneration and Near each
//     read ActivePin fresh, do not panic, and retain no cross-call state.
func TestNoRequestScopeFallsBackToFreshReads(t *testing.T) {
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	teiID := testTEIIdentity()
	spyProv := semantictest.NewSpyProvider(teiID)
	client := embedding.NewClient(spyProv, teiID.QueryPrefix, teiID.DocPrefix)
	cs := embedding.NewClientSet(client, nil)

	pin1 := testPinForIdentity(1, teiID)
	pin2 := testPinForIdentity(2, teiID)
	pinner := semantictest.NewSpyPinner(pin1, true)

	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000055"),
				Cos:        0.90,
				Name:       "wifi tầng 1",
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
	}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(teiID),
		VectorSearcher: searcher,
		SettingsReader: &semantictest.StaticSettingsReader{Default: true},
		Clock:          clk,
	})
	nearSrc := rt.NearSource()

	bareCtx := context.Background()
	gen1, err := nearSrc.ActiveGeneration(bareCtx, userID)
	if err != nil || gen1 == nil || *gen1 != 1 {
		t.Fatalf("ActiveGeneration on bareCtx = (%v, %v), want 1", gen1, err)
	}
	if pinner.Calls() != 1 {
		t.Fatalf("ActivePin calls after first read = %d, want 1", pinner.Calls())
	}

	pinner.SetPin(pin2, true)
	pinner.Notify()

	nearRes, err := nearSrc.Near(bareCtx, suggest.NearRequest{
		UserID:        userID,
		QN:            "wifi tầng",
		Scope:         suggest.ScopeAll,
		Limit:         20,
		Cap:           5,
		SemanticParam: true,
	})
	if err != nil || !nearRes.Semantic || nearRes.Generation == nil || *nearRes.Generation != 2 {
		t.Fatalf("Near on bareCtx = %+v (err=%v), want Generation=2 (fresh read)", nearRes, err)
	}
	if pinner.Calls() != 2 {
		t.Fatalf("ActivePin calls without carrier = %d, want 2", pinner.Calls())
	}
}
