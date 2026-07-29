-- Keep the legacy score-input projection on the same canonical platform key
-- used by the physical-board bundle and metric-trust surfaces. Historical
-- source rows may contain padded or empty legacy_platform values; those must
-- trim or fall back to the registry slug before a publication plan compares
-- identities across the three surfaces.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_score_inputs_json(text,integer,integer)'
  );
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_source_sha256 text;
  v_quarantine_markers integer;
  v_legacy_source_sha256 constant text :=
    'ac4d96ea0e3bdbf00a544d13337e2ec59d6f7074db3a36387f6e864792f05ebc';
  v_normalized_source_sha256 constant text :=
    '0af935aaa1278d39bce84cec1f87efb8373e094f00a847ef455698ff43b8497d';
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION
      'arena_score_inputs_json(text,integer,integer) must exist';
  END IF;

  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL THEN
    RAISE EXCEPTION 'score-input base relations must exist';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;

  SELECT *
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_source_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')
    ),
    'hex'
  );
  v_quarantine_markers := (
    pg_catalog.length(v_function_row.prosrc)
    - pg_catalog.length(
        pg_catalog.replace(
          v_function_row.prosrc,
          'bitget-bot-cumulative-rank-quarantine@1',
          ''
        )
      )
  ) / pg_catalog.length('bitget-bot-cumulative-rank-quarantine@1');

  IF v_source_sha256 NOT IN (
       v_legacy_source_sha256,
       v_normalized_source_sha256
     )
     OR v_quarantine_markers <> 3
     OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_function_row.prosecdef
     OR v_function_row.provolatile <> 's'
     OR v_function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'arena_score_inputs_json prerequisite contract drifted: %',
      v_source_sha256;
  END IF;
END
$preflight$;

CREATE TEMP TABLE arena_score_input_alias_contract_before
ON COMMIT DROP
AS
SELECT
  function_row.oid,
  pg_catalog.to_jsonb(function_row) - 'prosrc' AS catalog_without_source,
  pg_catalog.obj_description(function_row.oid, 'pg_proc') AS function_comment
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_json(text,integer,integer)'
    ::pg_catalog.regprocedure;

-- Generate the complete CREATE OR REPLACE statement from the exact reviewed
-- live definition. The source digest and counted anchors make this rewrite
-- deterministic while retaining the later STABLE and Bitget quarantine work.
DO $rewrite$
DECLARE
  v_function oid :=
    'public.arena_score_inputs_json(text,integer,integer)'
      ::pg_catalog.regprocedure;
  v_source text;
  v_definition text;
  v_source_sha256 text;
  v_count integer;
  v_legacy_source_sha256 constant text :=
    'ac4d96ea0e3bdbf00a544d13337e2ec59d6f7074db3a36387f6e864792f05ebc';
  v_normalized_source_sha256 constant text :=
    '0af935aaa1278d39bce84cec1f87efb8373e094f00a847ef455698ff43b8497d';
  v_old_watermark_alias constant text :=
    $needle$NULLIF(source.meta->>'legacy_platform', '')$needle$;
  v_new_watermark_alias constant text :=
    $replacement$NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), '')$replacement$;
  v_old_score_alias constant text :=
    $needle$COALESCE(source.meta->>'legacy_platform', source.slug)$needle$;
  v_new_score_alias constant text :=
    $replacement$COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      )$replacement$;
  v_old_null_sentinel constant text :=
    $needle$(source.meta->>'legacy_platform') IS DISTINCT FROM 'null'$needle$;
  v_new_null_sentinel constant text :=
    $replacement$pg_catalog.btrim(
        COALESCE(source.meta->>'legacy_platform', '')
      ) <> 'null'$replacement$;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_source_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
    'hex'
  );
  IF v_source_sha256 = v_normalized_source_sha256 THEN
    RETURN;
  ELSIF v_source_sha256 <> v_legacy_source_sha256 THEN
    RAISE EXCEPTION
      'arena_score_inputs_json source drifted before alias rewrite: %',
      v_source_sha256;
  END IF;

  v_count := (
    pg_catalog.length(v_source)
    - pg_catalog.length(
        pg_catalog.replace(v_source, v_old_watermark_alias, '')
      )
  ) / pg_catalog.length(v_old_watermark_alias);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'watermark alias rewrite anchor drifted: %/2', v_count;
  END IF;
  v_source := pg_catalog.replace(
    v_source,
    v_old_watermark_alias,
    v_new_watermark_alias
  );

  v_count := (
    pg_catalog.length(v_source)
    - pg_catalog.length(pg_catalog.replace(v_source, v_old_score_alias, ''))
  ) / pg_catalog.length(v_old_score_alias);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'score-row alias rewrite anchor drifted: %/2', v_count;
  END IF;
  v_source := pg_catalog.replace(
    v_source,
    v_old_score_alias,
    v_new_score_alias
  );

  v_count := (
    pg_catalog.length(v_source)
    - pg_catalog.length(
        pg_catalog.replace(v_source, v_old_null_sentinel, '')
      )
  ) / pg_catalog.length(v_old_null_sentinel);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'null-sentinel rewrite anchor drifted: %/2', v_count;
  END IF;
  v_source := pg_catalog.replace(
    v_source,
    v_old_null_sentinel,
    v_new_null_sentinel
  );

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> v_normalized_source_sha256 THEN
    RAISE EXCEPTION 'normalized alias source digest mismatch';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_watermark_alias,
    v_new_watermark_alias
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_score_alias,
    v_new_score_alias
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_null_sentinel,
    v_new_null_sentinel
  );
  EXECUTE v_definition;
END
$rewrite$;

-- Reassert rather than broaden the existing service-only PostgREST boundary.
REVOKE ALL
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  TO service_role;

DO $postflight$
DECLARE
  v_before arena_score_input_alias_contract_before%ROWTYPE;
  v_after pg_catalog.pg_proc%ROWTYPE;
  v_source_sha256 text;
  v_count integer;
BEGIN
  SELECT * INTO STRICT v_before
  FROM arena_score_input_alias_contract_before;

  SELECT * INTO STRICT v_after
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.arena_score_inputs_json(text,integer,integer)'
      ::pg_catalog.regprocedure;

  v_source_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_after.prosrc, 'UTF8')),
    'hex'
  );
  v_count := (
    pg_catalog.length(v_after.prosrc)
    - pg_catalog.length(
        pg_catalog.replace(
          v_after.prosrc,
          $needle$NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), '')$needle$,
          ''
        )
      )
  ) / pg_catalog.length(
    $needle$NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), '')$needle$
  );

  IF v_after.oid IS DISTINCT FROM v_before.oid
     OR (pg_catalog.to_jsonb(v_after) - 'prosrc')
          IS DISTINCT FROM v_before.catalog_without_source
     OR pg_catalog.obj_description(v_after.oid, 'pg_proc')
          IS DISTINCT FROM v_before.function_comment
     OR v_source_sha256 <>
          '0af935aaa1278d39bce84cec1f87efb8373e094f00a847ef455698ff43b8497d'
     OR v_count <> 4
     OR (
       pg_catalog.length(v_after.prosrc)
       - pg_catalog.length(
           pg_catalog.replace(
             v_after.prosrc,
             'bitget-bot-cumulative-rank-quarantine@1',
             ''
           )
         )
     ) / pg_catalog.length('bitget-bot-cumulative-rank-quarantine@1') <> 3
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after.oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'arena_score_inputs_json alias normalization postflight failed: %',
      v_source_sha256;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = v_after.oid
      AND dependency.refobjid =
        pg_catalog.to_regclass('arena.score_inputs')
  ) THEN
    RAISE EXCEPTION
      'arena_score_inputs_json regained arena.score_inputs dependency';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
