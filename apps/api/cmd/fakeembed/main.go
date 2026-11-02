// Command fakeembed runs the deterministic CI-only fake embedding server
// supporting TEI (/info, /health, /embed), OpenAI (/embeddings, /v1/embeddings),
// runtime fault control (POST /__control), and request counters
// (GET /__control/stats) for compose profile semantic-fake (plan P05 mục 2.12,
// 2.20, 2.22, Task 16; SPEC §4.4, §11.3; advisor-dec-279).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
)

const (
	defaultAddr = "0.0.0.0:8080"
	defaultDims = 1024
	minDims     = 1
	maxDims     = 2000

	shutdownTimeout = 10 * time.Second
)

type envLookup func(string) string

type serverConfig struct {
	appEnv      string
	addr        string
	dims        int
	queryPrefix string
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe GET /__control/stats on the local listener and exit by status")
	flag.Parse()

	if *healthcheck {
		if err := probeHealthcheck(context.Background(), os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With(slog.String("service", "engram-fakeembed"))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Getenv, logger); err != nil {
		logger.Error("fakeembed stopped with error", slog.String("err", err.Error()))
		os.Exit(1)
	}
}

func parseConfig(getenv envLookup) (serverConfig, error) {
	if getenv == nil {
		getenv = os.Getenv
	}

	// Fail closed outside development/staging (dec-262, advisor-dec-279):
	// never echo the raw APP_ENV value in the error or log message.
	appEnv := strings.TrimSpace(getenv("APP_ENV"))
	if appEnv != "development" && appEnv != "staging" {
		return serverConfig{}, errors.New("fakeembed: APP_ENV must be development or staging")
	}

	addr := strings.TrimSpace(getenv("FAKEEMBED_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}
	if _, _, err := net.SplitHostPort(addr); err != nil {
		return serverConfig{}, errors.New("fakeembed: invalid FAKEEMBED_ADDR")
	}

	dims := defaultDims
	if rawDims := strings.TrimSpace(getenv("FAKEEMBED_DIMS")); rawDims != "" {
		parsed, err := strconv.Atoi(rawDims)
		if err != nil || parsed < minDims || parsed > maxDims {
			return serverConfig{}, fmt.Errorf("fakeembed: FAKEEMBED_DIMS must be an integer in %d..%d", minDims, maxDims)
		}
		dims = parsed
	}

	queryPrefix := getenv("FAKEEMBED_QUERY_PREFIX")
	if strings.TrimSpace(queryPrefix) == "" {
		return serverConfig{}, errors.New("fakeembed: FAKEEMBED_QUERY_PREFIX must be non-empty")
	}

	return serverConfig{
		appEnv:      appEnv,
		addr:        addr,
		dims:        dims,
		queryPrefix: queryPrefix,
	}, nil
}

func newHandler(getenv envLookup) (*embedtest.Server, serverConfig, error) {
	cfg, err := parseConfig(getenv)
	if err != nil {
		return nil, serverConfig{}, err
	}

	// Identity (dec-262, advisor-dec-279): TEI /info returns model_id =
	// strings.TrimPrefix(embedding.FakeEmbedModel, "tei/") ("engram-fakeembed")
	// and model_sha = embedding.FakeEmbedModelSHA ("fakeembed-v1").
	modelID := strings.TrimPrefix(embedding.FakeEmbedModel, embedding.FakeEmbedProvider+"/")
	handler := embedtest.NewHandler(embedtest.Options{
		Dims:        cfg.dims,
		ModelID:     modelID,
		ModelSHA:    embedding.FakeEmbedModelSHA,
		QueryPrefix: cfg.queryPrefix,
	})
	return handler, cfg, nil
}

func run(ctx context.Context, getenv envLookup, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	handler, cfg, err := newHandler(getenv)
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return errors.New("fakeembed: failed to bind FAKEEMBED_ADDR")
	}

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		// Log only addr and dims; never log inputs, aliases, query text, or request bodies.
		logger.Info("starting fakeembed", slog.String("addr", ln.Addr().String()), slog.Int("dims", cfg.dims))
		if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	select {
	case serveErr := <-errCh:
		return serveErr
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// probeHealthcheck probes GET /__control/stats on the local listener.
// Unlike /health, /__control/stats does not apply the active fault mode, so
// setting mode="down" during degrade E2E tests keeps the container healthy.
func probeHealthcheck(ctx context.Context, getenv envLookup) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	addr := strings.TrimSpace(getenv("FAKEEMBED_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}
	return probeHealthcheckAddr(ctx, addr)
}

func probeTargetHostPort(listenAddr string) (string, error) {
	host, port, splitErr := net.SplitHostPort(listenAddr)
	if splitErr != nil {
		return "", errors.New("fakeembed: invalid FAKEEMBED_ADDR")
	}
	switch strings.TrimSpace(host) {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::", "[::]":
		host = "::1"
	}
	return net.JoinHostPort(host, port), nil
}

func probeHealthcheckAddr(ctx context.Context, listenAddr string) (err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	hostPort, addrErr := probeTargetHostPort(listenAddr)
	if addrErr != nil {
		return addrErr
	}

	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	targetURL := "http://" + hostPort + "/__control/stats"
	req, reqErr := http.NewRequestWithContext(probeCtx, http.MethodGet, targetURL, nil)
	if reqErr != nil {
		return fmt.Errorf("fakeembed healthcheck request: %w", reqErr)
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, doErr := client.Do(req)
	if doErr != nil {
		return fmt.Errorf("fakeembed healthcheck unreachable: %w", doErr)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close fakeembed healthcheck response body: %w", closeErr))
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fakeembed healthcheck returned status %d", resp.StatusCode)
	}
	return nil
}
