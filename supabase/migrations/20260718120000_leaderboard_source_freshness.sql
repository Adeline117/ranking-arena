-- Preserve the source-data watermark separately from score computation time.
--
-- leaderboard_ranks.computed_at is rewritten by Arena's scoring cron and can
-- therefore make an unchanged/stale exchange snapshot look fresh. This table
-- records the latest source snapshot that a complete leaderboard write
-- published for each 7D/30D/90D board.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT leaderboard_source_freshness_not_future
    CHECK (source_as_of <= recorded_at + interval '5 minutes'),
  PRIMARY KEY (season_id, source)
);

CREATE INDEX idx_leaderboard_source_freshness_age
  ON public.leaderboard_source_freshness (season_id, source_as_of DESC);

ALTER TABLE public.leaderboard_source_freshness ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leaderboard_source_freshness_public_read"
  ON public.leaderboard_source_freshness;
CREATE POLICY "leaderboard_source_freshness_public_read"
  ON public.leaderboard_source_freshness
  FOR SELECT
  USING (true);

GRANT SELECT ON public.leaderboard_source_freshness TO anon, authenticated;
GRANT ALL ON public.leaderboard_source_freshness TO service_role;

-- Backfill only from count-check-PASSED source snapshots. In particular, never
-- copy leaderboard_ranks.computed_at: that timestamp describes Arena's score
-- job, not the age of source data. The join to the currently served board keeps
-- retired/non-ranking sources out of the initial watermark set.
WITH latest_passed AS (
  SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at
  FROM arena.leaderboard_snapshots AS snapshot
  WHERE snapshot.count_check_passed
    AND snapshot.timeframe IN (7, 30, 90)
  ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at DESC
),
live_boards AS (
  SELECT DISTINCT ranks.season_id, ranks.source
  FROM public.leaderboard_ranks AS ranks
  WHERE ranks.arena_score > 0
    AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
),
source_watermarks AS (
  SELECT
    (latest.timeframe::text || 'D') AS season_id,
    COALESCE(
      NULLIF(source.meta->>'legacy_platform', ''),
      source.slug
    ) AS source,
    -- More than one physical source board may map to one public source alias.
    -- The public source is only as fresh as its oldest contributing board.
    MIN(latest.scraped_at) AS source_as_of
  FROM latest_passed AS latest
  JOIN arena.sources AS source
    ON source.id = latest.source_id
  JOIN live_boards AS live
    ON live.season_id = (latest.timeframe::text || 'D')
   AND live.source = COALESCE(
     NULLIF(source.meta->>'legacy_platform', ''),
     source.slug
   )
  WHERE source.status = 'active'
    AND source.serving_mode = 'serving'
    AND source.currency IN ('USDT', 'USDx', 'USDC', 'USD')
    AND (source.meta->>'legacy_platform') IS DISTINCT FROM 'null'
  GROUP BY
    (latest.timeframe::text || 'D'),
    COALESCE(
      NULLIF(source.meta->>'legacy_platform', ''),
      source.slug
    )
)
INSERT INTO public.leaderboard_source_freshness (
  season_id,
  source,
  source_as_of,
  recorded_at
)
SELECT
  watermark.season_id,
  watermark.source,
  watermark.source_as_of,
  pg_catalog.statement_timestamp()
FROM source_watermarks AS watermark
ON CONFLICT (season_id, source) DO UPDATE
SET
  source_as_of = EXCLUDED.source_as_of,
  recorded_at = CASE
    WHEN public.leaderboard_source_freshness.source_as_of
         IS DISTINCT FROM EXCLUDED.source_as_of
      THEN EXCLUDED.recorded_at
    ELSE public.leaderboard_source_freshness.recorded_at
  END;

COMMENT ON TABLE public.leaderboard_source_freshness IS
  'Last source-data watermark published by a complete leaderboard write. Never substitute leaderboard_ranks.computed_at.';
COMMENT ON COLUMN public.leaderboard_source_freshness.source_as_of IS
  'Exchange/protocol snapshot time (arena PASSED scraped_at), not Arena score computation time.';

NOTIFY pgrst, 'reload schema';

COMMIT;
