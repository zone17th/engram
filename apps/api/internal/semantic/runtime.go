// Package semantic implements the P05 query-time semantic search runtime:
// static availability caching, request-level decision precedence, HMAC-keyed
// LRU query-vector caching, single-pin candidate retrieval, pure near-zone
// merging, and the suggest.NearSource implementation (plan P05 mục 2.7,
// 2.18, 2.19, 2.21, Task 12; SPEC §6.3, §6.4, §6.10).
//
// Security invariant (user-dec-016, plan P05 mục 1, 2.7, 2.21):
//   - Never accesses entry bodies or item hints at query time.
//   - Never logs, wraps in an error, or emits in metric labels any raw query q,
//     normalized query qn, item/tag names, vectors, provider URLs, API keys, or
//     response bodies. Only fixed reason codes and error_class labels are logged.
//   - Every query cache key includes the user_id and generation_id, keyed with a
//     32-byte per-process random HMAC secret that is never persisted or logged.
package semantic

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// ActivePinReader abstracts generation.Pinner so tests can inject a deterministic
// or spy pinner while production uses *generation.Pinner.
type ActivePinReader interface {
	ActivePin(ctx context.Context) (generation.Pin, error)
	Subscribe(fn func())
}

// UserSettingsReader looks up the user's `semantic_suggest` setting (default true
// when absent or nil, matching app_user.settings schema in migration 0004).
type UserSettingsReader interface {
	SemanticSuggestEnabled(ctx context.Context, userID uuid.UUID) (bool, error)
}

type dbUserSettingsReader struct {
	db gen.DBTX
}

// NewDBUserSettingsReader constructs a UserSettingsReader backed by db.
func NewDBUserSettingsReader(db gen.DBTX) UserSettingsReader {
	return &dbUserSettingsReader{db: db}
}

func (r *dbUserSettingsReader) SemanticSuggestEnabled(ctx context.Context, userID uuid.UUID) (bool, error) {
	if r == nil || r.db == nil {
		return true, nil
	}
	u, err := gen.New(r.db).GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return parseSemanticSuggestSetting(u.Settings), nil
}

func parseSemanticSuggestSetting(raw []byte) bool {
	if len(raw) == 0 {
		return true
	}
	var parsed struct {
		SemanticSuggest *bool `json:"semantic_suggest"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return true
	}
	if parsed.SemanticSuggest == nil {
		return true
	}
	return *parsed.SemanticSuggest
}

// RuntimeConfig configures a semantic.Runtime instance.
type RuntimeConfig struct {
	Enabled        bool
	Provider       string
	ShadowProvider string
	AppEnv         string
	Knobs          VectorSearchKnobs
	ClientSet      *embedding.ClientSet
	PrimaryBreaker *embedding.Breaker
	ShadowBreaker  *embedding.Breaker
	Pinner         ActivePinReader
	Calibration    embedid.CalibrationLookup
	Cache          *QueryCache
	VectorSearcher VectorSearcher
	SettingsReader UserSettingsReader
	ItemTagLoader  ItemTagRefLoader
	Metrics        *obs.Metrics
	Logger         *slog.Logger
	Clock          clock.Clock
}

// Runtime owns the single shared semantic search state for an API process:
// provider ClientSet, per-provider API circuit breakers, generation Pinner,
// 30 s availability cache (invalidated immediately on NOTIFY), query embedding
// cache, and VectorSearcher (plan P05 mục 2.18, 2.19, Task 12, FS-6, L8).
type Runtime struct {
	enabled        bool
	provider       string
	shadowProvider string
	knobs          VectorSearchKnobs
	clients        *embedding.ClientSet
	breakers       map[string]*embedding.Breaker
	primaryBreaker *embedding.Breaker
	pinner         ActivePinReader
	calibration    embedid.CalibrationLookup
	cache          *QueryCache
	searcher       VectorSearcher
	settings       UserSettingsReader
	tagLoader      ItemTagRefLoader
	metrics        *obs.Metrics
	logger         *slog.Logger
	clk            clock.Clock

	availMu       sync.Mutex
	availCached   bool
	availExternal bool
	availProvider string
	availHasCache bool
	availExpires  time.Time
	availEpoch    uint64
}

// NewRuntime constructs a Runtime from rc and subscribes its availability cache
// to Pinner notifications so generation flips invalidate the 30 s cache
// immediately (M3, FS-25).
func NewRuntime(rc RuntimeConfig) *Runtime {
	clk := rc.Clock
	if clk == nil {
		clk = clock.System{}
	}
	prov := strings.TrimSpace(rc.Provider)
	if prov == "" {
		prov = embedding.ProviderNoop
	}
	shadowProv := strings.TrimSpace(rc.ShadowProvider)

	cal := rc.Calibration
	if cal == nil {
		cal = embedding.CalibrationLookupFor(rc.AppEnv)
	}
	knobs := rc.Knobs
	if knobs.VectorBranchTimeout <= 0 {
		knobs.VectorBranchTimeout = DefaultVectorBranchTimeout
	}

	var embMetrics *obs.EmbeddingMetrics
	if rc.Metrics != nil {
		embMetrics = rc.Metrics.Embedding
	}

	breakers := make(map[string]*embedding.Breaker, 2)
	primaryBreaker := rc.PrimaryBreaker
	if primaryBreaker == nil && prov != embedding.ProviderNoop {
		primaryBreaker = embedding.NewAPIBreaker(prov, clk.Now, embMetrics)
	}
	if primaryBreaker != nil && prov != "" && prov != embedding.ProviderNoop {
		breakers[prov] = primaryBreaker
	}
	if rc.ShadowBreaker != nil && shadowProv != "" && shadowProv != embedding.ProviderNoop {
		breakers[shadowProv] = rc.ShadowBreaker
	} else if shadowProv != "" && shadowProv != embedding.ProviderNoop && breakers[shadowProv] == nil {
		breakers[shadowProv] = embedding.NewAPIBreaker(shadowProv, clk.Now, embMetrics)
	}
	if rc.ClientSet != nil {
		if p := rc.ClientSet.Primary(); p.Identity.Provider != "" && p.Identity.Provider != embedding.ProviderNoop {
			if breakers[p.Identity.Provider] == nil {
				if primaryBreaker != nil {
					breakers[p.Identity.Provider] = primaryBreaker
				} else {
					b := embedding.NewAPIBreaker(p.Identity.Provider, clk.Now, embMetrics)
					breakers[p.Identity.Provider] = b
					if primaryBreaker == nil {
						primaryBreaker = b
					}
				}
			}
		}
		if s, ok := rc.ClientSet.Shadow(); ok && s.Identity.Provider != "" && s.Identity.Provider != embedding.ProviderNoop {
			if breakers[s.Identity.Provider] == nil {
				breakers[s.Identity.Provider] = embedding.NewAPIBreaker(s.Identity.Provider, clk.Now, embMetrics)
			}
		}
	}

	rt := &Runtime{
		enabled:        rc.Enabled,
		provider:       prov,
		shadowProvider: shadowProv,
		knobs:          knobs,
		clients:        rc.ClientSet,
		breakers:       breakers,
		primaryBreaker: primaryBreaker,
		pinner:         rc.Pinner,
		calibration:    cal,
		cache:          rc.Cache,
		searcher:       rc.VectorSearcher,
		settings:       rc.SettingsReader,
		tagLoader:      rc.ItemTagLoader,
		metrics:        rc.Metrics,
		logger:         rc.Logger,
		clk:            clk,
	}

	if rt.pinner != nil {
		rt.pinner.Subscribe(rt.InvalidateAvailability)
	}
	return rt
}

// NewRuntimeFromConfig builds the single process-wide semantic.Runtime from
// *config.Config and *pgxpool.Pool (used in cmd/api/main.go, plan P05 Task 12,
// FS-6, L8, degrade C4).
//
// Boot invariant (degrade C4): a provider failure at boot (such as TEI /info
// unreachable or returning a bad response) logs only error_class (never URLs,
// keys, or response bodies) and leaves ClientSet nil so Runtime reports
// unavailable (disabled_server) while the API server still starts cleanly.
func NewRuntimeFromConfig(
	ctx context.Context,
	cfg *config.Config,
	pool *pgxpool.Pool,
	pinner *generation.Pinner,
	clk clock.Clock,
	metrics *obs.Metrics,
	logger *slog.Logger,
) *Runtime {
	if clk == nil {
		clk = clock.System{}
	}
	var (
		enabled        bool
		prov           = embedding.ProviderNoop
		shadowProv     string
		appEnv         string
		knobs          VectorSearchKnobs
		clientSet      *embedding.ClientSet
		embMetrics     *obs.EmbeddingMetrics
		settingsReader UserSettingsReader
		tagLoader      ItemTagRefLoader
		searcher       VectorSearcher
	)
	if metrics != nil {
		embMetrics = metrics.Embedding
	}
	if cfg != nil {
		enabled = cfg.SearchSemanticEnabled
		if strings.TrimSpace(cfg.EmbeddingProvider) != "" {
			prov = strings.TrimSpace(cfg.EmbeddingProvider)
		}
		shadowProv = strings.TrimSpace(cfg.EmbeddingShadowProvider)
		appEnv = cfg.Env
		knobs = VectorSearchKnobs{
			ExactMaxVectors:         cfg.SearchExactMaxVectors,
			ExactFallbackMaxVectors: cfg.SearchExactFallbackMaxVectors,
			HNSWEfSearch:            cfg.SearchHNSWEfSearch,
			HNSWMaxScanTuples:       cfg.SearchHNSWMaxScanTuples,
			HNSWIterativeScan:       cfg.SearchHNSWIterativeScan,
			VectorBranchTimeout:     cfg.SearchVectorBranchTimeout,
			VectorFallbackMinBudget: cfg.SearchVectorFallbackMinBudget,
		}
	}
	if pool != nil {
		settingsReader = &dbUserSettingsReader{db: pool}
		tagLoader = &dbItemTagRefLoader{db: pool}
		searcher = NewExactVectorSearcher(pool)
		if pinner == nil && enabled && prov != embedding.ProviderNoop {
			pinner = generation.NewPinner(pool, generation.WithPinNowFunc(clk.Now))
		}
	}
	if cfg != nil {
		if enabled && prov != embedding.ProviderNoop {
			primaryCfg := cfg.EmbeddingPrimary()
			var shadowPtr *embedding.ClientConfig
			if sc, ok := cfg.EmbeddingShadow(); ok {
				shadowPtr = &sc
			}
			cs, err := embedding.NewClientSetFromConfigs(ctx, primaryCfg, shadowPtr, embedding.ClientDeps{
				Metrics: embMetrics,
				Logger:  logger,
				Now:     clk.Now,
			})
			if err != nil {
				logSafeError(ctx, logger, "semantic runtime provider init failed", classifyProviderError(err))
			} else {
				clientSet = cs
			}
		}
	}

	var pinReader ActivePinReader
	if pinner != nil {
		pinReader = pinner
	}

	return NewRuntime(RuntimeConfig{
		Enabled:        enabled,
		Provider:       prov,
		ShadowProvider: shadowProv,
		AppEnv:         appEnv,
		Knobs:          knobs,
		ClientSet:      clientSet,
		Pinner:         pinReader,
		VectorSearcher: searcher,
		SettingsReader: settingsReader,
		ItemTagLoader:  tagLoader,
		Metrics:        metrics,
		Logger:         logger,
		Clock:          clk,
	})
}

// ClientSet returns the configured *embedding.ClientSet (nil when disabled or
// when boot initialization degraded).
func (r *Runtime) ClientSet() *embedding.ClientSet {
	if r == nil {
		return nil
	}
	return r.clients
}

// Breaker returns the primary API circuit breaker (or the breaker for the
// active generation's provider).
func (r *Runtime) Breaker() *embedding.Breaker {
	if r == nil {
		return nil
	}
	return r.primaryBreaker
}

// BreakerForProvider returns the API circuit breaker for provider ("tei" or
// "openai_compat"), falling back to the primary breaker if registered.
func (r *Runtime) BreakerForProvider(provider string) *embedding.Breaker {
	if r == nil {
		return nil
	}
	if b, ok := r.breakers[provider]; ok && b != nil {
		return b
	}
	return r.primaryBreaker
}

// Cache returns the runtime's query embedding cache, lazily initializing it
// if not provided in RuntimeConfig.
func (r *Runtime) Cache() *QueryCache {
	if r == nil {
		return nil
	}
	r.availMu.Lock()
	defer r.availMu.Unlock()
	if r.cache == nil {
		r.cache = NewQueryCache(DefaultCacheMaxEntries, DefaultCacheTTL, r.clk.Now)
	}
	return r.cache
}

func classifyProviderError(err error) string {
	if err == nil {
		return ""
	}
	var pe *embedding.ProviderError
	if errors.As(err, &pe) && pe != nil && pe.Class != "" {
		return string(pe.Class)
	}
	if errors.Is(err, embedding.ErrBadResponse) {
		return string(embedding.ClassBadResponse)
	}
	if embedding.IsTimeoutError(err) {
		return string(embedding.ClassTimeout)
	}
	return string(embedding.ClassRefused)
}

// logSafeError writes a structured warning log containing ONLY a static message
// and the sanitized error_class reason code (plan P05 mục 1, 2.21).
func logSafeError(ctx context.Context, logger *slog.Logger, msg string, errorClass string) {
	if logger == nil || errorClass == "" {
		return
	}
	logger.LogAttrs(ctx, slog.LevelWarn, msg, slog.String("error_class", errorClass))
}
