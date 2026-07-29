-- Migration: 20260729070000_pure_arena_score_v5_zero_metric_scorer.sql
-- Description: Add an inert, private Arena Score v5 scorer in which a trusted
-- 0% win rate and 0% maximum drawdown are known values. V4 remains byte-for-byte
-- intact so historical v1 score-input manifests stay verifiable. V5 deliberately
-- reuses the frozen v4 round2 helper because the rounding algorithm did not change.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_v4_scorer oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v4_json(text,jsonb)'
  );
  v_round2 oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_v5_scorer oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v5_json(text,jsonb)'
  );
  v_v4_scorer_row pg_catalog.pg_proc%ROWTYPE;
  v_round2_row pg_catalog.pg_proc%ROWTYPE;
  v_v5_scorer_row pg_catalog.pg_proc%ROWTYPE;
  v_source_sha256 text;
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_v4_scorer_sha256 constant text :=
    'a3c245893d5a939020f70c70d09e41bf2e5b28e3ad640daf619c264c3bb530ba';
  v_round2_sha256 constant text :=
    '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3';
  v_v5_scorer_sha256 constant text :=
    '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae';
BEGIN
  IF v_v4_scorer IS NULL OR v_round2 IS NULL THEN
    RAISE EXCEPTION 'exact Arena Score v4 scorer and round2 helper must exist before v5';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist before installing v5';
  END IF;

  SELECT *
  INTO STRICT v_v4_scorer_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v4_scorer;

  SELECT *
  INTO STRICT v_round2_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_round2;

  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v4_scorer_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> v_v4_scorer_sha256
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_round2_row.prosrc, 'UTF8')),
       'hex'
     ) <> v_round2_sha256
     OR v_v4_scorer_row.proowner <> v_round2_row.proowner
     OR v_plpgsql IS NULL
     OR v_v4_scorer_row.prolang <> v_plpgsql
     OR v_round2_row.prolang <> v_plpgsql
     OR v_v4_scorer_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_round2_row.prorettype <> 'double precision'::pg_catalog.regtype
     OR v_v4_scorer_row.prokind <> 'f'
     OR v_round2_row.prokind <> 'f'
     OR v_v4_scorer_row.proretset
     OR v_round2_row.proretset
     OR v_v4_scorer_row.proisstrict
     OR NOT v_round2_row.proisstrict
     OR v_v4_scorer_row.proleakproof
     OR v_round2_row.proleakproof
     OR v_v4_scorer_row.provolatile <> 'i'
     OR v_round2_row.provolatile <> 'i'
     OR v_v4_scorer_row.proparallel <> 's'
     OR v_round2_row.proparallel <> 's'
     OR v_v4_scorer_row.prosecdef
     OR v_round2_row.prosecdef
     OR v_v4_scorer_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'extra_float_digits=3'
     ]::pg_catalog.text[]
     OR v_round2_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION 'Arena Score v4 prerequisite contract drifted';
  END IF;

  IF v_v5_scorer IS NOT NULL THEN
    SELECT *
    INTO STRICT v_v5_scorer_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v5_scorer;

    v_source_sha256 := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_v5_scorer_row.prosrc, 'UTF8')
      ),
      'hex'
    );
    IF v_source_sha256 <> v_v5_scorer_sha256
       OR (
         pg_catalog.to_jsonb(v_v5_scorer_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(v_v4_scorer_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) THEN
      RAISE EXCEPTION 'existing Arena Score v5 scorer contract drifted: %',
        v_source_sha256;
    END IF;
  END IF;
END
$preflight$;

-- Derive the new function from the exact reviewed v4 definition. The source
-- digest above freezes every inherited validation, bound, canonicalization and
-- scoring rule; the two counted removals are the complete semantic delta.
DO $install_v5$
DECLARE
  v_v4_scorer oid :=
    'arena.compute_arena_scores_v4_json(text,jsonb)'::pg_catalog.regprocedure;
  v_definition text;
  v_source text;
  v_count integer;
  v_old_mdd_zero constant text :=
    $needle$          OR (input_row.value->>'max_drawdown')::double precision = 0
$needle$;
  v_old_win_zero constant text :=
    $needle$          OR (input_row.value->>'win_rate')::double precision = 0
$needle$;
  v_v5_scorer_sha256 constant text :=
    '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae';
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.compute_arena_scores_v5_json(text,jsonb)'
     ) IS NOT NULL THEN
    RETURN;
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_v4_scorer);

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          'compute_arena_scores_v4_json',
          ''
        )
      )
  ) / pg_catalog.length('compute_arena_scores_v4_json');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'v5 function-name rewrite anchor drifted: %/1', v_count;
  END IF;

  v_definition := pg_catalog.replace(v_definition, 'v4', 'v5');
  -- The scorer version changed, but the already frozen rounding math did not.
  v_definition := pg_catalog.replace(
    v_definition,
    'arena.arena_score_v5_round2',
    'arena.arena_score_v4_round2'
  );

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_mdd_zero, '')
      )
  ) / pg_catalog.length(v_old_mdd_zero);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'v5 maximum-drawdown zero rewrite anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_mdd_zero,
    ''
  );

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_win_zero, '')
      )
  ) / pg_catalog.length(v_old_win_zero);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'v5 win-rate zero rewrite anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_win_zero,
    ''
  );

  EXECUTE v_definition;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> v_v5_scorer_sha256 THEN
    RAISE EXCEPTION 'installed Arena Score v5 source digest mismatch';
  END IF;
END
$install_v5$;

REVOKE ALL
  ON FUNCTION arena.compute_arena_scores_v5_json(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Hostile default privileges can grant EXECUTE to roles not named above.
DO $owner_only_acl$
DECLARE
  v_function oid :=
    'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid = v_function
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee NOT IN (0, function_row.proowner)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION arena.compute_arena_scores_v5_json(text,jsonb) FROM %I',
      v_role.role_name
    );
  END LOOP;
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.compute_arena_scores_v5_json(text, jsonb) IS
  'Private immutable Arena Score v5 shadow scorer. A trusted 0% win rate and 0% maximum drawdown are known values; only null is missing. V4 and historical v1 manifests remain unchanged. Uses the frozen v4 round2 helper because rounding semantics did not change. Pure parameters only; no production relation reads or writes.';

DO $postflight$
DECLARE
  v_v4_scorer oid :=
    'arena.compute_arena_scores_v4_json(text,jsonb)'::pg_catalog.regprocedure;
  v_round2 oid :=
    'arena.arena_score_v4_round2(double precision)'::pg_catalog.regprocedure;
  v_v5_scorer oid :=
    'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;
  v_v4_scorer_row pg_catalog.pg_proc%ROWTYPE;
  v_v5_scorer_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_v4_scorer_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v4_scorer;

  SELECT * INTO STRICT v_v5_scorer_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v5_scorer;

  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v4_scorer_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> 'a3c245893d5a939020f70c70d09e41bf2e5b28e3ad640daf619c264c3bb530ba'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v5_scorer_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae'
     OR (
       pg_catalog.to_jsonb(v_v5_scorer_row)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_v4_scorer_row)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) THEN
    RAISE EXCEPTION 'Arena Score v5 scorer postflight contract drifted';
  END IF;

  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(
           (SELECT function_row.prosrc
            FROM pg_catalog.pg_proc AS function_row
            WHERE function_row.oid = v_round2),
           'UTF8'
         )
       ),
       'hex'
     ) <> '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3' THEN
    RAISE EXCEPTION 'Arena Score v4 round2 helper changed during v5 install';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon', v_v5_scorer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_v5_scorer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_v5_scorer, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = v_v5_scorer
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'Arena Score v5 scorer is executable by a non-owner role';
  END IF;
END
$postflight$;

COMMIT;
