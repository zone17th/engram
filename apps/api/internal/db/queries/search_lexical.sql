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
--   - The folded arm computes the unaccented prefix by escaping `\`, `%`, `_`
--     AFTER `immutable_unaccent(qn)` (because PostgreSQL `unaccent` transliterates
--     full-width `％`/`＿`/`＼` to ASCII LIKE metacharacters — RV-T2-BE-3, lead call A)
--     and inlines the `IMMUTABLE` expression with `LIKE ... ESCAPE '\'` on
--     `name_unaccent` / `tag_unaccent` so the planner constant-folds it onto
--     `item_user_unaccent_prefix` / `tag_user_unaccent_prefix` (`text_pattern_ops`).
--   - Tiered prefix-first short-circuit (L2-B + P1-exact, advisor-dec-353):
--     `prefix_ranked` fetches up to `page_limit` Tier 3 + Tier 2 prefix matches first,
--     and `fuzzy_ranked` runs with `LIMIT GREATEST(0, page_limit - count(prefix_ranked))`
--     so PostgreSQL short-circuits the GIN trigram scan whenever prefix matches fill `page_limit`.
--   - Read transactions set `statement_timeout = '50ms'`,
--     `pg_trgm.similarity_threshold = 0.35`, and
--     `pg_trgm.word_similarity_threshold = 0.5` via `SET LOCAL`.
-- =============================================================================

-- name: SearchItemsLexical :many
WITH prefix_ranked AS (
  SELECT
    i.id,
    i.name,
    i.entry_count,
    i.last_used_at,
    i.created_at,
    (CASE
      WHEN i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      ELSE 2
    END)::int AS tier,
    (CASE
      WHEN NOT sqlc.arg('fuzzy')::bool THEN
        (CASE
          WHEN immutable_unaccent(sqlc.arg('qn')::text) ~ '^[[:alnum:]]+$' THEN
            (CASE
              WHEN i.name_unaccent ~ ('(^|[^[:alnum:]])' || immutable_unaccent(sqlc.arg('qn')::text) || '($|[^[:alnum:]])') THEN 1.0::float8
              ELSE round(
                (
                  char_length(immutable_unaccent(sqlc.arg('qn')::text))::numeric
                  / (char_length(immutable_unaccent(sqlc.arg('qn')::text)) + 1)::numeric
                ),
                2
              )::float8
            END)
          ELSE 0.0::float8
        END)
      ELSE
        round(
          GREATEST(
            similarity(i.name_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
            word_similarity(immutable_unaccent(sqlc.arg('qn')::text), i.name_unaccent)
          )::numeric,
          2
        )::float8
    END) AS score
  FROM item AS i
  WHERE i.user_id = sqlc.arg('user_id')
    AND i.deleted_at IS NULL
    AND (
      i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR i.name_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
  ORDER BY
    tier DESC,
    score DESC,
    i.last_used_at DESC,
    i.entry_count DESC,
    i.id ASC
  LIMIT sqlc.arg('page_limit')
),
fuzzy_ranked AS (
  SELECT
    i.id,
    i.name,
    i.entry_count,
    i.last_used_at,
    i.created_at,
    1::int AS tier,
    round(
      GREATEST(
        similarity(i.name_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
        word_similarity(immutable_unaccent(sqlc.arg('qn')::text), i.name_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM item AS i
  WHERE sqlc.arg('fuzzy')::bool
    AND i.user_id = sqlc.arg('user_id')
    AND i.deleted_at IS NULL
    AND (
      i.name_unaccent % immutable_unaccent(sqlc.arg('qn')::text)
      OR immutable_unaccent(sqlc.arg('qn')::text) <% i.name_unaccent
    )
    AND NOT (
      i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR i.name_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
  ORDER BY
    score DESC,
    i.last_used_at DESC,
    i.entry_count DESC,
    i.id ASC
  LIMIT GREATEST(0, sqlc.arg('page_limit')::int - (SELECT count(*)::int FROM prefix_ranked))
)
SELECT
  combined.id,
  combined.name,
  combined.entry_count,
  combined.last_used_at,
  combined.created_at,
  combined.tier,
  combined.score
FROM (
  SELECT
    prefix_ranked.id,
    prefix_ranked.name,
    prefix_ranked.entry_count,
    prefix_ranked.last_used_at,
    prefix_ranked.created_at,
    prefix_ranked.tier,
    prefix_ranked.score
  FROM prefix_ranked
  UNION ALL
  SELECT
    fuzzy_ranked.id,
    fuzzy_ranked.name,
    fuzzy_ranked.entry_count,
    fuzzy_ranked.last_used_at,
    fuzzy_ranked.created_at,
    fuzzy_ranked.tier,
    fuzzy_ranked.score
  FROM fuzzy_ranked
) AS combined
ORDER BY
  combined.tier DESC,
  combined.score DESC,
  combined.last_used_at DESC,
  combined.entry_count DESC,
  combined.id ASC
LIMIT sqlc.arg('page_limit');

-- name: SearchTagsLexical :many
WITH prefix_ranked AS (
  SELECT
    t.id,
    t.display,
    t.item_count,
    t.last_used_at,
    (CASE
      WHEN t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      ELSE 2
    END)::int AS tier,
    (CASE
      WHEN NOT sqlc.arg('fuzzy')::bool THEN
        (CASE
          WHEN immutable_unaccent(sqlc.arg('qn')::text) ~ '^[[:alnum:]]+$' THEN
            (CASE
              WHEN t.tag_unaccent ~ ('(^|[^[:alnum:]])' || immutable_unaccent(sqlc.arg('qn')::text) || '($|[^[:alnum:]])') THEN 1.0::float8
              ELSE round(
                (
                  char_length(immutable_unaccent(sqlc.arg('qn')::text))::numeric
                  / (char_length(immutable_unaccent(sqlc.arg('qn')::text)) + 1)::numeric
                ),
                2
              )::float8
            END)
          ELSE 0.0::float8
        END)
      ELSE
        round(
          GREATEST(
            similarity(t.tag_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
            word_similarity(immutable_unaccent(sqlc.arg('qn')::text), t.tag_unaccent)
          )::numeric,
          2
        )::float8
    END) AS score
  FROM tag AS t
  WHERE t.user_id = sqlc.arg('user_id')
    AND t.deleted_at IS NULL
    AND (
      t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR t.tag_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
  ORDER BY
    tier DESC,
    score DESC,
    t.last_used_at DESC,
    t.item_count DESC,
    t.id ASC
  LIMIT sqlc.arg('page_limit')
),
fuzzy_ranked AS (
  SELECT
    t.id,
    t.display,
    t.item_count,
    t.last_used_at,
    1::int AS tier,
    round(
      GREATEST(
        similarity(t.tag_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
        word_similarity(immutable_unaccent(sqlc.arg('qn')::text), t.tag_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM tag AS t
  WHERE sqlc.arg('fuzzy')::bool
    AND t.user_id = sqlc.arg('user_id')
    AND t.deleted_at IS NULL
    AND (
      t.tag_unaccent % immutable_unaccent(sqlc.arg('qn')::text)
      OR immutable_unaccent(sqlc.arg('qn')::text) <% t.tag_unaccent
    )
    AND NOT (
      t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR t.tag_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
  ORDER BY
    score DESC,
    t.last_used_at DESC,
    t.item_count DESC,
    t.id ASC
  LIMIT GREATEST(0, sqlc.arg('page_limit')::int - (SELECT count(*)::int FROM prefix_ranked))
)
SELECT
  combined.id,
  combined.display,
  combined.item_count,
  combined.last_used_at,
  combined.tier,
  combined.score
FROM (
  SELECT
    prefix_ranked.id,
    prefix_ranked.display,
    prefix_ranked.item_count,
    prefix_ranked.last_used_at,
    prefix_ranked.tier,
    prefix_ranked.score
  FROM prefix_ranked
  UNION ALL
  SELECT
    fuzzy_ranked.id,
    fuzzy_ranked.display,
    fuzzy_ranked.item_count,
    fuzzy_ranked.last_used_at,
    fuzzy_ranked.tier,
    fuzzy_ranked.score
  FROM fuzzy_ranked
) AS combined
ORDER BY
  combined.tier DESC,
  combined.score DESC,
  combined.last_used_at DESC,
  combined.item_count DESC,
  combined.id ASC
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
WITH prefix_all AS (
  SELECT
    i.id,
    i.name,
    i.entry_count,
    i.last_used_at,
    i.created_at,
    (CASE
      WHEN i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      ELSE 2
    END)::int AS tier,
    (CASE
      WHEN NOT sqlc.arg('fuzzy')::bool THEN
        (CASE
          WHEN immutable_unaccent(sqlc.arg('qn')::text) ~ '^[[:alnum:]]+$' THEN
            (CASE
              WHEN i.name_unaccent ~ ('(^|[^[:alnum:]])' || immutable_unaccent(sqlc.arg('qn')::text) || '($|[^[:alnum:]])') THEN 1.0::float8
              ELSE round(
                (
                  char_length(immutable_unaccent(sqlc.arg('qn')::text))::numeric
                  / (char_length(immutable_unaccent(sqlc.arg('qn')::text)) + 1)::numeric
                ),
                2
              )::float8
            END)
          ELSE 0.0::float8
        END)
      ELSE
        round(
          GREATEST(
            similarity(i.name_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
            word_similarity(immutable_unaccent(sqlc.arg('qn')::text), i.name_unaccent)
          )::numeric,
          2
        )::float8
    END) AS score
  FROM item AS i
  WHERE i.user_id = sqlc.arg('user_id')
    AND i.deleted_at IS NULL
    AND (
      sqlc.narg('cursor_id')::uuid IS NULL
      OR sqlc.narg('cursor_tier')::int >= 2
    )
    AND (
      i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR i.name_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
),
prefix_ranked AS (
  SELECT
    p.id,
    p.name,
    p.entry_count,
    p.last_used_at,
    p.created_at,
    p.tier,
    p.score
  FROM prefix_all AS p
  WHERE
    sqlc.narg('cursor_id')::uuid IS NULL
    OR p.tier < sqlc.narg('cursor_tier')::int
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score < sqlc.narg('cursor_score')::float8
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND p.entry_count < sqlc.narg('cursor_count')::int
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND p.entry_count = sqlc.narg('cursor_count')::int
      AND p.id > sqlc.narg('cursor_id')::uuid
    )
  ORDER BY
    p.tier DESC,
    p.score DESC,
    p.last_used_at DESC,
    p.entry_count DESC,
    p.id ASC
  LIMIT sqlc.arg('page_limit')
),
fuzzy_all AS (
  SELECT
    i.id,
    i.name,
    i.entry_count,
    i.last_used_at,
    i.created_at,
    1::int AS tier,
    round(
      GREATEST(
        similarity(i.name_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
        word_similarity(immutable_unaccent(sqlc.arg('qn')::text), i.name_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM item AS i
  WHERE sqlc.arg('fuzzy')::bool
    AND i.user_id = sqlc.arg('user_id')
    AND i.deleted_at IS NULL
    AND (
      i.name_unaccent % immutable_unaccent(sqlc.arg('qn')::text)
      OR immutable_unaccent(sqlc.arg('qn')::text) <% i.name_unaccent
    )
    AND NOT (
      i.name_normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR i.name_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
),
fuzzy_ranked AS (
  SELECT
    f.id,
    f.name,
    f.entry_count,
    f.last_used_at,
    f.created_at,
    f.tier,
    f.score
  FROM fuzzy_all AS f
  WHERE
    sqlc.narg('cursor_id')::uuid IS NULL
    OR f.tier < sqlc.narg('cursor_tier')::int
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score < sqlc.narg('cursor_score')::float8
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND f.entry_count < sqlc.narg('cursor_count')::int
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND f.entry_count = sqlc.narg('cursor_count')::int
      AND f.id > sqlc.narg('cursor_id')::uuid
    )
  ORDER BY
    f.score DESC,
    f.last_used_at DESC,
    f.entry_count DESC,
    f.id ASC
  LIMIT GREATEST(0, sqlc.arg('page_limit')::int - (SELECT count(*)::int FROM prefix_ranked))
)
SELECT
  combined.id,
  combined.name,
  combined.entry_count,
  combined.last_used_at,
  combined.created_at,
  combined.tier,
  combined.score
FROM (
  SELECT
    prefix_ranked.id,
    prefix_ranked.name,
    prefix_ranked.entry_count,
    prefix_ranked.last_used_at,
    prefix_ranked.created_at,
    prefix_ranked.tier,
    prefix_ranked.score
  FROM prefix_ranked
  UNION ALL
  SELECT
    fuzzy_ranked.id,
    fuzzy_ranked.name,
    fuzzy_ranked.entry_count,
    fuzzy_ranked.last_used_at,
    fuzzy_ranked.created_at,
    fuzzy_ranked.tier,
    fuzzy_ranked.score
  FROM fuzzy_ranked
) AS combined
ORDER BY
  combined.tier DESC,
  combined.score DESC,
  combined.last_used_at DESC,
  combined.entry_count DESC,
  combined.id ASC
LIMIT sqlc.arg('page_limit');

-- name: SearchTagsLexicalPage :many
WITH prefix_all AS (
  SELECT
    t.id,
    t.display,
    t.item_count,
    t.last_used_at,
    (CASE
      WHEN t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\' THEN 3
      ELSE 2
    END)::int AS tier,
    (CASE
      WHEN NOT sqlc.arg('fuzzy')::bool THEN
        (CASE
          WHEN immutable_unaccent(sqlc.arg('qn')::text) ~ '^[[:alnum:]]+$' THEN
            (CASE
              WHEN t.tag_unaccent ~ ('(^|[^[:alnum:]])' || immutable_unaccent(sqlc.arg('qn')::text) || '($|[^[:alnum:]])') THEN 1.0::float8
              ELSE round(
                (
                  char_length(immutable_unaccent(sqlc.arg('qn')::text))::numeric
                  / (char_length(immutable_unaccent(sqlc.arg('qn')::text)) + 1)::numeric
                ),
                2
              )::float8
            END)
          ELSE 0.0::float8
        END)
      ELSE
        round(
          GREATEST(
            similarity(t.tag_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
            word_similarity(immutable_unaccent(sqlc.arg('qn')::text), t.tag_unaccent)
          )::numeric,
          2
        )::float8
    END) AS score
  FROM tag AS t
  WHERE t.user_id = sqlc.arg('user_id')
    AND t.deleted_at IS NULL
    AND (
      sqlc.narg('cursor_id')::uuid IS NULL
      OR sqlc.narg('cursor_tier')::int >= 2
    )
    AND (
      t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR t.tag_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
),
prefix_ranked AS (
  SELECT
    p.id,
    p.display,
    p.item_count,
    p.last_used_at,
    p.tier,
    p.score
  FROM prefix_all AS p
  WHERE
    sqlc.narg('cursor_id')::uuid IS NULL
    OR p.tier < sqlc.narg('cursor_tier')::int
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score < sqlc.narg('cursor_score')::float8
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND p.item_count < sqlc.narg('cursor_count')::int
    )
    OR (
      p.tier = sqlc.narg('cursor_tier')::int
      AND p.score = sqlc.narg('cursor_score')::float8
      AND p.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND p.item_count = sqlc.narg('cursor_count')::int
      AND p.id > sqlc.narg('cursor_id')::uuid
    )
  ORDER BY
    p.tier DESC,
    p.score DESC,
    p.last_used_at DESC,
    p.item_count DESC,
    p.id ASC
  LIMIT sqlc.arg('page_limit')
),
fuzzy_all AS (
  SELECT
    t.id,
    t.display,
    t.item_count,
    t.last_used_at,
    1::int AS tier,
    round(
      GREATEST(
        similarity(t.tag_unaccent, immutable_unaccent(sqlc.arg('qn')::text)),
        word_similarity(immutable_unaccent(sqlc.arg('qn')::text), t.tag_unaccent)
      )::numeric,
      2
    )::float8 AS score
  FROM tag AS t
  WHERE sqlc.arg('fuzzy')::bool
    AND t.user_id = sqlc.arg('user_id')
    AND t.deleted_at IS NULL
    AND (
      t.tag_unaccent % immutable_unaccent(sqlc.arg('qn')::text)
      OR immutable_unaccent(sqlc.arg('qn')::text) <% t.tag_unaccent
    )
    AND NOT (
      t.normalized LIKE sqlc.arg('q_prefix')::text ESCAPE '\'
      OR t.tag_unaccent LIKE (
        replace(
          replace(
            replace(immutable_unaccent(sqlc.arg('qn')::text), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) || '%'
      ) ESCAPE '\'
    )
),
fuzzy_ranked AS (
  SELECT
    f.id,
    f.display,
    f.item_count,
    f.last_used_at,
    f.tier,
    f.score
  FROM fuzzy_all AS f
  WHERE
    sqlc.narg('cursor_id')::uuid IS NULL
    OR f.tier < sqlc.narg('cursor_tier')::int
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score < sqlc.narg('cursor_score')::float8
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND f.item_count < sqlc.narg('cursor_count')::int
    )
    OR (
      f.tier = sqlc.narg('cursor_tier')::int
      AND f.score = sqlc.narg('cursor_score')::float8
      AND f.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND f.item_count = sqlc.narg('cursor_count')::int
      AND f.id > sqlc.narg('cursor_id')::uuid
    )
  ORDER BY
    f.score DESC,
    f.last_used_at DESC,
    f.item_count DESC,
    f.id ASC
  LIMIT GREATEST(0, sqlc.arg('page_limit')::int - (SELECT count(*)::int FROM prefix_ranked))
)
SELECT
  combined.id,
  combined.display,
  combined.item_count,
  combined.last_used_at,
  combined.tier,
  combined.score
FROM (
  SELECT
    prefix_ranked.id,
    prefix_ranked.display,
    prefix_ranked.item_count,
    prefix_ranked.last_used_at,
    prefix_ranked.tier,
    prefix_ranked.score
  FROM prefix_ranked
  UNION ALL
  SELECT
    fuzzy_ranked.id,
    fuzzy_ranked.display,
    fuzzy_ranked.item_count,
    fuzzy_ranked.last_used_at,
    fuzzy_ranked.tier,
    fuzzy_ranked.score
  FROM fuzzy_ranked
) AS combined
ORDER BY
  combined.tier DESC,
  combined.score DESC,
  combined.last_used_at DESC,
  combined.item_count DESC,
  combined.id ASC
LIMIT sqlc.arg('page_limit');
