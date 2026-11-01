package notification

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

type Store struct {
	pool  *pgxpool.Pool
	q     *gen.Queries
	river *river.Client[pgx.Tx]
}

func NewStore(pool *pgxpool.Pool, client *river.Client[pgx.Tx]) *Store {
	if pool == nil {
		return nil
	}
	return &Store{pool: pool, q: gen.New(pool), river: client}
}

func (s *Store) qtx(tx pgx.Tx) *gen.Queries {
	if tx != nil {
		return s.q.WithTx(tx)
	}
	return s.q
}

// NotifySecurity tạo notice + snapshot email + job River trong cùng transaction.
func (s *Store) NotifySecurity(ctx context.Context, tx pgx.Tx, n secevent.Notice) error {
	if s == nil {
		return errNil("notification")
	}
	meta := n.Meta.Sanitize()
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	kind := n.Kind
	if kind == "" {
		kind = secevent.NoticeSecurity
	}
	row, err := s.qtx(tx).InsertNotification(ctx, gen.InsertNotificationParams{
		UserID:       n.UserID,
		Kind:         kind,
		Meta:         raw,
		EmailTargets: n.EmailTargets,
	})
	if err != nil {
		return err
	}
	if len(n.EmailTargets) == 0 || s.river == nil {
		return nil
	}
	if tx == nil {
		_, err = s.river.Insert(ctx, SecurityNoticeArgs{NotificationID: row.ID}, nil)
		return err
	}
	_, err = s.river.InsertTx(ctx, tx, SecurityNoticeArgs{NotificationID: row.ID}, nil)
	return err
}

type SecurityNoticeArgs struct {
	NotificationID int64 `json:"notification_id"`
}

func (SecurityNoticeArgs) Kind() string { return "security_notice_mail" }

type errNil string

func (e errNil) Error() string { return string(e) + " store is nil" }
