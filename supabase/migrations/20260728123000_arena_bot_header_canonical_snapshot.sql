-- Migration: 20260728123000_arena_bot_header_canonical_snapshot.sql
-- Created: 2026-07-28T12:30:00Z
-- Description: Make the public Bitget bot header a current board reader.
--   Identity and metadata come from the latest passed, non-derived canonical
--   30D snapshot membership and arena.traders.meta.bot. The retired duplicate
--   projection is not an authority for membership, metadata, or owner links.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_exact_sources integer;
  v_relation text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'arena.exchanges',
    'arena.sources',
    'arena.leaderboard_snapshots',
    'arena.leaderboard_entries',
    'arena.traders'
  ]::text[] LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'arena_bot_header foundation is missing: %', v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('public.arena_bot_header(text,text)') IS NULL THEN
    RAISE EXCEPTION 'existing public.arena_bot_header(text,text) contract is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'arena_bot_header execution roles are missing';
  END IF;

  -- Enforce migration order: the immediately preceding canonical-timeframe
  -- migration must already have converged both reviewed sources to exact 30D.
  SELECT pg_catalog.count(*)::integer
    INTO v_exact_sources
    FROM (
      VALUES
        ('bitget_bots_futures'::text, 'futures'::text),
        ('bitget_bots_spot'::text, 'spot'::text)
    ) AS target(slug, product_type)
    JOIN arena.sources AS source
      ON source.slug = target.slug
     AND source.product_type = target.product_type
    JOIN arena.exchanges AS exchange
      ON exchange.id = source.exchange_id
   WHERE exchange.slug = 'bitget'
     AND source.adapter_slug = 'bitget_bots'
     AND source.trader_kind_scope = 'bot'
     AND source.status = 'active'
     AND source.serving_mode = 'serving'
     AND source.currency = 'USDT'
     AND source.timeframes_native = ARRAY[30]::integer[]
     AND source.timeframes_derived = ARRAY[]::integer[]
     AND source.page_size = 20
     AND source.pagination_kind = 'numeric'
     AND source.meta->'boards' = CASE target.slug
       WHEN 'bitget_bots_futures' THEN
         '["futures_grid", "futures_martingale"]'::jsonb
       ELSE '["spot_grid", "spot_martingale"]'::jsonb
     END
     AND source.cadence_tier_a > interval '0 seconds'
     AND source.cadence_tier_a <= interval '7 days';

  IF v_exact_sources <> 2 THEN
    RAISE EXCEPTION
      'arena_bot_header requires two exact active serving Bitget bot 30D sources';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_bot_header(
  p_source text,
  p_trader_key text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH requested AS MATERIALIZED (
    SELECT
      p_source AS source_slug,
      p_trader_key AS trader_key
    WHERE p_source IS NOT NULL
      AND p_source = pg_catalog.btrim(p_source)
      AND pg_catalog.octet_length(p_source) BETWEEN 1 AND 128
      AND p_source ~ '^[a-z0-9_]+$'
      AND p_trader_key IS NOT NULL
      AND p_trader_key = pg_catalog.btrim(p_trader_key)
      AND pg_catalog.octet_length(p_trader_key) BETWEEN 1 AND 512
      AND p_trader_key !~ '[[:cntrl:]]'
  ),
  canonical_source AS MATERIALIZED (
    SELECT
      source.id AS source_id,
      source.exchange_id,
      source.slug AS source_slug,
      source.product_type,
      source.cadence_tier_a
    FROM requested
    JOIN arena.sources AS source
      ON source.slug = requested.source_slug
    JOIN arena.exchanges AS exchange
      ON exchange.id = source.exchange_id
    WHERE source.slug IN ('bitget_bots_futures', 'bitget_bots_spot')
      AND exchange.slug = 'bitget'
      AND source.adapter_slug = 'bitget_bots'
      AND source.trader_kind_scope = 'bot'
      AND source.status = 'active'
      AND source.serving_mode = 'serving'
      AND source.currency = 'USDT'
      AND source.timeframes_native = ARRAY[30]::integer[]
      AND source.timeframes_derived = ARRAY[]::integer[]
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.meta->'boards' = CASE source.slug
        WHEN 'bitget_bots_futures' THEN
          '["futures_grid", "futures_martingale"]'::jsonb
        ELSE '["spot_grid", "spot_martingale"]'::jsonb
      END
      AND source.cadence_tier_a > interval '0 seconds'
      AND source.cadence_tier_a <= interval '7 days'
      AND (
        (source.slug = 'bitget_bots_futures' AND source.product_type = 'futures')
        OR
        (source.slug = 'bitget_bots_spot' AND source.product_type = 'spot')
      )
  ),
  latest_passed_canonical_snapshot AS MATERIALIZED (
    SELECT
      source.source_id,
      source.exchange_id,
      source.source_slug,
      source.product_type,
      source.cadence_tier_a,
      snapshot.id AS snapshot_id,
      snapshot.scraped_at AS snapshot_as_of
    FROM canonical_source AS source
    CROSS JOIN LATERAL (
      SELECT
        candidate.id,
        candidate.scraped_at,
        candidate.actual_count
      FROM arena.leaderboard_snapshots AS candidate
      WHERE candidate.source_id = source.source_id
        AND candidate.timeframe = 30
        AND candidate.count_check_passed
        AND NOT candidate.is_derived
      ORDER BY candidate.scraped_at DESC, candidate.id DESC
      LIMIT 1
    ) AS snapshot
    WHERE snapshot.actual_count > 0
      AND snapshot.scraped_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
      AND snapshot.actual_count = (
        SELECT pg_catalog.count(*)::integer
        FROM arena.leaderboard_entries AS population
        WHERE population.snapshot_id = snapshot.id
          AND population.scraped_at = snapshot.scraped_at
          AND population.timeframe = 30
      )
  ),
  current_bot_membership AS MATERIALIZED (
    SELECT
      latest.source_id,
      latest.exchange_id,
      latest.source_slug,
      latest.product_type,
      latest.cadence_tier_a,
      latest.snapshot_id,
      latest.snapshot_as_of,
      trader.exchange_trader_id,
      trader.bot_strategy AS trader_bot_strategy,
      trader.meta->'bot' AS bot_document
    FROM latest_passed_canonical_snapshot AS latest
    JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = latest.snapshot_id
     AND entry.scraped_at = latest.snapshot_as_of
     AND entry.timeframe = 30
    JOIN arena.traders AS trader
      ON trader.id = entry.trader_id
     AND trader.source_id = latest.source_id
    JOIN requested
      ON requested.source_slug = latest.source_slug
     AND requested.trader_key = trader.exchange_trader_id
    WHERE trader.trader_kind = 'bot'
      AND pg_catalog.jsonb_typeof(trader.meta) = 'object'
      AND pg_catalog.jsonb_typeof(trader.meta->'bot') = 'object'
  ),
  validated_bot_identity AS MATERIALIZED (
    SELECT membership.*
    FROM current_bot_membership AS membership
    WHERE membership.bot_document ?& ARRAY[
            'exchange_bot_id',
            'product_id',
            'owner_account_id',
            'owner_name',
            'pair',
            'product_type',
            'strategy',
            'direction',
            'created_at_origin',
            'runtime_days',
            'profit_share_rate',
            'status'
          ]::text[]
      AND (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(membership.bot_document)
      ) = 12
      AND pg_catalog.jsonb_typeof(membership.bot_document->'exchange_bot_id') = 'string'
      AND membership.bot_document->>'exchange_bot_id' = membership.exchange_trader_id
      AND membership.bot_document->>'exchange_bot_id' =
          pg_catalog.btrim(membership.bot_document->>'exchange_bot_id')
      AND pg_catalog.octet_length(membership.bot_document->>'exchange_bot_id')
          BETWEEN 1 AND 512
      AND membership.bot_document->>'exchange_bot_id' !~ '[[:cntrl:]]'
      AND membership.bot_document->>'exchange_bot_id' ~ '^[0-9]+$'
      AND pg_catalog.jsonb_typeof(membership.bot_document->'product_type') = 'string'
      AND membership.bot_document->>'product_type' = membership.product_type
      AND pg_catalog.jsonb_typeof(membership.bot_document->'strategy') = 'string'
      AND membership.bot_document->>'strategy' IN ('grid', 'martingale')
      AND membership.bot_document->>'strategy' = membership.trader_bot_strategy
      AND pg_catalog.jsonb_typeof(membership.bot_document->'pair') = 'string'
      AND membership.bot_document->>'pair' =
          pg_catalog.btrim(membership.bot_document->>'pair')
      AND pg_catalog.octet_length(membership.bot_document->>'pair') BETWEEN 1 AND 64
      AND membership.bot_document->>'pair' !~ '[[:cntrl:]]'
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'product_id') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'product_id') = 'string'
          AND membership.bot_document->>'product_id' ~ '^[0-9]+$'
          AND pg_catalog.octet_length(membership.bot_document->>'product_id')
              BETWEEN 1 AND 512
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'direction') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'direction') = 'string'
          AND membership.bot_document->>'direction' IN ('long', 'short')
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'runtime_days') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'runtime_days') = 'number'
          AND membership.bot_document->>'runtime_days' ~ '^(0|[1-9][0-9]{0,8})$'
          AND (membership.bot_document->>'runtime_days')::numeric <= 365000
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'profit_share_rate') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'profit_share_rate') = 'number'
          AND membership.bot_document->>'profit_share_rate' ~
              '^(0|[1-9][0-9]{0,2})([.][0-9]+)?$'
          AND (membership.bot_document->>'profit_share_rate')::numeric BETWEEN 0 AND 100
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'created_at_origin') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'created_at_origin') = 'string'
          AND membership.bot_document->>'created_at_origin' ~
              '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'status') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'status') = 'string'
          AND membership.bot_document->>'status' =
              pg_catalog.btrim(membership.bot_document->>'status')
          AND pg_catalog.octet_length(membership.bot_document->>'status') BETWEEN 1 AND 64
          AND membership.bot_document->>'status' !~ '[[:cntrl:]]'
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'owner_account_id') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'owner_account_id') = 'string'
          AND membership.bot_document->>'owner_account_id' =
              pg_catalog.btrim(membership.bot_document->>'owner_account_id')
          AND pg_catalog.octet_length(membership.bot_document->>'owner_account_id')
              BETWEEN 1 AND 256
          AND membership.bot_document->>'owner_account_id' !~ '[[:cntrl:]]'
        )
      )
      AND (
        pg_catalog.jsonb_typeof(membership.bot_document->'owner_name') = 'null'
        OR (
          pg_catalog.jsonb_typeof(membership.bot_document->'owner_name') = 'string'
          AND membership.bot_document->>'owner_name' =
              pg_catalog.btrim(membership.bot_document->>'owner_name')
          AND pg_catalog.octet_length(membership.bot_document->>'owner_name') BETWEEN 1 AND 256
          AND membership.bot_document->>'owner_name' !~ '[[:cntrl:]]'
        )
      )
  ),
  parsed_bot_fields AS MATERIALIZED (
    SELECT
      identity.*,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'pair') = 'string'
         AND identity.bot_document->>'pair' =
             pg_catalog.btrim(identity.bot_document->>'pair')
         AND pg_catalog.octet_length(identity.bot_document->>'pair') BETWEEN 1 AND 64
         AND identity.bot_document->>'pair' !~ '[[:cntrl:]]'
        THEN identity.bot_document->>'pair'
      END AS pair,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'direction') = 'string'
         AND identity.bot_document->>'direction' =
             pg_catalog.btrim(identity.bot_document->>'direction')
         AND pg_catalog.octet_length(identity.bot_document->>'direction') BETWEEN 1 AND 32
         AND identity.bot_document->>'direction' !~ '[[:cntrl:]]'
        THEN identity.bot_document->>'direction'
      END AS direction,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'runtime_days') = 'number'
         AND identity.bot_document->>'runtime_days' ~ '^(0|[1-9][0-9]{0,8})$'
         AND (identity.bot_document->>'runtime_days')::numeric <= 365000
        THEN (identity.bot_document->>'runtime_days')::integer
      END AS runtime_days,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'profit_share_rate') = 'number'
         AND identity.bot_document->>'profit_share_rate' ~
             '^(0|[1-9][0-9]{0,2})([.][0-9]+)?$'
         AND (identity.bot_document->>'profit_share_rate')::numeric BETWEEN 0 AND 100
        THEN (identity.bot_document->>'profit_share_rate')::numeric
      END AS profit_share_rate,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'created_at_origin') = 'string'
         AND identity.bot_document->>'created_at_origin' ~
             '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
        THEN identity.bot_document->>'created_at_origin'
      END AS created_at_origin,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'status') = 'string'
         AND identity.bot_document->>'status' =
             pg_catalog.btrim(identity.bot_document->>'status')
         AND pg_catalog.octet_length(identity.bot_document->>'status') BETWEEN 1 AND 64
         AND identity.bot_document->>'status' !~ '[[:cntrl:]]'
        THEN identity.bot_document->>'status'
      END AS bot_status,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'owner_account_id') = 'string'
         AND identity.bot_document->>'owner_account_id' =
             pg_catalog.btrim(identity.bot_document->>'owner_account_id')
         AND pg_catalog.octet_length(identity.bot_document->>'owner_account_id')
             BETWEEN 1 AND 256
         AND identity.bot_document->>'owner_account_id' !~ '[[:cntrl:]]'
        THEN identity.bot_document->>'owner_account_id'
      END AS owner_account_id,
      CASE
        WHEN pg_catalog.jsonb_typeof(identity.bot_document->'owner_name') = 'string'
         AND identity.bot_document->>'owner_name' =
             pg_catalog.btrim(identity.bot_document->>'owner_name')
         AND pg_catalog.octet_length(identity.bot_document->>'owner_name') BETWEEN 1 AND 256
         AND identity.bot_document->>'owner_name' !~ '[[:cntrl:]]'
        THEN identity.bot_document->>'owner_name'
      END AS owner_name
    FROM validated_bot_identity AS identity
  )
  SELECT pg_catalog.jsonb_build_object(
    'bot_id', bot.exchange_trader_id,
    'pair', bot.pair,
    'product_type', bot.product_type,
    'bot_strategy', bot.trader_bot_strategy,
    'direction', bot.direction,
    'runtime_days', bot.runtime_days,
    'profit_share_rate', bot.profit_share_rate,
    'created_at_origin', bot.created_at_origin,
    'status', bot.bot_status,
    'owner_nickname', COALESCE(
      CASE
        WHEN owner.nickname IS NOT NULL
         AND owner.nickname = pg_catalog.btrim(owner.nickname)
         AND pg_catalog.octet_length(owner.nickname) BETWEEN 1 AND 256
         AND owner.nickname !~ '[[:cntrl:]]'
        THEN owner.nickname
      END,
      bot.owner_name
    ),
    'owner_trader_key', owner.exchange_trader_id,
    'owner_platform', CASE
      WHEN pg_catalog.jsonb_typeof(owner.source_meta->'legacy_platform') = 'string'
       AND owner.source_meta->>'legacy_platform' =
           pg_catalog.btrim(owner.source_meta->>'legacy_platform')
       AND owner.source_meta->>'legacy_platform' <> 'null'
       AND pg_catalog.octet_length(owner.source_meta->>'legacy_platform') BETWEEN 1 AND 128
       AND owner.source_meta->>'legacy_platform' !~ '[[:cntrl:]]'
      THEN owner.source_meta->>'legacy_platform'
      ELSE owner.source_slug
    END,
    'canonical_timeframe', 30,
    'snapshot_as_of', pg_catalog.to_char(
      bot.snapshot_as_of AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'fresh_until', pg_catalog.to_char(
      (bot.snapshot_as_of + bot.cadence_tier_a) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'is_current', true,
    'is_fresh', bot.snapshot_as_of + bot.cadence_tier_a >=
                pg_catalog.statement_timestamp(),
    'freshness', CASE
      WHEN bot.snapshot_as_of + bot.cadence_tier_a >=
           pg_catalog.statement_timestamp()
      THEN 'fresh'
      ELSE 'stale'
    END
  )
  FROM parsed_bot_fields AS bot
  LEFT JOIN LATERAL (
    SELECT
      owner_trader.exchange_trader_id,
      owner_trader.nickname,
      owner_source.slug AS source_slug,
      owner_source.meta AS source_meta
    FROM arena.traders AS owner_trader
    JOIN arena.sources AS owner_source
      ON owner_source.id = owner_trader.source_id
    JOIN arena.exchanges AS owner_exchange
      ON owner_exchange.id = owner_source.exchange_id
    WHERE bot.owner_account_id IS NOT NULL
      AND owner_trader.exchange_trader_id = bot.owner_account_id
      AND owner_trader.trader_kind = 'human'
      AND owner_source.exchange_id = bot.exchange_id
      AND owner_exchange.slug = 'bitget'
      AND owner_source.adapter_slug = 'bitget'
      AND owner_source.trader_kind_scope = 'human'
      AND owner_source.status = 'active'
      AND owner_source.serving_mode = 'serving'
    ORDER BY
      (owner_source.product_type = bot.product_type) DESC,
      owner_trader.last_seen_at DESC,
      owner_trader.id ASC
    LIMIT 1
  ) AS owner ON true
  LIMIT 1;
$function$;

ALTER FUNCTION public.arena_bot_header(text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_bot_header(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_bot_header(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_bot_header(text, text) IS
  'Returns Bitget bot metadata only for membership in the latest passed, non-derived canonical 30D source snapshot. is_current is true by construction. is_fresh is true through snapshot_as_of + cadence_tier_a; stale current membership remains visible with freshness=stale. Metadata is strictly parsed from arena.traders.meta.bot and owner_account_id links only to an active serving human Bitget trader.';

DO $postflight$
DECLARE
  v_definition text;
  v_function pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.arena_bot_header(text,text)');
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'arena_bot_header replacement is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO STRICT v_definition;

  IF position('arena.bots' IN pg_catalog.lower(v_definition)) > 0
     OR position('leaderboard_ranks' IN pg_catalog.lower(v_definition)) > 0 THEN
    RAISE EXCEPTION 'arena_bot_header retained a non-canonical read dependency';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = function_row.proowner
     WHERE function_row.oid = v_function
       AND function_row.prokind = 'f'
       AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
       AND function_row.pronargs = 2
       AND function_row.provolatile = 's'
       AND function_row.prosecdef
       AND function_row.proconfig @>
           ARRAY['search_path=pg_catalog, pg_temp']::text[]
       AND owner_role.rolname = 'postgres'
  ) THEN
    RAISE EXCEPTION 'arena_bot_header function identity postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
     WHERE function_row.oid = v_function
       AND privilege_row.grantee = 0::oid
       AND privilege_row.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'arena_bot_header remains executable by PUBLIC';
  END IF;

  IF NOT pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'arena_bot_header explicit execution grants are incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
