-- Migration: 20261118161307_tier_a_window_receipt_exhaustion_branch.sql
-- Forward repair: a Tier-A window receipt could not be recorded for a board
-- whose completeness is proven by exhaustion.
--
-- 20261115141050 added a second completeness mode, "exhausted", for boards
-- that report no total (okx_futures, okx_spot, binance_web3_bsc today; every
-- later exhaustion or reported_total_drift source). Their terminal outcome is
-- by design terminal_state 'unknown' / population_state 'unknown' / reason_code
-- 'population_unknown', authorized by recorded exhaustion evidence
-- (arena.leaderboard_outcome_exhaustion_bound). Publication
-- (public.rank_publication_trust_evidence) and metric-trust authority accept
-- that branch, but arena.record_tier_a_execution_window_receipt
-- (20260729015500) still requires terminal_state 'complete'. After a
-- successful exhaustion publication the worker's receipt call raised
-- 'Tier-A window receipt evidence is incomplete or mismatched' (55000), the
-- worker logged "Tier-A execution window receipt record failed
-- (unavailable)" and failed the job although its snapshot and evidence had
-- already committed.
--
-- This migration re-creates the function with exactly one change: the
-- terminal predicate becomes "complete OR exhaustion branch". The branch
-- mirrors 20261115141050 (validate_metric_trust_attempt_outcome_authority) and
-- 20261118112703: terminal unknown / population unknown / report unknown / no
-- reported total / reason_code population_unknown / exhaustion evidence
-- recorded and still holding. leaderboard_outcome_exhaustion_bound already
-- covers the reported_total_drift board version (20261118114230 replaced only
-- the completeness check it calls). The predicate is closed with IS NOT TRUE,
-- so a NULL anywhere refuses. Every other condition (claim, attempt, queue,
-- cycle, source run, payload, snapshot identity, count check, not derived) is
-- unchanged, as are owner, SECURITY DEFINER, configuration and ACL (CREATE OR
-- REPLACE keeps them; the postcheck proves it). Only the SET clauses the
-- reviewed function already had are used: no custom parameter.
--
-- The worker pins this body (TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256S in
-- worker/src/ingest/attempt-bound-capture-readiness.ts). The worker release
-- that accepts both the previous and this digest must serve first; after
-- that this migration may be applied at any time.
--
-- POSTDEPLOY, after 20261115141050 (predeploy). It touches no table 192134
-- guards and replaces no function 192134 pins.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_sha256 text;
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_outcome_exhaustion_bound(bigint)'
     ) IS NULL THEN
    RAISE EXCEPTION 'receipt exhaustion branch requires the Tier-A receipt RPC (20260729015500) and exhaustion completeness (20261115141050)';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
    INTO STRICT v_sha256
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
         'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure;

  -- The reviewed 20260729015500 body, or this migration's own body (replay).
  IF v_sha256 IS DISTINCT FROM 'e5bb12bf86a5ac29154c8e6e38d1225d9cb356231d358b464e73bdf1463ba887'
     AND v_sha256 IS DISTINCT FROM '8f23cbae0358f200dc7b2a0f4e00c7e218470ba1427968aa9fab0e390e8e1ef3' THEN
    RAISE EXCEPTION 'Tier-A window receipt RPC body drifted from the reviewed 20260729015500 body: %', v_sha256;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_receipt(
  p_claim_id uuid,
  p_generation_seq bigint,
  p_attempt_id uuid,
  p_snapshot_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '10s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_claim arena.tier_a_execution_claims%ROWTYPE;
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_outcome arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_snapshot arena.leaderboard_snapshots%ROWTYPE;
  v_existing arena.tier_a_execution_window_receipts%ROWTYPE;
  v_inserted arena.tier_a_execution_window_receipts%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_claim_id IS NULL
     OR p_generation_seq IS NULL
     OR p_generation_seq NOT BETWEEN 1 AND 9007199254740000
     OR p_attempt_id IS NULL
     OR p_snapshot_id IS NULL
     OR p_snapshot_id <= 0 THEN
    RAISE EXCEPTION 'invalid Tier-A execution receipt identity'
      USING ERRCODE = '22023';
  END IF;

  PERFORM arena.assert_tier_a_execution_write(
    p_claim_id, p_generation_seq
  );

  SELECT claim.* INTO STRICT v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id
     AND claim.generation_seq = p_generation_seq;

  SELECT attempt.* INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_id = p_attempt_id
   FOR SHARE;

  SELECT outcome.* INTO STRICT v_outcome
    FROM arena.leaderboard_acquisition_outcomes AS outcome
   WHERE outcome.attempt_seq = v_attempt.attempt_seq;

  SELECT snapshot.* INTO STRICT v_snapshot
    FROM arena.leaderboard_snapshots AS snapshot
   WHERE snapshot.id = p_snapshot_id
   FOR SHARE;

  IF v_attempt.source_id IS DISTINCT FROM v_claim.source_id
     OR v_attempt.execution_claim_id IS DISTINCT FROM p_claim_id
     OR v_attempt.execution_generation_seq IS DISTINCT FROM p_generation_seq
     OR v_attempt.queue_job_id IS DISTINCT FROM v_claim.queue_job_id
     OR v_attempt.queue_attempt IS DISTINCT FROM v_claim.queue_attempt
     OR v_attempt.observation_cycle_id IS NULL
     OR pg_catalog.btrim(v_attempt.observation_cycle_id) IS DISTINCT FROM
        v_attempt.observation_cycle_id
     OR pg_catalog.length(v_attempt.observation_cycle_id) NOT BETWEEN 1 AND 512
     -- Completeness mode (20261115141050): a complete outcome (reported total
     -- equal to the accepted rows), or an exhausted outcome whose recorded
     -- exhaustion proof still holds.
     OR (
       v_outcome.terminal_state = 'complete'
       OR (
         v_outcome.terminal_state = 'unknown'
         AND v_outcome.population_state = 'unknown'
         AND v_outcome.population_report_state = 'unknown'
         AND v_outcome.reported_population IS NULL
         AND v_outcome.reason_code = 'population_unknown'
         AND arena.leaderboard_outcome_exhaustion_bound(v_outcome.attempt_seq)
       )
     ) IS NOT TRUE
     OR v_outcome.source_run_id IS NULL
     OR v_outcome.source_payload_raw_object_id IS NULL
     OR v_snapshot.source_id IS DISTINCT FROM v_attempt.source_id
     OR v_snapshot.timeframe IS DISTINCT FROM v_attempt.timeframe
     OR v_snapshot.count_check_passed IS DISTINCT FROM true
     OR v_snapshot.is_derived IS DISTINCT FROM false
     OR v_snapshot.raw_object_id IS DISTINCT FROM
        v_outcome.source_payload_raw_object_id THEN
    RAISE EXCEPTION 'Tier-A window receipt evidence is incomplete or mismatched'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.tier-a-window-receipt:'
      || v_claim.source_id::text || ':'
      || v_claim.queue_name || ':'
      || v_claim.queue_job_id || ':'
      || v_attempt.observation_cycle_id || ':'
      || v_attempt.timeframe::text,
      0
    )
  );

  SELECT receipt.* INTO v_existing
    FROM arena.tier_a_execution_window_receipts AS receipt
   WHERE receipt.source_id = v_claim.source_id
     AND receipt.queue_name = v_claim.queue_name
     AND receipt.queue_job_id = v_claim.queue_job_id
     AND receipt.observation_cycle_id = v_attempt.observation_cycle_id
     AND receipt.timeframe = v_attempt.timeframe;

  IF FOUND THEN
    IF v_existing.observation_cycle_id IS DISTINCT FROM
          v_attempt.observation_cycle_id
       OR v_existing.generation_seq IS DISTINCT FROM p_generation_seq
       OR v_existing.claim_id IS DISTINCT FROM p_claim_id
       OR v_existing.attempt_seq IS DISTINCT FROM v_attempt.attempt_seq
       OR v_existing.attempt_id IS DISTINCT FROM p_attempt_id
       OR v_existing.snapshot_id IS DISTINCT FROM p_snapshot_id
       OR v_existing.raw_object_id IS DISTINCT FROM
          v_outcome.source_payload_raw_object_id
       OR v_existing.source_run_id IS DISTINCT FROM v_outcome.source_run_id THEN
      RAISE EXCEPTION 'Tier-A window receipt replay conflicts with frozen evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN arena.tier_a_execution_receipt_json(v_existing);
  END IF;

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  INSERT INTO arena.tier_a_execution_window_receipts (
    contract,
    source_id,
    queue_name,
    queue_job_id,
    observation_cycle_id,
    timeframe,
    generation_seq,
    claim_id,
    attempt_seq,
    attempt_id,
    snapshot_id,
    raw_object_id,
    source_run_id,
    recorded_at
  ) VALUES (
    'arena.ingest.tier-a-execution-window-receipt@1',
    v_claim.source_id,
    v_claim.queue_name,
    v_claim.queue_job_id,
    v_attempt.observation_cycle_id,
    v_attempt.timeframe,
    p_generation_seq,
    p_claim_id,
    v_attempt.attempt_seq,
    p_attempt_id,
    p_snapshot_id,
    v_outcome.source_payload_raw_object_id,
    v_outcome.source_run_id,
    v_now
  )
  RETURNING * INTO STRICT v_inserted;

  RETURN arena.tier_a_execution_receipt_json(v_inserted);
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Tier-A window receipt evidence does not exist'
      USING ERRCODE = '55000';
END
$function$;

DO $postcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_language AS language_row
        ON language_row.oid = function_row.prolang
     WHERE function_row.oid =
           'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure
       AND pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
           = '8f23cbae0358f200dc7b2a0f4e00c7e218470ba1427968aa9fab0e390e8e1ef3'
       AND function_row.proowner = 'postgres'::pg_catalog.regrole
       AND function_row.prosecdef
       AND function_row.provolatile = 'v'
       AND language_row.lanname = 'plpgsql'
       AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
       AND function_row.proconfig = ARRAY[
             'search_path=pg_catalog, pg_temp',
             'TimeZone=UTC',
             'lock_timeout=10s',
             'statement_timeout=30s'
           ]::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION 'Tier-A window receipt RPC contract is not exact after replacement';
  END IF;

  -- service_role keeps a non-grantable EXECUTE; no other grantee holds any
  -- privilege (PUBLIC, anon and authenticated included).
  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS expanded
        WHERE function_row.oid =
              'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure
          AND expanded.grantee <> function_row.proowner
          AND NOT (
            expanded.grantee = 'service_role'::pg_catalog.regrole
            AND expanded.privilege_type = 'EXECUTE'
            AND NOT expanded.is_grantable
          )
     ) THEN
    RAISE EXCEPTION 'Tier-A window receipt RPC ACL is not service_role EXECUTE only';
  END IF;
END
$postcheck$;

COMMIT;
