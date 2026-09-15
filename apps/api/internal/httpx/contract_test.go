package httpx_test

import (
	"os"
	"strings"
	"testing"
)

// OpenAPI phải khai báo đúng ba path của P01 và không khai báo endpoint ở root.
func TestOpenAPIDeclaresOnlyP01Paths(t *testing.T) {
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("đọc openapi.yaml: %v", err)
	}
	spec := string(raw)

	for _, p := range []string{"  /healthz:", "  /readyz:", "  /metrics:"} {
		if !strings.Contains(spec, p) {
			t.Errorf("openapi.yaml thiếu path %q", strings.TrimSpace(p))
		}
	}
	if !strings.Contains(spec, "url: /api/v1") {
		t.Error("server URL phải là /api/v1 (một origin, đường tương đối)")
	}
	if strings.Contains(spec, "http://localhost:8080") {
		t.Error("openapi.yaml không được hardcode origin của API — dev đi qua proxy")
	}
}
