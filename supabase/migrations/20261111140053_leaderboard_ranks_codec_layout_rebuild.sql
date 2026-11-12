-- Forward repair: rebuild public.leaderboard_ranks to the reviewed persisted
-- codec column order, numbering, and types. Launch slot: immediately before
-- 20260725016500_leaderboard_rank_persisted_codec.sql. Owner decision
-- 2026-11-11: option A (align the table so every reviewed contract after it
-- stays unchanged). Production application needs its own owner GO and a
-- maintenance window; pause both writers first (lib/pipeline/storage.ts upsert
-- and the typed batch writer). Rehearsed on 39,823 rows: about 4 seconds.
--
-- Evidence (2026-10-30 production backup, rehearsed on supabase/postgres
-- 17.6.1.178): at this slot the table has the reviewed 37 column names but
--   * 16 columns differ in type (unconstrained numeric, id integer,
--     followers bigint), and
--   * the physical order differs (is_outlier sits before sharpe_ratio; copiers
--     before rank_change): layout digest 7f99948b...58d4.
-- 20260725017000 builds rows positionally with ROW(...)::public.leaderboard_ranks
-- and 20260725017500 fingerprints attnum 1..37, so moving columns in place
-- (which leaves dropped-column gaps) is not enough: the table is rebuilt.
--
-- What is preserved exactly (all verified in the preflight first): the 4 LIST
-- partitions and bounds, every row, the id sequence and default, PK/UNIQUE and
-- all four CHECK constraints by name, the five indexes by name (partition index
-- names are regenerated identically), the RLS flag and single public-read
-- policy, the parent ACL, the three statement-level fence
-- triggers, the four column comments, and the dependent view
-- public.verified_data_authorizations (recreated with its exact definition,
-- options, owner, and ACL), and arena.leaderboard_rank_row_is_public_eligible
-- (the only live function using the row type; recreated byte-for-byte).
-- Tightened: partitions become owner-only (20260725017500 requires it; the
-- old direct SELECT/MAINTAIN partition grants to API roles are dropped).
-- Retired: public.get_diverse_leaderboard(text,integer,integer), which already
-- fails on every production call and has no caller. Values are rounded to the
-- codec scale; values that cannot fit are refused before anything changes.
--
-- Rollback: the transaction is all-or-nothing. After commit, restore the
-- previous layout only from a backup or PITR taken immediately before.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';

LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_column_count integer;
  v_layout_sha256 text;
  v_row_count bigint;
  v_overflow bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND table_row.relrowsecurity
      AND NOT table_row.relforcerowsecurity
      AND table_row.relreplident = 'd'
      AND table_row.reloptions IS NULL
      AND pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'
      AND table_row.relacl::text =
        '{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwd/postgres}'
  ) THEN
    RAISE EXCEPTION 'leaderboard_ranks rebuild requires the reviewed parent table state';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            attribute.attname || '|' ||
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
            attribute.attnotnull::text || '|' ||
            attribute.attidentity::text || '|' ||
            attribute.attgenerated::text || '|' ||
            COALESCE(collation_namespace.nspname || '.' || collation_row.collname, '-'),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_column_count, v_layout_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_collation AS collation_row
    ON collation_row.oid = attribute.attcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  -- Only the exact observed production layout is rebuilt.
  IF v_column_count <> 37
     OR v_layout_sha256 IS DISTINCT FROM
          '7f99948b74bddebc215f119e8131a73e6f9984c0c9b398356e24145bf9a458d4' THEN
    RAISE EXCEPTION
      'leaderboard_ranks layout is not the reviewed production state: columns %, digest %',
      v_column_count,
      v_layout_sha256;
  END IF;

  IF (
       SELECT pg_catalog.string_agg(
         child.relname || '=' || pg_catalog.pg_get_expr(child.relpartbound, child.oid)
           || '|' || child.relrowsecurity::text || '|' || child.relforcerowsecurity::text
           || '|' || child.relacl::text,
         ';' ORDER BY child.relname
       )
       FROM pg_catalog.pg_inherits AS inheritance
       JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
       WHERE inheritance.inhparent = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND child.relnamespace = 'public'::pg_catalog.regnamespace
         AND child.relkind = 'r'
         AND child.relowner = 'postgres'::pg_catalog.regrole
     ) IS DISTINCT FROM
       'lr_30d=FOR VALUES IN (''30D'')|true|false|{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=rm/postgres};'
       'lr_7d=FOR VALUES IN (''7D'')|true|false|{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=rm/postgres};'
       'lr_90d=FOR VALUES IN (''90D'')|true|false|{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=rm/postgres};'
       'lr_default=DEFAULT|true|false|{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=rm/postgres}'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_inherits AS inheritance
       WHERE inheritance.inhparent = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) <> 4 THEN
    RAISE EXCEPTION 'leaderboard_ranks partitions drifted from the reviewed production state';
  END IF;

  IF (
       SELECT pg_catalog.array_agg(index_row.relname::text ORDER BY index_row.relname)
       FROM pg_catalog.pg_index AS index_meta
       JOIN pg_catalog.pg_class AS index_row ON index_row.oid = index_meta.indexrelid
       WHERE index_meta.indrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) IS DISTINCT FROM ARRAY[
       'idx_leaderboard_ranks_diverse_v2',
       'idx_lr_api_default',
       'idx_lr_part_season_rank',
       'idx_lr_part_season_score',
       'idx_lr_part_source_season',
       'leaderboard_ranks_partitioned_pkey',
       'leaderboard_ranks_partitioned_season_id_source_source_trade_key'
     ]::text[]
     OR (
       SELECT pg_catalog.array_agg(constraint_row.conname::text ORDER BY constraint_row.conname)
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) IS DISTINCT FROM ARRAY[
       'chk_lr_part_arena_score',
       'chk_lr_part_mdd',
       'chk_lr_part_roi',
       'leaderboard_ranks_block_unverified_okx_web3_solana',
       'leaderboard_ranks_partitioned_pkey',
       'leaderboard_ranks_partitioned_season_id_source_source_trade_key'
     ]::text[]
     OR (
       SELECT pg_catalog.array_agg(trigger_row.tgname::text ORDER BY trigger_row.tgname)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND NOT trigger_row.tgisinternal
     ) IS DISTINCT FROM ARRAY[
       'leaderboard_rank_delete_fence',
       'leaderboard_rank_insert_fence',
       'leaderboard_rank_update_fence'
     ]::text[]
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       JOIN pg_catalog.pg_inherits AS inheritance
         ON inheritance.inhrelid = trigger_row.tgrelid
       WHERE inheritance.inhparent = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND NOT trigger_row.tgisinternal
     )
     OR (
       SELECT pg_catalog.array_agg(policy_row.polname::text)
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) IS DISTINCT FROM ARRAY['Public read leaderboard_ranks']::text[]
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       JOIN pg_catalog.pg_inherits AS inheritance
         ON inheritance.inhrelid = policy_row.polrelid
       WHERE inheritance.inhparent = 'public.leaderboard_ranks'::pg_catalog.regclass
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.confrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_publication_rel AS publication_rel
       WHERE publication_rel.prrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND attribute.attacl IS NOT NULL
     )
     OR pg_catalog.pg_get_serial_sequence('public.leaderboard_ranks', 'id') IS NOT NULL
     OR (
       -- Only verified_data_authorizations may depend on the table (it is
       -- dropped and recreated below); nothing may use its row type.
       SELECT pg_catalog.array_agg(DISTINCT dependent.oid::pg_catalog.regclass::text)
       FROM pg_catalog.pg_depend AS dependency
       JOIN pg_catalog.pg_rewrite AS rewrite_row ON rewrite_row.oid = dependency.objid
       JOIN pg_catalog.pg_class AS dependent ON dependent.oid = rewrite_row.ev_class
       WHERE dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
         AND dependency.refobjid = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND dependent.oid <> 'public.leaderboard_ranks'::pg_catalog.regclass
     ) IS DISTINCT FROM ARRAY['public.verified_data_authorizations']::text[]
     OR (
       -- Exactly two functions use the row type: the legacy
       -- get_diverse_leaderboard (already broken in production: its body
       -- returns 33 columns in the old order; no caller) and the 20260724235000
       -- eligibility policy (recreated byte-for-byte below).
       SELECT pg_catalog.array_agg(
         function_row.oid::pg_catalog.regprocedure::text || '#' ||
           pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
             'hex'
           )
         ORDER BY function_row.oid::pg_catalog.regprocedure::text
       )
       FROM pg_catalog.pg_depend AS dependency
       JOIN pg_catalog.pg_proc AS function_row ON function_row.oid = dependency.objid
       WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND dependency.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass
         AND dependency.refobjid = (
           SELECT table_row.reltype
           FROM pg_catalog.pg_class AS table_row
           WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
         )
         AND dependency.deptype = 'n'
     ) IS DISTINCT FROM ARRAY[
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)#aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df',
       'public.get_diverse_leaderboard(text,integer,integer)#ee7c1e2c7eaaf4070286ff0f29cae87eb7d65ea92d4dce98248d23da378c9381'
     ]::text[]
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass
         AND dependency.refobjid = (
           SELECT table_row.reltype
           FROM pg_catalog.pg_class AS table_row
           WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
         )
         AND dependency.deptype = 'n'
         AND dependency.classid <> 'pg_catalog.pg_proc'::pg_catalog.regclass
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND dependency.refobjid IN (
           'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'::pg_catalog.regprocedure,
           'public.get_diverse_leaderboard(text,integer,integer)'::pg_catalog.regprocedure
         )
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
             'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'::pg_catalog.regprocedure
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.proacl::text = '{postgres=X/postgres}'
         AND function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_depend AS dependency
       JOIN pg_catalog.pg_rewrite AS rewrite_row ON rewrite_row.oid = dependency.objid
       WHERE dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
         AND dependency.refobjid = 'public.verified_data_authorizations'::pg_catalog.regclass
         AND rewrite_row.ev_class <> 'public.verified_data_authorizations'::pg_catalog.regclass
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS view_row
       WHERE view_row.oid = 'public.verified_data_authorizations'::pg_catalog.regclass
         AND view_row.relkind = 'v'
         AND view_row.relowner = 'postgres'::pg_catalog.regrole
         AND view_row.reloptions = ARRAY['security_barrier=true']::text[]
         AND view_row.relacl::text =
           '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'
     ) THEN
    RAISE EXCEPTION 'leaderboard_ranks dependent surface drifted from the reviewed production state';
  END IF;

  SELECT pg_catalog.count(*) INTO STRICT v_row_count FROM public.leaderboard_ranks;
  PERFORM pg_catalog.set_config('arena.leaderboard_rank_rebuild_rows', v_row_count::text, true);

  SELECT pg_catalog.count(*)
  INTO v_overflow
  FROM public.leaderboard_ranks AS rank_row
  WHERE pg_catalog.abs(pg_catalog.round(rank_row.arena_score, 2)) >= 1e8
     OR pg_catalog.abs(pg_catalog.round(rank_row.roi, 4)) >= 1e8
     OR pg_catalog.abs(pg_catalog.round(rank_row.pnl, 2)) >= 1e16
     OR pg_catalog.abs(pg_catalog.round(rank_row.win_rate, 2)) >= 1e3
     OR pg_catalog.abs(pg_catalog.round(rank_row.max_drawdown, 2)) >= 1e3
     OR rank_row.followers > 2147483647
     OR rank_row.followers < -2147483648
     OR pg_catalog.abs(pg_catalog.round(rank_row.profitability_score, 2)) >= 1e4
     OR pg_catalog.abs(pg_catalog.round(rank_row.risk_control_score, 2)) >= 1e4
     OR pg_catalog.abs(pg_catalog.round(rank_row.execution_score, 2)) >= 1e4
     OR pg_catalog.abs(pg_catalog.round(rank_row.avg_holding_hours, 2)) >= 1e8
     OR pg_catalog.abs(pg_catalog.round(rank_row.style_confidence, 4)) >= 1e2
     OR pg_catalog.abs(pg_catalog.round(rank_row.sharpe_ratio, 4)) >= 1e6
     OR pg_catalog.abs(pg_catalog.round(rank_row.sortino_ratio, 4)) >= 1e6
     OR pg_catalog.abs(pg_catalog.round(rank_row.profit_factor, 4)) >= 1e6
     OR pg_catalog.abs(pg_catalog.round(rank_row.calmar_ratio, 4)) >= 1e6;

  IF v_overflow <> 0 THEN
    RAISE EXCEPTION
      'leaderboard_ranks has % rows outside the persisted codec range; normalize them first',
      v_overflow;
  END IF;
END
$preflight$;

-- 1. Move the dependents and the old table aside. get_diverse_leaderboard is
-- retired: in production it already fails on every call ("Final statement
-- returns too few columns") and nothing calls it. The eligibility policy is
-- recreated unchanged after the new table exists.
DROP VIEW public.verified_data_authorizations;
DROP FUNCTION public.get_diverse_leaderboard(text, integer, integer);
DROP FUNCTION arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz);

ALTER TABLE public.leaderboard_ranks RENAME TO leaderboard_ranks__layout_legacy;
ALTER TABLE public.lr_7d RENAME TO lr_7d__layout_legacy;
ALTER TABLE public.lr_30d RENAME TO lr_30d__layout_legacy;
ALTER TABLE public.lr_90d RENAME TO lr_90d__layout_legacy;
ALTER TABLE public.lr_default RENAME TO lr_default__layout_legacy;

-- 2. The reviewed persisted-codec table (column order and types).
CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL DEFAULT pg_catalog.nextval('public.leaderboard_ranks_id_seq'::pg_catalog.regclass),
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric(10,2),
  roi numeric(12,4),
  pnl numeric(18,2),
  win_rate numeric(5,2),
  max_drawdown numeric(5,2),
  followers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamp with time zone,
  profitability_score numeric(6,2),
  risk_control_score numeric(6,2),
  execution_score numeric(6,2),
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric(10,2),
  style_confidence numeric(6,4),
  sharpe_ratio numeric(10,4),
  sortino_ratio numeric(10,4),
  profit_factor numeric(10,4),
  calmar_ratio numeric(10,4),
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  copiers integer,
  arena_score_v4 numeric,
  arena_score_v3 numeric,
  score_factors jsonb,
  rank_publication_id uuid
) PARTITION BY LIST (season_id);

CREATE TABLE public.lr_7d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.lr_30d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.lr_90d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.lr_default PARTITION OF public.leaderboard_ranks DEFAULT;

-- 3. Copy every row by column name (values round to the codec scale).
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank, arena_score, roi,
  pnl, win_rate, max_drawdown, followers, trades_count, handle, avatar_url,
  computed_at, profitability_score, risk_control_score, execution_score,
  score_completeness, trading_style, avg_holding_hours, style_confidence,
  sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type,
  is_outlier, metrics_estimated, rank_change, is_new, copiers, arena_score_v4,
  arena_score_v3, score_factors, rank_publication_id
)
SELECT
  id, season_id, source, source_type, source_trader_id, rank, arena_score, roi,
  pnl, win_rate, max_drawdown, followers, trades_count, handle, avatar_url,
  computed_at, profitability_score, risk_control_score, execution_score,
  score_completeness, trading_style, avg_holding_hours, style_confidence,
  sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type,
  is_outlier, metrics_estimated, rank_change, is_new, copiers, arena_score_v4,
  arena_score_v3, score_factors, rank_publication_id
FROM public.leaderboard_ranks__layout_legacy;

DROP TABLE public.leaderboard_ranks__layout_legacy;

ALTER TABLE public.leaderboard_ranks OWNER TO postgres;

-- 4. Constraints and indexes, by their production names.
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_partitioned_pkey PRIMARY KEY (id, season_id),
  ADD CONSTRAINT leaderboard_ranks_partitioned_season_id_source_source_trade_key
    UNIQUE (season_id, source, source_trader_id),
  ADD CONSTRAINT chk_lr_part_arena_score
    CHECK ((arena_score IS NULL) OR ((arena_score >= (0)::numeric) AND (arena_score <= (100)::numeric))),
  ADD CONSTRAINT chk_lr_part_mdd
    CHECK ((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric))),
  ADD CONSTRAINT chk_lr_part_roi
    CHECK ((roi IS NULL) OR ((roi >= ('-10000'::integer)::numeric) AND (roi <= (10000)::numeric))),
  ADD CONSTRAINT leaderboard_ranks_block_unverified_okx_web3_solana
    CHECK (source <> 'okx_web3_solana'::text);

CREATE INDEX idx_leaderboard_ranks_diverse_v2 ON public.leaderboard_ranks
  USING btree (season_id, source, arena_score DESC NULLS LAST)
  INCLUDE (id, source_type, source_trader_id, rank, roi, pnl, win_rate, max_drawdown,
           followers, trades_count, handle, avatar_url, computed_at, profitability_score,
           risk_control_score, execution_score, score_completeness, trading_style,
           avg_holding_hours, style_confidence, sharpe_ratio, trader_type, is_outlier,
           copiers, sortino_ratio, profit_factor, calmar_ratio)
  WHERE ((arena_score > (0)::numeric) AND ((is_outlier IS NULL) OR (is_outlier = false)));

CREATE INDEX idx_lr_api_default ON public.leaderboard_ranks
  USING btree (season_id, arena_score DESC NULLS LAST)
  INCLUDE (source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
           trades_count, followers, copiers, avatar_url, rank, rank_change, is_new,
           computed_at, profitability_score, risk_control_score, execution_score,
           score_completeness, trading_style, avg_holding_hours, sharpe_ratio,
           sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier,
           metrics_estimated)
  WHERE ((arena_score IS NOT NULL) AND ((is_outlier IS NULL) OR (is_outlier = false))
         AND ((roi >= ('-50000'::integer)::numeric) AND (roi <= (50000)::numeric)));

CREATE INDEX idx_lr_part_season_rank ON public.leaderboard_ranks
  USING btree (season_id, rank);
CREATE INDEX idx_lr_part_season_score ON public.leaderboard_ranks
  USING btree (season_id, arena_score DESC);
CREATE INDEX idx_lr_part_source_season ON public.leaderboard_ranks
  USING btree (source, season_id, arena_score DESC);

COMMENT ON COLUMN public.leaderboard_ranks.arena_score_v4 IS
  'Shadow: Arena Score v4 (computeArenaScoreV4). Parallel-computed, NOT served until cutover. See lib/utils/arena-score.ts.';
COMMENT ON COLUMN public.leaderboard_ranks.arena_score_v3 IS
  'Rollback: the pre-v4 (V3 ROI+PnL) arena_score. arena_score itself now holds v4.';
COMMENT ON COLUMN public.leaderboard_ranks.score_factors IS
  'v4 score breakdown {roi,pnl,drawdown,sharpe,consistency} 0-1 for the score UI.';
COMMENT ON COLUMN public.leaderboard_ranks.rank_publication_id IS
  'Caller-generated score cohort token; a source is public only when every row matches its immutable publication receipt.';

-- The 20260724235000 eligibility policy, byte-for-byte (same signature, body
-- digest aa87e834...f0df, owner, config, ACL, and comment).
CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND (p_rank).source = pg_catalog.lower(pg_catalog.btrim((p_rank).source))
    AND pg_catalog.btrim((p_rank).source_trader_id) <> ''
    AND (p_rank).source_trader_id = pg_catalog.btrim((p_rank).source_trader_id)
    AND (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).arena_score <= 100
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).roi >= -10000
    AND (p_rank).roi <= 10000
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).pnl >= -100000000
    AND (p_rank).pnl <= 1000000000
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).win_rate >= 0
    AND (p_rank).win_rate <= 100
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).max_drawdown >= 0
    AND (p_rank).max_drawdown < 100
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;
REVOKE ALL
  ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
    public.leaderboard_ranks,
    timestamptz
  )
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) IS
  'Canonical database row policy shared by seal, replay, proof, and the season-global public ROW_NUMBER population.';

-- 5. RLS, policy, and the exact production ACLs (new relations would
-- otherwise inherit the schema's default privileges).
ALTER TABLE public.leaderboard_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lr_7d ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lr_30d ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lr_90d ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lr_default ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read leaderboard_ranks" ON public.leaderboard_ranks
  FOR SELECT USING (true);

REVOKE ALL ON TABLE public.leaderboard_ranks FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.lr_7d FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.lr_30d FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.lr_90d FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.lr_default FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, MAINTAIN ON TABLE public.leaderboard_ranks TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.leaderboard_ranks TO service_role;
-- Partitions stay owner-only, as 20260725017500 requires: every reader and
-- writer goes through the parent (its ACL and RLS policy). Production's old
-- direct partition grants (SELECT, MAINTAIN to anon/authenticated/service_role)
-- are not recreated; no application code addresses a partition directly.

-- 6. Statement-level publication fence triggers (exact definitions).
CREATE TRIGGER leaderboard_rank_delete_fence
  AFTER DELETE ON public.leaderboard_ranks
  REFERENCING OLD TABLE AS old_rank_rows
  FOR EACH STATEMENT EXECUTE FUNCTION arena.bump_leaderboard_rank_delete_fences();
CREATE TRIGGER leaderboard_rank_insert_fence
  AFTER INSERT ON public.leaderboard_ranks
  REFERENCING NEW TABLE AS new_rank_rows
  FOR EACH STATEMENT EXECUTE FUNCTION arena.bump_leaderboard_rank_insert_fences();
CREATE TRIGGER leaderboard_rank_update_fence
  AFTER UPDATE ON public.leaderboard_ranks
  REFERENCING OLD TABLE AS old_rank_rows NEW TABLE AS new_rank_rows
  FOR EACH STATEMENT EXECUTE FUNCTION arena.bump_leaderboard_rank_update_fences();

-- 7. Recreate the dependent view exactly.
CREATE VIEW public.verified_data_authorizations WITH (security_barrier='true') AS
 SELECT DISTINCT a.id AS authorization_id,
    a.platform,
    a.trader_id,
    a.last_sync_at
   FROM ((public.trader_authorizations a
     JOIN arena.sources s ON ((COALESCE((s.meta ->> 'legacy_platform'::text), s.slug) = a.platform)))
     JOIN arena.traders t ON (((t.source_id = s.id) AND (t.exchange_trader_id = a.trader_id))))
  WHERE ((a.status = 'active'::text) AND (a.read_only_verified_at IS NOT NULL) AND (a.last_sync_status = 'success'::text) AND (a.last_sync_at > (now() - '48:00:00'::interval)) AND (( SELECT count(DISTINCT st.timeframe) AS count
           FROM (arena.trader_stats st
             JOIN public.leaderboard_ranks lr ON (((lr.source = a.platform) AND (lr.source_trader_id = a.trader_id) AND (lr.season_id = ((st.timeframe)::text || 'D'::text)) AND (lr.computed_at >= st.as_of))))
          WHERE ((st.trader_id = t.id) AND (st.timeframe = ANY (ARRAY[7, 30, 90])) AND ((st.extras ->> 'provenance'::text) = 'first_party'::text) AND (st.as_of > (now() - '48:00:00'::interval)))) = 3));

ALTER VIEW public.verified_data_authorizations OWNER TO postgres;
REVOKE ALL ON TABLE public.verified_data_authorizations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verified_data_authorizations TO service_role;

DO $postflight$
DECLARE
  v_codec_count integer;
  v_codec_sha256 text;
  v_catalog_sha256 text;
  v_row_count bigint;
BEGIN
  -- The 20260725017000 layout digest.
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            attribute.attname || '|' ||
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
            attribute.attnotnull::text || '|' ||
            attribute.attidentity::text || '|' ||
            attribute.attgenerated::text || '|' ||
            COALESCE(collation_namespace.nspname || '.' || collation_row.collname, '-'),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_codec_count, v_codec_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_collation AS collation_row
    ON collation_row.oid = attribute.attcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  -- The 20260725017500 attnum-bearing column catalog digest.
  SELECT
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              attribute.attnum,
              attribute.attname,
              pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
              attribute.attnotnull,
              attribute.atthasdef,
              COALESCE(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, false), ''),
              attribute.attgenerated,
              attribute.attidentity,
              attribute.atttypmod,
              attribute.attndims,
              attribute.attcollation::pg_catalog.regcollation::text,
              COALESCE(attribute.attoptions::text, ''),
              COALESCE(attribute.attfdwoptions::text, '')
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_catalog_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_codec_count <> 37
     OR v_codec_sha256 IS DISTINCT FROM
          '153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514'
     OR v_catalog_sha256 IS DISTINCT FROM
          'df9746fe0917680970f22309413dd082c54d6cb0c43d0f65250ab3bc21c1406a' THEN
    RAISE EXCEPTION
      'leaderboard_ranks rebuild postflight layout mismatch: %, %, %',
      v_codec_count,
      v_codec_sha256,
      v_catalog_sha256;
  END IF;

  SELECT pg_catalog.count(*) INTO STRICT v_row_count FROM public.leaderboard_ranks;
  IF v_row_count::text IS DISTINCT FROM
       pg_catalog.current_setting('arena.leaderboard_rank_rebuild_rows', true) THEN
    RAISE EXCEPTION 'leaderboard_ranks rebuild changed the row count';
  END IF;

  IF (
       SELECT table_row.relacl::text
       FROM pg_catalog.pg_class AS table_row
       WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) IS DISTINCT FROM
       '{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwd/postgres}'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_inherits AS inheritance
       JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
       WHERE inheritance.inhparent = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND (
           NOT child.relrowsecurity
           OR child.relacl::text IS DISTINCT FROM '{postgres=arwdDxtm/postgres}'
         )
     )
     OR (
       SELECT view_row.relacl::text
       FROM pg_catalog.pg_class AS view_row
       WHERE view_row.oid = 'public.verified_data_authorizations'::pg_catalog.regclass
     ) IS DISTINCT FROM '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'
     OR pg_catalog.to_regprocedure('public.get_diverse_leaderboard(text,integer,integer)') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
             'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'::pg_catalog.regprocedure
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.proacl::text = '{postgres=X/postgres}'
         AND function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
               'hex'
             ) = 'aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df'
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_index AS index_meta
       WHERE index_meta.indrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
     ) <> 7
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
         AND NOT trigger_row.tgisinternal
     ) <> 3 THEN
    RAISE EXCEPTION 'leaderboard_ranks rebuild postflight dependent surface mismatch';
  END IF;
END
$postflight$;

COMMIT;
