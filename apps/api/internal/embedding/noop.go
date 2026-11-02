package embedding

import "context"

// Noop is a Provider for deployments where semantic search is disabled or
// unconfigured (SPEC §4.4, plan P05 mục 2.12). Its Embed* methods always
// return ErrUnavailable and never return a zero vector (cosine with a zero
// vector is NaN).
type Noop struct{}

// NewNoop returns a Noop provider.
func NewNoop() Noop {
	return Noop{}
}

func (Noop) Name() string         { return ProviderNoop }
func (Noop) Model() string        { return ProviderNoop }
func (Noop) ModelVersion() string { return "" }
func (Noop) Dims() int            { return 0 }
func (Noop) MaxBatch() int        { return MaxBatch }

func (Noop) EmbedDocuments(context.Context, []string) ([][]float32, error) {
	return nil, ErrUnavailable
}

func (Noop) EmbedQuery(context.Context, string) ([]float32, error) {
	return nil, ErrUnavailable
}
