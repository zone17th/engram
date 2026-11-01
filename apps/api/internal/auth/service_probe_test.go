package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/config"
)

func TestConfigProbeTracksTEIHealth(t *testing.T) {
	var available atomic.Bool
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/health" {
			http.Error(w, "wrong probe request", http.StatusNotFound)
			return
		}
		if !available.Load() {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	probe := ConfigProbe(&config.Config{EmbeddingProvider: "tei", TEIURL: server.URL})
	if got := requests.Load(); got != 0 {
		t.Fatalf("ConfigProbe performed %d requests during construction", got)
	}
	if probe.Available(context.Background()) {
		t.Fatal("unavailable TEI reported as available")
	}

	available.Store(true)
	if !probe.Available(context.Background()) {
		t.Fatal("available TEI reported as unavailable")
	}

	available.Store(false)
	if probe.Available(context.Background()) {
		t.Fatal("TEI outage reported as available after recovery check")
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("health request count = %d, want 3", got)
	}
}

func TestConfigProbeDisablesMissingTEI(t *testing.T) {
	probe := ConfigProbe(&config.Config{EmbeddingProvider: "noop", TEIURL: "http://127.0.0.1:1"})
	if probe.Available(context.Background()) {
		t.Fatal("noop embedding provider reported as available")
	}
}
