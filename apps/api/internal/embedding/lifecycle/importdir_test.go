package lifecycle_test

import (
	"errors"
	"go/build"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const modulePath = "github.com/zone17th/engram/apps/api"

// moduleRoot is apps/api, two levels above this package directory
// (internal/embedding/lifecycle -> internal/embedding -> internal -> apps/api).
func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("abs module root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("module root %s has no go.mod: %v", root, err)
	}
	return root
}

// importsOf returns the non-test import paths of the package in dir (go/build,
// no network, no module resolution). A directory without buildable Go files
// yields nil.
func importsOf(t *testing.T, dir string) []string {
	t.Helper()
	pkg, err := build.ImportDir(dir, 0)
	if err != nil {
		var noGo *build.NoGoError
		var multi *build.MultiplePackageError
		if errors.As(err, &noGo) || errors.As(err, &multi) {
			return nil
		}
		t.Fatalf("build.ImportDir(%s): %v", dir, err)
	}
	return pkg.Imports
}

// transitive returns every module-internal package reachable from pkgPath
// (excluding pkgPath itself), following non-test imports.
func transitive(t *testing.T, root, pkgPath string) map[string]bool {
	t.Helper()
	seen := map[string]bool{}
	var walk func(p string)
	walk = func(p string) {
		rel := strings.TrimPrefix(p, modulePath+"/")
		for _, imp := range importsOf(t, filepath.Join(root, filepath.FromSlash(rel))) {
			if !strings.HasPrefix(imp, modulePath+"/") || seen[imp] {
				continue
			}
			seen[imp] = true
			walk(imp)
		}
	}
	walk(pkgPath)
	return seen
}

// TestEmbeddingImportDirection locks the import edges of plan P05 mục 2.15
// (M2, FS-24): generation is a leaf within the embedding tree; reconcile never
// reaches jobs or lifecycle; jobs never reach lifecycle; only internal/worker and
// cmd/worker import lifecycle. Checked on the full transitive closure so an
// indirect edge cannot hide the cycle.
func TestEmbeddingImportDirection(t *testing.T) {
	root := moduleRoot(t)
	emb := modulePath + "/internal/embedding/"
	pkg := func(name string) string { return emb + name }

	forbidden := map[string][]string{
		pkg("generation"): {pkg("store"), pkg("reconcile"), pkg("jobs"), pkg("lifecycle")},
		pkg("store"):      {pkg("reconcile"), pkg("jobs"), pkg("lifecycle")},
		pkg("reconcile"):  {pkg("jobs"), pkg("lifecycle")},
		pkg("jobs"):       {pkg("lifecycle")},
		pkg("jobargs"):    {pkg("generation"), pkg("store"), pkg("reconcile"), pkg("jobs"), pkg("lifecycle")},
		pkg("embedid"):    {pkg("generation"), pkg("store"), pkg("reconcile"), pkg("jobs"), pkg("lifecycle")},
	}
	for from, bad := range forbidden {
		reach := transitive(t, root, from)
		for _, b := range bad {
			if reach[b] {
				t.Errorf("%s (transitively) imports %s: forbidden by the embedding import direction (M2)", from, b)
			}
		}
	}

	// lifecycle itself imports jobs-free: it must not import jobs (Backfill takes
	// the enqueue func from its caller).
	if transitive(t, root, pkg("lifecycle"))[pkg("jobs")] {
		t.Errorf("lifecycle imports jobs; the enqueue func must be injected (M2)")
	}

	// Only internal/worker and cmd/worker may import lifecycle.
	allowed := map[string]bool{
		"internal/worker": true,
		"cmd/worker":      true,
	}
	var importers []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		switch d.Name() {
		case "testdata", "node_modules", ".git", "vendor":
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "internal/embedding/lifecycle" {
			return nil
		}
		for _, imp := range importsOf(t, path) {
			if imp == pkg("lifecycle") {
				importers = append(importers, rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	sort.Strings(importers)
	for _, rel := range importers {
		if !allowed[rel] {
			t.Errorf("%s imports lifecycle; only internal/worker and cmd/worker may (M2)", rel)
		}
	}
	// The scan must be able to see the importer it is looking for: worker.go
	// registers the bootstrap-flip worker, so a scan that finds none is broken.
	found := false
	for _, rel := range importers {
		if rel == "internal/worker" {
			found = true
		}
	}
	if !found {
		t.Errorf("import scan did not find internal/worker importing lifecycle (importers: %v)", importers)
	}
}
