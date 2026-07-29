-- Shared PostgreSQL 17 foundation for atomic leaderboard-rank writer proofs.
--
-- The invoking proof owns cluster/bootstrap lifecycle, must initialize and
-- connect as the postgres database owner, and must create the anon,
-- authenticated, service_role, and fixture_rogue roles, the arena and
-- extensions schemas, and pgcrypto in extensions before loading this file.
-- This fixture creates only pre-migration parent objects. Production trigger,
-- scorer, score-input manifest, claim, receipt, codec, typed-batch, and writer
-- objects must be installed from their real migrations rather than copied into
-- a test fixture.

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  registry_slug text NOT NULL,
  filter_source text NOT NULL,
  exchange_name text NOT NULL,
  season_id text NOT NULL,
  is_serving boolean NOT NULL DEFAULT true,
  PRIMARY KEY (registry_slug, season_id)
);

INSERT INTO arena.exchanges (id, name)
VALUES (1, 'Atomic writer fixture');

INSERT INTO arena.sources (
  registry_slug,
  filter_source,
  exchange_name,
  season_id
) VALUES
  ('alpha', 'alpha', 'Alpha', '90D'),
  ('beta', 'beta', 'Beta', '90D');

CREATE SEQUENCE public.leaderboard_ranks_id_seq;

CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL DEFAULT pg_catalog.nextval(
    'public.leaderboard_ranks_id_seq'::pg_catalog.regclass
  ),
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric(10, 2),
  roi numeric(12, 4),
  pnl numeric(18, 2),
  win_rate numeric(5, 2),
  max_drawdown numeric(5, 2),
  followers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamptz,
  profitability_score numeric(6, 2),
  risk_control_score numeric(6, 2),
  execution_score numeric(6, 2),
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric(10, 2),
  style_confidence numeric(6, 4),
  sharpe_ratio numeric(10, 4),
  sortino_ratio numeric(10, 4),
  profit_factor numeric(10, 4),
  calmar_ratio numeric(10, 4),
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  copiers integer,
  arena_score_v4 numeric,
  arena_score_v3 numeric,
  score_factors jsonb,
  rank_publication_id uuid,
  CONSTRAINT leaderboard_ranks_identity_key
    UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);

CREATE TABLE public.lr_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.lr_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.lr_90d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.lr_default
  PARTITION OF public.leaderboard_ranks DEFAULT;

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (season_id, source)
);

CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    source.registry_slug,
    source.filter_source,
    source.exchange_name,
    source.season_id
  FROM arena.sources AS source
  WHERE source.is_serving
  ORDER BY
    source.exchange_name COLLATE pg_catalog."C",
    source.registry_slug COLLATE pg_catalog."C",
    source.season_id COLLATE pg_catalog."C"
$function$;
