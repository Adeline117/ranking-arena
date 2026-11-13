-- Migration: 20261113014105_arena_score_unknown_trades_confidence.sql
-- Description: Arena Score v4/v5 PG17 scorers — an unknown trade count
-- (NULL or <= 0) gets the sample confidence of ~5 real trades, 5/(5+50),
-- instead of the fixed 0.3 (= ~21.4 trades). With 0.3 a zero/unknown-trade
-- account out-scored real traders with 1-21 trades (audit 2026-11-12 probe:
-- t=0 -> 60.6, t=1 -> 23.1, t=10 -> 47.7, t=21 -> 59.9). The TypeScript
-- scorer (lib/utils/arena-score.ts, V4 and V5) changes in the same commit and
-- the golden vectors were re-issued, so TS/PG17 parity holds.
--
-- THIS IS A SCORING-DEFINITION CHANGE. Every published score that relies on
-- an unknown trade count moves. It must ship together with the TS change and
-- the re-issued golden vectors; it is NOT applied by this commit.
--
-- Mechanics (same derive-from-catalog pattern as 20260729070000 / 070500):
--   1. Preflight: both scorers must be byte-identical to their reviewed
--      sources (prosrc sha256), and the definition-digest formula used by the
--      manifest encoders must reproduce the reviewed v1/v2 digests.
--   2. Rewrite exactly one needle in each scorer via pg_get_functiondef +
--      CREATE OR REPLACE (owner, ACL, SET clauses and volatility preserved).
--   3. Every other arena/public function whose body pins one of the four old
--      fingerprints (v4/v5 prosrc sha256, v1/v2 definition digest) is
--      re-created with the new fingerprints, so the manifest encoders and
--      verifiers bind to the new definitions.
--   4. Postflight: pinned new fingerprints, no old fingerprint left anywhere.
-- Historical score-input manifests sealed under the old definition will no
-- longer verify against the live scorer (their definition digest differs) —
-- intended: the definition changed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $unknown_trades_confidence$
DECLARE
  v_v4 oid := pg_catalog.to_regprocedure('arena.compute_arena_scores_v4_json(text,jsonb)');
  v_v5 oid := pg_catalog.to_regprocedure('arena.compute_arena_scores_v5_json(text,jsonb)');
  v_round2 oid := pg_catalog.to_regprocedure('arena.arena_score_v4_round2(double precision)');
  v_arena oid := pg_catalog.to_regnamespace('arena');
  v_public oid := pg_catalog.to_regnamespace('public');

  c_v4_src_old constant text :=
    'a3c245893d5a939020f70c70d09e41bf2e5b28e3ad640daf619c264c3bb530ba';
  c_v5_src_old constant text :=
    '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae';
  c_v1_def_old constant text :=
    '845039eaafed171ea040409281e0a49aa127c69d48005d07b6228bd0b1bf56d9';
  c_v2_def_old constant text :=
    'a77fc9863c8e349aaea062c69ed5057167c5800383c6d9830d8214251cea6b18';
  c_v4_src_new constant text := '916666cd6d6fed9f66e12ba5236928cdea5816c32942524eb4b3a19cd812a686';
  c_v5_src_new constant text := '45fc5c5c5d20afb7a2d5047ec635b79053a009651f6ea9e2c8c0b76e56b1b84d';
  c_v1_def_new constant text := 'da0e644623441dfa6e50ca957c607350216175f0e9172ce156f1c3be129b1e33';
  c_v2_def_new constant text := 'e4c88c9ffb921ac4a66813f9485eaa0ddd353e48f1db51129cf7ed00a3b9d324';
  -- The ONLY reviewed functions whose bodies pin an old fingerprint: the
  -- score-input manifest encoders (v1 pins the v4 definition digest, v2 the
  -- v5 one). Either may be absent in a scorer-only catalog; any other function
  -- carrying an old fingerprint is unreviewed and aborts the migration.
  v_encoder_v1 oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'
  );
  v_encoder_v2 oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'
  );
  v_expected_dependents integer;

  c_needle constant text :=
    $needle$          THEN 0.3::double precision
$needle$;
  c_replacement constant text :=
    $replacement$          THEN (5::double precision / (5::double precision + 50::double precision))
$replacement$;

  v_v4_src text;
  v_v5_src text;
  v_definition text;
  v_count integer;
  v_dependents integer := 0;
  v_function record;
  v_scorer oid;
  v_v1_def text;
  v_v2_def text;
BEGIN
  IF v_v4 IS NULL OR v_v5 IS NULL OR v_round2 IS NULL OR v_arena IS NULL THEN
    RAISE EXCEPTION 'Arena Score v4/v5 PG17 scorers must exist before the unknown-trades change';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_v4_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v4;
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_v5_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v5;

  IF v_v4_src = c_v4_src_new AND v_v5_src = c_v5_src_new THEN
    -- Already applied: only prove that no old fingerprint survived.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.pronamespace IN (v_arena, v_public)
        AND (
          pg_catalog.strpos(f.prosrc, c_v4_src_old) > 0
          OR pg_catalog.strpos(f.prosrc, c_v5_src_old) > 0
          OR pg_catalog.strpos(f.prosrc, c_v1_def_old) > 0
          OR pg_catalog.strpos(f.prosrc, c_v2_def_old) > 0
        )
    ) THEN
      RAISE EXCEPTION 'unknown-trades scorer applied but an old scorer fingerprint survived';
    END IF;
    RETURN;
  END IF;

  IF v_v4_src <> c_v4_src_old OR v_v5_src <> c_v5_src_old THEN
    RAISE EXCEPTION 'Arena Score v4/v5 scorer source drifted before the unknown-trades change: %, %',
      v_v4_src, v_v5_src;
  END IF;

  -- The encoders' definition-digest formula must reproduce the reviewed
  -- digests before we trust it to compute the replacements.
  IF pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
       pg_catalog.jsonb_build_object(
         'contract', 'arena-score-v4-pg17-definition@1',
         'postgresMajor', 17,
         'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
         'scorerDefinition', pg_catalog.pg_get_functiondef(v_v4)
       )::text, 'UTF8'), 'sha256'), 'hex') <> c_v1_def_old
     OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
       pg_catalog.jsonb_build_object(
         'contract', 'arena-score-v5-pg17-definition@1',
         'postgresMajor', 17,
         'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
         'scorerDefinition', pg_catalog.pg_get_functiondef(v_v5)
       )::text, 'UTF8'), 'sha256'), 'hex') <> c_v2_def_old THEN
    RAISE EXCEPTION 'scorer definition-digest formula no longer reproduces the reviewed digests';
  END IF;

  -- Rewrite exactly one needle per scorer.
  FOREACH v_scorer IN ARRAY ARRAY[v_v4, v_v5]::oid[] LOOP
    v_definition := pg_catalog.pg_get_functiondef(v_scorer);
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, c_needle, ''))
    ) / pg_catalog.length(c_needle);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'expected exactly one unknown-trades needle in %, found %',
        v_scorer::pg_catalog.regprocedure, v_count;
    END IF;
    EXECUTE pg_catalog.replace(v_definition, c_needle, c_replacement);
  END LOOP;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_v4_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v4;
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_v5_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v5;
  v_v1_def := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v4-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v4)
    )::text, 'UTF8'), 'sha256'), 'hex');
  v_v2_def := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v5-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v5)
    )::text, 'UTF8'), 'sha256'), 'hex');
  RAISE NOTICE 'unknown-trades fingerprints: v4_src=% v5_src=% v1_def=% v2_def=%',
    v_v4_src, v_v5_src, v_v1_def, v_v2_def;
  IF v_v4_src <> c_v4_src_new OR v_v5_src <> c_v5_src_new
     OR v_v1_def <> c_v1_def_new OR v_v2_def <> c_v2_def_new THEN
    RAISE EXCEPTION 'unknown-trades scorer fingerprints differ from the reviewed values: %, %, %, %',
      v_v4_src, v_v5_src, v_v1_def, v_v2_def;
  END IF;

  -- Re-bind every dependent function that pins an old fingerprint.
  FOR v_function IN
    SELECT f.oid
    FROM pg_catalog.pg_proc AS f
    WHERE f.pronamespace IN (v_arena, v_public)
      AND f.oid NOT IN (v_v4, v_v5)
      AND (
        pg_catalog.strpos(f.prosrc, c_v4_src_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v5_src_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v1_def_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v2_def_old) > 0
      )
    ORDER BY f.oid
  LOOP
    IF v_function.oid IS DISTINCT FROM v_encoder_v1 AND v_function.oid IS DISTINCT FROM v_encoder_v2 THEN
      RAISE EXCEPTION 'unreviewed function % pins an old Arena Score fingerprint',
        v_function.oid::pg_catalog.regprocedure;
    END IF;
    v_definition := pg_catalog.pg_get_functiondef(v_function.oid);
    v_definition := pg_catalog.replace(v_definition, c_v4_src_old, c_v4_src_new);
    v_definition := pg_catalog.replace(v_definition, c_v5_src_old, c_v5_src_new);
    v_definition := pg_catalog.replace(v_definition, c_v1_def_old, c_v1_def_new);
    v_definition := pg_catalog.replace(v_definition, c_v2_def_old, c_v2_def_new);
    EXECUTE v_definition;
    v_dependents := v_dependents + 1;
    RAISE NOTICE 'unknown-trades re-bound dependent %', v_function.oid::pg_catalog.regprocedure;
  END LOOP;

  v_expected_dependents :=
    (v_encoder_v1 IS NOT NULL)::integer + (v_encoder_v2 IS NOT NULL)::integer;
  IF v_dependents <> v_expected_dependents THEN
    RAISE EXCEPTION 'unknown-trades change re-bound % dependent functions, expected %',
      v_dependents, v_expected_dependents;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS f
    WHERE f.pronamespace IN (v_arena, v_public)
      AND (
        pg_catalog.strpos(f.prosrc, c_v4_src_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v5_src_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v1_def_old) > 0
        OR pg_catalog.strpos(f.prosrc, c_v2_def_old) > 0
      )
  ) THEN
    RAISE EXCEPTION 'an old scorer fingerprint survived the unknown-trades change';
  END IF;
END
$unknown_trades_confidence$;

COMMIT;
