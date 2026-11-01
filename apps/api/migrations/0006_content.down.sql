-- Chỉ dùng trên DB test một lần. Không phải quy trình rollback production.
DROP TABLE IF EXISTS entry;
DROP TABLE IF EXISTS item_tag;
DROP TABLE IF EXISTS tag;
DROP TABLE IF EXISTS item;
