// Package embedid defines the full seven-field embedding generation identity
// and calibration lookup contract shared across provider clients, generation
// registry/pinning, and calibration tables (plan P05 mục 2.12, 2.15, 2.20;
// M1, N3, BE-13/BE-14, FS-23/FS-32).
//
// It is a pure stdlib leaf package with no internal dependencies so that W1
// lanes (embedprov, embedstore, semeval) can import it without cycles.
package embedid

import (
	"strconv"
	"strings"
)

// Identity uniquely identifies the embedding space of a generation and a
// configured provider client across all seven parameters that affect vector
// compatibility (plan P05 mục 2.12, 2.15).
//
// Two configurations are compatible if and only if Identity.Key() is equal.
type Identity struct {
	Provider      string
	Model         string
	ModelVersion  string
	Dims          int
	QueryPrefix   string
	DocPrefix     string
	Preprocessing string
}

// Key returns a canonical, unambiguous length-prefixed encoding of all seven
// fields of id. Because every string field is preceded by its byte length in
// decimal and a colon, arbitrary field contents (including colons, pipes, or
// newlines) can never collide across field boundaries.
func (id Identity) Key() string {
	dims := strconv.Itoa(id.Dims)
	var b strings.Builder
	b.Grow(len(id.Provider) + len(id.Model) + len(id.ModelVersion) + len(dims) +
		len(id.QueryPrefix) + len(id.DocPrefix) + len(id.Preprocessing) + 48)

	writeLenPrefixed(&b, id.Provider)
	writeLenPrefixed(&b, id.Model)
	writeLenPrefixed(&b, id.ModelVersion)
	writeLenPrefixed(&b, dims)
	writeLenPrefixed(&b, id.QueryPrefix)
	writeLenPrefixed(&b, id.DocPrefix)
	writeLenPrefixed(&b, id.Preprocessing)
	return b.String()
}

func writeLenPrefixed(b *strings.Builder, s string) {
	b.WriteString(strconv.Itoa(len(s)))
	b.WriteByte(':')
	b.WriteString(s)
	b.WriteByte(';')
}

// CalibrationLookup resolves the calibrated cosine similarity threshold and
// committed evaluation report path for a given embedding Identity (plan P05
// mục 2.12, 2.15, 2.20; N3/FS-32). It returns ok=false when the identity has
// no valid calibration entry for the current environment.
type CalibrationLookup func(Identity) (minCos float64, reportPath string, ok bool)
