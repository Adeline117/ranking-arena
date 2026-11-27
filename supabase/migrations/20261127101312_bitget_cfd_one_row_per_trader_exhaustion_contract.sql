-- Migration: 20261127101312_bitget_cfd_one_row_per_trader_exhaustion_contract.sql
-- Description: One ranked row per trader for bitget_cfd. Extends exhausted
--   completeness (@1) with an optional identity_merge declaration and
--   registers bitget_cfd with it in arena.leaderboard_exhaustion_contracts
--   (the reviewed copy of BITGET_CFD_LEADERBOARD_EXHAUSTION in
--   lib/ingest/adapters/bitget/index.ts; the proof mirrors
--   exhaustionCompletenessHolds in lib/ingest/acquisition-exhaustion.ts).
--
-- Why: the CFD board lists one row per portfolio, and a trader may lead two
--   (a type 1 copy-trading portfolio and a type 2 UTA portfolio), so the same
--   traderUid appears on two rows. A public probe on 2026-11-27 (four full
--   reads of 7/30/90 days at the paced interval) found 191 / 220 / 224 rows,
--   as many distinct portfolioIds as data.maxShowSizes, of 188 / 218 / 222
--   distinct traders, identical on every read. The capture keeps one row per
--   traderUid, so the total mode (accepted rows = reported total, no
--   duplicate) refused every capture since 2026-11-24 ("population=partial").
--
-- What:
--   * arena.leaderboard_exhaustion_declaration_valid also accepts a
--     declaration with
--       "identity_merge": {"kind": "best_rank", "identity_path": [...]}
--     and only together with a reported_total_drift board version and
--     max_duplicate_rows 0. Every declaration valid before is valid with the
--     same result.
--   * arena.leaderboard_exhaustion_completeness_holds: for such a declaration
--     the completeness block also carries
--       "identity_merge": {"identities": I, "merged_rows": M}
--     and the proof holds only when the rows (row_key_path, here portfolioId)
--     were each read exactly once (no duplicate), their number equals the
--     last reported total, I equals the accepted rows (one per identity, the
--     best-ranked row kept), M = distinct rows - I, and the outcome's
--     deduplicated rows equal M. A row read twice is never tolerated. A
--     declaration without identity_merge takes the unchanged path: the same
--     five-key block, distinct rows = accepted rows, duplicates = deduplicated
--     rows.
--   * bitget_cfd is registered: portfolioId rows, short_page end, total at
--     data.maxShowSizes with max_drift_bps 50 (the total may move by 0.5% of
--     itself between pages, one row at 224: in 12 window reads of the probe it
--     moved once, 224-225 during a 90D read), max_duplicate_rows 0 (no
--     portfolio read twice), identity_merge best_rank on
--     traderUid.
--
--   The kept row is the trader's best-ranked portfolio: one real portfolio's
--   figures, not the trader's combined performance. The worker records which
--   portfolio and how many were merged on that row (trader_stats extras).
--
-- POSTDEPLOY, after 20261118114230 (whose function bodies this replaces) and
-- 20261124114433. The worker release that captures bitget_cfd in this mode
-- must be deployed before or with this file: until both are in place its
-- capture is refused as it is now. No table, column, constraint, trigger or
-- caller changes; the replaced functions keep their owner and grants.
--
-- Replaced bodies that are not the reviewed 20261118114230 ones, a missing or
-- re-adaptered source, an existing bitget_cfd registration (including a
-- replay) or a database without 20261118114230 refuse the whole migration.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_declaration_valid(jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_completeness_holds(smallint,jsonb,text,integer,text,integer,integer,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'bitget_cfd identity merge requires exhaustion completeness (20261115141050)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM arena.sources AS source_row
     WHERE source_row.slug = 'bitget_cfd'
       AND source_row.adapter_slug = 'bitget'
       AND source_row.page_size IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'bitget_cfd identity merge registration source drift: bitget_cfd';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.leaderboard_exhaustion_contracts AS contract
      JOIN arena.sources AS source_row ON source_row.id = contract.source_id
     WHERE source_row.slug = 'bitget_cfd'
  ) THEN
    RAISE EXCEPTION 'bitget_cfd identity merge registration already exists for: bitget_cfd';
  END IF;

  -- Both replaced functions must be their exact 20261118114230 bodies.
  IF (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.leaderboard_exhaustion_declaration_valid(jsonb)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM '34efde966f6b40630ee1d57bcbc6b43593259ee4a5ff6b684dfcb5d45f31cba0'
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.leaderboard_exhaustion_completeness_holds(smallint,jsonb,text,integer,text,integer,integer,integer,integer)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM '4c89fead62698f0aabd762dd8be0ea9c92e9c47f28f2d3ced1da6828ede25844' THEN
    RAISE EXCEPTION 'bitget_cfd identity merge requires the reported_total_drift proof (20261118114230)';
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
    (
      arena.leaderboard_exhaustion_keys(p_declaration) = ARRAY[
        'board_version', 'completeness_mode', 'end_signal', 'list_path',
        'max_duplicate_rows', 'row_key_path'
      ]
      OR (
        -- One ranked row per identity: only with a reported total that the
        -- rows must equal, and no duplicate row tolerated.
        arena.leaderboard_exhaustion_keys(p_declaration) = ARRAY[
          'board_version', 'completeness_mode', 'end_signal', 'identity_merge',
          'list_path', 'max_duplicate_rows', 'row_key_path'
        ]
        AND arena.leaderboard_exhaustion_keys(p_declaration->'identity_merge') =
            ARRAY['identity_path', 'kind']
        AND p_declaration->'identity_merge'->'kind' = '"best_rank"'::jsonb
        AND arena.leaderboard_exhaustion_path_valid(
          p_declaration->'identity_merge'->'identity_path'
        )
        AND p_declaration->'board_version'->>'kind' = 'reported_total_drift'
        AND p_declaration->'max_duplicate_rows' = '0'::jsonb
      )
    )
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
          ARRAY['kind', 'max_drift_bps', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'board_version'->'path')
        AND arena.leaderboard_exhaustion_count_valid(
          p_declaration->'board_version'->'max_drift_bps'
        )
        -- At most 1% of the board.
        AND (p_declaration->'board_version'->>'max_drift_bps')::integer <= 100
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
  v_allowance bigint;
  v_merge jsonb;
BEGIN
  IF p_completeness->>'data_contract' IS DISTINCT FROM
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

  -- identity_merge evidence is present exactly when the declaration merges
  -- identities; every other declaration keeps the five-key block.
  IF v_declaration ? 'identity_merge' THEN
    v_merge := p_completeness->'identity_merge';
    IF arena.leaderboard_exhaustion_keys(p_completeness) IS DISTINCT FROM ARRAY[
         'board_version', 'data_contract', 'declaration', 'identity_merge', 'pages', 'row_keys'
       ]
       OR arena.leaderboard_exhaustion_keys(v_merge) IS DISTINCT FROM
          ARRAY['identities', 'merged_rows']
       OR NOT arena.leaderboard_exhaustion_count_valid(v_merge->'identities')
       OR NOT arena.leaderboard_exhaustion_count_valid(v_merge->'merged_rows') THEN
      RETURN false;
    END IF;
  ELSIF arena.leaderboard_exhaustion_keys(p_completeness) IS DISTINCT FROM ARRAY[
          'board_version', 'data_contract', 'declaration', 'pages', 'row_keys'
        ] THEN
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
     OR (v_rows->>'duplicate')::integer IS DISTINCT FROM
        (v_rows->>'observed')::integer - (v_rows->>'distinct')::integer
     OR (v_rows->>'duplicate')::integer > (v_declaration->>'max_duplicate_rows')::integer THEN
    RETURN false;
  END IF;
  IF v_merge IS NULL THEN
    -- One ranked row per row key (every declaration without identity_merge).
    IF (v_rows->>'distinct')::integer IS DISTINCT FROM p_accepted_population
       OR (v_rows->>'duplicate')::integer IS DISTINCT FROM p_deduplicated_row_count THEN
      RETURN false;
    END IF;
  ELSIF (v_rows->>'duplicate')::integer IS DISTINCT FROM 0
     OR v_declaration->'board_version'->>'kind' IS DISTINCT FROM 'reported_total_drift'
     OR (v_merge->>'identities')::integer < 1
     OR (v_merge->>'identities')::integer > (v_rows->>'distinct')::integer
     OR (v_merge->>'identities')::integer IS DISTINCT FROM p_accepted_population
     OR (v_merge->>'merged_rows')::integer IS DISTINCT FROM
        (v_rows->>'distinct')::integer - (v_merge->>'identities')::integer
     OR (v_merge->>'merged_rows')::integer IS DISTINCT FROM p_deduplicated_row_count THEN
    -- One ranked row per identity: every row read once, and the only rows the
    -- capture drops are those merged into their identity's best-ranked row.
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
      -- A live board: the total every page reports, the distinct rows against
      -- the last total, and the duplicate rows each stay within the declared
      -- share of the last total, never above max_duplicate_rows.
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
            (v_totals->>'min')::integer AND (v_totals->>'max')::integer THEN
        RETURN false;
      END IF;
      -- identity_merge declares max_duplicate_rows 0 and forbids any duplicate
      -- and any distinct-vs-total gap on its own (below); the drift share then
      -- bounds only how far the reported total may move between pages.
      v_allowance := CASE WHEN v_merge IS NULL THEN LEAST(
        (v_totals->>'last')::bigint
          * (v_declaration->'board_version'->>'max_drift_bps')::bigint / 10000,
        (v_declaration->>'max_duplicate_rows')::bigint
      ) ELSE
        (v_totals->>'last')::bigint
          * (v_declaration->'board_version'->>'max_drift_bps')::bigint / 10000
      END;
      -- A NULL allowance must refuse, never fall through to true.
      IF v_allowance IS NULL
         OR (v_totals->>'max')::bigint - (v_totals->>'min')::bigint > v_allowance
         OR pg_catalog.abs((v_totals->>'last')::bigint - (v_rows->>'distinct')::bigint) >
            v_allowance
         OR (v_rows->>'duplicate')::bigint > v_allowance
         -- identity_merge: the rows equal the last reported total exactly.
         OR (
           v_merge IS NOT NULL
           AND (v_rows->>'distinct')::bigint IS DISTINCT FROM (v_totals->>'last')::bigint
         )
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

-- Session-local seed (pg_temp); it disappears with the applying session.
CREATE TEMPORARY TABLE bitget_cfd_one_row_seed (
  source_slug text PRIMARY KEY,
  declaration jsonb NOT NULL
);

INSERT INTO bitget_cfd_one_row_seed VALUES
  ('bitget_cfd',
   '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["portfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "maxShowSizes"], "max_drift_bps": 50}, "max_duplicate_rows": 0, "identity_merge": {"kind": "best_rank", "identity_path": ["traderUid"]}}');

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id, completeness_contract, declaration
)
SELECT source_row.id,
       'arena.ingest.leaderboard-exhaustion-completeness@1',
       seed.declaration
  FROM bitget_cfd_one_row_seed AS seed
  JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
 ORDER BY source_row.id;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM bitget_cfd_one_row_seed AS seed
      JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
      JOIN arena.leaderboard_exhaustion_contracts AS contract
        ON contract.source_id = source_row.id
       AND contract.declaration = seed.declaration
  ) <> 1
     OR NOT arena.leaderboard_exhaustion_declaration_valid(
       (SELECT seed.declaration FROM bitget_cfd_one_row_seed AS seed)
     )
     -- Every contract registered before stays valid.
     OR EXISTS (
       SELECT 1
         FROM arena.leaderboard_exhaustion_contracts AS contract
        WHERE NOT arena.leaderboard_exhaustion_declaration_valid(contract.declaration)
     ) THEN
    RAISE EXCEPTION 'bitget_cfd identity merge registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
