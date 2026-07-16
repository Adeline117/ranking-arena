-- Cover 2C interaction export keysets with the authenticated owner followed
-- by the UUID cursor. Existing owner-only and owner/time indexes still require
-- a sort by id. Keep this migration outside an explicit transaction because
-- PostgreSQL forbids CREATE INDEX CONCURRENTLY inside a transaction block.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_export_user_id_id
  ON public.notifications (user_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_likes_export_user_id_id
  ON public.comment_likes (user_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_emoji_reactions_export_user_id_id
  ON public.post_emoji_reactions (user_id, id);

-- IF NOT EXISTS checks only the relation name. Reject wrong definitions and
-- interrupted concurrent builds so an export cannot silently run unindexed.
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
          'idx_notifications_export_user_id_id',
          'public.notifications'::regclass,
          ARRAY['user_id', 'id']::name[]
        ),
        (
          'idx_comment_likes_export_user_id_id',
          'public.comment_likes'::regclass,
          ARRAY['user_id', 'id']::name[]
        ),
        (
          'idx_post_emoji_reactions_export_user_id_id',
          'public.post_emoji_reactions'::regclass,
          ARRAY['user_id', 'id']::name[]
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
        AND NOT index_metadata.indisunique
        AND NOT index_metadata.indisprimary
        AND NOT index_metadata.indisexclusion
        AND index_metadata.indpred IS NULL
        AND index_metadata.indexprs IS NULL
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND access_method.amname = 'btree'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(index_metadata.indoption) AS option_bits
          WHERE option_bits <> 0
        )
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
        'interaction export cursor index % is missing, invalid, or has the wrong definition',
        v_index_name;
    END IF;
  END LOOP;
END
$postflight$;

RESET statement_timeout;
RESET lock_timeout;
