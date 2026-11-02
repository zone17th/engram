// Package generation provides the embedding generation registry, advisory
// locking, dynamic table identifier validation, request pinning, and g1
// bootstrap (plan P05 mục 2.15, ADR 0007).
//
// Import direction (M2/FS-24): generation is a leaf within the embedding tree
// and imports only embedid, internal/db/gen, pgx/pgxpool, and the Go standard
// library.
package generation

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// Corpus identifies an embedding target corpus ("item" or "tag").
type Corpus string

const (
	// CorpusItem is the item embedding corpus.
	CorpusItem Corpus = "item"
	// CorpusTag is the tag embedding corpus.
	CorpusTag Corpus = "tag"
)

// Valid reports whether c is one of CorpusItem or CorpusTag.
func (c Corpus) Valid() bool {
	return c == CorpusItem || c == CorpusTag
}

const (
	// MinGenerationID is the minimum valid generation ID (1..9999).
	MinGenerationID = 1
	// MaxGenerationID is the maximum valid generation ID (1..9999).
	MaxGenerationID = 9999
)

var (
	// ErrInvalidTableName is returned when a table name or generation ID fails
	// the dynamic table name allowlist check (OQ-22, ADR 0007 §5).
	ErrInvalidTableName = errors.New("generation: invalid embedding table name")

	// ErrInvalidCorpus is returned when a Corpus value is neither "item" nor "tag".
	ErrInvalidCorpus = errors.New("generation: invalid embedding corpus")

	// tableAllowlistRe enforces ^(item|tag)_embedding_g[1-9][0-9]{0,3}$.
	tableAllowlistRe = regexp.MustCompile(`^(item|tag)_embedding_g[1-9][0-9]{0,3}$`)
)

// DerivedTableName returns the canonical table name for generation id and corpus
// after verifying id is in [1, 9999] and corpus is valid.
func DerivedTableName(genID int, corpus Corpus) (string, error) {
	if !corpus.Valid() {
		return "", fmt.Errorf("%w: %q", ErrInvalidCorpus, corpus)
	}
	if genID < MinGenerationID || genID > MaxGenerationID {
		return "", fmt.Errorf("%w: generation id %d out of range 1..9999", ErrInvalidTableName, genID)
	}
	name := string(corpus) + "_embedding_g" + strconv.Itoa(genID)
	if !tableAllowlistRe.MatchString(name) {
		return "", fmt.Errorf("%w: %q does not match allowlist", ErrInvalidTableName, name)
	}
	return name, nil
}

// ValidateTableName checks that name matches ^(item|tag)_embedding_g[1-9][0-9]{0,3}$
// AND equals the canonical table name derived from (genID, corpus). It returns
// ErrInvalidTableName (or ErrInvalidCorpus) before any database call if invalid.
func ValidateTableName(genID int, corpus Corpus, name string) error {
	expected, err := DerivedTableName(genID, corpus)
	if err != nil {
		return err
	}
	if !tableAllowlistRe.MatchString(name) {
		return fmt.Errorf("%w: %q does not match allowlist", ErrInvalidTableName, name)
	}
	if name != expected {
		return fmt.Errorf("%w: %q does not match derived name %q for generation %d", ErrInvalidTableName, name, expected, genID)
	}
	return nil
}

// ValidateRowTableNames validates both item_table and tag_table stored on a
// generation row against the canonical names derived from genID.
func ValidateRowTableNames(genID int, itemTable, tagTable string) error {
	if err := ValidateTableName(genID, CorpusItem, itemTable); err != nil {
		return err
	}
	if err := ValidateTableName(genID, CorpusTag, tagTable); err != nil {
		return err
	}
	return nil
}

// TableIdent returns a validated pgx.Identifier for the canonical table of
// (genID, corpus). Callers sanitize the returned identifier with .Sanitize()
// when building dynamic vector-table SQL.
func TableIdent(genID int, corpus Corpus) (pgx.Identifier, error) {
	name, err := DerivedTableName(genID, corpus)
	if err != nil {
		return nil, err
	}
	return pgx.Identifier{name}, nil
}

// TableIdentFromName validates that name matches the allowlist and equals the
// derived name for (genID, corpus), then returns pgx.Identifier{name}.
func TableIdentFromName(genID int, corpus Corpus, name string) (pgx.Identifier, error) {
	if err := ValidateTableName(genID, corpus, name); err != nil {
		return nil, err
	}
	return pgx.Identifier{name}, nil
}
