-- Make a followed trader account source-scoped end to end.
--
-- Historical rows may have source=NULL. Backfill only when the current
-- leaderboard / authoritative serving set resolves the raw trader id to one
-- and only one source. Ambiguous or missing identities remain explicitly NULL;
-- the API exposes them as legacy edges and supports an exact IS NULL unfollow.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.trader_follows:composite-identity:v1', 0)
);

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_follows') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
  THEN
    RAISE EXCEPTION
      'trader follow composite-identity dependencies are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.trader_follows'::pg_catalog.regclass
      AND constraint_row.conname = 'trader_follows_user_id_trader_id_key'
      AND constraint_row.contype = 'u'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
            = 'UNIQUE (user_id, trader_id)'
  ) THEN
    RAISE EXCEPTION
      'expected legacy trader_follows UNIQUE(user_id, trader_id) is missing or drifted';
  END IF;
END
$preflight$;

LOCK TABLE public.trader_follows IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE trader_follow_source_candidates
ON COMMIT DROP
AS
SELECT DISTINCT candidate.follow_id, candidate.source
FROM (
  SELECT follow_row.id AS follow_id, leaderboard.source
  FROM public.trader_follows AS follow_row
  JOIN public.leaderboard_ranks AS leaderboard
    ON leaderboard.source_trader_id = follow_row.trader_id
  WHERE follow_row.source IS NULL
    AND leaderboard.season_id = '90D'
    AND leaderboard.computed_at >= pg_catalog.now() - interval '5 days'
    AND leaderboard.source IS NOT NULL
    AND leaderboard.source <> ''

  UNION

  SELECT
    follow_row.id AS follow_id,
    COALESCE(
      NULLIF(source_row.meta ->> 'legacy_platform', ''),
      source_row.slug
    ) AS source
  FROM public.trader_follows AS follow_row
  JOIN arena.traders AS trader_row
    ON trader_row.exchange_trader_id = follow_row.trader_id
  JOIN arena.sources AS source_row
    ON source_row.id = trader_row.source_id
  WHERE follow_row.source IS NULL
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
) AS candidate;

WITH uniquely_resolved AS (
  SELECT follow_id, pg_catalog.min(source) AS source
  FROM trader_follow_source_candidates
  GROUP BY follow_id
  HAVING pg_catalog.count(DISTINCT source) = 1
)
UPDATE public.trader_follows AS follow_row
SET source = resolved.source
FROM uniquely_resolved AS resolved
WHERE follow_row.id = resolved.follow_id
  AND follow_row.source IS NULL;

DO $legacy_report$
DECLARE
  v_ambiguous bigint;
  v_unresolved bigint;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_ambiguous
  FROM (
    SELECT follow_id
    FROM trader_follow_source_candidates
    GROUP BY follow_id
    HAVING pg_catalog.count(DISTINCT source) > 1
  ) AS ambiguous;

  SELECT pg_catalog.count(*)
  INTO v_unresolved
  FROM public.trader_follows AS follow_row
  WHERE follow_row.source IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM trader_follow_source_candidates AS candidate
      WHERE candidate.follow_id = follow_row.id
    );

  RAISE WARNING
    'trader_follows legacy source report: ambiguous=%, unresolved=%; rows remain source=NULL and are removable through exact IS NULL unfollow',
    v_ambiguous,
    v_unresolved;
END
$legacy_report$;

ALTER TABLE public.trader_follows
  DROP CONSTRAINT trader_follows_user_id_trader_id_key;

ALTER TABLE public.trader_follows
  ADD CONSTRAINT trader_follows_user_id_trader_id_source_key
  UNIQUE NULLS NOT DISTINCT (user_id, trader_id, source);

COMMENT ON COLUMN public.trader_follows.source IS
  'Exchange/source component of trader identity. NULL is legacy-only and must be mutated with explicit IS NULL semantics.';

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_row.indexrelid
    WHERE index_row.indrelid = 'public.trader_follows'::pg_catalog.regclass
      AND index_class.relname = 'trader_follows_user_id_trader_id_source_key'
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnullsnotdistinct
      AND index_row.indnkeyatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'trader_id', 'source']::name[]
  ) THEN
    RAISE EXCEPTION
      'trader_follows composite identity unique constraint is missing or incompatible';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
