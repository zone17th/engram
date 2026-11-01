-- P04: item, tag, item_tag, entry (content CRUD, JSON lossless, provenance xoá, feed changes).
-- Server chỉ lưu ciphertext body; name, hint, tag, type và metadata kích thước làm tròn là plaintext.
-- Forward-only trên production; down chỉ dùng DB test.

CREATE TABLE item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  name_normalized  text NOT NULL CHECK (char_length(name_normalized) BETWEEN 1 AND 200),
  name_unaccent    text GENERATED ALWAYS AS (immutable_unaccent(name_normalized)) STORED,
  hint             text CHECK (hint IS NULL OR char_length(hint) <= 120),
  entry_count      int  NOT NULL DEFAULT 0,
  version          int  NOT NULL DEFAULT 1,
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  delete_batch     uuid,
  UNIQUE (user_id, id)
);
CREATE INDEX item_user_name_prefix ON item (user_id, name_normalized text_pattern_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX item_name_trgm ON item USING gin (name_unaccent gin_trgm_ops);
CREATE INDEX item_user_recent ON item (user_id, last_used_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX item_user_created ON item (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX item_user_name_exact ON item (user_id, name_normalized, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX item_purge_idx ON item (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE tag (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  display       text NOT NULL CHECK (char_length(display) BETWEEN 1 AND 50),
  normalized    text NOT NULL CHECK (char_length(normalized) BETWEEN 1 AND 50),
  tag_unaccent  text GENERATED ALWAYS AS (immutable_unaccent(normalized)) STORED,
  item_count    int  NOT NULL DEFAULT 0,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX tag_user_norm_uq ON tag (user_id, normalized) WHERE deleted_at IS NULL;
CREATE INDEX tag_user_norm_prefix ON tag (user_id, normalized text_pattern_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX tag_norm_trgm ON tag USING gin (tag_unaccent gin_trgm_ops);
CREATE INDEX tag_user_recent ON tag (user_id, last_used_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tag_purge_idx ON tag (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE item_tag (
  item_id    uuid NOT NULL REFERENCES item (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX item_tag_tag_idx ON item_tag (tag_id, item_id);

CREATE TABLE entry (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  item_id              uuid NOT NULL,
  type                 text NOT NULL CHECK (type IN ('text', 'json', 'link', 'file', 'image')),
  position             int  NOT NULL DEFAULT 0,
  envelope             jsonb NOT NULL,
  ciphertext           bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 263168),
  plaintext_len_bucket int  NOT NULL CHECK (plaintext_len_bucket BETWEEN 256 AND 262144
                                            AND plaintext_len_bucket % 256 = 0),
  version              int  NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  deleted_via          text CHECK (deleted_via IN ('entry', 'item')),
  delete_batch         uuid,
  CHECK ((deleted_at IS NULL) = (deleted_via IS NULL)),
  FOREIGN KEY (user_id, item_id) REFERENCES item (user_id, id) ON DELETE CASCADE
);
CREATE INDEX entry_item_live_pos_idx ON entry (item_id, position, id) WHERE deleted_at IS NULL;
CREATE INDEX entry_user_updated_idx ON entry (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX entry_user_changes_idx ON entry (user_id, updated_at, id);
CREATE INDEX entry_purge_idx ON entry (deleted_at) WHERE deleted_at IS NOT NULL;
