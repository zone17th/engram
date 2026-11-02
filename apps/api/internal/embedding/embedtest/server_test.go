package embedtest_test

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
)

func cosine(a, b []float32) float64 {
	var dot, na, nb float64
	for i := range a {
		fa, fb := float64(a[i]), float64(b[i])
		dot += fa * fb
		na += fa * fa
		nb += fb * fb
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

func l2Norm(v []float32) float64 {
	var sum float64
	for _, x := range v {
		f := float64(x)
		sum += f * f
	}
	return math.Sqrt(sum)
}

func TestDeterministicVectorTrigramSimilarity(t *testing.T) {
	v1 := embedtest.DeterministicVector("mật khẩu wifi nhà", 1024, true, 1.0)
	v1Again := embedtest.DeterministicVector("mật khẩu wifi nhà", 1024, true, 1.0)
	if len(v1) != 1024 {
		t.Fatalf("len(v1) = %d, want 1024", len(v1))
	}
	for i := range v1 {
		if v1[i] != v1Again[i] {
			t.Fatalf("non-deterministic at index %d: %v vs %v", i, v1[i], v1Again[i])
		}
	}
	if diff := math.Abs(l2Norm(v1) - 1.0); diff > 1e-6 {
		t.Fatalf("normalized norm = %v, want 1.0 ± 1e-6", l2Norm(v1))
	}

	vSimilar := embedtest.DeterministicVector("mật khẩu wifi tầng 2", 1024, true, 1.0)
	vUnrelated := embedtest.DeterministicVector("họp kế hoạch ngân sách quý 4", 1024, true, 1.0)

	cosSim := cosine(v1, vSimilar)
	cosUnrel := cosine(v1, vUnrelated)
	if cosSim <= cosUnrel || cosSim < 0.4 {
		t.Fatalf("expected similar trigram cosine (%v) > unrelated cosine (%v) and >= 0.4", cosSim, cosUnrel)
	}

	vUnnorm := embedtest.DeterministicVector("mật khẩu wifi nhà", 1024, false, 3.0)
	if diff := math.Abs(l2Norm(vUnnorm) - 3.0); diff > 1e-4 {
		t.Fatalf("unnormalized norm = %v, want ~3.0", l2Norm(vUnnorm))
	}
}

func TestServerTEIAndOpenAIEndpoints(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{
		Dims:     16,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-abc123",
	})
	defer srv.Close()

	// 1. GET /info
	resp, err := http.Get(srv.URL() + "/info")
	if err != nil {
		t.Fatalf("GET /info: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /info status = %d", resp.StatusCode)
	}
	var info map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("decode /info: %v", err)
	}
	if info["model_id"] != "BAAI/bge-m3" || info["model_sha"] != "sha-abc123" {
		t.Fatalf("unexpected /info: %+v", info)
	}

	// 2. POST /embed (TEI)
	teiBody := []byte(`{"inputs":["doc-a","doc-b"],"normalize":true,"truncate":true}`)
	teiResp, err := http.Post(srv.URL()+"/embed", "application/json", bytes.NewReader(teiBody))
	if err != nil {
		t.Fatalf("POST /embed: %v", err)
	}
	defer teiResp.Body.Close()
	var teiVecs [][]float32
	if err := json.NewDecoder(teiResp.Body).Decode(&teiVecs); err != nil {
		t.Fatalf("decode /embed: %v", err)
	}
	if len(teiVecs) != 2 || len(teiVecs[0]) != 16 {
		t.Fatalf("unexpected TEI vectors shape: %d x %d", len(teiVecs), len(teiVecs[0]))
	}

	// 3. POST /v1/embeddings (OpenAI)
	oaiBody := []byte(`{"model":"qwen","input":["Instruct: test\nQuery:wifi"],"dimensions":16,"encoding_format":"float"}`)
	oaiResp, err := http.Post(srv.URL()+"/v1/embeddings", "application/json", bytes.NewReader(oaiBody))
	if err != nil {
		t.Fatalf("POST /v1/embeddings: %v", err)
	}
	defer oaiResp.Body.Close()
	raw, _ := io.ReadAll(oaiResp.Body)
	if !bytes.Contains(raw, []byte(`"embedding"`)) {
		t.Fatalf("unexpected OpenAI body: %s", raw)
	}

	gotInputs := srv.ReceivedInputs()
	if len(gotInputs) != 3 {
		t.Fatalf("ReceivedInputs len = %d, want 3: %v", len(gotInputs), gotInputs)
	}

	stats := srv.Stats()
	if stats.DocumentRequests != 1 || stats.QueryRequests != 1 || stats.TotalRequests != 2 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}
