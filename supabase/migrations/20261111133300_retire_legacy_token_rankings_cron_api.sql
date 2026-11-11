-- Forward replacement for 20260804043000_retire_legacy_token_rankings.sql
-- (never applied to production). The body is identical except for the
-- $disable_cron$ block: Supabase grants the migration owner only SELECT on
-- cron.job, so the original direct UPDATE fails there. This version
-- deactivates the job through pg_cron's owner-checked cron.alter_job API.
-- Apply it in the original's launch slot; the original is superseded.
--
-- Retire the legacy token-ranking publication surface.
--
-- The current token MVs are derived from public.trader_position_history and
-- carry no frozen rank-eligible authority snapshot. Generation fencing makes
-- those rows internally coherent, but cannot make the input trustworthy.
-- Preserve every callable and relation OID for rolling-deploy safety while
-- making the publication head explicitly unpublished, stopping refresh work,
-- replacing every legacy reader/writer with a fail-closed stub, and removing
-- all non-owner MV access. Reopening requires a later authority-snapshot
-- migration; replay of this retirement only reconverges the same closed state.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260804-retire-legacy-token-rankings', 0)
);

DO $prerequisites$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regclass('arena.token_ranking_publication_head') IS NULL
     OR pg_catalog.to_regclass('public.mv_token_trader_daily_90d') IS NULL
     OR pg_catalog.to_regclass('public.mv_popular_tokens_90d') IS NULL
     OR pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'legacy token-ranking retirement prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.get_token_trader_rankings(text,integer,integer,integer)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.get_popular_tokens(integer,integer)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.get_token_ranking_publication_head()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.get_popular_tokens_v2(integer,integer,bigint)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.refresh_popular_tokens_mv()'
        ) IS NULL THEN
    RAISE EXCEPTION 'legacy token-ranking callable set is incomplete';
  END IF;
END
$prerequisites$;

-- The predecessor refresh takes this row FOR UPDATE before touching either
-- MV. NOWAIT therefore proves there is no publication in flight and holds the
-- same serialization point until all retirement changes commit.
DO $drain_refresh$
BEGIN
  PERFORM 1
  FROM ONLY arena.token_ranking_publication_head AS publication
  WHERE publication.singleton
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token-ranking publication head singleton is missing';
  END IF;
END
$drain_refresh$;

CREATE TEMP TABLE token_ranking_retirement_expected_functions (
  function_oid oid PRIMARY KEY,
  schema_name text NOT NULL,
  function_name text NOT NULL,
  predecessor_body_hash text NOT NULL,
  target_body_hash text NOT NULL,
  predecessor_language text NOT NULL,
  target_language text NOT NULL,
  volatility "char" NOT NULL,
  parallel_safety "char" NOT NULL,
  security_definer boolean NOT NULL,
  returns_set boolean NOT NULL,
  return_type oid NOT NULL,
  argument_defaults smallint NOT NULL,
  argument_names text[],
  function_config text[]
) ON COMMIT DROP;

INSERT INTO pg_temp.token_ranking_retirement_expected_functions (
  function_oid,
  schema_name,
  function_name,
  predecessor_body_hash,
  target_body_hash,
  predecessor_language,
  target_language,
  volatility,
  parallel_safety,
  security_definer,
  returns_set,
  return_type,
  argument_defaults,
  argument_names,
  function_config
) VALUES
  (
    'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)'::pg_catalog.regprocedure,
    'arena',
    'token_trader_ranking_page_payload_v1',
    '531d6e567c5d40f173fda139d595930eb11e6b643ca85af3b690baba1b469222',
    'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e',
    'sql',
    'plpgsql',
    's',
    's',
    false,
    false,
    'pg_catalog.jsonb'::pg_catalog.regtype,
    0,
    ARRAY[
      'p_token_symbol',
      'p_lookback_days',
      'p_max_traders',
      'p_row_offset',
      'p_window_through_date'
    ]::text[],
    ARRAY['search_path=pg_catalog, pg_temp', 'TimeZone=UTC']::text[]
  ),
  (
    'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure,
    'public',
    'get_token_trader_rankings',
    '2c04bf68408f89695eff963312fb5407d3d1095c7708d987cee06dd4308c9e65',
    'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e',
    'sql',
    'plpgsql',
    's',
    'u',
    true,
    true,
    'pg_catalog.record'::pg_catalog.regtype,
    3,
    ARRAY[
      'token_symbol', 'lookback_days', 'max_traders', 'row_offset',
      'source', 'source_trader_id', 'token_rank', 'token_pnl',
      'token_trade_count', 'token_win_rate', 'token_avg_pnl_pct',
      'total_count'
    ]::text[],
    ARRAY['search_path=pg_catalog, pg_temp', 'TimeZone=UTC']::text[]
  ),
  (
    'public.get_popular_tokens(integer,integer)'::pg_catalog.regprocedure,
    'public',
    'get_popular_tokens',
    '57d5e4bea3513f1f4708c757eb01d83a09118a0e815b277983c932b4ec0d783e',
    'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e',
    'sql',
    'plpgsql',
    's',
    'u',
    false,
    true,
    'pg_catalog.record'::pg_catalog.regtype,
    2,
    ARRAY[
      'lookback_days', 'max_tokens', 'token', 'trade_count',
      'trader_count', 'total_pnl'
    ]::text[],
    ARRAY['search_path=public']::text[]
  ),
  (
    'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure,
    'public',
    'get_token_ranking_publication_head',
    '95e5faadb55be164014870f19a848dfeb7b7d10b33261568acdae94f38c0f7cf',
    'b24f3284f48fda1a79c0f3aff2027b00c7bc51c1669d49dcfc6667a9c84b55b0',
    'sql',
    'sql',
    's',
    'u',
    true,
    true,
    'pg_catalog.record'::pg_catalog.regtype,
    0,
    ARRAY[
      'generation_seq', 'published_at', 'published_at_epoch_ms',
      'window_through_date', 'source_as_of', 'source_through_date',
      'daily_row_count', 'popular_row_count'
    ]::text[],
    ARRAY['search_path=pg_catalog, pg_temp', 'TimeZone=UTC']::text[]
  ),
  (
    'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure,
    'public',
    'get_token_trader_rankings_v2',
    '51cb3103a603ae285e620cf59818a363c7d175c77eae28495a9d69aa15cd0f06',
    'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e',
    'plpgsql',
    'plpgsql',
    's',
    'u',
    true,
    false,
    'pg_catalog.jsonb'::pg_catalog.regtype,
    0,
    ARRAY[
      'token_symbol', 'lookback_days', 'max_traders', 'row_offset',
      'expected_generation'
    ]::text[],
    ARRAY['search_path=pg_catalog, pg_temp', 'TimeZone=UTC']::text[]
  ),
  (
    'public.get_popular_tokens_v2(integer,integer,bigint)'::pg_catalog.regprocedure,
    'public',
    'get_popular_tokens_v2',
    'dc03334d8871a13be430de004a2f72adec3ccaeb6a7872ea294c3b369a9254ff',
    'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e',
    'plpgsql',
    'plpgsql',
    's',
    'u',
    true,
    false,
    'pg_catalog.jsonb'::pg_catalog.regtype,
    0,
    ARRAY['lookback_days', 'max_tokens', 'expected_generation']::text[],
    ARRAY['search_path=pg_catalog, pg_temp', 'TimeZone=UTC']::text[]
  ),
  (
    'public.refresh_popular_tokens_mv()'::pg_catalog.regprocedure,
    'public',
    'refresh_popular_tokens_mv',
    'bed3694b0b91b860da8aaa2d0fcf94fbe3ca19489e6fed0fcbae4f08f02a5108',
    '75fe59844b765986a8d631a16cfc14efae8b55ad5afd3906ca616e94253de6f0',
    'plpgsql',
    'plpgsql',
    'v',
    'u',
    true,
    false,
    'pg_catalog.void'::pg_catalog.regtype,
    0,
    NULL::text[],
    ARRAY[
      'search_path=pg_catalog, pg_temp',
      'TimeZone=UTC',
      'lock_timeout=10s'
    ]::text[]
  );

DO $preflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM pg_temp.token_ranking_retirement_expected_functions
     ) <> 7
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('arena', 'token_trader_ranking_page_payload_v1'),
           ('public', 'get_token_trader_rankings'),
           ('public', 'get_popular_tokens'),
           ('public', 'get_token_ranking_publication_head'),
           ('public', 'get_token_trader_rankings_v2'),
           ('public', 'get_popular_tokens_v2'),
           ('public', 'refresh_popular_tokens_mv')
       ) AS expected_name(schema_name, function_name)
       WHERE (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS function_row
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = function_row.pronamespace
         WHERE namespace_row.nspname = expected_name.schema_name
           AND function_row.proname = expected_name.function_name
       ) <> 1
     ) THEN
    RAISE EXCEPTION 'legacy token-ranking overload set is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.token_ranking_retirement_expected_functions AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR function_row.proleakproof
       OR function_row.proisstrict
       OR function_row.provolatile <> expected.volatility
       OR function_row.proparallel <> expected.parallel_safety
       OR function_row.prosecdef <> expected.security_definer
       OR function_row.proretset <> expected.returns_set
       OR function_row.prorettype <> expected.return_type
       OR function_row.pronargdefaults <> expected.argument_defaults
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR function_row.proconfig IS DISTINCT FROM expected.function_config
       OR NOT (
         (
           language_row.lanname = expected.predecessor_language
           AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(function_row.prosrc, 'UTF8')
             ),
             'hex'
           ) = expected.predecessor_body_hash
         )
         OR (
           language_row.lanname = expected.target_language
           AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(function_row.prosrc, 'UTF8')
             ),
             'hex'
           ) = expected.target_body_hash
         )
       )
  ) THEN
    RAISE EXCEPTION 'legacy token-ranking callable metadata or body drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('service_role'::pg_catalog.regrole),
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS application_role(role_oid)
    CROSS JOIN pg_catalog.pg_roles AS privileged_role
    WHERE (
        privileged_role.rolsuper
        OR privileged_role.oid = 'postgres'::pg_catalog.regrole
      )
      AND pg_catalog.pg_has_role(
        application_role.role_oid,
        privileged_role.oid,
        'MEMBER'
      )
  ) THEN
    RAISE EXCEPTION 'application role can assume a superuser or owner role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS public_role(role_oid)
    WHERE pg_catalog.pg_has_role(
      public_role.role_oid,
      'service_role'::pg_catalog.regrole,
      'MEMBER'
    )
  ) THEN
    RAISE EXCEPTION 'public application role can assume service_role';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation_row
       WHERE relation_row.oid =
             'arena.token_ranking_publication_head'::pg_catalog.regclass
         AND relation_row.relkind = 'r'
         AND relation_row.relowner = 'postgres'::pg_catalog.regrole
         AND relation_row.relrowsecurity
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM ONLY arena.token_ranking_publication_head
       WHERE singleton
     ) <> 1
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('public.mv_token_trader_daily_90d'::pg_catalog.regclass),
           ('public.mv_popular_tokens_90d'::pg_catalog.regclass)
       ) AS expected_relation(relation_oid)
       LEFT JOIN pg_catalog.pg_class AS relation_row
         ON relation_row.oid = expected_relation.relation_oid
       WHERE relation_row.oid IS NULL
          OR relation_row.relkind <> 'm'
          OR relation_row.relowner <> 'postgres'::pg_catalog.regrole
          OR NOT relation_row.relispopulated
     ) THEN
    RAISE EXCEPTION 'legacy token-ranking relation authority drifted';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM cron.job AS job
       WHERE job.jobname = 'refresh-mv-popular-tokens'
         AND job.database = pg_catalog.current_database()
         AND job.username = 'postgres'
         AND job.schedule = '*/30 * * * *'
         AND job.command =
             'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();'
         AND job.active IN (true, false)
     ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM cron.job AS job
       WHERE job.jobname = 'refresh-mv-popular-tokens'
     ) <> 1 THEN
    RAISE EXCEPTION 'legacy token-ranking cron identity drifted';
  END IF;
END
$preflight$;

CREATE TEMP TABLE token_ranking_retirement_function_oids
ON COMMIT DROP
AS
SELECT expected.function_oid
FROM pg_temp.token_ranking_retirement_expected_functions AS expected;

CREATE TEMP TABLE token_ranking_retirement_relation_snapshot
ON COMMIT DROP
AS
SELECT
  relation_row.oid,
  relation_row.relname,
  relation_row.relkind,
  relation_row.relowner,
  relation_row.relispopulated,
  pg_catalog.pg_get_viewdef(relation_row.oid, false) AS view_definition
FROM pg_catalog.pg_class AS relation_row
WHERE relation_row.oid IN (
  'public.mv_token_trader_daily_90d'::pg_catalog.regclass,
  'public.mv_popular_tokens_90d'::pg_catalog.regclass
);

CREATE TEMP TABLE token_ranking_retirement_cron_snapshot
ON COMMIT DROP
AS
SELECT
  job.jobid,
  job.jobname,
  job.schedule,
  job.command,
  job.database,
  job.username
FROM cron.job AS job
WHERE job.jobname = 'refresh-mv-popular-tokens';

DO $snapshot_preflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM pg_temp.token_ranking_retirement_function_oids
     ) <> 7
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_temp.token_ranking_retirement_relation_snapshot
     ) <> 2
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_temp.token_ranking_retirement_cron_snapshot
     ) <> 1 THEN
    RAISE EXCEPTION 'legacy token-ranking dependency snapshot is incomplete';
  END IF;
END
$snapshot_preflight$;

UPDATE ONLY arena.token_ranking_publication_head AS publication
SET
  generation_seq = 0,
  published_at = NULL,
  window_through_date = NULL,
  source_as_of = NULL,
  source_through_date = NULL,
  daily_row_count = 0,
  popular_row_count = 0
WHERE publication.singleton;

-- Supabase grants the migration owner only SELECT on cron.job, so the job is
-- deactivated through pg_cron's owner-checked cron.alter_job API.
DO $disable_cron$
DECLARE
  v_job_ids bigint[];
BEGIN
  SELECT pg_catalog.array_agg(job.jobid ORDER BY job.jobid)
  INTO v_job_ids
  FROM cron.job AS job
  WHERE job.jobname = 'refresh-mv-popular-tokens'
    AND job.database = pg_catalog.current_database()
    AND job.username = 'postgres'
    AND job.schedule = '*/30 * * * *'
    AND job.command =
        'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();';

  IF COALESCE(pg_catalog.cardinality(v_job_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'legacy token-ranking cron retirement failed';
  END IF;

  PERFORM cron.alter_job(job_id := v_job_ids[1], active := false);

  IF EXISTS (
    SELECT 1
    FROM cron.job AS job
    WHERE job.jobid = v_job_ids[1]
      AND job.active
  ) THEN
    RAISE EXCEPTION 'legacy token-ranking cron retirement failed';
  END IF;
END
$disable_cron$;

CREATE OR REPLACE FUNCTION arena.token_trader_ranking_page_payload_v1(
  p_token_symbol text,
  p_lookback_days integer,
  p_max_traders integer,
  p_row_offset integer,
  p_window_through_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy token rankings are retired; authority snapshot required'
    USING ERRCODE = '55000';
END
$function$;

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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy token rankings are retired; authority snapshot required'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION public.get_popular_tokens(
  lookback_days integer DEFAULT 90,
  max_tokens integer DEFAULT 50
)
RETURNS TABLE(
  token text,
  trade_count bigint,
  trader_count bigint,
  total_pnl numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy token rankings are retired; authority snapshot required'
    USING ERRCODE = '55000';
END
$function$;

-- Preserve the existing return shape for old application builds. Its one row
-- is now a constant unpublished barrier and does not consult legacy state.
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
    0::bigint,
    NULL::timestamp with time zone,
    NULL::bigint,
    NULL::date,
    NULL::timestamp with time zone,
    NULL::date,
    0::bigint,
    0::bigint;
$function$;

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
BEGIN
  RAISE EXCEPTION
    'legacy token rankings are retired; authority snapshot required'
    USING ERRCODE = '55000';
END
$function$;

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
BEGIN
  RAISE EXCEPTION
    'legacy token rankings are retired; authority snapshot required'
    USING ERRCODE = '55000';
END
$function$;

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
BEGIN
  RAISE EXCEPTION
    'legacy token ranking refresh is retired; authority snapshot publisher required'
    USING ERRCODE = '55000';
END
$function$;

-- Collapse PUBLIC, direct, group-role, and delegated EXECUTE grants. The head
-- getter is re-opened only to service_role so rolling application builds see
-- generation zero before attempting any generation-keyed cache read.
DO $normalize_function_acls$
DECLARE
  v_function record;
  v_grantee oid;
  v_grantee_name text;
BEGIN
  FOR v_function IN
    SELECT
      function_row.oid,
      namespace_row.nspname,
      function_row.proname,
      pg_catalog.pg_get_function_identity_arguments(function_row.oid) AS arguments
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    JOIN pg_temp.token_ranking_retirement_function_oids AS expected
      ON expected.function_oid = function_row.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC CASCADE',
      v_function.nspname,
      v_function.proname,
      v_function.arguments
    );

    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      WHERE function_row.oid = v_function.oid
        AND privilege.grantee <> 0
        AND privilege.grantee <> function_row.proowner
    LOOP
      SELECT role_row.rolname
      INTO STRICT v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I CASCADE',
        v_function.nspname,
        v_function.proname,
        v_function.arguments,
        v_grantee_name
      );
    END LOOP;
  END LOOP;
END
$normalize_function_acls$;

GRANT EXECUTE ON FUNCTION public.get_token_ranking_publication_head()
  TO service_role;

-- Relation-level REVOKE does not remove column-level SELECT grants. Normalize
-- both ACL layers so no unknown role or delegated group can read either MV.
DO $normalize_mv_acls$
DECLARE
  v_relation record;
  v_grantee oid;
  v_grantee_name text;
  v_column record;
BEGIN
  FOR v_relation IN
    SELECT relation_row.oid, namespace_row.nspname, relation_row.relname
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.oid IN (
      'public.mv_token_trader_daily_90d'::pg_catalog.regclass,
      'public.mv_popular_tokens_90d'::pg_catalog.regclass
    )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
      v_relation.nspname,
      v_relation.relname
    );

    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee
      FROM pg_catalog.pg_class AS relation_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation_row.relacl,
          pg_catalog.acldefault('r', relation_row.relowner)
        )
      ) AS privilege
      WHERE relation_row.oid = v_relation.oid
        AND privilege.grantee <> 0
        AND privilege.grantee <> relation_row.relowner
    LOOP
      SELECT role_row.rolname
      INTO STRICT v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I CASCADE',
        v_relation.nspname,
        v_relation.relname,
        v_grantee_name
      );
    END LOOP;

    FOR v_column IN
      SELECT
        attribute_row.attname,
        privilege.grantee,
        privilege.privilege_type
      FROM pg_catalog.pg_attribute AS attribute_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS privilege
      WHERE attribute_row.attrelid = v_relation.oid
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
        AND attribute_row.attacl IS NOT NULL
        AND privilege.grantee <> 0
        AND privilege.grantee <>
            (SELECT relation_row.relowner
             FROM pg_catalog.pg_class AS relation_row
             WHERE relation_row.oid = v_relation.oid)
    LOOP
      SELECT role_row.rolname
      INTO STRICT v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_column.grantee;

      EXECUTE pg_catalog.format(
        'REVOKE %s (%I) ON TABLE %I.%I FROM %I CASCADE',
        v_column.privilege_type,
        v_column.attname,
        v_relation.nspname,
        v_relation.relname,
        v_grantee_name
      );
    END LOOP;
  END LOOP;
END
$normalize_mv_acls$;

COMMENT ON FUNCTION public.get_token_ranking_publication_head() IS
  'Retired token-ranking publication barrier. Generation zero is constant until a frozen authority snapshot is published by a later reviewed contract.';
COMMENT ON FUNCTION public.refresh_popular_tokens_mv() IS
  'Retired legacy token-MV refresh. public.trader_position_history is not token ranking authority.';

DO $postflight$
DECLARE
  v_head pg_catalog.regprocedure :=
    'public.get_token_ranking_publication_head()'::pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.token_ranking_retirement_expected_functions AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR function_row.proleakproof
       OR function_row.proisstrict
       OR function_row.provolatile <> expected.volatility
       OR function_row.proparallel <> expected.parallel_safety
       OR function_row.prosecdef <> expected.security_definer
       OR function_row.proretset <> expected.returns_set
       OR function_row.prorettype <> expected.return_type
       OR function_row.pronargdefaults <> expected.argument_defaults
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR function_row.proconfig IS DISTINCT FROM expected.function_config
       OR language_row.lanname <> expected.target_language
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) <> expected.target_body_hash
       OR pg_catalog.strpos(function_row.prosrc, 'mv_token_trader_daily_90d') <> 0
       OR pg_catalog.strpos(function_row.prosrc, 'mv_popular_tokens_90d') <> 0
       OR pg_catalog.strpos(function_row.prosrc, 'trader_position_history') <> 0
  ) THEN
    RAISE EXCEPTION 'legacy token-ranking callable retirement postflight failed';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('arena', 'token_trader_ranking_page_payload_v1'),
           ('public', 'get_token_trader_rankings'),
           ('public', 'get_popular_tokens'),
           ('public', 'get_token_ranking_publication_head'),
           ('public', 'get_token_trader_rankings_v2'),
           ('public', 'get_popular_tokens_v2'),
           ('public', 'refresh_popular_tokens_mv')
       ) AS expected_name(schema_name, function_name)
       WHERE (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS function_row
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = function_row.pronamespace
         WHERE namespace_row.nspname = expected_name.schema_name
           AND function_row.proname = expected_name.function_name
       ) <> 1
     )
     OR EXISTS (
       SELECT 1
       FROM pg_temp.token_ranking_retirement_function_oids AS expected
       JOIN pg_catalog.pg_proc AS function_row
         ON function_row.oid = expected.function_oid
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE privilege.grantee <> function_row.proowner
         AND NOT (
           function_row.oid = v_head
           AND privilege.grantee = 'service_role'::pg_catalog.regrole
           AND privilege.grantor = function_row.proowner
           AND privilege.privilege_type = 'EXECUTE'
           AND NOT privilege.is_grantable
         )
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_head
         AND privilege.grantee = 'service_role'::pg_catalog.regrole
         AND privilege.grantor = function_row.proowner
         AND privilege.privilege_type = 'EXECUTE'
         AND NOT privilege.is_grantable
     ) <> 1 THEN
    RAISE EXCEPTION 'legacy token-ranking function ACL postflight failed';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation_row.relacl,
           pg_catalog.acldefault('r', relation_row.relowner)
         )
       ) AS privilege
       WHERE relation_row.oid IN (
         'public.mv_token_trader_daily_90d'::pg_catalog.regclass,
         'public.mv_popular_tokens_90d'::pg_catalog.regclass
       )
         AND privilege.grantee <> relation_row.relowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS privilege
       JOIN pg_catalog.pg_class AS relation_row
         ON relation_row.oid = attribute_row.attrelid
       WHERE attribute_row.attrelid IN (
         'public.mv_token_trader_daily_90d'::pg_catalog.regclass,
         'public.mv_popular_tokens_90d'::pg_catalog.regclass
       )
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
         AND attribute_row.attacl IS NOT NULL
         AND privilege.grantee <> relation_row.relowner
     ) THEN
    RAISE EXCEPTION 'legacy token-ranking MV ACL postflight failed';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_temp.token_ranking_retirement_relation_snapshot AS snapshot
       LEFT JOIN pg_catalog.pg_class AS relation_row
         ON relation_row.oid = snapshot.oid
       WHERE relation_row.oid IS NULL
          OR relation_row.relname IS DISTINCT FROM snapshot.relname
          OR relation_row.relkind IS DISTINCT FROM snapshot.relkind
          OR relation_row.relowner IS DISTINCT FROM snapshot.relowner
          OR relation_row.relispopulated IS DISTINCT FROM snapshot.relispopulated
          OR pg_catalog.pg_get_viewdef(relation_row.oid, false)
             IS DISTINCT FROM snapshot.view_definition
     )
     OR EXISTS (
       SELECT 1
       FROM pg_temp.token_ranking_retirement_cron_snapshot AS snapshot
       LEFT JOIN cron.job AS job
         ON job.jobid = snapshot.jobid
       WHERE job.jobid IS NULL
          OR job.jobname IS DISTINCT FROM snapshot.jobname
          OR job.schedule IS DISTINCT FROM snapshot.schedule
          OR job.command IS DISTINCT FROM snapshot.command
          OR job.database IS DISTINCT FROM snapshot.database
          OR job.username IS DISTINCT FROM snapshot.username
          OR job.active
     ) THEN
    RAISE EXCEPTION 'legacy token-ranking dependency identity postflight failed';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM ONLY arena.token_ranking_publication_head AS publication
       WHERE publication.singleton
         AND publication.generation_seq = 0
         AND publication.published_at IS NULL
         AND publication.window_through_date IS NULL
         AND publication.source_as_of IS NULL
         AND publication.source_through_date IS NULL
         AND publication.daily_row_count = 0
         AND publication.popular_row_count = 0
     ) <> 1
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_head, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_head, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_head, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('service_role'::pg_catalog.regrole),
           ('anon'::pg_catalog.regrole),
           ('authenticated'::pg_catalog.regrole)
       ) AS application_role(role_oid)
       CROSS JOIN pg_catalog.pg_roles AS privileged_role
       WHERE (
           privileged_role.rolsuper
           OR privileged_role.oid = 'postgres'::pg_catalog.regrole
         )
         AND pg_catalog.pg_has_role(
           application_role.role_oid,
           privileged_role.oid,
           'MEMBER'
         )
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('anon'::pg_catalog.regrole),
           ('authenticated'::pg_catalog.regrole)
       ) AS public_role(role_oid)
       WHERE pg_catalog.pg_has_role(
         public_role.role_oid,
         'service_role'::pg_catalog.regrole,
         'MEMBER'
       )
     ) THEN
    RAISE EXCEPTION 'legacy token-ranking unpublished barrier postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
