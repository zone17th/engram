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
