-- Stub catalog cho sqlc. Không phải migration — golang-migrate chỉ đọc *.up.sql/*.down.sql.
-- pg_extension là system catalog; sqlc không ship schema sẵn nên cần khai báo tay.
CREATE TABLE pg_extension (
    oid oid,
    extname name NOT NULL,
    extowner oid,
    extnamespace oid,
    extrelocatable boolean,
    extversion text
);
