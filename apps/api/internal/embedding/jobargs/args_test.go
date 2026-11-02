package jobargs_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
)

func TestJobArgsKindsAndJSONShape(t *testing.T) {
	itemArgs := jobargs.EmbedItemArgs{
		GenerationID: 1,
		UserID:       "11111111-1111-1111-1111-111111111111",
		TargetID:     "22222222-2222-2222-2222-222222222222",
		InputHash:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	if got := itemArgs.Kind(); got != "embed_item" {
		t.Fatalf("EmbedItemArgs.Kind() = %q, want embed_item", got)
	}
	rawItem, err := json.Marshal(itemArgs)
	if err != nil {
		t.Fatalf("marshal EmbedItemArgs: %v", err)
	}
	for _, wantKey := range []string{`"generation_id":1`, `"user_id":`, `"target_id":`, `"input_hash":`} {
		if !strings.Contains(string(rawItem), wantKey) {
			t.Fatalf("EmbedItemArgs JSON %s missing %s", rawItem, wantKey)
		}
	}

	tagArgs := jobargs.EmbedTagArgs{
		GenerationID: 2,
		UserID:       "11111111-1111-1111-1111-111111111111",
		TargetID:     "33333333-3333-3333-3333-333333333333",
		InputHash:    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	}
	if got := tagArgs.Kind(); got != "embed_tag" {
		t.Fatalf("EmbedTagArgs.Kind() = %q, want embed_tag", got)
	}

	reembedUser := jobargs.ReembedUserArgs{UserID: "11111111-1111-1111-1111-111111111111"}
	if got := reembedUser.Kind(); got != "reembed_user" {
		t.Fatalf("ReembedUserArgs.Kind() = %q, want reembed_user", got)
	}

	reembedAll := jobargs.ReembedAllArgs{}
	if got := reembedAll.Kind(); got != "reembed_all" {
		t.Fatalf("ReembedAllArgs.Kind() = %q, want reembed_all", got)
	}
	rawAllEmpty, err := json.Marshal(reembedAll)
	if err != nil || string(rawAllEmpty) != `{}` {
		t.Fatalf("ReembedAllArgs zero JSON = %s err=%v, want {}", rawAllEmpty, err)
	}

	if got := (jobargs.CanaryArgs{}).Kind(); got != "embedding_canary" {
		t.Fatalf("CanaryArgs.Kind() = %q, want embedding_canary", got)
	}
	if got := (jobargs.BootstrapFlipArgs{}).Kind(); got != "embedding_bootstrap_flip" {
		t.Fatalf("BootstrapFlipArgs.Kind() = %q, want embedding_bootstrap_flip", got)
	}
}
