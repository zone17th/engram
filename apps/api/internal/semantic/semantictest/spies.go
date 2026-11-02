// Package semantictest provides reusable fakes and spies for testing the
// query-time semantic runtime without live provider networks or Postgres
// containers when unit-testing (plan P05 Task 12).
package semantictest

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/semantic"
)

// SpyProvider implements embedding.Provider and counts EmbedQuery and
// EmbedDocuments calls.
type SpyProvider struct {
	ProviderName string
	ModelID      string
	Version      string
	VectorDims   int
	EmbedQueryFn func(ctx context.Context, q string) ([]float32, error)
	EmbedDocsFn  func(ctx context.Context, inputs []string) ([][]float32, error)

	queryCalls atomic.Int64
	docCalls   atomic.Int64
}

// NewSpyProvider constructs a SpyProvider for identity with a deterministic
// unit vector along axis 0 by default.
func NewSpyProvider(id embedid.Identity) *SpyProvider {
	dims := id.Dims
	if dims <= 0 {
		dims = 8
	}
	return &SpyProvider{
		ProviderName: id.Provider,
		ModelID:      id.Model,
		Version:      id.ModelVersion,
		VectorDims:   dims,
	}
}

func (p *SpyProvider) Name() string         { return p.ProviderName }
func (p *SpyProvider) Model() string        { return p.ModelID }
func (p *SpyProvider) ModelVersion() string { return p.Version }
func (p *SpyProvider) Dims() int            { return p.VectorDims }
func (p *SpyProvider) MaxBatch() int        { return embedding.MaxBatch }

func (p *SpyProvider) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	p.queryCalls.Add(1)
	if p.EmbedQueryFn != nil {
		return p.EmbedQueryFn(ctx, q)
	}
	vec := make([]float32, p.VectorDims)
	if len(vec) > 0 {
		vec[0] = 1.0
	}
	return vec, nil
}

func (p *SpyProvider) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	p.docCalls.Add(1)
	if p.EmbedDocsFn != nil {
		return p.EmbedDocsFn(ctx, inputs)
	}
	out := make([][]float32, len(inputs))
	for i := range inputs {
		vec := make([]float32, p.VectorDims)
		if len(vec) > 0 {
			vec[0] = 1.0
		}
		out[i] = vec
	}
	return out, nil
}

// QueryCalls returns the number of EmbedQuery invocations observed so far.
func (p *SpyProvider) QueryCalls() int64 {
	return p.queryCalls.Load()
}

// ResetQueryCalls resets the EmbedQuery counter to 0.
func (p *SpyProvider) ResetQueryCalls() {
	p.queryCalls.Store(0)
}

// SpyPinner implements semantic.ActivePinReader with an atomic call counter and
// subscriber broadcast for simulating NOTIFY invalidations.
type SpyPinner struct {
	mu          sync.Mutex
	pin         generation.Pin
	hasPin      bool
	err         error
	afterRead   func(call int64)
	subscribers []func()
	calls       atomic.Int64
}

// NewSpyPinner creates a SpyPinner returning pin when hasPin is true, or
// generation.ErrNoActiveGeneration when hasPin is false.
func NewSpyPinner(pin generation.Pin, hasPin bool) *SpyPinner {
	return &SpyPinner{
		pin:    pin,
		hasPin: hasPin,
	}
}

func (p *SpyPinner) ActivePin(_ context.Context) (generation.Pin, error) {
	call := p.calls.Add(1)
	p.mu.Lock()
	pin := p.pin
	hasPin := p.hasPin
	err := p.err
	hook := p.afterRead
	p.mu.Unlock()
	if hook != nil {
		hook(call)
	}
	if err != nil {
		return generation.Pin{}, err
	}
	if !hasPin {
		return generation.Pin{}, generation.ErrNoActiveGeneration
	}
	return pin, nil
}

func (p *SpyPinner) Subscribe(fn func()) {
	if fn == nil {
		return
	}
	p.mu.Lock()
	p.subscribers = append(p.subscribers, fn)
	p.mu.Unlock()
}

// SetPin updates the active Pin returned by SpyPinner.
func (p *SpyPinner) SetPin(pin generation.Pin, hasPin bool) {
	p.mu.Lock()
	p.pin = pin
	p.hasPin = hasPin
	p.err = nil
	p.mu.Unlock()
}

// SetError configures SpyPinner to return err on ActivePin.
func (p *SpyPinner) SetError(err error) {
	p.mu.Lock()
	p.err = err
	p.mu.Unlock()
}

// SetAfterRead registers an optional callback invoked after each ActivePin read
// (outside p.mu so the callback may call SetPin / Notify to simulate a flip
// immediately after the first read).
func (p *SpyPinner) SetAfterRead(fn func(call int64)) {
	p.mu.Lock()
	p.afterRead = fn
	p.mu.Unlock()
}

// Notify triggers all registered subscribers (simulating NOTIFY embedding_generation_changed).
func (p *SpyPinner) Notify() {
	p.mu.Lock()
	subs := make([]func(), len(p.subscribers))
	copy(subs, p.subscribers)
	p.mu.Unlock()
	for _, fn := range subs {
		fn()
	}
}

// Calls returns the number of ActivePin calls observed so far.
func (p *SpyPinner) Calls() int64 {
	return p.calls.Load()
}

// ResetCalls resets the ActivePin call counter to 0.
func (p *SpyPinner) ResetCalls() {
	p.calls.Store(0)
}

// SpyVectorSearcher implements semantic.VectorSearcher and records calls per corpus.
type SpyVectorSearcher struct {
	mu        sync.Mutex
	ItemHits  []semantic.VectorHit
	TagHits   []semantic.VectorHit
	ItemStats semantic.VectorPathStats
	TagStats  semantic.VectorPathStats
	ItemErr   error
	TagErr    error
	SearchFn  func(
		ctx context.Context,
		pin generation.Pin,
		userID uuid.UUID,
		corpus generation.Corpus,
		qvec []float32,
		k int,
		deadline time.Time,
		knobs semantic.VectorSearchKnobs,
	) ([]semantic.VectorHit, semantic.VectorPathStats, error)

	totalCalls atomic.Int64
	itemCalls  atomic.Int64
	tagCalls   atomic.Int64
}

func (s *SpyVectorSearcher) VectorSearch(
	ctx context.Context,
	pin generation.Pin,
	userID uuid.UUID,
	corpus generation.Corpus,
	qvec []float32,
	k int,
	deadline time.Time,
	knobs semantic.VectorSearchKnobs,
) ([]semantic.VectorHit, semantic.VectorPathStats, error) {
	s.totalCalls.Add(1)
	switch corpus {
	case generation.CorpusItem:
		s.itemCalls.Add(1)
	case generation.CorpusTag:
		s.tagCalls.Add(1)
	}
	if len(qvec) != pin.Identity.Dims {
		return nil, semantic.VectorPathStats{}, semantic.ErrDimsMismatch
	}
	if s.SearchFn != nil {
		return s.SearchFn(ctx, pin, userID, corpus, qvec, k, deadline, knobs)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if corpus == generation.CorpusItem {
		hits := make([]semantic.VectorHit, len(s.ItemHits))
		copy(hits, s.ItemHits)
		st := s.ItemStats
		if st.Path == "" {
			st.Path = "exact"
		}
		return hits, st, s.ItemErr
	}
	hits := make([]semantic.VectorHit, len(s.TagHits))
	copy(hits, s.TagHits)
	st := s.TagStats
	if st.Path == "" {
		st.Path = "exact"
	}
	return hits, st, s.TagErr
}

// TotalCalls returns the total number of VectorSearch calls across both corpora.
func (s *SpyVectorSearcher) TotalCalls() int64 {
	return s.totalCalls.Load()
}

// ItemCalls returns the number of item corpus VectorSearch calls.
func (s *SpyVectorSearcher) ItemCalls() int64 {
	return s.itemCalls.Load()
}

// TagCalls returns the number of tag corpus VectorSearch calls.
func (s *SpyVectorSearcher) TagCalls() int64 {
	return s.tagCalls.Load()
}

// ResetCalls resets all VectorSearch counters to 0.
func (s *SpyVectorSearcher) ResetCalls() {
	s.totalCalls.Store(0)
	s.itemCalls.Store(0)
	s.tagCalls.Store(0)
}

// StaticSettingsReader implements semantic.UserSettingsReader with a configurable
// boolean or per-user map.
type StaticSettingsReader struct {
	mu      sync.Mutex
	Default bool
	ByUser  map[uuid.UUID]bool
	Err     error
	calls   atomic.Int64
}

func (r *StaticSettingsReader) SemanticSuggestEnabled(_ context.Context, userID uuid.UUID) (bool, error) {
	r.calls.Add(1)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Err != nil {
		return false, r.Err
	}
	if r.ByUser != nil {
		if v, ok := r.ByUser[userID]; ok {
			return v, nil
		}
	}
	return r.Default, nil
}

// Calls returns how many times SemanticSuggestEnabled was called.
func (r *StaticSettingsReader) Calls() int64 {
	return r.calls.Load()
}
