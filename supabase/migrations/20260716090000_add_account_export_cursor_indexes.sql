-- Cover every account-export keyset with its owner equality key followed by
-- the monotonically increasing UUID cursor. Existing owner/created_at and
-- single-column indexes cannot satisfy ORDER BY id after the owner filter.
--
-- Keep this migration outside an explicit transaction: PostgreSQL forbids
-- CREATE INDEX CONCURRENTLY inside a transaction block. CONCURRENTLY avoids
-- blocking ordinary INSERT/UPDATE/DELETE traffic while each index is built.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_export_author_id_id
  ON public.posts (author_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_export_user_id_id
  ON public.comments (user_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_export_follower_id_id
  ON public.user_follows (follower_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_export_following_id_id
  ON public.user_follows (following_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tips_export_from_user_id_id
  ON public.tips (from_user_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tips_export_to_user_id_id
  ON public.tips (to_user_id, id);

-- IF NOT EXISTS is replay-safe, but PostgreSQL checks only the index name.
-- Refuse to mark the migration successful if a pre-existing same-name index
-- has the wrong table/keys, or if an interrupted concurrent build left an
-- INVALID index behind. Operators can then remove that one invalid index and
-- safely replay this migration instead of silently running unindexed exports.
DO $postflight$
DECLARE
  v_index_name text;
  v_table regclass;
  v_columns name[];
BEGIN
  FOR v_index_name, v_table, v_columns IN
    SELECT expected.index_name, expected.table_name, expected.columns
    FROM (
      VALUES
        (
          'idx_posts_export_author_id_id',
          'public.posts'::regclass,
          ARRAY['author_id', 'id']::name[]
        ),
        (
          'idx_comments_export_user_id_id',
          'public.comments'::regclass,
          ARRAY['user_id', 'id']::name[]
        ),
        (
          'idx_user_follows_export_follower_id_id',
          'public.user_follows'::regclass,
          ARRAY['follower_id', 'id']::name[]
        ),
        (
          'idx_user_follows_export_following_id_id',
          'public.user_follows'::regclass,
          ARRAY['following_id', 'id']::name[]
        ),
        (
          'idx_tips_export_from_user_id_id',
          'public.tips'::regclass,
          ARRAY['from_user_id', 'id']::name[]
        ),
        (
          'idx_tips_export_to_user_id_id',
          'public.tips'::regclass,
          ARRAY['to_user_id', 'id']::name[]
        )
    ) AS expected(index_name, table_name, columns)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS index_relation
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indexrelid = index_relation.oid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_namespace.nspname = 'public'
        AND index_relation.relname = v_index_name
        AND index_metadata.indrelid = v_table
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND index_metadata.indpred IS NULL
        AND index_metadata.indexprs IS NULL
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND access_method.amname = 'btree'
        AND (
          SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_column.ordinality)
          FROM pg_catalog.unnest(index_metadata.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute_row
            ON attribute_row.attrelid = index_metadata.indrelid
           AND attribute_row.attnum = key_column.attnum
        ) = v_columns
    ) THEN
      RAISE EXCEPTION
        'account export cursor index % is missing, invalid, or has the wrong definition',
        v_index_name;
    END IF;
  END LOOP;
END
$postflight$;

RESET statement_timeout;
RESET lock_timeout;
