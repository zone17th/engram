-- =============================================================================
-- P05 Search Lexical Queries (plan mục 2.3, 2.4, 2.5, Task 2)
--
-- Security invariants:
--   - Every query filters `user_id = sqlc.arg('user_id')` and `deleted_at IS NULL`.
--   - Nothing reads `entry` or `item.hint` (lexical item corpus is `name` only, OQ-4).
--   - `q_prefix` MUST be escaped by the caller via `item.EscapeLikePrefix(qn)`
--     (escapes `\`, `%`, `_` then appends `%`) and is used ONLY for the exact-accent
--     arm (`name_normalized` / `normalized` with `LIKE ... ESCAPE '\'`, matching
--     `item_user_name_prefix` / `tag_user_norm_prefix` (`text_pattern_ops`)).
--   - The folded arm computes `qa_prefix` in the CTE by escaping `\`, `%`, `_`
--     AFTER `immutable_unaccent(qn)` (because PostgreSQL `unaccent` transliterates
--     full-width `％`/`＿`/`＼` to ASCII LIKE metacharacters — RV-T2-BE-3, lead call A)
--     and uses `qa_prefix` with `LIKE ... ESCAPE '\'` on `name_unaccent` / `tag_unaccent`
--     (`item_user_unaccent_prefix` / `tag_user_unaccent_prefix` (`text_pattern_ops`)).
--   - Read transactions set `statement_timeout = '50ms'`,
--     `pg_trgm.similarity_threshold = 0.35`, and
--     `pg_trgm.word_similarity_threshold = 0.5` via `SET LOCAL`.
-- =============================================================================

-- name: SearchItemsLexical :many
WITH q AS (
  SELECT
    sqlc.arg('qn')::text AS qn,
    immutable_unaccent(sqlc.arg('qn')::text) AS qa,
    replace(
      replace(
        replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    ) || '%' AS qa_prefix
)
SELECT
  i.id,
  i.name,
  i.entry_count,
  i.last_used_at,
  i.created_at,
  (CASE
    WHEN i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
    WHEN i.name_unaccent LIKE q.qa_prefix ESCAPE '\' THEN 2
    ELSE 1
  END)::int AS tier,
  round(
    GREATEST(
      similarity(i.name_unaccent, q.qa),
      word_similarity(q.qa, i.name_unaccent)
    )::numeric,
    2
  )::float8 AS score
FROM item AS i, q
WHERE i.user_id = sqlc.arg('user_id')
  AND i.deleted_at IS NULL
  AND (
    i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
    OR i.name_unaccent LIKE q.qa_prefix ESCAPE '\'
    OR (
      sqlc.arg('fuzzy')::bool
      AND (
        i.name_unaccent % q.qa
        OR q.qa <% i.name_unaccent
      )
    )
  )
ORDER BY
  tier DESC,
  score DESC,
  i.last_used_at DESC,
  i.entry_count DESC,
  i.id ASC
LIMIT sqlc.arg('page_limit');

-- name: SearchTagsLexical :many
WITH q AS (
  SELECT
    sqlc.arg('qn')::text AS qn,
    immutable_unaccent(sqlc.arg('qn')::text) AS qa,
    replace(
      replace(
        replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    ) || '%' AS qa_prefix
)
SELECT
  t.id,
  t.display,
  t.item_count,
  t.last_used_at,
  (CASE
    WHEN t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
    WHEN t.tag_unaccent LIKE q.qa_prefix ESCAPE '\' THEN 2
    ELSE 1
  END)::int AS tier,
  round(
    GREATEST(
      similarity(t.tag_unaccent, q.qa),
      word_similarity(q.qa, t.tag_unaccent)
    )::numeric,
    2
  )::float8 AS score
FROM tag AS t, q
WHERE t.user_id = sqlc.arg('user_id')
  AND t.deleted_at IS NULL
  AND (
    t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
    OR t.tag_unaccent LIKE q.qa_prefix ESCAPE '\'
    OR (
      sqlc.arg('fuzzy')::bool
      AND (
        t.tag_unaccent % q.qa
        OR q.qa <% t.tag_unaccent
      )
    )
  )
ORDER BY
  tier DESC,
  score DESC,
  t.last_used_at DESC,
  t.item_count DESC,
  t.id ASC
LIMIT sqlc.arg('page_limit');

-- name: RecentItemsForSuggest :many
SELECT
  i.id,
  i.name,
  i.entry_count,
  i.last_used_at,
  i.created_at
FROM item AS i
WHERE i.user_id = sqlc.arg('user_id')
  AND i.deleted_at IS NULL
ORDER BY
  i.last_used_at DESC,
  i.id DESC
LIMIT sqlc.arg('page_limit');

-- name: RecentTagsForSuggest :many
SELECT
  t.id,
  t.display,
  t.item_count,
  t.last_used_at
FROM tag AS t
WHERE t.user_id = sqlc.arg('user_id')
  AND t.deleted_at IS NULL
ORDER BY
  t.last_used_at DESC,
  t.id DESC
LIMIT sqlc.arg('page_limit');

-- name: ListTagRefsForItems :many
SELECT
  ranked.item_id,
  ranked.tag_id,
  ranked.display,
  ranked.tag_total
FROM (
  SELECT
    it.item_id,
    t.id AS tag_id,
    t.display,
    count(*) OVER (PARTITION BY it.item_id)::int AS tag_total,
    row_number() OVER (
      PARTITION BY it.item_id
      ORDER BY t.display ASC, t.id ASC
    )::int AS rn
  FROM item_tag AS it
  JOIN item AS i ON i.id = it.item_id AND i.user_id = sqlc.arg('user_id')
  JOIN tag AS t ON t.id = it.tag_id AND t.user_id = sqlc.arg('user_id')
  WHERE it.item_id = ANY(sqlc.arg('item_ids')::uuid[])
    AND i.deleted_at IS NULL
    AND t.deleted_at IS NULL
) AS ranked
WHERE ranked.rn <= 3
ORDER BY
  ranked.item_id ASC,
  ranked.display ASC,
  ranked.tag_id ASC;

-- name: SearchItemsLexicalPage :many
WITH q AS (
  SELECT
    sqlc.arg('qn')::text AS qn,
    immutable_unaccent(sqlc.arg('qn')::text) AS qa,
    replace(
      replace(
        replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    ) || '%' AS qa_prefix
),
ranked AS (
  SELECT
    i.id,
    i.name,
    i.entry_count,
    i.last_used_at,
    i.created_at,
    (CASE
      WHEN i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      WHEN i.name_unaccent LIKE q.qa_prefix ESCAPE '\' THEN 2
      ELSE 1
    END)::int AS tier,
    round(
      GREATEST(
        similarity(i.name_unaccent, q.qa),
        word_similarity(q.qa, i.name_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM item AS i, q
  WHERE i.user_id = sqlc.arg('user_id')
    AND i.deleted_at IS NULL
    AND (
      i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR i.name_unaccent LIKE q.qa_prefix ESCAPE '\'
      OR (
        sqlc.arg('fuzzy')::bool
        AND (
          i.name_unaccent % q.qa
          OR q.qa <% i.name_unaccent
        )
      )
    )
)
SELECT
  ranked.id,
  ranked.name,
  ranked.entry_count,
  ranked.last_used_at,
  ranked.created_at,
  ranked.tier,
  ranked.score
FROM ranked
WHERE
  sqlc.narg('cursor_id')::uuid IS NULL
  OR ranked.tier < sqlc.narg('cursor_tier')::int
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score < sqlc.narg('cursor_score')::float8
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
    AND ranked.entry_count < sqlc.narg('cursor_count')::int
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
    AND ranked.entry_count = sqlc.narg('cursor_count')::int
    AND ranked.id > sqlc.narg('cursor_id')::uuid
  )
ORDER BY
  ranked.tier DESC,
  ranked.score DESC,
  ranked.last_used_at DESC,
  ranked.entry_count DESC,
  ranked.id ASC
LIMIT sqlc.arg('page_limit');

-- name: SearchTagsLexicalPage :many
WITH q AS (
  SELECT
    sqlc.arg('qn')::text AS qn,
    immutable_unaccent(sqlc.arg('qn')::text) AS qa,
    replace(
      replace(
        replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    ) || '%' AS qa_prefix
),
ranked AS (
  SELECT
    t.id,
    t.display,
    t.item_count,
    t.last_used_at,
    (CASE
      WHEN t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      WHEN t.tag_unaccent LIKE q.qa_prefix ESCAPE '\' THEN 2
      ELSE 1
    END)::int AS tier,
    round(
      GREATEST(
        similarity(t.tag_unaccent, q.qa),
        word_similarity(q.qa, t.tag_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM tag AS t, q
  WHERE t.user_id = sqlc.arg('user_id')
    AND t.deleted_at IS NULL
    AND (
      t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR t.tag_unaccent LIKE q.qa_prefix ESCAPE '\'
      OR (
        sqlc.arg('fuzzy')::bool
        AND (
          t.tag_unaccent % q.qa
          OR q.qa <% t.tag_unaccent
        )
      )
    )
)
SELECT
  ranked.id,
  ranked.display,
  ranked.item_count,
  ranked.last_used_at,
  ranked.tier,
  ranked.score
FROM ranked
WHERE
  sqlc.narg('cursor_id')::uuid IS NULL
  OR ranked.tier < sqlc.narg('cursor_tier')::int
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score < sqlc.narg('cursor_score')::float8
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
    AND ranked.item_count < sqlc.narg('cursor_count')::int
  )
  OR (
    ranked.tier = sqlc.narg('cursor_tier')::int
    AND ranked.score = sqlc.narg('cursor_score')::float8
    AND ranked.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
    AND ranked.item_count = sqlc.narg('cursor_count')::int
    AND ranked.id > sqlc.narg('cursor_id')::uuid
  )
ORDER BY
  ranked.tier DESC,
  ranked.score DESC,
  ranked.last_used_at DESC,
  ranked.item_count DESC,
  ranked.id ASC
LIMIT sqlc.arg('page_limit');
