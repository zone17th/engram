package suggest

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// Error represents a domain error mapped to an existing RFC 9457 ProblemCode
// ("invalid_request" or "name_invalid"). Detail is always a static string and
// never echoes user input (user-dec-016).
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string { return e.Code }

// Is supports errors.Is comparison by Code.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && e != nil && t != nil && e.Code == t.Code
}

var (
	// ErrInvalidRequest maps to HTTP 400 "invalid_request".
	ErrInvalidRequest = &Error{Code: "invalid_request", Detail: "Yêu cầu không hợp lệ."}
	// ErrNameInvalid maps to HTTP 400 "name_invalid".
	ErrNameInvalid = &Error{Code: "name_invalid", Detail: "Từ khoá tìm kiếm không hợp lệ."}
)

// AsError extracts a *Error from err if present.
func AsError(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var se *Error
	if errors.As(err, &se) && se != nil {
		return se, true
	}
	return nil, false
}

// TestHooks allows tests (such as TestSuggestBranchTimeoutPartial) to inject
// deterministic hooks into a lexical branch without sleeping or modifying production SQL.
// Test-only: production never sets it.
type TestHooks struct {
	// BeforeBranch runs at the start of the branch SETUP stage, before acquire + BEGIN; its ctx
	// is bounded by BranchSetupTimeout (FU-SB-2).
	BeforeBranch func(ctx context.Context, corpus string) error
	// AfterBranchSetLocal runs at the start of the QUERY stage, after the SET LOCALs; its ctx is
	// the 50 ms branch budget.
	AfterBranchSetLocal func(ctx context.Context, tx pgx.Tx, corpus string) error
	// BranchContext, when set, replaces context.WithTimeout(parent, BranchTimeout) as the
	// per-branch QUERY context (FU-SB-2: the setup stage has its own bound, see SetupTimeout). A test that injects a GENUINE error uses it to hand the branch a
	// non-expiring context (a WithCancel child of parent), so the real 50 ms timer cannot fire
	// between the injection and classifyBranchErr (RV-SB1-BE-4). The parent must stay its
	// parent so a request cancel still reaches the branch.
	BranchContext func(parent context.Context, corpus string) (context.Context, context.CancelFunc)
	// SetupTimeout, when > 0, replaces BranchSetupTimeout (acquire + BEGIN + SET LOCAL) so a test
	// can expire the setup stage without waiting the production 2 s (FU-SB-2).
	SetupTimeout time.Duration
}

// Service implements `/suggest` (Task 3) and `/search` (Task 4).
type Service struct {
	pool      *pgxpool.Pool
	txStarter TxStarter
	clk       clock.Clock
	near      NearSource
	metrics   *obs.Metrics
	cursorKey []byte
	hooks     atomic.Pointer[TestHooks]
	logger    atomic.Pointer[slog.Logger]

	lexicalCustomPlanOff atomic.Bool
}

// NewService constructs a suggest Service.
// If `near` is nil, `NewNoopNearSource()` is used.
// If `clk` is nil, `clock.System{}` is used.
func NewService(
	pool *pgxpool.Pool,
	clk clock.Clock,
	near NearSource,
	metrics *obs.Metrics,
	cursorKey []byte,
) *Service {
	if clk == nil {
		clk = clock.System{}
	}
	if near == nil {
		near = NewNoopNearSource()
	}
	var keyCopy []byte
	if len(cursorKey) > 0 {
		keyCopy = make([]byte, len(cursorKey))
		copy(keyCopy, cursorKey)
	}
	var txStarter TxStarter
	if pool != nil {
		txStarter = pool
	}
	return &Service{
		pool:      pool,
		txStarter: txStarter,
		clk:       clk,
		near:      near,
		metrics:   metrics,
		cursorKey: keyCopy,
	}
}

// SetTxStarter overrides the transaction starter (used by tests to wrap BeginTx).
func (s *Service) SetTxStarter(ts TxStarter) {
	if ts != nil {
		s.txStarter = ts
	} else if s.pool != nil {
		s.txStarter = s.pool
	}
}

// SetNearSource overrides the NearSource (used by Task 12 or tests).
func (s *Service) SetNearSource(near NearSource) {
	if near == nil {
		near = NewNoopNearSource()
	}
	s.near = near
}

// SetTestHooks attaches test hooks to the service.
func (s *Service) SetTestHooks(h *TestHooks) {
	s.hooks.Store(h)
}

// setLogger attaches the logger used for the lexical partial line (FU-SB-2). It is set through
// Handler.SetLogger / Mount so NewService and the compose call sites stay unchanged.
func (s *Service) setLogger(l *slog.Logger) { s.logger.Store(l) }

func (s *Service) activeHooks() *TestHooks {
	return s.hooks.Load()
}

// branchContext returns the per-branch QUERY context: the BranchTimeout budget in production, or
// the TestHooks.BranchContext override a test installed. runBranch creates it only after setup.
func (s *Service) branchContext(parent context.Context, corpus string) (context.Context, context.CancelFunc) {
	if h := s.activeHooks(); h != nil && h.BranchContext != nil {
		return h.BranchContext(parent, corpus)
	}
	return context.WithTimeout(parent, BranchTimeout)
}

// CursorKey returns a copy of the HKDF-derived cursor HMAC key (for Task 4 `/search`).
func (s *Service) CursorKey() []byte {
	if len(s.cursorKey) == 0 {
		return nil
	}
	out := make([]byte, len(s.cursorKey))
	copy(out, s.cursorKey)
	return out
}

// SuggestInput holds the validated query parameters for `GET /suggest`.
type SuggestInput struct {
	UserID   uuid.UUID
	RawQ     string
	Scope    string
	Limit    int
	Semantic bool
}

// ParsedSuggestQuery holds the normalized query, effective scope, mode, and whether
// normalization produced an empty query (`ErrEmptyQuery` -> 200 empty prefix response).
type ParsedSuggestQuery struct {
	Scope      string
	Mode       string
	QN         string
	EmptyAfter bool
}

// ParseSuggestQuery implements plan P05 mục 2.2 normalization and mode resolution:
//  1. Reject invalid UTF-8 or forbidden control/bidi characters immediately -> ErrNameInvalid.
//  2. Trim leading Unicode whitespace (`unicode.IsSpace`).
//  3. If the remaining string is empty -> mode `recent` (effective scope stays caller's scope).
//  4. If the first rune after leading-whitespace trim is `#`:
//     - Force `scope = "tag"`.
//     - Strip the leading `#`.
//     - Take the first whitespace-delimited token (up to the first `unicode.IsSpace` rune;
//     if nothing precedes the first whitespace, e.g. `"# foo"` or `"#"`, the token is `""`
//     which normalizes to empty -> 200 empty prefix response, NOT recent).
//  5. Normalize via `textnorm.NormalizeTagQuery` (when `scope == "tag"`) or
//     `textnorm.NormalizeQuery` (when `scope == "all" | "item"`).
//  6. `errors.Is(err, textnorm.ErrEmptyQuery)` -> 200 empty response with `mode = "prefix"`.
//     Any other error (>200 runes, >50 tag runes, control/bidi, invalid UTF-8) -> 400 `name_invalid`.
//  7. `len_runes(qn) < 2` -> `mode = "prefix"`; `len_runes(qn) >= 2` -> `mode = "full"`.
func ParseSuggestQuery(rawQ string, requestedScope string) (ParsedSuggestQuery, error) {
	scope := requestedScope
	if scope == "" {
		scope = ScopeAll
	}
	if !ValidSuggestScope(scope) {
		return ParsedSuggestQuery{}, ErrInvalidRequest
	}

	if !utf8.ValidString(rawQ) || hasForbiddenInRaw(rawQ) {
		return ParsedSuggestQuery{}, ErrNameInvalid
	}
	if trimmed := strings.TrimFunc(rawQ, unicode.IsSpace); utf8.RuneCountInString(trimmed) > textnorm.QueryMaxRunes {
		return ParsedSuggestQuery{}, ErrNameInvalid
	}

	trimmedLeading := strings.TrimLeftFunc(rawQ, unicode.IsSpace)
	if trimmedLeading == "" {
		return ParsedSuggestQuery{
			Scope: scope,
			Mode:  ModeRecent,
			QN:    "",
		}, nil
	}

	candidate := trimmedLeading
	if strings.HasPrefix(trimmedLeading, "#") {
		scope = ScopeTag
		afterHash := trimmedLeading[1:]
		token := firstTokenBeforeSpace(afterHash)
		if token == "" {
			return ParsedSuggestQuery{
				Scope:      ScopeTag,
				Mode:       ModePrefix,
				QN:         "",
				EmptyAfter: true,
			}, nil
		}
		candidate = token
	}

	var (
		qn  string
		err error
	)
	if scope == ScopeTag {
		qn, err = textnorm.NormalizeTagQuery(candidate)
	} else {
		qn, err = textnorm.NormalizeQuery(candidate)
	}
	if err != nil {
		if errors.Is(err, textnorm.ErrEmptyQuery) {
			return ParsedSuggestQuery{
				Scope:      scope,
				Mode:       ModePrefix,
				QN:         "",
				EmptyAfter: true,
			}, nil
		}
		return ParsedSuggestQuery{}, ErrNameInvalid
	}
	if qn == "" {
		return ParsedSuggestQuery{
			Scope:      scope,
			Mode:       ModePrefix,
			QN:         "",
			EmptyAfter: true,
		}, nil
	}

	mode := ModePrefix
	if utf8.RuneCountInString(qn) >= 2 {
		mode = ModeFull
	}
	return ParsedSuggestQuery{
		Scope: scope,
		Mode:  mode,
		QN:    qn,
	}, nil
}

func firstTokenBeforeSpace(s string) string {
	for i, r := range s {
		if unicode.IsSpace(r) {
			return s[:i]
		}
	}
	return s
}

func hasForbiddenInRaw(s string) bool {
	for _, r := range s {
		if r == ' ' {
			continue
		}
		if r <= 0x001F || (r >= 0x007F && r <= 0x009F) {
			return true
		}
		if (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			return true
		}
	}
	return false
}

// Suggest executes `GET /api/v1/suggest` (SPEC §6.2–§6.4, §9.2, plan P05 mục 2.2–2.5, Task 3).
func (s *Service) Suggest(ctx context.Context, in SuggestInput) (SuggestResponse, error) {
	start := time.Now()
	if in.UserID == uuid.Nil {
		return SuggestResponse{}, ErrInvalidRequest
	}
	limit := in.Limit
	if limit == 0 {
		limit = DefaultSuggestLimit
	}
	if !ValidSuggestLimit(limit) {
		return SuggestResponse{}, ErrInvalidRequest
	}

	parsed, err := ParseSuggestQuery(in.RawQ, in.Scope)
	if err != nil {
		return SuggestResponse{}, err
	}

	var resp SuggestResponse
	defer func() {
		if resp.Scope != "" && s.metrics != nil && s.metrics.Search != nil && s.metrics.Search.SuggestLatency != nil {
			s.metrics.Search.SuggestLatency.WithLabelValues(
				resp.Mode,
				resp.Scope,
				strconv.FormatBool(resp.Semantic),
			).Observe(time.Since(start).Seconds())
		}
	}()

	// Case 1: Query normalized to empty (`!!!`, `#` alone) -> 200 with empty arrays,
	// mode = "prefix", no DB query, no provider call (plan mục 2.2, BE-10).
	if parsed.EmptyAfter {
		alloc := ComputeQuota(parsed.Scope, limit, ModePrefix, 0, 0, 0)
		reason, err := s.recentSemanticReason(ctx, in, parsed, limit)
		if err != nil {
			return SuggestResponse{}, withScope(err, parsed.Scope, parsed.Mode)
		}
		resp = SuggestResponse{
			Scope:          parsed.Scope,
			Limit:          limit,
			Mode:           ModePrefix,
			Quota:          alloc.WireQuota,
			Tags:           []SuggestTag{},
			Items:          []SuggestItem{},
			HasMore:        false,
			LexicalPartial: []string{},
			Semantic:       false,
			SemanticReason: reason,
			Near:           []SuggestNearRow{},
			Generation:     nil,
		}
		resp.NormalizeSlices()
		return resp, nil
	}

	// Case 2: Run lexical branches (recent, prefix, or full).
	rawTags, rawItems, tagMoreFetched, itemMoreFetched, partial, err := s.runLexicalBranches(
		ctx,
		in.UserID,
		parsed.Scope,
		limit,
		parsed.Mode,
		parsed.QN,
	)
	if err != nil {
		return SuggestResponse{}, withScope(err, parsed.Scope, parsed.Mode)
	}

	alloc := ComputeQuota(parsed.Scope, limit, parsed.Mode, len(rawTags), len(rawItems), 0)
	tags := rawTags
	if len(tags) > alloc.TagsUsed {
		tags = tags[:alloc.TagsUsed]
	}
	items := rawItems
	if len(items) > alloc.ItemsUsed {
		items = items[:alloc.ItemsUsed]
	}

	hasMore := tagMoreFetched || itemMoreFetched || len(rawTags) > alloc.TagsUsed || len(rawItems) > alloc.ItemsUsed

	// Recent mode: ask NearSource for its semantic decision with QN="" and Cap=0
	// (so no embedding/provider/vector work is requested), while keeping near: [],
	// semantic: false, generation: null, and recent quota.near = 0 (plan mục 2.4, 2.18, 2.24 item 5).
	if parsed.Mode == ModeRecent {
		reason, err := s.recentSemanticReason(ctx, in, parsed, limit)
		if err != nil {
			return SuggestResponse{}, withScope(err, parsed.Scope, parsed.Mode)
		}
		resp = SuggestResponse{
			Scope:          parsed.Scope,
			Limit:          limit,
			Mode:           ModeRecent,
			Quota:          alloc.WireQuota,
			Tags:           tags,
			Items:          items,
			HasMore:        hasMore,
			LexicalPartial: partial,
			Semantic:       false,
			SemanticReason: reason,
			Near:           []SuggestNearRow{},
			Generation:     nil,
		}
		resp.NormalizeSlices()
		return resp, nil
	}

	// Build lexical exclusion list `(kind, id)` so NearSource and post-filter exclude lexical rows.
	exclude := make([]KindID, 0, len(tags)+len(items))
	lexSet := make(map[KindID]struct{}, len(tags)+len(items))
	for _, t := range tags {
		k := KindID{Kind: CorpusTag, ID: t.ID}
		exclude = append(exclude, k)
		lexSet[k] = struct{}{}
	}
	for _, it := range items {
		k := KindID{Kind: CorpusItem, ID: it.ID}
		exclude = append(exclude, k)
		lexSet[k] = struct{}{}
	}

	nearCap := min(alloc.WireQuota.Near, max(0, limit-len(tags)-len(items)))
	nearRes, err := s.resolveNear(ctx, in, parsed, limit, exclude, nearCap)
	if err != nil {
		return SuggestResponse{}, withScope(err, parsed.Scope, parsed.Mode)
	}

	nearRows := filterAndClipNear(nearRes.Near, lexSet, alloc.WireQuota, limit, len(tags), len(items))

	resp = SuggestResponse{
		Scope:          parsed.Scope,
		Limit:          limit,
		Mode:           parsed.Mode,
		Quota:          alloc.WireQuota,
		Tags:           tags,
		Items:          items,
		HasMore:        hasMore,
		LexicalPartial: partial,
		Semantic:       nearRes.Semantic,
		SemanticReason: nearRes.SemanticReason,
		Near:           nearRows,
		Generation:     nearRes.Generation,
	}
	resp.NormalizeSlices()
	return resp, nil
}

func (s *Service) recentSemanticReason(ctx context.Context, in SuggestInput, parsed ParsedSuggestQuery, limit int) (*string, error) {
	// Route recent mode (`QN == ""`, `Cap == 0`) through NearSource so decision
	// ownership (deployment -> generation -> user -> request -> breaker -> length)
	// stays in the source without concrete type assertions, while Cap == 0 and QN == ""
	// guarantee no provider or vector work is requested.
	nearRes, err := s.resolveNear(ctx, in, parsed, limit, nil, 0)
	if err != nil {
		return nil, err
	}
	if nearRes.SemanticReason != nil {
		return nearRes.SemanticReason, nil
	}
	if !in.Semantic {
		return new(ReasonRequestLexical), nil
	}
	return new(ReasonShortQuery), nil
}

func (s *Service) resolveNear(
	ctx context.Context,
	in SuggestInput,
	parsed ParsedSuggestQuery,
	limit int,
	exclude []KindID,
	nearCap int,
) (NearResult, error) {
	req := NearRequest{
		UserID:        in.UserID,
		QN:            parsed.QN,
		Scope:         parsed.Scope,
		Limit:         limit,
		Exclude:       exclude,
		Cap:           nearCap,
		SemanticParam: in.Semantic,
	}
	var (
		res NearResult
		err error
	)
	if s.near == nil {
		res, err = (NoopNearSource{}).Near(ctx, req)
	} else {
		res, err = s.near.Near(ctx, req)
	}
	if err != nil {
		if _, domain := AsError(err); domain {
			return NearResult{}, err
		}
		return NearResult{}, newInternalError(ClassNearSource, "", parsed.Mode, err)
	}
	if !res.Semantic {
		res.Near = []SuggestNearRow{}
		res.Generation = nil
		if res.SemanticReason == nil {
			res.SemanticReason = new(ReasonDisabledServer)
		}
	} else {
		res.SemanticReason = nil
	}
	return res, nil
}

// filterAndClipNear deduplicates near candidates against lexical `(kind, id)`,
// enforces `match = "semantic"`, orders `SuggestTag` before `SuggestItem` (SPEC §6.4, OQ-11),
// and clips to `near_used = min(near_hits_after_dedup, quota.near, limit - tags_used - items_used)`.
func filterAndClipNear(
	raw []SuggestNearRow,
	lexSet map[KindID]struct{},
	wireQuota SuggestQuota,
	limit int,
	tagsUsed int,
	itemsUsed int,
) []SuggestNearRow {
	if len(raw) == 0 {
		return []SuggestNearRow{}
	}
	maxNear := min(wireQuota.Near, max(0, limit-tagsUsed-itemsUsed))
	if maxNear <= 0 {
		return []SuggestNearRow{}
	}

	seen := make(map[KindID]struct{}, len(lexSet)+len(raw))
	for k := range lexSet {
		seen[k] = struct{}{}
	}

	var nearTags []SuggestNearRow
	var nearItems []SuggestNearRow

	for _, row := range raw {
		switch v := row.(type) {
		case SuggestTag:
			k := KindID{Kind: CorpusTag, ID: v.ID}
			if _, exists := seen[k]; exists {
				continue
			}
			seen[k] = struct{}{}
			v.Kind = CorpusTag
			v.Match = MatchSemantic
			nearTags = append(nearTags, v)
		case *SuggestTag:
			if v == nil {
				continue
			}
			cp := *v
			k := KindID{Kind: CorpusTag, ID: cp.ID}
			if _, exists := seen[k]; exists {
				continue
			}
			seen[k] = struct{}{}
			cp.Kind = CorpusTag
			cp.Match = MatchSemantic
			nearTags = append(nearTags, cp)
		case SuggestItem:
			k := KindID{Kind: CorpusItem, ID: v.ID}
			if _, exists := seen[k]; exists {
				continue
			}
			seen[k] = struct{}{}
			v.Kind = CorpusItem
			v.Match = MatchSemantic
			if v.Tags == nil {
				v.Tags = []TagRef{}
			}
			nearItems = append(nearItems, v)
		case *SuggestItem:
			if v == nil {
				continue
			}
			cp := *v
			k := KindID{Kind: CorpusItem, ID: cp.ID}
			if _, exists := seen[k]; exists {
				continue
			}
			seen[k] = struct{}{}
			cp.Kind = CorpusItem
			cp.Match = MatchSemantic
			if cp.Tags == nil {
				cp.Tags = []TagRef{}
			}
			nearItems = append(nearItems, cp)
		}
	}

	combined := make([]SuggestNearRow, 0, len(nearTags)+len(nearItems))
	combined = append(combined, nearTags...)
	combined = append(combined, nearItems...)
	if len(combined) > maxNear {
		combined = combined[:maxNear]
	}
	return combined
}
