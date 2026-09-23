package audit_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

func TestAuditRecordSanitizesAndRollback(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	st := audit.NewStore(pool)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Record(ctx, tx, secevent.Record{
		Event: secevent.EventLoginFailure, Result: secevent.ResultFailure,
		UserAgent: "secret-token-should-stay-ua", Meta: secevent.Meta{Reason: secevent.ReasonInvalid, Provider: "password=leak"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("rollback phải huỷ audit")
	}

	if err := st.Record(ctx, nil, secevent.Record{
		Event: secevent.EventLoginFailure, Result: secevent.ResultFailure,
		Meta: secevent.Meta{Reason: secevent.ReasonInvalid},
	}); err != nil {
		t.Fatal(err)
	}
	var meta []byte
	if err := pool.QueryRow(ctx, `SELECT meta FROM audit_log LIMIT 1`).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if containsSecret(string(meta), "password=leak") {
		t.Fatalf("meta lộ secret: %s", meta)
	}
	var m map[string]any
	_ = json.Unmarshal(meta, &m)
	if _, ok := m["provider"]; ok {
		t.Fatalf("provider lạ không được lưu: %v", m)
	}
}

func containsSecret(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	}()
}
