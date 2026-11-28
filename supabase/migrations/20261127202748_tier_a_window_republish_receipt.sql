-- Migration: 20261127202748_tier_a_window_republish_receipt.sql
-- Description: a Tier-A window receipt may be recorded for a capture that an
--   earlier queue attempt of the same job recorded but failed to publish.
--
-- Why: on 2026-11-27 the bybit_mt5 7D window (2,047 pages, 107 minutes per
--   scan) captured twice with a holding exhaustion proof, and both times the
--   publication transaction ran into its write deadline. The capture, its RAW
--   artifacts and its terminal outcome were durable; only publication failed.
--   The BullMQ retry nevertheless rescanned the board for another 107
--   minutes, and after three attempts the window stayed unpublished for 18 h.
--   The worker can instead re-publish the recorded capture (it rebuilds the
--   manifest from the stored RAW and requires it to be byte-identical; that
--   is the worker release that calls this function). Publication fences
--   already accept it: the snapshot guard needs only the current execution
--   claim, and metric-trust authority needs the window's latest terminal
--   attempt, which the recorded one still is. Only the window receipt
--   refuses: arena.record_tier_a_execution_window_receipt requires the
--   attempt to belong to the calling claim, and the retry is a new claim.
--
-- What is added (nothing existing changes):
--   * arena.tier_a_execution_window_republishes: one append-only row per
--     re-published attempt (primary key attempt_seq, so an attempt is
--     re-published at most once), naming the claim that captured it and the
--     claim that published it, referencing the receipt it explains.
--   * arena.record_tier_a_execution_window_republish_receipt(claim, generation,
--     attempt, snapshot): the receipt for a re-published attempt. It records
--     the same receipt row (same table, same contract, same primary key) as
--     arena.record_tier_a_execution_window_receipt, plus the republish row, in
--     one transaction. It accepts an attempt only when ALL hold:
--       - the calling claim is the current execution (assert_tier_a_execution_write);
--       - the attempt was captured by an earlier claim of the same source and
--         the same queue job (queue name and job id), with a lower generation
--         and a lower queue attempt. The calling claim is the head, so the
--         capturing claim is no longer current and cannot write;
--       - the attempt is the latest attempt of its source and window
--         (no attempt started after it);
--       - it has an observation cycle, and its outcome is complete or the
--         exhausted branch with a holding proof (as in 20261118161307);
--       - the snapshot belongs to the same source and window, passed the count
--         check, is not derived, and carries the attempt's source payload RAW;
--       - no republish row exists for the attempt.
--     A repeated identical call (an uncertain commit) returns the recorded
--     receipt. Any other second receipt for the window or the attempt is
--     refused, including a second republish by a later claim.
--   The existing receipt function, the receipts table and every object the
--   worker startup gate pins (worker/src/ingest/attempt-bound-capture-readiness.ts)
--   are untouched, so this migration may be applied before the worker that
--   calls it; until then nothing calls it.
--
-- POSTDEPLOY, after 20261118161307. Generated only; not applied to any
-- environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)') IS NULL
     OR pg_catalog.to_regprocedure('arena.assert_tier_a_execution_write(uuid,bigint)') IS NULL
     OR pg_catalog.to_regprocedure('arena.leaderboard_outcome_exhaustion_bound(bigint)') IS NULL
     OR pg_catalog.to_regprocedure('arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_window_receipts') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_claims') IS NULL THEN
    RAISE EXCEPTION 'republish receipt requires the Tier-A receipt substrate (20260729015500, 20261118161307)';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.tier_a_execution_window_republishes (
  attempt_seq bigint NOT NULL,
  source_id smallint NOT NULL,
  queue_name text NOT NULL,
  queue_job_id text NOT NULL,
  observation_cycle_id text NOT NULL,
  timeframe smallint NOT NULL,
  captured_by_claim_id uuid NOT NULL,
  captured_by_generation_seq bigint NOT NULL,
  published_by_claim_id uuid NOT NULL,
  published_by_generation_seq bigint NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT tier_a_execution_window_republishes_pkey PRIMARY KEY (attempt_seq),
  CONSTRAINT tier_a_execution_window_republishes_receipt_fkey
    FOREIGN KEY (source_id, queue_name, queue_job_id, observation_cycle_id, timeframe)
    REFERENCES arena.tier_a_execution_window_receipts(
      source_id, queue_name, queue_job_id, observation_cycle_id, timeframe
    ) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_republishes_receipt_key
    UNIQUE (source_id, queue_name, queue_job_id, observation_cycle_id, timeframe),
  CONSTRAINT tier_a_execution_window_republishes_attempt_fkey
    FOREIGN KEY (attempt_seq)
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_republishes_order_check
    CHECK (captured_by_generation_seq < published_by_generation_seq
           AND captured_by_claim_id <> published_by_claim_id)
);

ALTER TABLE arena.tier_a_execution_window_republishes OWNER TO postgres;
ALTER TABLE arena.tier_a_execution_window_republishes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.tier_a_execution_window_republishes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.tier_a_execution_window_republishes TO service_role;
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
     WHERE polrelid = 'arena.tier_a_execution_window_republishes'::pg_catalog.regclass
       AND polname = 'tier_a_execution_window_republishes_service_read'
  ) THEN
    CREATE POLICY tier_a_execution_window_republishes_service_read
      ON arena.tier_a_execution_window_republishes
      FOR SELECT TO service_role USING (true);
  END IF;
END
$policy$;

CREATE OR REPLACE FUNCTION arena.reject_tier_a_execution_republish_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'arena.tier_a_execution_window_republishes is append-only'
    USING ERRCODE = '55000';
END
$function$;
ALTER FUNCTION arena.reject_tier_a_execution_republish_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_tier_a_execution_republish_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE TRIGGER tier_a_execution_window_republishes_immutable
  BEFORE UPDATE OR DELETE ON arena.tier_a_execution_window_republishes
  FOR EACH ROW EXECUTE FUNCTION arena.reject_tier_a_execution_republish_mutation();
CREATE OR REPLACE TRIGGER tier_a_execution_window_republishes_no_truncate
  BEFORE TRUNCATE ON arena.tier_a_execution_window_republishes
  FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_tier_a_execution_republish_mutation();

CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_republish_receipt(
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
  v_captured_by arena.tier_a_execution_claims%ROWTYPE;
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_outcome arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_snapshot arena.leaderboard_snapshots%ROWTYPE;
  v_existing arena.tier_a_execution_window_receipts%ROWTYPE;
  v_inserted arena.tier_a_execution_window_receipts%ROWTYPE;
  v_republish arena.tier_a_execution_window_republishes%ROWTYPE;
  v_latest_attempt_seq bigint;
  v_now timestamptz;
BEGIN
  IF p_claim_id IS NULL
     OR p_generation_seq IS NULL
     OR p_generation_seq NOT BETWEEN 1 AND 9007199254740000
     OR p_attempt_id IS NULL
     OR p_snapshot_id IS NULL
     OR p_snapshot_id <= 0 THEN
    RAISE EXCEPTION 'invalid Tier-A republish receipt identity'
      USING ERRCODE = '22023';
  END IF;

  -- The calling claim must be the current execution of its source.
  PERFORM arena.assert_tier_a_execution_write(p_claim_id, p_generation_seq);

  SELECT claim.* INTO STRICT v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id
     AND claim.generation_seq = p_generation_seq;

  SELECT attempt.* INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_id = p_attempt_id
   FOR SHARE;

  SELECT claim.* INTO STRICT v_captured_by
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = v_attempt.execution_claim_id
     AND claim.generation_seq = v_attempt.execution_generation_seq;

  SELECT outcome.* INTO STRICT v_outcome
    FROM arena.leaderboard_acquisition_outcomes AS outcome
   WHERE outcome.attempt_seq = v_attempt.attempt_seq;

  SELECT snapshot.* INTO STRICT v_snapshot
    FROM arena.leaderboard_snapshots AS snapshot
   WHERE snapshot.id = p_snapshot_id
   FOR SHARE;

  SELECT pg_catalog.max(later.attempt_seq) INTO v_latest_attempt_seq
    FROM arena.leaderboard_acquisition_attempts AS later
   WHERE later.source_id = v_attempt.source_id
     AND later.timeframe = v_attempt.timeframe;

  IF v_attempt.source_id IS DISTINCT FROM v_claim.source_id
     -- Captured by an earlier claim of the same queue job, now superseded.
     OR v_captured_by.source_id IS DISTINCT FROM v_claim.source_id
     OR v_captured_by.queue_name IS DISTINCT FROM v_claim.queue_name
     OR v_captured_by.queue_job_id IS DISTINCT FROM v_claim.queue_job_id
     OR v_captured_by.claim_id = v_claim.claim_id
     OR v_captured_by.generation_seq >= v_claim.generation_seq
     OR v_captured_by.queue_attempt >= v_claim.queue_attempt
     OR v_attempt.queue_job_id IS DISTINCT FROM v_claim.queue_job_id
     OR v_attempt.queue_attempt IS DISTINCT FROM v_captured_by.queue_attempt
     -- Still the window's latest attempt.
     OR v_latest_attempt_seq IS DISTINCT FROM v_attempt.attempt_seq
     OR v_attempt.observation_cycle_id IS NULL
     OR pg_catalog.btrim(v_attempt.observation_cycle_id) IS DISTINCT FROM
        v_attempt.observation_cycle_id
     OR pg_catalog.length(v_attempt.observation_cycle_id) NOT BETWEEN 1 AND 512
     -- Completeness exactly as 20261118161307.
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
    RAISE EXCEPTION 'Tier-A republish receipt evidence is incomplete or mismatched'
      USING ERRCODE = '55000';
  END IF;

  -- The same lock as the receipt function: one writer per window receipt.
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

  SELECT republish.* INTO v_republish
    FROM arena.tier_a_execution_window_republishes AS republish
   WHERE republish.attempt_seq = v_attempt.attempt_seq;

  IF v_existing.attempt_seq IS NOT NULL OR v_republish.attempt_seq IS NOT NULL THEN
    -- Only the identical call (an uncertain commit) is answered; anything
    -- else, a second republish by a later claim included, is refused.
    IF v_existing.attempt_seq IS NULL
       OR v_republish.attempt_seq IS NULL
       OR v_existing.generation_seq IS DISTINCT FROM p_generation_seq
       OR v_existing.claim_id IS DISTINCT FROM p_claim_id
       OR v_existing.attempt_seq IS DISTINCT FROM v_attempt.attempt_seq
       OR v_existing.attempt_id IS DISTINCT FROM p_attempt_id
       OR v_existing.snapshot_id IS DISTINCT FROM p_snapshot_id
       OR v_existing.raw_object_id IS DISTINCT FROM v_outcome.source_payload_raw_object_id
       OR v_existing.source_run_id IS DISTINCT FROM v_outcome.source_run_id
       OR v_republish.published_by_claim_id IS DISTINCT FROM p_claim_id
       OR v_republish.published_by_generation_seq IS DISTINCT FROM p_generation_seq
       OR v_republish.captured_by_claim_id IS DISTINCT FROM v_captured_by.claim_id THEN
      RAISE EXCEPTION 'Tier-A republish receipt conflicts with a recorded receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN arena.tier_a_execution_receipt_json(v_existing);
  END IF;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  INSERT INTO arena.tier_a_execution_window_receipts (
    contract, source_id, queue_name, queue_job_id, observation_cycle_id,
    timeframe, generation_seq, claim_id, attempt_seq, attempt_id,
    snapshot_id, raw_object_id, source_run_id, recorded_at
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

  INSERT INTO arena.tier_a_execution_window_republishes (
    attempt_seq, source_id, queue_name, queue_job_id, observation_cycle_id,
    timeframe, captured_by_claim_id, captured_by_generation_seq,
    published_by_claim_id, published_by_generation_seq, recorded_at
  ) VALUES (
    v_attempt.attempt_seq,
    v_claim.source_id,
    v_claim.queue_name,
    v_claim.queue_job_id,
    v_attempt.observation_cycle_id,
    v_attempt.timeframe,
    v_captured_by.claim_id,
    v_captured_by.generation_seq,
    p_claim_id,
    p_generation_seq,
    v_now
  );

  RETURN arena.tier_a_execution_receipt_json(v_inserted);
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Tier-A republish receipt evidence does not exist'
      USING ERRCODE = '55000';
END
$function$;

ALTER FUNCTION arena.record_tier_a_execution_window_republish_receipt(uuid, bigint, uuid, bigint)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.record_tier_a_execution_window_republish_receipt(uuid, bigint, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.record_tier_a_execution_window_republish_receipt(uuid, bigint, uuid, bigint)
  TO service_role;

DO $postcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid =
           'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure
       AND function_row.proowner = 'postgres'::pg_catalog.regrole
       AND function_row.prosecdef
       AND function_row.proconfig = ARRAY[
             'search_path=pg_catalog, pg_temp',
             'TimeZone=UTC',
             'lock_timeout=10s',
             'statement_timeout=30s'
           ]::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION 'Tier-A republish receipt RPC contract is not exact';
  END IF;

  -- The ingest worker connects as postgres (no superuser, BYPASSRLS): it
  -- holds the function and reads the table as their owner.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid = 'arena.tier_a_execution_window_republishes'::pg_catalog.regclass
       AND table_row.relowner = 'postgres'::pg_catalog.regrole
       AND table_row.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'arena.tier_a_execution_window_republishes must be owned by postgres with RLS enabled';
  END IF;

  IF NOT pg_catalog.has_function_privilege('service_role',
       'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon',
       'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated',
       'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)', 'EXECUTE')
     OR pg_catalog.has_table_privilege('service_role',
       'arena.tier_a_execution_window_republishes', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('anon', 'arena.tier_a_execution_window_republishes', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'arena.tier_a_execution_window_republishes', 'SELECT') THEN
    RAISE EXCEPTION 'Tier-A republish receipt ACL is not service_role EXECUTE / SELECT only';
  END IF;
END
$postcheck$;

COMMIT;
