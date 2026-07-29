-- Migration: 20260729071000_leaderboard_metric_trust_projection_v2.sql
-- Description: Add an inert, owner-only metric-trust projection for Arena
-- Score v5. Only database-rankable, same-run, same-window USDT observations
-- can supply win rate or drawdown. A trusted numeric zero is retained, while
-- missing evidence and the 100% drawdown policy cap remain outside ranking.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

DO $preflight$
DECLARE
  v_v1 oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'
  );
  v_v2 oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'
  );
  v_v5 oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v5_json(text,jsonb)'
  );
  v_manifest_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_manifest_seal oid := pg_catalog.to_regprocedure(
    'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_manifest_verify oid := pg_catalog.to_regprocedure(
    'arena.verify_leaderboard_score_input_manifest_v2(uuid)'
  );
  v_v1_row pg_catalog.pg_proc%ROWTYPE;
  v_v2_row pg_catalog.pg_proc%ROWTYPE;
  v_v5_row pg_catalog.pg_proc%ROWTYPE;
  v_encoder_row pg_catalog.pg_proc%ROWTYPE;
  v_seal_row pg_catalog.pg_proc%ROWTYPE;
  v_verify_row pg_catalog.pg_proc%ROWTYPE;
  v_named_count integer;
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'metric-trust projection v2 requires PostgreSQL 17';
  END IF;
  IF v_v1 IS NULL
     OR v_v5 IS NULL
     OR v_manifest_encoder IS NULL
     OR v_manifest_seal IS NULL
     OR v_manifest_verify IS NULL
     OR v_plpgsql IS NULL THEN
    RAISE EXCEPTION 'exact v1 projection, v5 scorer, and manifest v2 must exist';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'projection authority roles must exist';
  END IF;

  SELECT * INTO STRICT v_v1_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v1;
  SELECT * INTO STRICT v_v5_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v5;
  SELECT * INTO STRICT v_encoder_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_manifest_encoder;
  SELECT * INTO STRICT v_seal_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_manifest_seal;
  SELECT * INTO STRICT v_verify_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_manifest_verify;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v1_row.prosrc, 'UTF8')),
       'hex'
     ) <> '6047c43ac685bb54a006cae1f3989e61c3a07236c71d03941ddeefd9c4338234'
     OR v_v1_row.proowner <> 'postgres'::pg_catalog.regrole
     OR v_v1_row.prolang <> v_plpgsql
     OR v_v1_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_v1_row.prokind <> 'f'
     OR v_v1_row.proretset
     OR v_v1_row.proisstrict
     OR v_v1_row.proleakproof
     OR v_v1_row.prosecdef
     OR v_v1_row.provolatile <> 'v'
     OR v_v1_row.proparallel <> 'u'
     OR v_v1_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'TimeZone=UTC',
       'extra_float_digits=3'
     ]::pg_catalog.text[] THEN
    RAISE EXCEPTION 'metric-trust projection v1 prerequisite drifted';
  END IF;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v5_row.prosrc, 'UTF8')),
       'hex'
     ) <> '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_encoder_row.prosrc, 'UTF8')),
       'hex'
     ) <> '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_seal_row.prosrc, 'UTF8')),
       'hex'
     ) <> '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_verify_row.prosrc, 'UTF8')),
       'hex'
     ) <> '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e'
     OR v_v5_row.proowner <> v_v1_row.proowner
     OR v_encoder_row.proowner <> v_v1_row.proowner
     OR v_seal_row.proowner <> v_v1_row.proowner
     OR v_verify_row.proowner <> v_v1_row.proowner
     OR v_v5_row.prolang <> v_plpgsql
     OR v_encoder_row.prolang <> v_plpgsql
     OR v_seal_row.prolang <> v_plpgsql
     OR v_verify_row.prolang <> v_plpgsql
     OR v_v5_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_encoder_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_seal_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_verify_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_v5_row.prokind <> 'f'
     OR v_encoder_row.prokind <> 'f'
     OR v_seal_row.prokind <> 'f'
     OR v_verify_row.prokind <> 'f'
     OR v_v5_row.proretset
     OR v_encoder_row.proretset
     OR v_seal_row.proretset
     OR v_verify_row.proretset
     OR v_v5_row.proisstrict
     OR v_encoder_row.proisstrict
     OR v_seal_row.proisstrict
     OR v_verify_row.proisstrict
     OR v_v5_row.proleakproof
     OR v_encoder_row.proleakproof
     OR v_seal_row.proleakproof
     OR v_verify_row.proleakproof
     OR v_v5_row.prosecdef
     OR v_encoder_row.prosecdef
     OR v_seal_row.prosecdef
     OR v_verify_row.prosecdef
     OR v_v5_row.provolatile <> 'i'
     OR v_encoder_row.provolatile <> 's'
     OR v_seal_row.provolatile <> 'v'
     OR v_verify_row.provolatile <> 's'
     OR v_v5_row.proparallel <> 's'
     OR v_encoder_row.proparallel <> 'u'
     OR v_seal_row.proparallel <> 'u'
     OR v_verify_row.proparallel <> 'u'
     OR v_v5_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'extra_float_digits=3'
     ]::pg_catalog.text[]
     OR v_encoder_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'extra_float_digits=3',
       'quote_all_identifiers=off'
     ]::pg_catalog.text[]
     OR v_seal_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_verify_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION 'projection v2 scorer or manifest prerequisite drifted';
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
    WHERE function_row.oid IN (
      v_v1,
      v_v5,
      v_manifest_encoder,
      v_manifest_seal,
      v_manifest_verify
    )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      v_v1,
      v_v5,
      v_manifest_encoder,
      v_manifest_seal,
      v_manifest_verify
    ]::oid[]) AS checked_function(function_oid)
    WHERE pg_catalog.has_function_privilege(
      checked_role.role_name,
      checked_function.function_oid,
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'projection v2 prerequisite authority boundary drifted';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_named_count
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'arena'::pg_catalog.regnamespace
    AND function_row.proname =
      'build_leaderboard_metric_trust_projection_v2';
  IF v_named_count <> (CASE WHEN v_v2 IS NULL THEN 0 ELSE 1 END) THEN
    RAISE EXCEPTION 'noncanonical metric-trust projection v2 overload detected';
  END IF;

  IF v_v2 IS NOT NULL THEN
    SELECT * INTO STRICT v_v2_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v2;
    IF pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(v_v2_row.prosrc, 'UTF8')),
         'hex'
       ) <> 'b223a5c81a01d6e3a9b83d34dd4552d86f14124442f48359b11e81b4cd77957c'
       OR (
         pg_catalog.to_jsonb(v_v2_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(v_v1_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) THEN
      RAISE EXCEPTION 'existing metric-trust projection v2 drifted';
    END IF;
  END IF;
END
$preflight$;

DO $install_v2$
DECLARE
  v_definition text;
  v_source text;
  v_count integer;
  v_old_eligibility constant text :=
    $old$'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1'$old$;
  v_new_eligibility constant text :=
    $new$'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@2'$new$;
  v_old_projection constant text :=
    $old$'leaderboard-score-metric-trust-projection@1'$old$;
  v_new_projection constant text :=
    $new$'leaderboard-score-metric-trust-projection@2'$new$;
  v_old_zero_policy constant text := $old$        -- The existing v4 scorer treats zero as missing. Excluding zero keeps
        -- this four-metric contract semantically complete for every member.
        AND candidate.win_rate > 0
        AND candidate.win_rate <= 100
        AND candidate.max_drawdown > 0
        AND candidate.max_drawdown < 100
        AND NOT (
          candidate.max_drawdown = 0
          AND pg_catalog.abs(candidate.roi) > 50
        )
        AND NOT (
          candidate.max_drawdown < 1
          AND candidate.roi > 500
        )
        AND NOT (
          candidate.max_drawdown >= 99
          AND candidate.roi > 0
        )
        AND NOT (
          candidate.win_rate = 0
          AND (candidate.roi > 10 OR candidate.pnl > 0)
        )
        AND NOT (
          candidate.win_rate >= 100
          AND (candidate.roi < -10 OR candidate.pnl < 0)
        )$old$;
  v_new_zero_policy constant text := $new$        -- V5 treats zero as known only after the rankable observation joins
        -- above prove complete, fresh, same-window, same-run USDT evidence.
        AND candidate.win_rate >= 0
        AND candidate.win_rate <= 100
        AND candidate.max_drawdown >= 0
        AND candidate.max_drawdown < 100
        AND NOT (
          candidate.max_drawdown > 0
          AND candidate.max_drawdown < 1
          AND candidate.roi > 500
        )
        AND NOT (
          candidate.max_drawdown >= 99
          AND candidate.roi > 0
        )
        AND NOT (
          candidate.win_rate >= 100
          AND (candidate.roi < -10 OR candidate.pnl < 0)
        )$new$;
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'
     ) IS NOT NULL THEN
    RETURN;
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::pg_catalog.regprocedure
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'build_leaderboard_metric_trust_projection_v1',
        ''
      ))
  ) / pg_catalog.length('build_leaderboard_metric_trust_projection_v1');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'projection v2 function-name anchor drifted: %/1',
      v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    'build_leaderboard_metric_trust_projection_v1',
    'build_leaderboard_metric_trust_projection_v2'
  );

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'arena-v4-roi-pnl-win-mdd-',
        ''
      ))
  ) / pg_catalog.length('arena-v4-roi-pnl-win-mdd-');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'projection v2 ranking-method anchors drifted: %/3',
      v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    'arena-v4-roi-pnl-win-mdd-',
    'arena-v5-roi-pnl-win-mdd-'
  );

  FOREACH v_source IN ARRAY ARRAY[
    v_old_eligibility,
    v_old_projection,
    v_old_zero_policy
  ]::text[]
  LOOP
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_source, ''))
    ) / pg_catalog.length(v_source);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'projection v2 semantic anchor drifted: %/1',
        v_count;
    END IF;
  END LOOP;
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_eligibility,
    v_new_eligibility
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_projection,
    v_new_projection
  );
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_zero_policy,
    v_new_zero_policy
  );

  EXECUTE v_definition;
  ALTER FUNCTION arena.build_leaderboard_metric_trust_projection_v2(
    text, jsonb, jsonb
  ) OWNER TO postgres;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'::pg_catalog.regprocedure;
  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> 'b223a5c81a01d6e3a9b83d34dd4552d86f14124442f48359b11e81b4cd77957c' THEN
    RAISE EXCEPTION 'installed metric-trust projection v2 source drifted';
  END IF;
END
$install_v2$;

REVOKE ALL ON FUNCTION arena.build_leaderboard_metric_trust_projection_v2(
  text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

DO $owner_only_acl$
DECLARE
  v_function oid :=
    'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'::pg_catalog.regprocedure;
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee)
      AS role_name
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
      'REVOKE ALL ON FUNCTION arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb) FROM %I',
      v_role.role_name
    );
  END LOOP;
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.build_leaderboard_metric_trust_projection_v2(
  text, jsonb, jsonb
) IS
  'Owner-only inert Arena Score v5 input projection. Trusted WR/MDD zero is retained; incomplete evidence and MDD 100 remain excluded. No writer calls this version yet.';

DO $postflight$
DECLARE
  v_v1 pg_catalog.pg_proc%ROWTYPE;
  v_v2 pg_catalog.pg_proc%ROWTYPE;
  v_v5 oid := 'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;
  v_manifest_encoder oid :=
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  v_manifest_seal oid :=
    'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  v_manifest_verify oid :=
    'arena.verify_leaderboard_score_input_manifest_v2(uuid)'::pg_catalog.regprocedure;
  v_named_count integer;
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
BEGIN
  SELECT * INTO STRICT v_v1
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v2
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'::pg_catalog.regprocedure;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v1.prosrc, 'UTF8')),
       'hex'
     ) <> '6047c43ac685bb54a006cae1f3989e61c3a07236c71d03941ddeefd9c4338234'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v2.prosrc, 'UTF8')),
       'hex'
     ) <> 'b223a5c81a01d6e3a9b83d34dd4552d86f14124442f48359b11e81b4cd77957c'
     OR (
       pg_catalog.to_jsonb(v_v2)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_v1)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) THEN
    RAISE EXCEPTION 'metric-trust projection v1/v2 postflight drifted';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_named_count
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'arena'::pg_catalog.regnamespace
    AND function_row.proname =
      'build_leaderboard_metric_trust_projection_v2';
  IF v_named_count <> 1 THEN
    RAISE EXCEPTION 'metric-trust projection v2 overload postflight drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      (
        v_v5,
        '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae',
        'i'::"char",
        's'::"char",
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'extra_float_digits=3'
        ]::text[]
      ),
      (
        v_manifest_encoder,
        '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3',
        's'::"char",
        'u'::"char",
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'extra_float_digits=3',
          'quote_all_identifiers=off'
        ]::text[]
      ),
      (
        v_manifest_seal,
        '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42',
        'v'::"char",
        'u'::"char",
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
      ),
      (
        v_manifest_verify,
        '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e',
        's'::"char",
        'u'::"char",
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
      )
    ) AS expected(
      function_oid,
      source_sha256,
      volatility,
      parallel_safety,
      config
    )
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              function_row.prosrc,
              'UTF8'
            )),
            'hex'
          ) <> expected.source_sha256
       OR function_row.proowner <> v_v1.proowner
       OR function_row.prolang <> v_plpgsql
       OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
       OR function_row.prokind <> 'f'
       OR function_row.proretset
       OR function_row.proisstrict
       OR function_row.proleakproof
       OR function_row.prosecdef
       OR function_row.provolatile <> expected.volatility
       OR function_row.proparallel <> expected.parallel_safety
       OR function_row.proconfig IS DISTINCT FROM expected.config
  ) THEN
    RAISE EXCEPTION 'projection v2 dependency changed during installation';
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
    WHERE function_row.oid IN (
      v_v1.oid,
      v_v2.oid,
      v_v5,
      v_manifest_encoder,
      v_manifest_seal,
      v_manifest_verify
    )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      v_v1.oid,
      v_v2.oid,
      v_v5,
      v_manifest_encoder,
      v_manifest_seal,
      v_manifest_verify
    ]::oid[]) AS checked_function(function_oid)
    WHERE pg_catalog.has_function_privilege(
      checked_role.role_name,
      checked_function.function_oid,
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'metric-trust projection v2 leaked execution authority';
  END IF;
END
$postflight$;

COMMIT;
