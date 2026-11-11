-- Forward replacement for 20260729230000_token_ranking_generation_barrier.sql
-- (never applied to production). The body is identical except for the
-- $cron_update$ block: Supabase grants the migration owner only SELECT on
-- cron.job, so the original direct UPDATE fails there. This version changes
-- the job through pg_cron's owner-checked cron.alter_job API. Apply it in the
-- original's launch slot; the original is superseded.
--
-- Bind every token-ranking page and popular-token response to one atomically
-- published materialized-view generation.
--
-- The two token MVs already refresh in one function call, but their consumers
-- cache independent pages for an hour. Without a durable generation, page 0
-- from the old MV contents can be combined with page 1 from the new contents.
-- Bootstrap is deliberately generation zero with no publication timestamp:
-- only the first successful controlled refresh may claim a published snapshot.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regnamespace('arena') IS NULL THEN
    RAISE EXCEPTION 'arena schema is required';
  END IF;
  IF pg_catalog.to_regclass('public.mv_token_trader_daily_90d') IS NULL
     OR pg_catalog.to_regclass('public.mv_popular_tokens_90d') IS NULL THEN
    RAISE EXCEPTION 'token ranking materialized views are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.mv_token_trader_daily_90d'::pg_catalog.regclass
      AND relation.relkind = 'm'
      AND relation.relispopulated
  )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.mv_popular_tokens_90d'::pg_catalog.regclass
         AND relation.relkind = 'm'
         AND relation.relispopulated
     ) THEN
    RAISE EXCEPTION 'token ranking materialized views must be populated';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
          'public.mv_token_trader_daily_90d'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
  )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indrelid =
             'public.mv_popular_tokens_90d'::pg_catalog.regclass
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indpred IS NULL
         AND index_row.indexprs IS NULL
     ) THEN
    RAISE EXCEPTION 'concurrent token MV refresh requires full unique indexes';
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.get_token_trader_rankings(text,integer,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.get_popular_tokens(integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.refresh_popular_tokens_mv()'
     ) IS NULL THEN
    RAISE EXCEPTION 'token ranking RPC foundations are required';
  END IF;
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Supabase runtime roles are required';
  END IF;
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'token ranking refresh cron job catalog is required';
  END IF;
  IF pg_catalog.current_setting(
       'cron.use_background_workers',
       true
     ) IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'token ranking refresh requires pg_cron libpq mode';
  END IF;
  IF (
       SELECT pg_catalog.count(*)
       FROM cron.job AS job
       WHERE job.jobname = 'refresh-mv-popular-tokens'
         AND job.database = pg_catalog.current_database()
         AND job.username = 'postgres'
         AND job.active
     ) <> 1 THEN
    RAISE EXCEPTION 'active postgres token ranking refresh cron job is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.token_ranking_publication_head (
  singleton boolean PRIMARY KEY DEFAULT true,
  generation_seq bigint NOT NULL DEFAULT 0,
  published_at timestamp with time zone,
  window_through_date date,
  source_as_of timestamp with time zone,
  source_through_date date,
  daily_row_count bigint NOT NULL,
  popular_row_count bigint NOT NULL,
  CONSTRAINT token_ranking_publication_head_singleton_check
    CHECK (singleton),
  CONSTRAINT token_ranking_publication_head_generation_check
    CHECK (generation_seq BETWEEN 0 AND 9007199254740000),
  CONSTRAINT token_ranking_publication_head_counts_check
    CHECK (daily_row_count >= 0 AND popular_row_count >= 0),
  CONSTRAINT token_ranking_publication_head_state_check
    CHECK (
      (
        generation_seq = 0
        AND published_at IS NULL
        AND window_through_date IS NULL
      )
      OR (
        generation_seq > 0
        AND published_at IS NOT NULL
        AND window_through_date IS NOT NULL
      )
    ),
  CONSTRAINT token_ranking_publication_head_source_time_check
    CHECK (
      source_as_of IS NULL
      OR (
        published_at IS NOT NULL
        AND source_as_of <= published_at + interval '5 minutes'
      )
    )
);

ALTER TABLE arena.token_ranking_publication_head OWNER TO postgres;
ALTER TABLE arena.token_ranking_publication_head ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.token_ranking_publication_head
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO arena.token_ranking_publication_head (
  singleton,
  generation_seq,
  published_at,
  window_through_date,
  source_as_of,
  source_through_date,
  daily_row_count,
  popular_row_count
)
SELECT
  true,
  0::bigint,
  NULL::timestamp with time zone,
  NULL::date,
  NULL::timestamp with time zone,
  pg_catalog.max(daily.trade_date),
  pg_catalog.count(*)::bigint,
  (
    SELECT pg_catalog.count(*)::bigint
    FROM public.mv_popular_tokens_90d AS popular
  )
FROM public.mv_token_trader_daily_90d AS daily
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE arena.token_ranking_publication_head IS
  'Private singleton publication head for the atomically refreshed token MVs. Generation zero and NULL published_at are unproven bootstrap state.';
COMMENT ON COLUMN arena.token_ranking_publication_head.published_at IS
  'Actual completion time of the controlled two-MV publication, never request/render time.';
COMMENT ON COLUMN arena.token_ranking_publication_head.window_through_date IS
  'UTC date captured from the refresh transaction timestamp; generation-bound detail windows use this instead of request CURRENT_DATE.';
COMMENT ON COLUMN arena.token_ranking_publication_head.source_as_of IS
  'Exact source-data watermark. NULL until close_time lineage is materialized; published_at must never substitute for it.';
COMMENT ON COLUMN arena.token_ranking_publication_head.source_through_date IS
  'Coarse UTC calendar date present in the daily aggregate; not an exact source timestamp.';

CREATE OR REPLACE FUNCTION arena.token_trader_ranking_page_payload_v1(
  p_token_symbol text,
  p_lookback_days integer,
  p_max_traders integer,
  p_row_offset integer,
  p_window_through_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
  WITH totals AS MATERIALIZED (
    SELECT
      daily.source,
      daily.source_trader_id,
      pg_catalog.round(pg_catalog.sum(daily.token_pnl), 2) AS token_pnl,
      pg_catalog.sum(daily.trade_count)::bigint AS token_trade_count,
      pg_catalog.round(
        100.0 * pg_catalog.sum(daily.win_count)
          / nullif(pg_catalog.sum(daily.trade_count), 0),
        2
      ) AS token_win_rate,
      pg_catalog.round(
        pg_catalog.sum(daily.pnl_pct_sum)
          / nullif(pg_catalog.sum(daily.pnl_pct_count), 0),
        2
      ) AS token_avg_pnl_pct
    FROM public.mv_token_trader_daily_90d AS daily
    WHERE daily.token = pg_catalog.upper(pg_catalog.btrim(p_token_symbol))
      AND p_window_through_date IS NOT NULL
      AND daily.trade_date >= p_window_through_date
        - greatest(1, least(p_lookback_days, 90))
      AND daily.trade_date <= p_window_through_date
      AND daily.source IS NOT NULL
      AND pg_catalog.btrim(daily.source) <> ''
      AND daily.source_trader_id IS NOT NULL
      AND pg_catalog.btrim(daily.source_trader_id) <> ''
    GROUP BY daily.source, daily.source_trader_id
  ), ranked AS MATERIALIZED (
    SELECT
      totals.*,
      pg_catalog.row_number() OVER (
        ORDER BY
          totals.token_pnl DESC,
          totals.source ASC,
          totals.source_trader_id ASC
      ) AS token_rank
    FROM totals
    WHERE totals.token_pnl IS NOT NULL
      AND totals.token_pnl::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND totals.token_trade_count >= 0
  ), page_rows AS MATERIALIZED (
    SELECT
      ranked.source,
      ranked.source_trader_id,
      ranked.token_rank,
      ranked.token_pnl,
      ranked.token_trade_count,
      ranked.token_win_rate,
      ranked.token_avg_pnl_pct
    FROM ranked
    ORDER BY ranked.token_rank ASC
    LIMIT greatest(1, least(p_max_traders, 200))
    OFFSET greatest(p_row_offset, 0)
  )
  SELECT pg_catalog.jsonb_build_object(
    'total', (SELECT pg_catalog.count(*)::bigint FROM ranked),
    'traders', COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'source', page.source,
            'source_trader_id', page.source_trader_id,
            'token_rank', page.token_rank,
            'token_pnl', page.token_pnl,
            'token_trade_count', page.token_trade_count,
            'token_win_rate', page.token_win_rate,
            'token_avg_pnl_pct', page.token_avg_pnl_pct
          )
          ORDER BY page.token_rank
        )
        FROM page_rows AS page
      ),
      '[]'::jsonb
    )
  );
$function$;

ALTER FUNCTION arena.token_trader_ranking_page_payload_v1(
  text,
  integer,
  integer,
  integer,
  date
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.token_trader_ranking_page_payload_v1(
  text,
  integer,
  integer,
  integer,
  date
) FROM PUBLIC, anon, authenticated, service_role;

-- Keep the rolling-deploy v1 contract, but route it through the same private
-- payload builder as v2 so ranking eligibility/order cannot drift by version.
CREATE OR REPLACE FUNCTION public.get_token_trader_rankings(
  token_symbol text,
  lookback_days integer DEFAULT 90,
  max_traders integer DEFAULT 50,
  row_offset integer DEFAULT 0
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  token_rank bigint,
  token_pnl numeric,
  token_trade_count bigint,
  token_win_rate numeric,
  token_avg_pnl_pct numeric,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
  WITH snapshot AS MATERIALIZED (
    SELECT arena.token_trader_ranking_page_payload_v1(
      token_symbol,
      lookback_days,
      max_traders,
      row_offset,
      CURRENT_DATE
    ) AS payload
  )
  SELECT
    page.source,
    page.source_trader_id,
    page.token_rank,
    page.token_pnl,
    page.token_trade_count,
    page.token_win_rate,
    page.token_avg_pnl_pct,
    (snapshot.payload->>'total')::bigint AS total_count
  FROM snapshot
  CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(
    snapshot.payload->'traders'
  ) AS page(
    source text,
    source_trader_id text,
    token_rank bigint,
    token_pnl numeric,
    token_trade_count bigint,
    token_win_rate numeric,
    token_avg_pnl_pct numeric
  )
  ORDER BY page.token_rank ASC;
$function$;

ALTER FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.get_token_ranking_publication_head()
RETURNS TABLE(
  generation_seq bigint,
  published_at timestamp with time zone,
  published_at_epoch_ms bigint,
  window_through_date date,
  source_as_of timestamp with time zone,
  source_through_date date,
  daily_row_count bigint,
  popular_row_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
  SELECT
    publication.generation_seq,
    publication.published_at,
    pg_catalog.floor(
      pg_catalog.date_part('epoch', publication.published_at) * 1000
    )::bigint,
    publication.window_through_date,
    publication.source_as_of,
    publication.source_through_date,
    publication.daily_row_count,
    publication.popular_row_count
  FROM arena.token_ranking_publication_head AS publication
  WHERE publication.singleton;
$function$;

ALTER FUNCTION public.get_token_ranking_publication_head()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.get_token_trader_rankings_v2(
  token_symbol text,
  lookback_days integer,
  max_traders integer,
  row_offset integer,
  expected_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
DECLARE
  v_generation bigint;
  v_published_at timestamp with time zone;
  v_window_through_date date;
  v_source_as_of timestamp with time zone;
  v_source_through_date date;
  v_token text;
  v_payload jsonb;
BEGIN
  v_token := pg_catalog.upper(pg_catalog.btrim(token_symbol));
  IF token_symbol IS NULL
     OR v_token !~ '^[A-Z0-9]{1,20}$'
     OR lookback_days IS NULL
     OR lookback_days < 1
     OR lookback_days > 90
     OR max_traders IS NULL
     OR max_traders < 1
     OR max_traders > 200
     OR row_offset IS NULL
     OR row_offset < 0
     OR row_offset > 2000000
     OR expected_generation IS NULL
     OR expected_generation < 0
     OR expected_generation > 9007199254740000 THEN
    RAISE EXCEPTION 'invalid token ranking page request'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    publication.generation_seq,
    publication.published_at,
    publication.window_through_date,
    publication.source_as_of,
    publication.source_through_date
    INTO STRICT
      v_generation,
      v_published_at,
      v_window_through_date,
      v_source_as_of,
      v_source_through_date
  FROM arena.token_ranking_publication_head AS publication
  WHERE publication.singleton;

  IF v_generation = 0
     OR v_published_at IS NULL
     OR v_window_through_date IS NULL THEN
    RAISE EXCEPTION 'token ranking generation is not published'
      USING ERRCODE = '55000';
  END IF;
  IF expected_generation <> v_generation THEN
    RAISE EXCEPTION 'token ranking generation changed'
      USING
        ERRCODE = '40001',
        DETAIL = v_generation::text;
  END IF;

  v_payload := arena.token_trader_ranking_page_payload_v1(
    v_token,
    lookback_days,
    max_traders,
    row_offset,
    v_window_through_date
  );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'token-ranking-page@1',
    'generation', v_generation::text,
    'published_at', v_published_at,
    'published_at_epoch_ms', pg_catalog.floor(
      pg_catalog.date_part('epoch', v_published_at) * 1000
    )::bigint,
    'window_through_date', v_window_through_date,
    'source_as_of', v_source_as_of,
    'source_through_date', v_source_through_date,
    'token', v_token,
    'lookback_days', lookback_days,
    'limit', max_traders,
    'offset', row_offset
  ) || v_payload;
END
$function$;

ALTER FUNCTION public.get_token_trader_rankings_v2(
  text,
  integer,
  integer,
  integer,
  bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.get_popular_tokens_v2(
  lookback_days integer,
  max_tokens integer,
  expected_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
DECLARE
  v_generation bigint;
  v_published_at timestamp with time zone;
  v_window_through_date date;
  v_source_as_of timestamp with time zone;
  v_source_through_date date;
  v_rows jsonb;
  v_total bigint;
BEGIN
  IF lookback_days IS DISTINCT FROM 90
     OR max_tokens IS NULL
     OR max_tokens < 1
     OR max_tokens > 60
     OR expected_generation IS NULL
     OR expected_generation < 0
     OR expected_generation > 9007199254740000 THEN
    RAISE EXCEPTION 'invalid popular token request'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    publication.generation_seq,
    publication.published_at,
    publication.window_through_date,
    publication.source_as_of,
    publication.source_through_date
    INTO STRICT
      v_generation,
      v_published_at,
      v_window_through_date,
      v_source_as_of,
      v_source_through_date
  FROM arena.token_ranking_publication_head AS publication
  WHERE publication.singleton;

  IF v_generation = 0
     OR v_published_at IS NULL
     OR v_window_through_date IS NULL THEN
    RAISE EXCEPTION 'token ranking generation is not published'
      USING ERRCODE = '55000';
  END IF;
  IF expected_generation <> v_generation THEN
    RAISE EXCEPTION 'token ranking generation changed'
      USING
        ERRCODE = '40001',
        DETAIL = v_generation::text;
  END IF;

  WITH eligible AS MATERIALIZED (
    SELECT
      popular.token,
      popular.trade_count,
      popular.trader_count,
      popular.total_pnl
    FROM public.mv_popular_tokens_90d AS popular
    WHERE popular.token IS NOT NULL
      AND popular.token ~ '^[A-Z0-9]{1,10}$'
      AND popular.token ~ '[A-Z]'
      AND popular.trade_count IS NOT NULL
      AND popular.trade_count >= 0
      AND popular.trader_count IS NOT NULL
      AND popular.trader_count >= 0
      AND popular.total_pnl IS NOT NULL
      AND popular.total_pnl::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ), page AS MATERIALIZED (
    SELECT
      eligible.token,
      eligible.trade_count,
      eligible.trader_count,
      eligible.total_pnl
    FROM eligible
    ORDER BY eligible.trade_count DESC, eligible.token ASC
    LIMIT max_tokens
  )
  SELECT
    (SELECT pg_catalog.count(*)::bigint FROM eligible),
    COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'token', page.token,
            'trade_count', page.trade_count,
            'trader_count', page.trader_count,
            'total_pnl', page.total_pnl
          )
          ORDER BY page.trade_count DESC, page.token ASC
        )
        FROM page
      ),
      '[]'::jsonb
    )
    INTO STRICT v_total, v_rows;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'popular-token-page@1',
    'generation', v_generation::text,
    'published_at', v_published_at,
    'published_at_epoch_ms', pg_catalog.floor(
      pg_catalog.date_part('epoch', v_published_at) * 1000
    )::bigint,
    'window_through_date', v_window_through_date,
    'source_as_of', v_source_as_of,
    'source_through_date', v_source_through_date,
    'lookback_days', lookback_days,
    'limit', max_tokens,
    'total', v_total,
    'tokens', v_rows
  );
END
$function$;

ALTER FUNCTION public.get_popular_tokens_v2(integer, integer, bigint)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.refresh_popular_tokens_mv()
RETURNS void
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_generation bigint;
  v_window_through_date date := pg_catalog.timezone(
    'UTC',
    pg_catalog.transaction_timestamp()
  )::date;
  v_source_through_date date;
  v_daily_row_count bigint;
  v_popular_row_count bigint;
BEGIN
  IF pg_catalog.current_setting(
       'cron.use_background_workers',
       true
     ) IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'token ranking refresh requires pg_cron libpq mode'
      USING ERRCODE = '55000';
  END IF;

  -- NOWAIT turns overlapping cron/manual refreshes into one explicit failure;
  -- it never queues a second expensive scan behind the first publication.
  SELECT publication.generation_seq
    INTO STRICT v_generation
  FROM arena.token_ranking_publication_head AS publication
  WHERE publication.singleton
  FOR UPDATE NOWAIT;

  IF v_generation >= 9007199254740000 THEN
    RAISE EXCEPTION 'token ranking generation exhausted'
      USING ERRCODE = '54000';
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_token_trader_daily_90d;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_popular_tokens_90d;

  SELECT
    pg_catalog.max(daily.trade_date),
    pg_catalog.count(*)::bigint
    INTO STRICT v_source_through_date, v_daily_row_count
  FROM public.mv_token_trader_daily_90d AS daily;

  IF v_source_through_date > v_window_through_date THEN
    RAISE EXCEPTION 'token ranking source contains future UTC dates'
      USING ERRCODE = '22000';
  END IF;

  SELECT pg_catalog.count(*)::bigint
    INTO STRICT v_popular_row_count
  FROM public.mv_popular_tokens_90d AS popular;

  UPDATE arena.token_ranking_publication_head AS publication
  SET
    generation_seq = v_generation + 1,
    published_at = pg_catalog.clock_timestamp(),
    window_through_date = v_window_through_date,
    -- The current daily MV stores only close_time::date. Keep exact source
    -- freshness unknown instead of fabricating it from publication time.
    source_as_of = NULL,
    source_through_date = v_source_through_date,
    daily_row_count = v_daily_row_count,
    popular_row_count = v_popular_row_count
  WHERE publication.singleton;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token ranking publication head is missing'
      USING ERRCODE = '55000';
  END IF;
END
$function$;

ALTER FUNCTION public.refresh_popular_tokens_mv() OWNER TO postgres;

-- pg_cron defaults to a libpq connection. PostgreSQL 13+ starts a new
-- statement timer for each command in one simple-query message, so this SET
-- arms the following refresh SELECT before it starts. The preflight rejects
-- pg_cron background-worker mode, whose timer is armed before command parsing.
-- Supabase grants the migration owner only SELECT on cron.job, so the job is
-- changed through pg_cron's owner-checked cron.alter_job API, not a direct
-- catalog UPDATE.
DO $cron_update$
DECLARE
  v_job_ids bigint[];
BEGIN
  SELECT pg_catalog.array_agg(job.jobid ORDER BY job.jobid)
  INTO v_job_ids
  FROM cron.job AS job
  WHERE job.jobname = 'refresh-mv-popular-tokens'
    AND job.database = pg_catalog.current_database()
    AND job.username = 'postgres';

  IF COALESCE(pg_catalog.cardinality(v_job_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'token ranking refresh cron update failed';
  END IF;

  PERFORM cron.alter_job(
    job_id := v_job_ids[1],
    schedule := '*/30 * * * *',
    command := 'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();',
    active := true
  );

  IF NOT EXISTS (
    SELECT 1
    FROM cron.job AS job
    WHERE job.jobid = v_job_ids[1]
      AND job.schedule = '*/30 * * * *'
      AND job.command =
        'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();'
      AND job.active
  ) THEN
    RAISE EXCEPTION 'token ranking refresh cron update failed';
  END IF;
END
$cron_update$;

REVOKE ALL ON FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_token_ranking_publication_head()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_token_trader_rankings_v2(
  text,
  integer,
  integer,
  integer,
  bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_popular_tokens_v2(integer, integer, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_popular_tokens_mv()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_token_ranking_publication_head()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings_v2(
  text,
  integer,
  integer,
  integer,
  bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_popular_tokens_v2(integer, integer, bigint)
  TO service_role;

COMMENT ON FUNCTION public.get_token_ranking_publication_head() IS
  'Service-only token MV publication head; generation zero is not publishable.';
COMMENT ON FUNCTION public.get_token_trader_rankings_v2(
  text,
  integer,
  integer,
  integer,
  bigint
) IS 'Generation-bound token trader page. SQLSTATE 40001 means the requested snapshot changed.';
COMMENT ON FUNCTION public.get_popular_tokens_v2(integer, integer, bigint) IS
  'Generation-bound popular-token page. SQLSTATE 40001 means the requested snapshot changed.';
COMMENT ON FUNCTION public.refresh_popular_tokens_mv() IS
  'Postgres-owner-only atomic refresh of both token MVs followed by one publication-head generation advance.';

DO $postflight$
DECLARE
  v_head_count bigint;
BEGIN
  SELECT pg_catalog.count(*)
    INTO STRICT v_head_count
  FROM arena.token_ranking_publication_head AS publication
  WHERE publication.singleton;
  IF v_head_count <> 1 THEN
    RAISE EXCEPTION 'token ranking publication head singleton postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
          'arena.token_ranking_publication_head'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'token ranking publication head authority postflight failed';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'arena.token_ranking_publication_head'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 8
     OR (
       SELECT pg_catalog.count(*)
       FROM (
         VALUES
           ('singleton', 'boolean', true),
           ('generation_seq', 'bigint', true),
           ('published_at', 'timestamp with time zone', false),
           ('window_through_date', 'date', false),
           ('source_as_of', 'timestamp with time zone', false),
           ('source_through_date', 'date', false),
           ('daily_row_count', 'bigint', true),
           ('popular_row_count', 'bigint', true)
       ) AS expected(attname, formatted_type, attnotnull)
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid =
            'arena.token_ranking_publication_head'::pg_catalog.regclass
        AND attribute.attname = expected.attname
        AND pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ) = expected.formatted_type
        AND attribute.attnotnull = expected.attnotnull
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
     ) <> 8 THEN
    RAISE EXCEPTION 'token ranking publication head shape postflight failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.token_ranking_publication_head'::pg_catalog.regclass
         AND constraint_row.conname =
             'token_ranking_publication_head_state_check'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
       WHERE relation.oid =
             'arena.token_ranking_publication_head'::pg_catalog.regclass
         AND privilege.grantee IN (
           0,
           'anon'::pg_catalog.regrole,
           'authenticated'::pg_catalog.regrole,
           'service_role'::pg_catalog.regrole
         )
     ) THEN
    RAISE EXCEPTION 'token ranking publication head ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = ANY (
      ARRAY[
        'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)'::pg_catalog.regprocedure,
        'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure,
        'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure,
        'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure,
        'public.get_popular_tokens_v2(integer,integer,bigint)'::pg_catalog.regprocedure,
        'public.refresh_popular_tokens_mv()'::pg_catalog.regprocedure
      ]
    )
      AND (
        function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR function_row.proconfig IS NULL
        OR NOT function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION 'token ranking function authority postflight failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
             'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)'::pg_catalog.regprocedure
         AND function_row.provolatile = 's'
         AND function_row.proparallel = 's'
         AND NOT function_row.prosecdef
         AND pg_catalog.cardinality(function_row.proconfig) = 2
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = ANY (
         ARRAY[
           'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure,
           'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure,
           'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure,
           'public.get_popular_tokens_v2(integer,integer,bigint)'::pg_catalog.regprocedure
         ]
       )
         AND (
           function_row.provolatile <> 's'
           OR function_row.proparallel <> 'u'
           OR NOT function_row.prosecdef
           OR pg_catalog.cardinality(function_row.proconfig) <> 2
         )
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
             'public.refresh_popular_tokens_mv()'::pg_catalog.regprocedure
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND function_row.prosecdef
         AND pg_catalog.cardinality(function_row.proconfig) = 3
         AND function_row.proconfig @> ARRAY[
           'lock_timeout=10s'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'token ranking function mode postflight failed';
  END IF;

  IF pg_catalog.pg_get_function_result(
       'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure
     ) <> 'TABLE(source text, source_trader_id text, token_rank bigint, token_pnl numeric, token_trade_count bigint, token_win_rate numeric, token_avg_pnl_pct numeric, total_count bigint)'
     OR pg_catalog.pg_get_function_result(
       'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure
     ) <> 'TABLE(generation_seq bigint, published_at timestamp with time zone, published_at_epoch_ms bigint, window_through_date date, source_as_of timestamp with time zone, source_through_date date, daily_row_count bigint, popular_row_count bigint)'
     OR pg_catalog.pg_get_function_result(
       'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure
     ) <> 'jsonb'
     OR pg_catalog.pg_get_function_result(
       'public.get_popular_tokens_v2(integer,integer,bigint)'::pg_catalog.regprocedure
     ) <> 'jsonb' THEN
    RAISE EXCEPTION 'token ranking return contract postflight failed';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = ANY (
         ARRAY[
           'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)'::pg_catalog.regprocedure,
           'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure,
           'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure,
           'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure,
           'public.get_popular_tokens_v2(integer,integer,bigint)'::pg_catalog.regprocedure,
           'public.refresh_popular_tokens_mv()'::pg_catalog.regprocedure
         ]
       )
         AND privilege.grantee IN (
           0,
           'anon'::pg_catalog.regrole,
           'authenticated'::pg_catalog.regrole
         )
     ) THEN
    RAISE EXCEPTION 'token ranking unauthorized function ACL postflight failed';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.get_token_trader_rankings(text,integer,integer,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.get_token_ranking_publication_head()',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.get_popular_tokens_v2(integer,integer,bigint)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.refresh_popular_tokens_mv()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'token ranking service function ACL postflight failed';
  END IF;

  IF pg_catalog.current_setting(
       'cron.use_background_workers',
       true
     ) IS DISTINCT FROM 'off'
     OR NOT EXISTS (
       SELECT 1
       FROM cron.job AS job
       WHERE job.jobname = 'refresh-mv-popular-tokens'
         AND job.schedule = '*/30 * * * *'
         AND job.command =
             'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();'
         AND job.database = pg_catalog.current_database()
         AND job.username = 'postgres'
         AND job.active
     ) THEN
    RAISE EXCEPTION 'token ranking refresh cron postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
