// Package db quản lý kết nối Postgres và migration.
package db

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/zone17th/engram/apps/api/migrations"
)

func newMigrator(dsn string) (*migrate.Migrate, error) {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("đọc migrations nhúng: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		return nil, fmt.Errorf("tạo migrator: %w", err)
	}
	return m, nil
}

// MigrateUp chạy toàn bộ migration còn thiếu. Không lỗi khi đã ở bản mới nhất.
func MigrateUp(dsn string) (err error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := closeMigrator(m); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

// MigrateDown lùi đúng một bước. Dùng cho dev, không phải quy trình phục hồi.
func MigrateDown(dsn string) (err error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := closeMigrator(m); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	if err := m.Steps(-1); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate down: %w", err)
	}
	return nil
}

// Version trả version hiện tại và cờ dirty.
func Version(dsn string) (v uint, dirty bool, err error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return 0, false, err
	}
	defer func() {
		if closeErr := closeMigrator(m); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	v, dirty, err = m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return 0, false, fmt.Errorf("đọc version: %w", err)
	}
	return v, dirty, nil
}

func closeMigrator(m *migrate.Migrate) error {
	sourceErr, databaseErr := m.Close()
	return errors.Join(
		wrapCloseError("đóng migration source", sourceErr),
		wrapCloseError("đóng migration database", databaseErr),
	)
}

func wrapCloseError(label string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", label, err)
}
