// Package searchbench generates deterministic synthetic benchmark datasets for
// P05 lexical and semantic search evaluation (plan mục 2.23, protocol §1,
// targets §2–§3, advisor-dec-255, advisor-dec-261).
//
// Synthetic benchmark data only: no entry bodies, no real user data, and no
// real names or emails (user-dec-016).
//
// Build-tag and import boundary (advisor-dec-261):
//   - W1 files (dataset.go, lexicon.go, dataset_test.go) are untagged pure
//     generators (no DB writes, streamed hashing, no vector materialisation in
//     memory) so standard Go checks compile, vet, lint, and run
//     TestDatasetDeterministic in W1.
//   - W3 adds build-tag `searchbench` files (seed.go with pgx.CopyFrom, g1 DDL
//     invocations, queries.go, runner.go, report.go, search_bench_test.go).
//   - This package must NEVER be imported by any production binary (cmd/api,
//     cmd/worker, cmd/migrate, internal/compose, etc.).
package searchbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"unicode/utf8"

	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// LexiconVersion is the schema version required for bench-lexicon.json.
const (
	LexiconVersion = 1
	LexiconSchema  = "engram-search-bench-lexicon-v1"
)

// DefaultLexiconRelativePath is the path to bench-lexicon.json relative to the
// apps/api/internal/searchbench package directory. Because //go:embed cannot
// reach outside the Go module root (apps/api), LoadDefaultLexicon resolves this
// path relative to the caller source file (or current working directory as a
// fallback) so both package tests and the W3 benchmark runner can load it
// without environment configuration.
const DefaultLexiconRelativePath = "../../../../packages/search-fixtures/bench-lexicon.json"

// Lexicon holds synthetic Vietnamese (with diacritics) and English word lists
// used to compose deterministic item names, hints, and tags.
type Lexicon struct {
	Version int      `json:"version"`
	Schema  string   `json:"schema"`
	Vi      []string `json:"vi"`
	En      []string `json:"en"`
}

// ParseLexicon decodes and validates a Lexicon from raw JSON bytes.
func ParseLexicon(data []byte) (*Lexicon, error) {
	if len(data) == 0 {
		return nil, errors.New("searchbench: empty lexicon data")
	}
	var lex Lexicon
	if err := json.Unmarshal(data, &lex); err != nil {
		return nil, fmt.Errorf("searchbench: unmarshal lexicon: %w", err)
	}
	if err := lex.Validate(); err != nil {
		return nil, err
	}
	return &lex, nil
}

// ReadLexicon decodes and validates a Lexicon from an io.Reader.
func ReadLexicon(r io.Reader) (*Lexicon, error) {
	if r == nil {
		return nil, errors.New("searchbench: nil lexicon reader")
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("searchbench: read lexicon: %w", err)
	}
	return ParseLexicon(data)
}

// LoadLexiconFile loads and validates a Lexicon from the given filesystem path.
func LoadLexiconFile(path string) (*Lexicon, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("searchbench: read lexicon file %q: %w", path, err)
	}
	return ParseLexicon(data)
}

// LoadDefaultLexicon loads packages/search-fixtures/bench-lexicon.json relative
// to the searchbench package directory. Both W1 unit tests and the W3 runner
// reuse this helper.
func LoadDefaultLexicon() (*Lexicon, error) {
	if _, file, _, ok := runtime.Caller(0); ok {
		candidate := filepath.Clean(filepath.Join(filepath.Dir(file), DefaultLexiconRelativePath))
		if _, err := os.Stat(candidate); err == nil {
			return LoadLexiconFile(candidate)
		}
	}
	return LoadLexiconFile(filepath.FromSlash(DefaultLexiconRelativePath))
}

// Validate checks that the lexicon version, schema, word counts, diacritics,
// long words (for typo paths in W3), and textnorm compatibility hold.
func (l *Lexicon) Validate() error {
	if l == nil {
		return errors.New("searchbench: nil lexicon")
	}
	if l.Version != LexiconVersion {
		return fmt.Errorf("searchbench: unsupported lexicon version %d (want %d)", l.Version, LexiconVersion)
	}
	if l.Schema != "" && l.Schema != LexiconSchema {
		return fmt.Errorf("searchbench: unexpected lexicon schema %q (want %q)", l.Schema, LexiconSchema)
	}
	if len(l.Vi) < 100 {
		return fmt.Errorf("searchbench: vi word list too small (%d < 100)", len(l.Vi))
	}
	if len(l.En) < 100 {
		return fmt.Errorf("searchbench: en word list too small (%d < 100)", len(l.En))
	}

	hasDiacritic := false
	hasLongWord := false

	for i, w := range l.Vi {
		trimmed, norm, err := textnorm.NormalizeTag(w)
		if err != nil || trimmed == "" || norm == "" {
			return fmt.Errorf("searchbench: invalid vi word at index %d (%q): %w", i, w, err)
		}
		for _, r := range norm {
			if r > 127 {
				hasDiacritic = true
				break
			}
		}
		if utf8.RuneCountInString(norm) >= 10 {
			hasLongWord = true
		}
	}

	for i, w := range l.En {
		trimmed, norm, err := textnorm.NormalizeTag(w)
		if err != nil || trimmed == "" || norm == "" {
			return fmt.Errorf("searchbench: invalid en word at index %d (%q): %w", i, w, err)
		}
		if utf8.RuneCountInString(norm) >= 12 {
			hasLongWord = true
		}
	}

	if !hasDiacritic {
		return errors.New("searchbench: vi word list must contain words with Vietnamese diacritics")
	}
	if !hasLongWord {
		return errors.New("searchbench: lexicon must contain long words (>= 12 runes) for typo paths")
	}
	return nil
}
