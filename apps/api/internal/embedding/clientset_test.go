package embedding_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

type countingFakeProvider struct {
	name         string
	model        string
	modelVersion string
	dims         int
	docCalls     atomic.Int32
	queryCalls   atomic.Int32
}

func (p *countingFakeProvider) Name() string         { return p.name }
func (p *countingFakeProvider) Model() string        { return p.model }
func (p *countingFakeProvider) ModelVersion() string { return p.modelVersion }
func (p *countingFakeProvider) Dims() int            { return p.dims }
func (p *countingFakeProvider) MaxBatch() int        { return embedding.MaxBatch }

func (p *countingFakeProvider) EmbedDocuments(_ context.Context, inputs []string) ([][]float32, error) {
	p.docCalls.Add(1)
	out := make([][]float32, len(inputs))
	for i := range inputs {
		v := make([]float32, p.dims)
		if p.dims > 0 {
			v[0] = 1
		}
		out[i] = v
	}
	return out, nil
}

func (p *countingFakeProvider) EmbedQuery(_ context.Context, _ string) ([]float32, error) {
	p.queryCalls.Add(1)
	v := make([]float32, p.dims)
	if p.dims > 0 {
		v[0] = 1
	}
	return v, nil
}

func TestIdentityKeyCoversAllFields(t *testing.T) {
	base := embedid.Identity{
		Provider:      "openai_compat",
		Model:         "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "dims=1024;instr=3a8f1b2c",
		Dims:          1024,
		QueryPrefix:   "Instruct: Given a short search query, retrieve matching item names or tags\nQuery:",
		DocPrefix:     "",
		Preprocessing: "v1",
	}
	baseKey := base.Key()

	mutators := []struct {
		field string
		fn    func(id *embedid.Identity)
	}{
		{"Provider", func(id *embedid.Identity) { id.Provider = "tei" }},
		{"Model", func(id *embedid.Identity) { id.Model = "openai_compat/qwen/other" }},
		{"ModelVersion", func(id *embedid.Identity) { id.ModelVersion = "dims=1024;instr=ffffffff" }},
		{"Dims", func(id *embedid.Identity) { id.Dims = 768 }},
		{"QueryPrefix", func(id *embedid.Identity) { id.QueryPrefix = "query: " }},
		{"DocPrefix", func(id *embedid.Identity) { id.DocPrefix = "passage: " }},
		{"Preprocessing", func(id *embedid.Identity) { id.Preprocessing = "v2" }},
	}

	for _, tc := range mutators {
		t.Run("single_field_"+tc.field, func(t *testing.T) {
			modified := base
			tc.fn(&modified)
			if got := modified.Key(); got == baseKey {
				t.Fatalf("changing %s alone did not change Identity.Key(): %q", tc.field, got)
			}
		})
	}

	// Ambiguous boundary concatenations must never collide (M1).
	collisionPairs := []struct {
		name string
		a, b embedid.Identity
	}{
		{
			name: "pipe_boundary_provider_model",
			a:    embedid.Identity{Provider: "a|b", Model: "c", ModelVersion: "v1", Dims: 1024, Preprocessing: "v1"},
			b:    embedid.Identity{Provider: "a", Model: "b|c", ModelVersion: "v1", Dims: 1024, Preprocessing: "v1"},
		},
		{
			name: "semicolon_and_length_prefix_injection",
			a:    embedid.Identity{Provider: "a;1:b", Model: "c", ModelVersion: "v1", Dims: 1024, Preprocessing: "v1"},
			b:    embedid.Identity{Provider: "a", Model: "b;1:c", ModelVersion: "v1", Dims: 1024, Preprocessing: "v1"},
		},
		{
			name: "query_prefix_vs_doc_prefix_shift",
			a:    embedid.Identity{Provider: "tei", Model: "tei/bge-m3", ModelVersion: "sha", Dims: 1024, QueryPrefix: "q:", DocPrefix: "", Preprocessing: "v1"},
			b:    embedid.Identity{Provider: "tei", Model: "tei/bge-m3", ModelVersion: "sha", Dims: 1024, QueryPrefix: "", DocPrefix: "q:", Preprocessing: "v1"},
		},
		{
			name: "colon_newline_injection",
			a:    embedid.Identity{Provider: "tei", Model: "m\n3:abc;", ModelVersion: "v", Dims: 512, QueryPrefix: "x", DocPrefix: "y", Preprocessing: "v1"},
			b:    embedid.Identity{Provider: "tei", Model: "m\n", ModelVersion: "abc;1:v", Dims: 512, QueryPrefix: "x", DocPrefix: "y", Preprocessing: "v1"},
		},
	}

	for _, pair := range collisionPairs {
		t.Run(pair.name, func(t *testing.T) {
			if pair.a.Key() == pair.b.Key() {
				t.Fatalf("ambiguous identities collided on Key() = %q", pair.a.Key())
			}
		})
	}
}

func TestClientMatchRequiresFullIdentity(t *testing.T) {
	primaryProv := &countingFakeProvider{
		name:         embedding.ProviderOpenAICompat,
		model:        "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		modelVersion: "dims=1024;instr=3a8f1b2c",
		dims:         1024,
	}
	shadowProv := &countingFakeProvider{
		name:         embedding.ProviderTEI,
		model:        "tei/intfloat/multilingual-e5-base",
		modelVersion: "9f4b1c2;qp=a1b2c3d4;dp=e5f60718",
		dims:         768,
	}

	primaryClient := embedding.NewClient(
		primaryProv,
		embedding.OpenAIQueryPrefix("Given a short search query, retrieve matching item names or tags"),
		"",
	)
	shadowClient := embedding.NewClientWithRole(
		shadowProv,
		"query: ",
		"passage: ",
		embedding.RoleShadow,
	)

	cs := embedding.NewClientSet(primaryClient, &shadowClient)

	// 1. Mismatched identities (same model ID, different ModelVersion / DocPrefix /
	// QueryPrefix / Dims / Preprocessing) must not match and must make 0 provider calls.
	mismatches := []struct {
		name   string
		mutate func(id *embedid.Identity)
	}{
		{"different_model_version", func(id *embedid.Identity) { id.ModelVersion = "dims=1024;instr=00000000" }},
		{"different_doc_prefix", func(id *embedid.Identity) { id.DocPrefix = "passage: " }},
		{"different_query_prefix", func(id *embedid.Identity) { id.QueryPrefix = "Instruct: other\nQuery:" }},
		{"different_preprocessing", func(id *embedid.Identity) { id.Preprocessing = "v2" }},
		{"different_dims", func(id *embedid.Identity) { id.Dims = 512 }},
		{"different_provider", func(id *embedid.Identity) { id.Provider = embedding.ProviderTEI }},
		{"different_model", func(id *embedid.Identity) { id.Model = "openai_compat/other/model" }},
	}

	for _, tc := range mismatches {
		t.Run("mismatch_"+tc.name, func(t *testing.T) {
			id := primaryClient.Identity
			tc.mutate(&id)
			got, ok := cs.Match(id)
			if ok {
				t.Fatalf("Match(%s) = true (role=%s), want false", tc.name, got.Role)
			}
		})
	}

	if primaryProv.docCalls.Load() != 0 || primaryProv.queryCalls.Load() != 0 {
		t.Fatalf("primary provider called during failed Match checks: doc=%d query=%d",
			primaryProv.docCalls.Load(), primaryProv.queryCalls.Load())
	}
	if shadowProv.docCalls.Load() != 0 || shadowProv.queryCalls.Load() != 0 {
		t.Fatalf("shadow provider called during failed Match checks: doc=%d query=%d",
			shadowProv.docCalls.Load(), shadowProv.queryCalls.Load())
	}

	// 2. Exact primary identity matches primary client.
	matchedPrimary, ok := cs.Match(primaryClient.Identity)
	if !ok {
		t.Fatal("expected exact primary identity to match")
	}
	if matchedPrimary.Role != embedding.RolePrimary {
		t.Fatalf("matched Role = %q, want %q", matchedPrimary.Role, embedding.RolePrimary)
	}
	if matchedPrimary.Identity.Key() != primaryClient.Identity.Key() {
		t.Fatalf("matched Identity.Key() = %q, want %q", matchedPrimary.Identity.Key(), primaryClient.Identity.Key())
	}

	// 3. Exact shadow identity matches shadow client.
	matchedShadow, ok := cs.Match(shadowClient.Identity)
	if !ok {
		t.Fatal("expected exact shadow identity to match")
	}
	if matchedShadow.Role != embedding.RoleShadow {
		t.Fatalf("matched Role = %q, want %q", matchedShadow.Role, embedding.RoleShadow)
	}
	if matchedShadow.Identity.Key() != shadowClient.Identity.Key() {
		t.Fatalf("matched Identity.Key() = %q, want %q", matchedShadow.Identity.Key(), shadowClient.Identity.Key())
	}

	// 4. Noop client never matches.
	noopCS := embedding.NewClientSet(embedding.NewClient(embedding.NewNoop(), "", ""), nil)
	if _, ok := noopCS.Match(embedid.Identity{Provider: embedding.ProviderNoop}); ok {
		t.Fatal("noop client must never match")
	}
}
