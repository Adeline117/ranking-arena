-- Migration: 20260816151614_public_ranked_leaderboard.sql
-- Created: 2026-08-16T22:16:14Z
-- Description: Expose one public, eligibility-filtered ranked cohort view.
--
-- `leaderboard_ranks` deliberately retains partial, estimated, stale, and
-- otherwise non-rankable observations for profile, remediation, and replay
-- paths. Browser-facing leaderboard reads need a database-native boundary so
-- a future caller cannot paginate an unfiltered relation and then try to
-- remove unsafe rows in application code. This view is that boundary only;
-- it does not rewrite rankings or change existing readers in this migration.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'database owner and Supabase API roles are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = 'postgres'::pg_catalog.regrole
      AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'public ranked leaderboard owner must bypass retained-row RLS';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('anon', 'arena', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege('authenticated', 'arena', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege('service_role', 'arena', 'USAGE') THEN
    RAISE EXCEPTION 'API roles require arena schema usage for ranked cohort wrappers';
  END IF;

  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL THEN
    RAISE EXCEPTION 'leaderboard ranks and source registry foundations are required';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
     ) IS NULL THEN
    RAISE EXCEPTION 'rank freshness and row eligibility authorities are required';
  END IF;

  IF pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.public_ranked_leaderboard_source_is_expected(text,text)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'public ranked leaderboard is already or partially installed';
  END IF;

  -- Explicit projection below is intentional. A wildcard would silently
  -- publish a future internal leaderboard column through PostgREST.
  IF EXISTS (
    SELECT required_column.name
    FROM pg_catalog.unnest(ARRAY[
      'id', 'season_id', 'source', 'source_type', 'source_trader_id',
      'rank', 'arena_score', 'arena_score_v3', 'arena_score_v4',
      'roi', 'pnl', 'win_rate', 'max_drawdown',
      'followers', 'copiers', 'trades_count', 'handle', 'avatar_url',
      'computed_at', 'profitability_score', 'risk_control_score',
      'execution_score', 'score_completeness', 'trading_style',
      'avg_holding_hours', 'style_confidence', 'sharpe_ratio',
      'sortino_ratio', 'profit_factor', 'calmar_ratio', 'trader_type',
      'is_outlier', 'metrics_estimated', 'rank_change', 'is_new'
    ]::text[]) AS required_column(name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid = 'public.leaderboard_ranks'::regclass
        AND attribute_row.attname = required_column.name
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'leaderboard rank public projection contract is incomplete';
  END IF;
END
$preflight$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260816-public-ranked-leaderboard',
    0
  )
);

LOCK TABLE ONLY public.leaderboard_ranks IN SHARE MODE;
LOCK TABLE ONLY arena.sources IN SHARE MODE;
LOCK TABLE ONLY arena.exchanges IN SHARE MODE;

-- Views do not carry the owner identity into an invoked function's EXECUTE
-- ACL check, even when security_invoker is false. Keep the detailed expected
-- source set private and expose only this boolean, pair-scoped capability to
-- browser roles. STRICT preserves NULL as unknown; malformed text is false.
CREATE FUNCTION arena.public_ranked_leaderboard_source_is_expected(
  p_source text,
  p_season_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT COALESCE(
    p_source = pg_catalog.lower(pg_catalog.btrim(p_source))
    AND p_source = pg_catalog.btrim(p_source)
    AND p_source <> ''
    AND p_season_id IN ('7D', '30D', '90D')
    AND EXISTS (
      SELECT 1
      FROM public.arena_freshness_expected_sources() AS expected_source
      WHERE expected_source.filter_source = p_source
        AND expected_source.season_id = p_season_id
    ),
    false
  );
$function$;

ALTER FUNCTION arena.public_ranked_leaderboard_source_is_expected(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_source_is_expected(
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_source_is_expected(
  text,
  text
) TO anon, authenticated, service_role;

-- The row-level eligibility authority is likewise private. It accepts an
-- already-selected rank composite and returns only a boolean; it cannot
-- enumerate or return any retained leaderboard observation.
CREATE FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT COALESCE(
    arena.leaderboard_rank_row_is_public_eligible(
      p_rank,
      p_observed_at
    ),
    false
  );
$function$;

ALTER FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks,
  timestamptz
) TO anon, authenticated, service_role;

-- `security_invoker = false` is deliberate. The expected-source authority is
-- a SECURITY DEFINER monitoring contract whose direct EXECUTE ACL is limited
-- to service_role. The narrow boolean wrappers above are the only browser-callable
-- capabilities. `security_barrier` ensures this mandatory cohort predicate
-- remains a fence before caller-supplied filters/pagination.
CREATE VIEW public.public_ranked_leaderboard
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  rank_row.id,
  rank_row.season_id,
  rank_row.source,
  rank_row.source_type,
  rank_row.source_trader_id,
  rank_row.rank,
  rank_row.arena_score,
  rank_row.arena_score_v3,
  rank_row.arena_score_v4,
  rank_row.roi,
  rank_row.pnl,
  rank_row.win_rate,
  rank_row.max_drawdown,
  rank_row.followers,
  rank_row.copiers,
  rank_row.trades_count,
  rank_row.handle,
  rank_row.avatar_url,
  rank_row.computed_at,
  rank_row.profitability_score,
  rank_row.risk_control_score,
  rank_row.execution_score,
  rank_row.score_completeness,
  rank_row.trading_style,
  rank_row.avg_holding_hours,
  rank_row.style_confidence,
  rank_row.sharpe_ratio,
  rank_row.sortino_ratio,
  rank_row.profit_factor,
  rank_row.calmar_ratio,
  rank_row.trader_type,
  rank_row.is_outlier,
  rank_row.metrics_estimated,
  rank_row.rank_change,
  rank_row.is_new
FROM public.leaderboard_ranks AS rank_row
WHERE rank_row.rank IS NOT NULL
  AND arena.public_ranked_leaderboard_row_is_eligible(
    rank_row,
    pg_catalog.statement_timestamp()
  )
  AND arena.public_ranked_leaderboard_source_is_expected(
    rank_row.source,
    rank_row.season_id
  );

ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;

REVOKE ALL ON TABLE public.public_ranked_leaderboard
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_ranked_leaderboard
  TO anon, authenticated, service_role;

COMMENT ON VIEW public.public_ranked_leaderboard IS
  'Only currently expected-source, persisted-rank, full/non-estimated/current public leaderboard rows. Explicit projection prevents accidental publication of future internal columns.';

-- This first view migration is intentionally additive: existing browser raw
-- table grants remain until every public reader has switched to this view.
-- Revoke parent and partition SELECT in a separately reviewed cutover after
-- that reader deployment; doing it here would create a deploy-order 403.

NOTIFY pgrst, 'reload schema';

COMMIT;
