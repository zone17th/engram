-- Chỉ dùng trên DB test một lần. Không phải quy trình rollback production.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.embedding_generation') IS NOT NULL THEN
    FOR r IN SELECT id FROM embedding_generation LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I', 'item_embedding_g' || r.id);
      EXECUTE format('DROP TABLE IF EXISTS %I', 'tag_embedding_g' || r.id);
    END LOOP;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS embedding_generation_drop_tables(int);
DROP FUNCTION IF EXISTS embedding_generation_create_tables(int, int, int, boolean, int, int);
DROP TABLE IF EXISTS embedding_active;
DROP TABLE IF EXISTS embedding_generation;
