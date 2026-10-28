package audit

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

type Store struct {
	pool *pgxpool.Pool
	q    *gen.Queries
}

func NewStore(pool *pgxpool.Pool) *Store {
	if pool == nil {
		return nil
	}
	return &Store{pool: pool, q: gen.New(pool)}
}

func (s *Store) qtx(tx pgx.Tx) *gen.Queries {
	if tx != nil {
		return s.q.WithTx(tx)
	}
	return s.q
}

func (s *Store) Record(ctx context.Context, tx pgx.Tx, rec secevent.Record) error {
	if s == nil {
		return errNil("audit")
	}
	meta := rec.Meta.Sanitize()
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	result := rec.Result
	if result != secevent.ResultSuccess && result != secevent.ResultFailure {
		result = secevent.ResultFailure
	}
	ua := sanitizeUA(rec.UserAgent)
	_, err = s.qtx(tx).InsertAudit(ctx, gen.InsertAuditParams{
		UserID:    rec.UserID,
		SessionID: rec.SessionID,
		Event:     rec.Event,
		Result:    result,
		Actor:     strPtr(rec.Actor),
		IpHash:    rec.IPHash,
		UserAgent: ua,
		Meta:      raw,
	})
	return err
}

func sanitizeUA(ua string) *string {
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return nil
	}
	if len(ua) > 256 {
		ua = ua[:256]
	}
	return &ua
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

type errNil string

func (e errNil) Error() string { return string(e) + " store is nil" }
