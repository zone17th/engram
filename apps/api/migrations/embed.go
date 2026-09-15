// Package migrations nhúng file SQL để binary chạy được mà không cần thư mục nguồn.
//
// File này PHẢI nằm cùng thư mục với các file .sql: `//go:embed` không đi ra
// ngoài thư mục package được, nên `//go:embed ../../migrations/*.sql` trong
// internal/db sẽ không build.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
