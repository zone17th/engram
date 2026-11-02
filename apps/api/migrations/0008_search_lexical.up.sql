-- P05: index lexical theo user cho /suggest và /search (prefix unaccent + trigram GIN với btree_gin).
-- Giữ nguyên item_name_trgm và tag_norm_trgm toàn cục tới khi benchmark P05 (Task 23) cho phép bỏ.
-- Không thêm cột generated mới.
-- Dùng CREATE INDEX thường (bảng nhỏ khi P05 lên; nếu > 1 triệu hàng lúc deploy thì runbook chạy
-- CREATE INDEX CONCURRENTLY ngoài migration).
-- Forward-only trên production; down chỉ dùng DB test.

CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE INDEX item_user_unaccent_prefix
  ON item (user_id, name_unaccent text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX tag_user_unaccent_prefix
  ON tag (user_id, tag_unaccent text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX item_user_name_trgm
  ON item USING gin (user_id, name_unaccent gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX tag_user_tag_trgm
  ON tag USING gin (user_id, tag_unaccent gin_trgm_ops)
  WHERE deleted_at IS NULL;
