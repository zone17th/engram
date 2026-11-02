package embedding_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

type inputHashFixture struct {
	Comment string                 `json:"$comment"`
	Cases   []inputHashFixtureCase `json:"cases"`
}

type inputHashFixtureCase struct {
	Name           string `json:"name"`
	Input          string `json:"input"`
	InputPrefix    string `json:"input_prefix"`
	Model          string `json:"model"`
	ModelVersion   string `json:"model_version"`
	ExpectedJCS    string `json:"expected_jcs"`
	ExpectedSHA256 string `json:"expected_sha256"`
}

func TestInputHashFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "input_hash.json"))
	if err != nil {
		t.Fatalf("read testdata/input_hash.json: %v", err)
	}
	var fix inputHashFixture
	if err := json.Unmarshal(raw, &fix); err != nil {
		t.Fatalf("unmarshal testdata/input_hash.json: %v", err)
	}
	if len(fix.Cases) < 6 {
		t.Fatalf("fixture has %d cases, want >= 6", len(fix.Cases))
	}

	for _, tc := range fix.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			sum := embedding.InputHash(tc.Input, tc.InputPrefix, tc.Model, tc.ModelVersion)
			gotHex := hex.EncodeToString(sum[:])
			if gotHex != tc.ExpectedSHA256 {
				t.Fatalf("InputHash(%q) = %s, want %s", tc.Name, gotHex, tc.ExpectedSHA256)
			}

			id := embedid.Identity{
				Provider:      "openai_compat",
				Model:         tc.Model,
				ModelVersion:  tc.ModelVersion,
				Dims:          1024,
				QueryPrefix:   "Instruct: ignored-in-doc-hash\nQuery:",
				DocPrefix:     tc.InputPrefix,
				Preprocessing: embedding.Preprocessing,
			}
			sumFor := embedding.InputHashFor(id, tc.Input)
			if sumFor != sum {
				t.Fatalf("InputHashFor mismatch: %x vs %x", sumFor, sum)
			}
		})
	}
}

func TestItemInputAndTagInput(t *testing.T) {
	cases := []struct {
		name string
		item string
		hint string
		want string
	}{
		{"name only", "wifi-password", "", "wifi-password"},
		{"whitespace hint omitted", "wifi-password", "   \t\n  ", "wifi-password"},
		{"trimmed name and hint", "  Mật khẩu Wi-Fi  ", "  tầng 2 khách  ", "Mật khẩu Wi-Fi — tầng 2 khách"},
		{"non-empty hint", "router", "192.168.1.1", "router — 192.168.1.1"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := embedding.ItemInput(tc.item, tc.hint); got != tc.want {
				t.Fatalf("ItemInput(%q, %q) = %q, want %q", tc.item, tc.hint, got, tc.want)
			}
		})
	}

	if got := embedding.TagInput("Mạng-Nhà"); got != "Mạng-Nhà" {
		t.Fatalf("TagInput = %q, want %q", got, "Mạng-Nhà")
	}
}
