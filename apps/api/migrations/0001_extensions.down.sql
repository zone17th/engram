DROP FUNCTION IF EXISTS immutable_unaccent(text);
-- Không DROP EXTENSION: các object khác trong database có thể đang phụ thuộc,
-- và rollback app không được phá dữ liệu (P01 §Bàn giao và khôi phục).
