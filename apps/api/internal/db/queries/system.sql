-- name: ExtensionVersions :many
-- Dùng cho preflight lúc boot: khẳng định database đã cài đúng extension.
SELECT extname, extversion
FROM pg_extension
ORDER BY extname;
