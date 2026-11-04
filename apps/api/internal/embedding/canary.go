package embedding

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// CanaryThreshold is the minimum acceptable cosine similarity between freshly
// embedded canary vectors and stored canary vectors before drift is reported
// (ADR 0004, plan P05 mục 2.12, SPEC §10.3: cos < 0.99 -> drift).
const CanaryThreshold = 0.99

// CanaryCount is the fixed number of synthetic canary strings embedded on
// each canary check (ADR 0004, plan P05 mục 2.12).
const CanaryCount = 8

// canaryStrings holds the 8 constant, synthetic, harmless Vietnamese/English
// strings embedded as documents during canary drift checks (ADR 0004, plan P05
// mục 2.12). They contain no user data or secrets.
var canaryStrings = [CanaryCount]string{
	"mật khẩu wifi mạng nội bộ văn phòng tầng hai",
	"ghi chú cuộc họp kế hoạch sản phẩm quý bốn",
	"ssh jump host key FingerPrint ed25519 staging cluster",
	"hướng dẫn sao lưu cơ sở dữ liệu postgres hàng ngày",
	"project roadmap milestone alpha release checklist",
	"tài khoản thanh toán hóa đơn điện nước hàng tháng",
	"internal service mesh tls certificate rotation policy",
	"danh sách thiết bị mạng router switch phòng máy chủ",
}

// CanaryStrings returns a fresh copy of the 8 constant synthetic canary
// strings (mix of Vietnamese and English, no user data).
func CanaryStrings() []string {
	out := make([]string, CanaryCount)
	copy(out, canaryStrings[:])
	return out
}

// CanaryResult summarizes the outcome of a CheckCanary run for a generation.
type CanaryResult struct {
	// FirstRun is true when no stored canary vectors were supplied; Vectors
	// contains the newly computed canary vectors to persist on the generation row.
	FirstRun bool
	// Drifted is true when stored vectors were provided and MinCos < CanaryThreshold (0.99).
	Drifted bool
	// MinCos is the minimum cosine similarity across the 8 canary pairs (1.0 on FirstRun).
	MinCos float64
	// Vectors holds the 8 freshly embedded document vectors of length client.Identity.Dims.
	Vectors [][]float32
}

// CheckCanary embeds the 8 constant canary strings via client as documents and
// compares them against stored (ADR 0004, plan P05 mục 2.12):
//   - First run (len(stored) == 0): returns CanaryResult{FirstRun: true,
//     MinCos: 1.0, Vectors: fresh} so the caller can persist Vectors on the
//     generation row.
//   - Subsequent runs: computes cosine similarity for each of the 8 canary
//     pairs, sets CanaryMinCos{generation} to the minimum cosine (when
//     metrics != nil), and if MinCos < 0.99 increments
//     CanaryDriftTotal{generation} and logs a structured warning via logger
//     (without logging any canary inputs or vector values).
//
// CheckCanary is a pure function with respect to the database and never
// triggers an automatic generation cutover.
func CheckCanary(
	ctx context.Context,
	client Client,
	generationID int,
	stored [][]float32,
	metrics *obs.EmbeddingMetrics,
	logger *slog.Logger,
) (CanaryResult, error) {
	if client.Provider == nil {
		return CanaryResult{}, ErrUnavailable
	}
	inputs := CanaryStrings()
	fresh, err := client.Provider.EmbedDocuments(ctx, inputs)
	if err != nil {
		return CanaryResult{}, err
	}
	if len(fresh) != CanaryCount {
		return CanaryResult{}, &ProviderError{
			Class:  ClassBadResponse,
			Detail: "canary embedding returned wrong vector count",
			Err:    ErrBadResponse,
		}
	}
	dims := client.Provider.Dims()
	for i, v := range fresh {
		if dims > 0 && len(v) != dims {
			return CanaryResult{}, &ProviderError{
				Class:  ClassBadResponse,
				Detail: fmt.Sprintf("canary vector %d dimension mismatch", i),
				Err:    ErrBadResponse,
			}
		}
	}

	if len(stored) == 0 {
		return CanaryResult{
			FirstRun: true,
			Drifted:  false,
			MinCos:   1.0,
			Vectors:  fresh,
		}, nil
	}

	if len(stored) != CanaryCount {
		return CanaryResult{}, fmt.Errorf("embedding: stored canary has %d vectors, want %d", len(stored), CanaryCount)
	}

	minCos := 1.0
	for i := range CanaryCount {
		cos, err := cosineSimilarity(fresh[i], stored[i])
		if err != nil {
			return CanaryResult{}, err
		}
		if i == 0 || cos < minCos {
			minCos = cos
		}
	}

	genLabel := formatGenerationLabel(generationID)
	if metrics != nil && metrics.CanaryMinCos != nil {
		metrics.CanaryMinCos.WithLabelValues(genLabel).Set(minCos)
	}

	drifted := minCos < CanaryThreshold
	if drifted {
		if metrics != nil && metrics.CanaryDriftTotal != nil {
			metrics.CanaryDriftTotal.WithLabelValues(genLabel).Inc()
		}
		if logger != nil {
			logger.LogAttrs(
				ctx,
				slog.LevelWarn,
				"embedding canary drift detected",
				slog.String("generation", genLabel),
				slog.String("provider", client.Provider.Name()),
				slog.Int("count", CanaryCount),
				slog.Float64("min_cos", minCos),
				slog.Float64("threshold", CanaryThreshold),
			)
		}
	}

	return CanaryResult{
		FirstRun: false,
		Drifted:  drifted,
		MinCos:   minCos,
		Vectors:  fresh,
	}, nil
}

func formatGenerationLabel(generationID int) string {
	if generationID <= 0 {
		return "unknown"
	}
	return strings.TrimSpace(strconv.Itoa(generationID))
}

func cosineSimilarity(a, b []float32) (float64, error) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, fmt.Errorf("embedding: canary vector dimension mismatch (%d vs %d)", len(a), len(b))
	}
	var dot, normA, normB float64
	for i := range a {
		fa := float64(a[i])
		fb := float64(b[i])
		if math.IsNaN(fa) || math.IsInf(fa, 0) || math.IsNaN(fb) || math.IsInf(fb, 0) {
			return 0, fmt.Errorf("embedding: canary vector contains NaN or Inf")
		}
		dot += fa * fb
		normA += fa * fa
		normB += fb * fb
	}
	if normA <= 0 || normB <= 0 {
		return 0, fmt.Errorf("embedding: canary vector has zero norm")
	}
	cos := dot / (math.Sqrt(normA) * math.Sqrt(normB))
	if cos > 1.0 {
		cos = 1.0
	} else if cos < -1.0 {
		cos = -1.0
	}
	return cos, nil
}
