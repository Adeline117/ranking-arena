-- Migration: 20260729070500_leaderboard_score_input_manifest_v2.sql
-- Description: Add an owner-only score-input manifest v2 bound to Arena Score
-- v5. Historical v1 rows and functions remain byte-for-byte verifiable. V2
-- requires concrete PnL, win-rate, and maximum-drawdown observations; trusted
-- zero is valid, null is unknown, and the 100% MDD policy cap is not rankable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

DO $preflight$
DECLARE
  v_table oid := pg_catalog.to_regclass(
    'arena.leaderboard_score_input_manifests'
  );
  v_v1_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_v1_seal oid := pg_catalog.to_regprocedure(
    'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_v1_verify oid := pg_catalog.to_regprocedure(
    'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
  );
  v_v2_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_v2_seal oid := pg_catalog.to_regprocedure(
    'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_v2_verify oid := pg_catalog.to_regprocedure(
    'arena.verify_leaderboard_score_input_manifest_v2(uuid)'
  );
  v_v5_scorer oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v5_json(text,jsonb)'
  );
  v_round2 oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_v1_encoder_row pg_catalog.pg_proc%ROWTYPE;
  v_v1_seal_row pg_catalog.pg_proc%ROWTYPE;
  v_v1_verify_row pg_catalog.pg_proc%ROWTYPE;
  v_v2_encoder_row pg_catalog.pg_proc%ROWTYPE;
  v_v2_seal_row pg_catalog.pg_proc%ROWTYPE;
  v_v2_verify_row pg_catalog.pg_proc%ROWTYPE;
  v_v5_scorer_row pg_catalog.pg_proc%ROWTYPE;
  v_round2_row pg_catalog.pg_proc%ROWTYPE;
  v_table_row pg_catalog.pg_class%ROWTYPE;
  v_scalar_hash text;
  v_required_metrics_hash text;
  v_pnl_hash text;
  v_v2_function_count integer;
  v_v2_named_function_count integer;
  v_definition_digest text;
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'leaderboard score-input manifest v2 requires PostgreSQL 17';
  END IF;
  IF v_table IS NULL
     OR v_v1_encoder IS NULL
     OR v_v1_seal IS NULL
     OR v_v1_verify IS NULL
     OR v_v5_scorer IS NULL
     OR v_round2 IS NULL
     OR v_plpgsql IS NULL THEN
    RAISE EXCEPTION 'exact v1 manifest and Arena Score v5 prerequisites must exist';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist before manifest v2';
  END IF;
  IF pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) must exist';
  END IF;

  SELECT * INTO STRICT v_v1_encoder_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v1_encoder;
  SELECT * INTO STRICT v_v1_seal_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v1_seal;
  SELECT * INTO STRICT v_v1_verify_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v1_verify;
  SELECT * INTO STRICT v_v5_scorer_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_v5_scorer;
  SELECT * INTO STRICT v_round2_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_round2;
  SELECT * INTO STRICT v_table_row
  FROM pg_catalog.pg_class AS relation_row
  WHERE relation_row.oid = v_table;

  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v1_encoder_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v1_seal_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '50f06dfb9f552ac48e244270fc52568f21f9f144f9e5c6b7b1e6a4967fb44218'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v1_verify_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc'
     OR v_v1_encoder_row.proowner <> v_v1_seal_row.proowner
     OR v_v1_encoder_row.proowner <> v_v1_verify_row.proowner
     OR v_v1_encoder_row.prolang <> v_plpgsql
     OR v_v1_seal_row.prolang <> v_plpgsql
     OR v_v1_verify_row.prolang <> v_plpgsql
     OR v_v1_encoder_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_v1_seal_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_v1_verify_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_v1_encoder_row.prokind <> 'f'
     OR v_v1_seal_row.prokind <> 'f'
     OR v_v1_verify_row.prokind <> 'f'
     OR v_v1_encoder_row.proretset
     OR v_v1_seal_row.proretset
     OR v_v1_verify_row.proretset
     OR v_v1_encoder_row.proisstrict
     OR v_v1_seal_row.proisstrict
     OR v_v1_verify_row.proisstrict
     OR v_v1_encoder_row.proleakproof
     OR v_v1_seal_row.proleakproof
     OR v_v1_verify_row.proleakproof
     OR v_v1_encoder_row.prosecdef
     OR v_v1_seal_row.prosecdef
     OR v_v1_verify_row.prosecdef
     OR v_v1_encoder_row.provolatile <> 's'
     OR v_v1_seal_row.provolatile <> 'v'
     OR v_v1_verify_row.provolatile <> 's'
     OR v_v1_encoder_row.proparallel <> 'u'
     OR v_v1_seal_row.proparallel <> 'u'
     OR v_v1_verify_row.proparallel <> 'u'
     OR v_v1_encoder_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'extra_float_digits=3',
       'quote_all_identifiers=off'
     ]::pg_catalog.text[]
     OR v_v1_seal_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_v1_verify_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION 'v1 score-input manifest function contract drifted';
  END IF;
  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_v5_scorer_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(v_round2_row.prosrc, 'UTF8')
       ),
       'hex'
     ) <> '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3'
     OR v_v5_scorer_row.proowner <> v_v1_encoder_row.proowner
     OR v_round2_row.proowner <> v_v1_encoder_row.proowner
     OR v_table_row.relowner <> v_v1_encoder_row.proowner
     OR v_table_row.relkind <> 'r'
     OR NOT v_table_row.relrowsecurity
     OR v_v5_scorer_row.prolang <> v_plpgsql
     OR v_round2_row.prolang <> v_plpgsql
     OR v_v5_scorer_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_round2_row.prorettype <> 'double precision'::pg_catalog.regtype
     OR v_v5_scorer_row.prokind <> 'f'
     OR v_round2_row.prokind <> 'f'
     OR v_v5_scorer_row.proretset
     OR v_round2_row.proretset
     OR v_v5_scorer_row.proisstrict
     OR NOT v_round2_row.proisstrict
     OR v_v5_scorer_row.proleakproof
     OR v_round2_row.proleakproof
     OR v_v5_scorer_row.prosecdef
     OR v_round2_row.prosecdef
     OR v_v5_scorer_row.provolatile <> 'i'
     OR v_round2_row.provolatile <> 'i'
     OR v_v5_scorer_row.proparallel <> 's'
     OR v_round2_row.proparallel <> 's'
     OR v_v5_scorer_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'extra_float_digits=3'
     ]::pg_catalog.text[]
     OR v_round2_row.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION 'manifest v2 scorer or table prerequisite drifted';
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
      v_v1_encoder,
      v_v1_seal,
      v_v1_verify,
      v_v5_scorer,
      v_round2
    )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      v_v1_encoder,
      v_v1_seal,
      v_v1_verify,
      v_v5_scorer,
      v_round2
    ]::oid[]) AS checked_function(function_oid)
    WHERE pg_catalog.has_function_privilege(
      checked_role.role_name,
      checked_function.function_oid,
      'EXECUTE'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS privilege_row
    WHERE relation_row.oid = v_table
      AND privilege_row.grantee <> relation_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER'
    ]::text[]) AS checked_privilege(privilege_name)
    WHERE pg_catalog.has_table_privilege(
      checked_role.role_name,
      v_table,
      checked_privilege.privilege_name
    )
  ) THEN
    RAISE EXCEPTION 'manifest v2 prerequisite authority boundary drifted';
  END IF;

  v_definition_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'arena-score-v5-pg17-definition@1',
          'postgresMajor', 17,
          'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
          'scorerDefinition', pg_catalog.pg_get_functiondef(v_v5_scorer)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_definition_digest IS DISTINCT FROM
       'a77fc9863c8e349aaea062c69ed5057167c5800383c6d9830d8214251cea6b18' THEN
    RAISE EXCEPTION 'Arena Score v5 definition contract drifted: %',
      v_definition_digest;
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_scalar_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_scalar_binding'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO v_required_metrics_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_v2_required_metrics'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_pnl_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_rank_eligible_pnl'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;
  IF v_pnl_hash <>
       'f6c94c39b1b299130644e7d8cb349bc72a8b98907a744f476aa94caf46930caf' THEN
    RAISE EXCEPTION 'rank-eligible PnL manifest constraint drifted';
  END IF;

  v_v2_function_count := pg_catalog.num_nonnulls(
    v_v2_encoder,
    v_v2_seal,
    v_v2_verify
  );
  IF v_v2_function_count NOT IN (0, 3) THEN
    RAISE EXCEPTION 'partial manifest v2 function installation detected';
  END IF;
  SELECT pg_catalog.count(*)
  INTO STRICT v_v2_named_function_count
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'arena'::pg_catalog.regnamespace
    AND function_row.proname IN (
      'encode_leaderboard_score_input_manifest_v2',
      'seal_leaderboard_score_input_manifest_v2',
      'verify_leaderboard_score_input_manifest_v2'
    );
  IF v_v2_named_function_count <> v_v2_function_count THEN
    RAISE EXCEPTION 'noncanonical manifest v2 function overload detected';
  END IF;

  IF v_v2_function_count = 0 THEN
    IF v_scalar_hash IS DISTINCT FROM
         'ab4c55e0eadf275a448b334212b7c40d4c54db62cc52f616ac3402a9609fdc89'
       OR v_required_metrics_hash IS NOT NULL THEN
      RAISE EXCEPTION 'manifest table is not at the exact v1 prerequisite state';
    END IF;
  ELSE
    IF v_scalar_hash IS DISTINCT FROM
         '97db10ed42bebdd97e938c712c7a1c02c56e5eeb95b952c2e8d655ed1a103cf5'
       OR v_required_metrics_hash IS DISTINCT FROM
         '5634c576d03962d3510db4f49582b8c729d3a7481038b7e70b252ecf5bd35ffe' THEN
      RAISE EXCEPTION 'manifest v2 table constraints drifted';
    END IF;

    SELECT * INTO STRICT v_v2_encoder_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v2_encoder;
    SELECT * INTO STRICT v_v2_seal_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v2_seal;
    SELECT * INTO STRICT v_v2_verify_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v2_verify;

    IF pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(v_v2_encoder_row.prosrc, 'UTF8')
         ),
         'hex'
       ) <> '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3'
       OR pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(v_v2_seal_row.prosrc, 'UTF8')
         ),
         'hex'
       ) <> '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42'
       OR pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(v_v2_verify_row.prosrc, 'UTF8')
         ),
         'hex'
       ) <> '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e'
       OR (
         pg_catalog.to_jsonb(v_v2_encoder_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(v_v1_encoder_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       )
       OR (
         pg_catalog.to_jsonb(v_v2_seal_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(v_v1_seal_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       )
       OR (
         pg_catalog.to_jsonb(v_v2_verify_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) IS DISTINCT FROM (
         pg_catalog.to_jsonb(v_v1_verify_row)
           - 'oid' - 'proname' - 'prosrc' - 'proacl'
       ) THEN
      RAISE EXCEPTION 'existing manifest v2 function contract drifted';
    END IF;
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.leaderboard_score_input_manifests
  IN ACCESS EXCLUSIVE MODE;

DO $broaden_table_contract$
DECLARE
  v_table oid := 'arena.leaderboard_score_input_manifests'::pg_catalog.regclass;
  v_scalar_hash text;
BEGIN
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_scalar_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_scalar_binding';

  IF v_scalar_hash =
       '97db10ed42bebdd97e938c712c7a1c02c56e5eeb95b952c2e8d655ed1a103cf5' THEN
    RETURN;
  ELSIF v_scalar_hash <>
       'ab4c55e0eadf275a448b334212b7c40d4c54db62cc52f616ac3402a9609fdc89' THEN
    RAISE EXCEPTION 'manifest scalar binding drifted before v2';
  END IF;

  ALTER TABLE arena.leaderboard_score_input_manifests
    DROP CONSTRAINT leaderboard_score_input_manifest_scalar_binding;
  ALTER TABLE arena.leaderboard_score_input_manifests
    ADD CONSTRAINT leaderboard_score_input_manifest_scalar_binding
    CHECK (
      (
        manifest->>'contract' IN (
          'leaderboard-score-input-manifest@1',
          'leaderboard-score-input-manifest@2'
        )
        AND manifest->>'manifestDigest' = manifest_digest
        AND manifest->>'period' = period
        AND (manifest->>'validUntil')::timestamp with time zone = valid_until
      ) IS TRUE
    ) NOT VALID;
  ALTER TABLE arena.leaderboard_score_input_manifests
    VALIDATE CONSTRAINT leaderboard_score_input_manifest_scalar_binding;

  ALTER TABLE arena.leaderboard_score_input_manifests
    ADD CONSTRAINT leaderboard_score_input_manifest_v2_required_metrics
    CHECK (
      (
        manifest->>'contract' <> 'leaderboard-score-input-manifest@2'
        OR (
          pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
          AND pg_catalog.jsonb_array_length(manifest->'inputs') =
              pg_catalog.jsonb_array_length(
                pg_catalog.jsonb_path_query_array(
                  manifest->'inputs',
                  '$[*] ? (
                    @.win_rate.type() == "number"
                    && @.max_drawdown.type() == "number"
                    && @.win_rate >= 0
                    && @.win_rate <= 100
                    && @.max_drawdown >= 0
                    && @.max_drawdown < 100
                  )'::pg_catalog.jsonpath
                )
              )
        )
      ) IS TRUE
    ) NOT VALID;
  ALTER TABLE arena.leaderboard_score_input_manifests
    VALIDATE CONSTRAINT
      leaderboard_score_input_manifest_v2_required_metrics;
END
$broaden_table_contract$;

DO $install_v2_functions$
DECLARE
  v_definition text;
  v_source text;
  v_count integer;
  v_risk_anchor constant text :=
    $anchor$  -- Rebuild canonical inputs from the same parsed float8/integer domain as the
$anchor$;
  v_risk_guard constant text :=
    $guard$  -- V2 ranking inputs require concrete risk observations. A trusted zero is a
  -- number, while null or a 100% drawdown cap remains outside public ranking.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'win_rate')
            IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(input_row.value->'max_drawdown')
            IS DISTINCT FROM 'number'
       OR (input_row.value->>'win_rate')::numeric < 0
       OR (input_row.value->>'win_rate')::numeric > 100
       OR (input_row.value->>'max_drawdown')::numeric < 0
       OR (input_row.value->>'max_drawdown')::numeric >= 100
  ) THEN
    RAISE EXCEPTION 'v2 leaderboard score inputs require win rate in [0,100] and maximum drawdown in [0,100)'
      USING ERRCODE = '22023';
  END IF;

$guard$;
  v_verify_anchor constant text :=
    $anchor$  WHERE stored.manifest_id = p_manifest_id;

$anchor$;
  v_verify_gate constant text :=
    $gate$  IF v_row.manifest->>'contract' IS DISTINCT FROM
       'leaderboard-score-input-manifest@2' THEN
    RAISE EXCEPTION 'v2 verifier requires a v2 score-input manifest'
      USING ERRCODE = '22023';
  END IF;

$gate$;
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
     ) IS NOT NULL THEN
    RETURN;
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'encode_leaderboard_score_input_manifest_v1',
        ''
      ))
  ) / pg_catalog.length('encode_leaderboard_score_input_manifest_v1');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'manifest v2 encoder name anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    'encode_leaderboard_score_input_manifest_v1',
    'encode_leaderboard_score_input_manifest_v2'
  );
  v_definition := pg_catalog.replace(v_definition, 'v4', 'v5');
  v_definition := pg_catalog.replace(
    v_definition,
    'arena.arena_score_v5_round2',
    'arena.arena_score_v4_round2'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '845039eaafed171ea040409281e0a49aa127c69d48005d07b6228bd0b1bf56d9',
    'a77fc9863c8e349aaea062c69ed5057167c5800383c6d9830d8214251cea6b18'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'leaderboard-score-input-manifest@1',
    'leaderboard-score-input-manifest@2'
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(
        pg_catalog.replace(v_definition, v_risk_anchor, '')
      )
  ) / pg_catalog.length(v_risk_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'manifest v2 risk guard anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    v_risk_anchor,
    v_risk_guard || v_risk_anchor
  );
  EXECUTE v_definition;

  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3' THEN
    RAISE EXCEPTION 'installed manifest v2 encoder source digest mismatch';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'seal_leaderboard_score_input_manifest_v1',
        ''
      ))
  ) / pg_catalog.length('seal_leaderboard_score_input_manifest_v1');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'manifest v2 sealer name anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    'seal_leaderboard_score_input_manifest_v1',
    'seal_leaderboard_score_input_manifest_v2'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'encode_leaderboard_score_input_manifest_v1',
    'encode_leaderboard_score_input_manifest_v2'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'leaderboard-score-input-manifest-seal@1',
    'leaderboard-score-input-manifest-seal@2'
  );
  EXECUTE v_definition;

  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42' THEN
    RAISE EXCEPTION 'installed manifest v2 sealer source digest mismatch';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::pg_catalog.regprocedure
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(
        v_definition,
        'verify_leaderboard_score_input_manifest_v1',
        ''
      ))
  ) / pg_catalog.length('verify_leaderboard_score_input_manifest_v1');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'manifest v2 verifier name anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    'verify_leaderboard_score_input_manifest_v1',
    'verify_leaderboard_score_input_manifest_v2'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'encode_leaderboard_score_input_manifest_v1',
    'encode_leaderboard_score_input_manifest_v2'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'leaderboard-score-input-manifest-verification@1',
    'leaderboard-score-input-manifest-verification@2'
  );
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(
        pg_catalog.replace(v_definition, v_verify_anchor, '')
      )
  ) / pg_catalog.length(v_verify_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'manifest v2 verifier gate anchor drifted: %/1', v_count;
  END IF;
  v_definition := pg_catalog.replace(
    v_definition,
    v_verify_anchor,
    v_verify_anchor || v_verify_gate
  );
  EXECUTE v_definition;

  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.verify_leaderboard_score_input_manifest_v2(uuid)'::pg_catalog.regprocedure;
  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
       'hex'
     ) <> '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e' THEN
    RAISE EXCEPTION 'installed manifest v2 verifier source digest mismatch';
  END IF;
END
$install_v2_functions$;

REVOKE ALL ON FUNCTION arena.encode_leaderboard_score_input_manifest_v2(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.seal_leaderboard_score_input_manifest_v2(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.verify_leaderboard_score_input_manifest_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $owner_only_acl$
DECLARE
  v_signature text;
  v_role record;
BEGIN
  FOR v_signature IN
    SELECT signature.value
    FROM pg_catalog.unnest(ARRAY[
      'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.verify_leaderboard_score_input_manifest_v2(uuid)'
    ]::text[]) AS signature(value)
  LOOP
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
      WHERE function_row.oid = pg_catalog.to_regprocedure(v_signature)
        AND privilege_row.privilege_type = 'EXECUTE'
        AND privilege_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %I',
        v_signature,
        v_role.role_name
      );
    END LOOP;
  END LOOP;
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.encode_leaderboard_score_input_manifest_v2(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) IS
  'Private parsed-jsonb codec for Arena Score v5. PnL, win rate, and maximum drawdown must be concrete; trusted zero is valid and MDD 100 is policy-excluded. Owner-only.';
COMMENT ON FUNCTION arena.seal_leaderboard_score_input_manifest_v2(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) IS
  'Private content-addressed Arena Score v5 manifest sealer. It does not change public rankings. Owner-only.';
COMMENT ON FUNCTION arena.verify_leaderboard_score_input_manifest_v2(uuid) IS
  'Private v2 manifest verifier. It accepts only leaderboard-score-input-manifest@2 rows and leaves v1 verification unchanged. Owner-only.';

DO $postflight$
DECLARE
  v_table oid := 'arena.leaderboard_score_input_manifests'::pg_catalog.regclass;
  v_v1_encoder pg_catalog.pg_proc%ROWTYPE;
  v_v1_seal pg_catalog.pg_proc%ROWTYPE;
  v_v1_verify pg_catalog.pg_proc%ROWTYPE;
  v_v2_encoder pg_catalog.pg_proc%ROWTYPE;
  v_v2_seal pg_catalog.pg_proc%ROWTYPE;
  v_v2_verify pg_catalog.pg_proc%ROWTYPE;
  v_v5_scorer oid := 'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;
  v_round2 oid := 'arena.arena_score_v4_round2(double precision)'::pg_catalog.regprocedure;
  v_scalar_hash text;
  v_required_metrics_hash text;
  v_pnl_hash text;
  v_v2_named_function_count integer;
BEGIN
  SELECT * INTO STRICT v_v1_encoder FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v1_seal FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v1_verify FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v2_encoder FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v2_seal FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.seal_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure;
  SELECT * INTO STRICT v_v2_verify FROM pg_catalog.pg_proc
  WHERE oid =
    'arena.verify_leaderboard_score_input_manifest_v2(uuid)'::pg_catalog.regprocedure;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v1_encoder.prosrc, 'UTF8')),
       'hex'
     ) <> '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v1_seal.prosrc, 'UTF8')),
       'hex'
     ) <> '50f06dfb9f552ac48e244270fc52568f21f9f144f9e5c6b7b1e6a4967fb44218'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v1_verify.prosrc, 'UTF8')),
       'hex'
     ) <> '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v2_encoder.prosrc, 'UTF8')),
       'hex'
     ) <> '2e6c0515597bb448e9841ba351c6c3539a27e65a5753f214f1c164b433f81ae3'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v2_seal.prosrc, 'UTF8')),
       'hex'
     ) <> '7b2bf9eedf06c25d1b2a42259f31fa80ecb7b6cdf99952ee5c7e80efde166f42'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_v2_verify.prosrc, 'UTF8')),
       'hex'
     ) <> '22b1a5ab4db7a0141f661cdeb5b45a97bf9153beab6f05cc1a5483359fbf671e'
     OR (
       pg_catalog.to_jsonb(v_v2_encoder)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_v1_encoder)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     )
     OR (
       pg_catalog.to_jsonb(v_v2_seal)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_v1_seal)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     )
     OR (
       pg_catalog.to_jsonb(v_v2_verify)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_v1_verify)
         - 'oid' - 'proname' - 'prosrc' - 'proacl'
     ) THEN
    RAISE EXCEPTION 'manifest v1/v2 function postflight drifted';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_scalar_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_scalar_binding'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_required_metrics_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_v2_required_metrics'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ),
             'UTF8'
           )),
           'hex'
         )
  INTO STRICT v_pnl_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'leaderboard_score_input_manifest_rank_eligible_pnl'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;
  IF v_scalar_hash <>
       '97db10ed42bebdd97e938c712c7a1c02c56e5eeb95b952c2e8d655ed1a103cf5'
     OR v_required_metrics_hash <>
       '5634c576d03962d3510db4f49582b8c729d3a7481038b7e70b252ecf5bd35ffe'
     OR v_pnl_hash <>
       'f6c94c39b1b299130644e7d8cb349bc72a8b98907a744f476aa94caf46930caf' THEN
    RAISE EXCEPTION 'manifest v2 constraint postflight drifted';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_v2_named_function_count
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'arena'::pg_catalog.regnamespace
    AND function_row.proname IN (
      'encode_leaderboard_score_input_manifest_v2',
      'seal_leaderboard_score_input_manifest_v2',
      'verify_leaderboard_score_input_manifest_v2'
    );
  IF v_v2_named_function_count <> 3 THEN
    RAISE EXCEPTION 'manifest v2 function overload postflight drifted';
  END IF;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(
         (SELECT function_row.prosrc
          FROM pg_catalog.pg_proc AS function_row
          WHERE function_row.oid = v_v5_scorer),
         'UTF8'
       )),
       'hex'
     ) <> '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae'
     OR pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(
         (SELECT function_row.prosrc
          FROM pg_catalog.pg_proc AS function_row
          WHERE function_row.oid = v_round2),
         'UTF8'
       )),
       'hex'
     ) <> '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3'
     OR NOT (
       SELECT relation_row.relrowsecurity
          AND relation_row.relowner = v_v1_encoder.proowner
       FROM pg_catalog.pg_class AS relation_row
       WHERE relation_row.oid = v_table
     ) THEN
    RAISE EXCEPTION 'manifest v2 prerequisite changed during installation';
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
      v_v1_encoder.oid,
      v_v1_seal.oid,
      v_v1_verify.oid,
      v_v2_encoder.oid,
      v_v2_seal.oid,
      v_v2_verify.oid,
      v_v5_scorer,
      v_round2
    )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      v_v1_encoder.oid,
      v_v1_seal.oid,
      v_v1_verify.oid,
      v_v2_encoder.oid,
      v_v2_seal.oid,
      v_v2_verify.oid,
      v_v5_scorer,
      v_round2
    ]::oid[]) AS checked_function(function_oid)
    WHERE pg_catalog.has_function_privilege(
      checked_role.role_name,
      checked_function.function_oid,
      'EXECUTE'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS privilege_row
    WHERE relation_row.oid = v_table
      AND privilege_row.grantee <> relation_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER'
    ]::text[]) AS checked_privilege(privilege_name)
    WHERE pg_catalog.has_table_privilege(
      checked_role.role_name,
      v_table,
      checked_privilege.privilege_name
    )
  ) THEN
    RAISE EXCEPTION 'manifest v2 authority boundary drifted during installation';
  END IF;
END
$postflight$;

COMMIT;
