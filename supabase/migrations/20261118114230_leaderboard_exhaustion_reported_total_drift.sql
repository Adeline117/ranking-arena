-- Migration: 20261118114230_leaderboard_exhaustion_reported_total_drift.sql
-- Description: A third board-version proof for exhausted completeness:
--   reported_total_drift (lib/ingest/acquisition-exhaustion.ts).
--
-- Why: large live boards change while they are paged (binance_futures: 660
--   pages and 35 minutes per window at 20 rows per page). A trader crossing
--   the cursor is seen twice while another slides past unseen, and the total
--   each page reports moves. The total mode refuses any duplicate row, and the
--   two existing exhausted proofs (one version token on every page, page one
--   re-read with identical row keys) both assert a frozen board, so no such
--   capture could ever be trusted and these exchanges could not be published.
--
-- What: a source may declare
--     "board_version": {"kind": "reported_total_drift",
--                       "path": [...], "max_drift_rows": N}
--   and its capture then records the smallest, largest and last board total it
--   was given. The proof holds only when the total varied by at most N rows and
--   the distinct rows differ from the last total by at most N; every other
--   condition is unchanged (one entry per source page, natural short/empty
--   page end, zero rejected rows, distinct = accepted rows, duplicates =
--   observed - distinct and within max_duplicate_rows). The outcome keeps the
--   exhausted ledger shape; no table, column, constraint or caller changes.
--
--   This extends completeness contract @1 with one more accepted declaration;
--   every declaration and proof valid before stays valid with the same result.
--   The contract name is pinned by CHECK constraints on both exhaustion tables.
--
-- Inert until a source registers such a declaration (each by its own reviewed
-- migration). PREDEPLOY-safe: it only replaces two function bodies, and the
-- worker release that emits the new block is refused exactly as before until
-- its source is registered.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_declaration_valid(jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_completeness_holds(smallint,jsonb,text,integer,text,integer,integer,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'reported-total drift requires exhaustion completeness (20261115141050)';
  END IF;

  -- Both replaced functions must be their exact reviewed bodies.
  IF (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.leaderboard_exhaustion_declaration_valid(jsonb)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM 'a358ae1a17a908a25852fd91da9d47a7b55ff528b954b6d1e1f232d2df3bf251'
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.leaderboard_exhaustion_completeness_holds(smallint,jsonb,text,integer,text,integer,integer,integer,integer)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM 'e4bfeb502a9b47f34b50e9ecf0018046078bbb3abaf37e1110fc7a9392463f38' THEN
    RAISE EXCEPTION 'exhaustion completeness functions (20261115141050) drifted';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.leaderboard_exhaustion_declaration_valid(p_declaration jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    arena.leaderboard_exhaustion_keys(p_declaration) = ARRAY[
      'board_version', 'completeness_mode', 'end_signal', 'list_path',
      'max_duplicate_rows', 'row_key_path'
    ]
    AND p_declaration->>'completeness_mode' = 'exhausted'
    AND pg_catalog.jsonb_typeof(p_declaration->'completeness_mode') = 'string'
    AND arena.leaderboard_exhaustion_path_valid(p_declaration->'list_path')
    AND arena.leaderboard_exhaustion_path_valid(p_declaration->'row_key_path')
    AND arena.leaderboard_exhaustion_count_valid(p_declaration->'max_duplicate_rows')
    AND CASE p_declaration->'end_signal'->>'kind'
      WHEN 'flag' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') =
          ARRAY['end_values', 'kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'end_signal'->'path')
        AND pg_catalog.jsonb_typeof(p_declaration->'end_signal'->'end_values') = 'array'
        AND pg_catalog.jsonb_array_length(p_declaration->'end_signal'->'end_values')
            BETWEEN 1 AND 8
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.jsonb_array_elements(
              p_declaration->'end_signal'->'end_values'
            ) AS end_value(value)
           WHERE NOT arena.leaderboard_exhaustion_scalar_valid(end_value.value)
        )
      WHEN 'page_count' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') = ARRAY['kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'end_signal'->'path')
      WHEN 'short_page' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') = ARRAY['kind']
      ELSE false
    END
    AND CASE p_declaration->'board_version'->>'kind'
      WHEN 'token' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'board_version') = ARRAY['kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'board_version'->'path')
      WHEN 'first_page_reread' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'board_version') = ARRAY['kind']
      WHEN 'reported_total_drift' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'board_version') =
          ARRAY['kind', 'max_drift_rows', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'board_version'->'path')
        AND arena.leaderboard_exhaustion_count_valid(
          p_declaration->'board_version'->'max_drift_rows'
        )
      ELSE false
    END,
    false
  )
$function$;

CREATE OR REPLACE FUNCTION arena.leaderboard_exhaustion_completeness_holds(
  p_source_id smallint,
  p_completeness jsonb,
  p_termination_reason text,
  p_source_page_count integer,
  p_population_report_state text,
  p_observed_population integer,
  p_accepted_population integer,
  p_rejected_row_count integer,
  p_deduplicated_row_count integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_declaration jsonb;
  v_page_size integer;
  v_pages jsonb;
  v_page_count integer;
  v_last jsonb;
  v_rows jsonb;
  v_board_version jsonb;
  v_reread jsonb;
  v_end_values jsonb;
  v_totals jsonb;
BEGIN
  IF arena.leaderboard_exhaustion_keys(p_completeness) IS DISTINCT FROM ARRAY[
       'board_version', 'data_contract', 'declaration', 'pages', 'row_keys'
     ]
     OR p_completeness->>'data_contract' IS DISTINCT FROM
        'arena.ingest.leaderboard-exhaustion-completeness@1' THEN
    RETURN false;
  END IF;

  SELECT contract.declaration, source_row.page_size
    INTO v_declaration, v_page_size
    FROM arena.leaderboard_exhaustion_contracts AS contract
    JOIN arena.sources AS source_row ON source_row.id = contract.source_id
   WHERE contract.source_id = p_source_id;
  IF NOT FOUND OR p_completeness->'declaration' IS DISTINCT FROM v_declaration THEN
    RETURN false;
  END IF;

  -- Outcome facts: no reported total, nothing rejected, a non-empty board.
  IF p_population_report_state IS DISTINCT FROM 'unknown'
     OR p_rejected_row_count IS DISTINCT FROM 0
     OR p_accepted_population IS NULL
     OR p_accepted_population < 1
     OR p_observed_population IS NULL
     OR p_deduplicated_row_count IS NULL THEN
    RETURN false;
  END IF;

  -- One entry per source page, contiguous from one.
  v_pages := p_completeness->'pages';
  IF pg_catalog.jsonb_typeof(v_pages) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  v_page_count := pg_catalog.jsonb_array_length(v_pages);
  IF v_page_count < 1 OR v_page_count IS DISTINCT FROM p_source_page_count THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
     WHERE arena.leaderboard_exhaustion_keys(page.value) IS DISTINCT FROM ARRAY[
             'end_signal_value', 'ordinal', 'request_sha256', 'response_sha256',
             'row_count', 'row_keys_sha256', 'version_token_sha256'
           ]
        OR pg_catalog.jsonb_typeof(page.value->'ordinal') IS DISTINCT FROM 'number'
        OR page.value->>'ordinal' IS DISTINCT FROM page.ordinal::text
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'request_sha256')
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'response_sha256')
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'row_keys_sha256')
        OR NOT arena.leaderboard_exhaustion_count_valid(page.value->'row_count')
        OR NOT arena.leaderboard_exhaustion_scalar_valid(page.value->'end_signal_value')
  ) THEN
    RETURN false;
  END IF;
  IF (
    SELECT pg_catalog.sum((page.value->>'row_count')::bigint)
      FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
  ) IS DISTINCT FROM p_observed_population::numeric THEN
    RETURN false;
  END IF;
  v_last := v_pages->(v_page_count - 1);

  -- Cross-page row identity.
  v_rows := p_completeness->'row_keys';
  IF arena.leaderboard_exhaustion_keys(v_rows) IS DISTINCT FROM
       ARRAY['distinct', 'duplicate', 'observed']
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'observed')
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'distinct')
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'duplicate')
     OR (v_rows->>'observed')::integer IS DISTINCT FROM p_observed_population
     OR (v_rows->>'distinct')::integer IS DISTINCT FROM p_accepted_population
     OR (v_rows->>'duplicate')::integer IS DISTINCT FROM
        (v_rows->>'observed')::integer - (v_rows->>'distinct')::integer
     OR (v_rows->>'duplicate')::integer IS DISTINCT FROM p_deduplicated_row_count
     OR (v_rows->>'duplicate')::integer > (v_declaration->>'max_duplicate_rows')::integer THEN
    RETURN false;
  END IF;

  -- The declared end signal: "more" on every page but the last, "end" on the last.
  CASE v_declaration->'end_signal'->>'kind'
    WHEN 'flag' THEN
      v_end_values := v_declaration->'end_signal'->'end_values';
      IF NOT (v_end_values @> pg_catalog.jsonb_build_array(v_last->'end_signal_value'))
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
            WHERE page.ordinal < v_page_count
              AND v_end_values @> pg_catalog.jsonb_build_array(page.value->'end_signal_value')
         )
         OR NOT (
           (p_termination_reason = 'cursor_exhausted' AND (v_last->>'row_count')::integer > 0)
           OR (p_termination_reason = 'empty_page' AND (v_last->>'row_count')::integer = 0)
         ) THEN
        RETURN false;
      END IF;
    WHEN 'page_count' THEN
      IF p_termination_reason IS DISTINCT FROM 'reported_page_count_reached'
         OR (v_last->>'row_count')::integer < 1
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE page.value->'end_signal_value' IS DISTINCT FROM pg_catalog.to_jsonb(v_page_count)
         ) THEN
        RETURN false;
      END IF;
    WHEN 'short_page' THEN
      IF v_page_size IS NULL
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
            WHERE page.value->'end_signal_value' IS DISTINCT FROM 'null'::jsonb
               OR (
                 page.ordinal < v_page_count
                 AND (page.value->>'row_count')::integer IS DISTINCT FROM v_page_size
               )
         )
         OR NOT (
           (
             p_termination_reason = 'short_page'
             AND (v_last->>'row_count')::integer BETWEEN 1 AND v_page_size - 1
           )
           OR (p_termination_reason = 'empty_page' AND (v_last->>'row_count')::integer = 0)
         ) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
  END CASE;

  -- Board stability.
  v_board_version := p_completeness->'board_version';
  CASE v_declaration->'board_version'->>'kind'
    WHEN 'token' THEN
      IF v_board_version IS DISTINCT FROM '{"kind": "token"}'::jsonb
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'version_token_sha256')
         )
         OR (
           SELECT pg_catalog.count(DISTINCT page.value->>'version_token_sha256')
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
         ) IS DISTINCT FROM 1 THEN
        RETURN false;
      END IF;
    WHEN 'first_page_reread' THEN
      v_reread := v_board_version->'reread';
      IF arena.leaderboard_exhaustion_keys(v_board_version) IS DISTINCT FROM ARRAY['kind', 'reread']
         OR v_board_version->>'kind' IS DISTINCT FROM 'first_page_reread'
         OR arena.leaderboard_exhaustion_keys(v_reread) IS DISTINCT FROM ARRAY[
              'http_status', 'request_sha256', 'response_sha256', 'row_keys_sha256'
            ]
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'request_sha256')
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'response_sha256')
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'row_keys_sha256')
         OR NOT arena.leaderboard_exhaustion_count_valid(v_reread->'http_status')
         OR (v_reread->>'http_status')::integer NOT BETWEEN 200 AND 299
         OR v_reread->'row_keys_sha256' IS DISTINCT FROM v_pages->0->'row_keys_sha256'
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE page.value->'version_token_sha256' IS DISTINCT FROM 'null'::jsonb
         ) THEN
        RETURN false;
      END IF;
    WHEN 'reported_total_drift' THEN
      -- A live board: the total every page reports and the distinct rows stay
      -- within the declared allowance of each other.
      v_totals := v_board_version->'reported_totals';
      IF arena.leaderboard_exhaustion_keys(v_board_version) IS DISTINCT FROM
           ARRAY['kind', 'reported_totals']
         OR v_board_version->>'kind' IS DISTINCT FROM 'reported_total_drift'
         OR arena.leaderboard_exhaustion_keys(v_totals) IS DISTINCT FROM
            ARRAY['last', 'max', 'min']
         OR NOT arena.leaderboard_exhaustion_count_valid(v_totals->'min')
         OR NOT arena.leaderboard_exhaustion_count_valid(v_totals->'max')
         OR NOT arena.leaderboard_exhaustion_count_valid(v_totals->'last')
         OR (v_totals->>'last')::integer NOT BETWEEN
            (v_totals->>'min')::integer AND (v_totals->>'max')::integer
         OR (v_totals->>'max')::integer - (v_totals->>'min')::integer >
            (v_declaration->'board_version'->>'max_drift_rows')::integer
         OR pg_catalog.abs((v_totals->>'last')::integer - (v_rows->>'distinct')::integer) >
            (v_declaration->'board_version'->>'max_drift_rows')::integer
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE page.value->'version_token_sha256' IS DISTINCT FROM 'null'::jsonb
         ) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
  END CASE;

  RETURN true;
END
$function$;

COMMIT;
