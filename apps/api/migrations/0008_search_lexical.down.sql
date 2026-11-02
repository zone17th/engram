-- Chỉ dùng trên DB test một lần. Không phải quy trình rollback production.
-- Không DROP EXTENSION btree_gin (giống quy ước 0001_extensions.down.sql: extension dùng chung,
-- giữ lại để tránh phá phụ thuộc khác và an toàn khi step down/up trong DB test).

DROP INDEX IF EXISTS tag_user_tag_trgm;
DROP INDEX IF EXISTS item_user_name_trgm;
DROP INDEX IF EXISTS tag_user_unaccent_prefix;
DROP INDEX IF EXISTS item_user_unaccent_prefix;
