-- Durable Tier-A execution ownership, transaction fencing, and window receipts.
--
-- This migration is deliberately expand-only.  The legacy acquisition start
-- and finish RPCs remain byte-for-byte, OID-for-OID, and ACL-for-ACL compatible.
-- New workers may opt into the claimed overloads; retiring the legacy write
-- path is a separate drain-after-cutover migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TEMP TABLE tier_a_execution_install_state (
  core_existed boolean NOT NULL,
  old_start_oid oid NOT NULL,
  old_start_source text NOT NULL,
  old_start_acl aclitem[],
  old_finish_oid oid NOT NULL,
  old_finish_source text NOT NULL,
  old_finish_acl aclitem[]
) ON COMMIT DROP;

DO $preflight$
DECLARE
  v_old_start oid := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_old_finish oid := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
  );
  v_present integer;
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_instances') IS NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_authorities') IS NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_activations') IS NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_write_guards') IS NULL
     OR v_old_start IS NULL
     OR v_old_finish IS NULL THEN
    RAISE EXCEPTION 'Tier-A execution fence prerequisites are missing';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO STRICT v_present
    FROM (VALUES
      (pg_catalog.to_regclass('arena.tier_a_execution_claims')),
      (pg_catalog.to_regclass('arena.tier_a_execution_heads')),
      (pg_catalog.to_regclass('arena.tier_a_execution_write_guards')),
      (pg_catalog.to_regclass('arena.tier_a_execution_window_receipts'))
    ) AS object(object_oid)
   WHERE object.object_oid IS NOT NULL;

  IF v_present NOT IN (0, 4) THEN
    RAISE EXCEPTION 'Tier-A execution fence tables are only partially installed';
  END IF;

  IF v_present = 4 AND (
       NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
                'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
            AND attribute.attname = 'execution_claim_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       )
       OR NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
                'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
            AND attribute.attname = 'execution_generation_seq'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       )
     ) THEN
    RAISE EXCEPTION 'Tier-A execution attempt binding is only partially installed';
  END IF;

  INSERT INTO tier_a_execution_install_state (
    core_existed,
    old_start_oid,
    old_start_source,
    old_start_acl,
    old_finish_oid,
    old_finish_source,
    old_finish_acl
  )
  SELECT
    v_present = 4,
    start_function.oid,
    start_function.prosrc,
    start_function.proacl,
    finish_function.oid,
    finish_function.prosrc,
    finish_function.proacl
  FROM pg_catalog.pg_proc AS start_function
  CROSS JOIN pg_catalog.pg_proc AS finish_function
  WHERE start_function.oid = v_old_start
    AND finish_function.oid = v_old_finish;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.tier_a_execution_claims (
  contract text NOT NULL,
  source_id smallint NOT NULL,
  generation_seq bigint NOT NULL,
  claim_id uuid NOT NULL,
  bull_proof_contract text NOT NULL,
  queue_name text NOT NULL,
  queue_job_id text NOT NULL,
  queue_job_name text NOT NULL,
  queue_attempt integer NOT NULL,
  queue_attempt_started integer NOT NULL,
  bull_lock_token_sha256 text NOT NULL,
  source_lease_contract text NOT NULL,
  source_lease_id uuid NOT NULL,
  source_lease_lane text NOT NULL,
  source_lease_scope_id text NOT NULL,
  source_lease_token_sha256 text NOT NULL,
  execution_region text NOT NULL,
  authority_scope text NOT NULL,
  authority_epoch bigint NOT NULL,
  worker_instance_id uuid NOT NULL,
  worker_node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  lease_seconds integer NOT NULL,
  claimed_at timestamptz NOT NULL,
  initial_lease_expires_at timestamptz NOT NULL,
  CONSTRAINT tier_a_execution_claims_pkey
    PRIMARY KEY (source_id, generation_seq),
  CONSTRAINT tier_a_execution_claims_claim_id_key UNIQUE (claim_id),
  CONSTRAINT tier_a_execution_claims_source_lease_key UNIQUE (source_lease_id),
  CONSTRAINT tier_a_execution_claims_identity_key
    UNIQUE (source_id, generation_seq, claim_id),
  CONSTRAINT tier_a_execution_claims_source_fkey
    FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_claims_activation_fkey
    FOREIGN KEY (authority_scope, authority_epoch)
    REFERENCES arena.ingest_worker_activations(authority_scope, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_claims_instance_fkey
    FOREIGN KEY (worker_instance_id)
    REFERENCES arena.ingest_worker_instances(instance_id)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_claims_contract_check
    CHECK (contract = 'arena.ingest.tier-a-execution@1'),
  CONSTRAINT tier_a_execution_claims_generation_check
    CHECK (generation_seq BETWEEN 1 AND 9007199254740000),
  CONSTRAINT tier_a_execution_claims_bull_contract_check
    CHECK (bull_proof_contract = 'arena.ingest.bull-job-provenance@1'),
  CONSTRAINT tier_a_execution_claims_queue_name_check
    CHECK (
      pg_catalog.btrim(queue_name) = queue_name
      AND pg_catalog.length(queue_name) BETWEEN 1 AND 256
      AND queue_name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT tier_a_execution_claims_queue_job_id_check
    CHECK (
      pg_catalog.btrim(queue_job_id) = queue_job_id
      AND pg_catalog.length(queue_job_id) BETWEEN 1 AND 512
      AND queue_job_id !~ '[[:cntrl:]]'
    ),
  CONSTRAINT tier_a_execution_claims_queue_job_name_check
    CHECK (queue_job_name = 'tiera:leaderboard'),
  CONSTRAINT tier_a_execution_claims_queue_attempt_check
    CHECK (queue_attempt BETWEEN 0 AND 1000000),
  CONSTRAINT tier_a_execution_claims_queue_started_check
    CHECK (queue_attempt_started BETWEEN 0 AND 1000000),
  CONSTRAINT tier_a_execution_claims_bull_digest_check
    CHECK (
      bull_lock_token_sha256 ~ '^[0-9a-f]{64}$'
      AND bull_lock_token_sha256 <> pg_catalog.repeat('0', 64)
    ),
  CONSTRAINT tier_a_execution_claims_source_contract_check
    CHECK (
      source_lease_contract =
        'arena.ingest.source-job-lease-provenance@1'
    ),
  CONSTRAINT tier_a_execution_claims_source_lane_check
    CHECK (source_lease_lane = 'tier-a'),
  CONSTRAINT tier_a_execution_claims_source_scope_check
    CHECK (
      pg_catalog.btrim(source_lease_scope_id) = source_lease_scope_id
      AND pg_catalog.length(source_lease_scope_id) BETWEEN 1 AND 256
      AND source_lease_scope_id ~ '^[a-z0-9][a-z0-9_-]{0,255}$'
    ),
  CONSTRAINT tier_a_execution_claims_source_digest_check
    CHECK (
      source_lease_token_sha256 ~ '^[0-9a-f]{64}$'
      AND source_lease_token_sha256 <> pg_catalog.repeat('0', 64)
    ),
  CONSTRAINT tier_a_execution_claims_region_check
    CHECK (
      execution_region IN ('local', 'vps_sg')
      AND worker_region = execution_region
      AND authority_scope = 'region:' || worker_region
    ),
  CONSTRAINT tier_a_execution_claims_authority_epoch_check
    CHECK (authority_epoch BETWEEN 1 AND 9007199254740000),
  CONSTRAINT tier_a_execution_claims_node_check
    CHECK (
      worker_node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND pg_catalog.btrim(worker_node_id) = worker_node_id
    ),
  CONSTRAINT tier_a_execution_claims_control_epoch_check
    CHECK (control_epoch BETWEEN 1 AND 9007199254740000),
  CONSTRAINT tier_a_execution_claims_release_check
    CHECK (
      release_id ~ '^[0-9a-f]{64}$'
      AND release_id <> pg_catalog.repeat('0', 64)
    ),
  CONSTRAINT tier_a_execution_claims_git_check
    CHECK (
      git_sha ~ '^[0-9a-f]{40}$'
      AND git_sha <> pg_catalog.repeat('0', 40)
    ),
  CONSTRAINT tier_a_execution_claims_lease_seconds_check
    CHECK (lease_seconds BETWEEN 15 AND 300),
  CONSTRAINT tier_a_execution_claims_time_check
    CHECK (
      pg_catalog.isfinite(claimed_at)
      AND claimed_at = pg_catalog.date_trunc('milliseconds', claimed_at)
      AND initial_lease_expires_at =
            claimed_at + lease_seconds * interval '1 second'
    )
);

CREATE TABLE IF NOT EXISTS arena.tier_a_execution_heads (
  source_id smallint NOT NULL,
  generation_seq bigint NOT NULL,
  claim_id uuid,
  phase text NOT NULL,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT tier_a_execution_heads_pkey PRIMARY KEY (source_id),
  CONSTRAINT tier_a_execution_heads_source_fkey
    FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_heads_claim_fkey
    FOREIGN KEY (source_id, generation_seq, claim_id)
    REFERENCES arena.tier_a_execution_claims(
      source_id, generation_seq, claim_id
    ) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_heads_generation_check
    CHECK (generation_seq BETWEEN 0 AND 9007199254740000),
  CONSTRAINT tier_a_execution_heads_phase_check
    CHECK (phase IN ('idle', 'active', 'completed', 'failed', 'revoked')),
  CONSTRAINT tier_a_execution_heads_state_check
    CHECK (
      (
        generation_seq = 0
        AND claim_id IS NULL
        AND phase = 'idle'
        AND last_heartbeat_at IS NULL
        AND lease_expires_at IS NULL
      )
      OR
      (
        generation_seq > 0
        AND claim_id IS NOT NULL
        AND last_heartbeat_at IS NOT NULL
        AND pg_catalog.isfinite(last_heartbeat_at)
        AND (
          (
            phase = 'active'
            AND lease_expires_at IS NOT NULL
            AND pg_catalog.isfinite(lease_expires_at)
            AND lease_expires_at > last_heartbeat_at
          )
          OR
          (
            phase IN ('completed', 'failed', 'revoked')
            AND lease_expires_at IS NULL
          )
        )
      )
    ),
  CONSTRAINT tier_a_execution_heads_updated_check
    CHECK (pg_catalog.isfinite(updated_at))
);

CREATE TABLE IF NOT EXISTS arena.tier_a_execution_write_guards (
  contract text NOT NULL,
  top_xid8_text text NOT NULL,
  source_id smallint NOT NULL,
  generation_seq bigint NOT NULL,
  claim_id uuid NOT NULL,
  authority_scope text NOT NULL,
  authority_epoch bigint NOT NULL,
  worker_instance_id uuid NOT NULL,
  worker_node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  asserted_at timestamptz NOT NULL,
  lease_expires_at_at_assertion timestamptz NOT NULL,
  CONSTRAINT tier_a_execution_write_guards_pkey
    PRIMARY KEY (top_xid8_text, source_id),
  CONSTRAINT tier_a_execution_write_guards_claim_fkey
    FOREIGN KEY (source_id, generation_seq, claim_id)
    REFERENCES arena.tier_a_execution_claims(
      source_id, generation_seq, claim_id
    ) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_write_guards_activation_fkey
    FOREIGN KEY (authority_scope, authority_epoch)
    REFERENCES arena.ingest_worker_activations(authority_scope, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_write_guards_instance_fkey
    FOREIGN KEY (worker_instance_id)
    REFERENCES arena.ingest_worker_instances(instance_id)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_write_guards_contract_check
    CHECK (contract = 'arena.ingest.tier-a-execution@1'),
  CONSTRAINT tier_a_execution_write_guards_xid_check
    CHECK (
      top_xid8_text ~ '^[1-9][0-9]*$'
      AND pg_catalog.length(top_xid8_text) <= 20
    ),
  CONSTRAINT tier_a_execution_write_guards_generation_check
    CHECK (generation_seq BETWEEN 1 AND 9007199254740000),
  CONSTRAINT tier_a_execution_write_guards_authority_check
    CHECK (
      authority_epoch BETWEEN 1 AND 9007199254740000
      AND control_epoch BETWEEN 1 AND 9007199254740000
      AND worker_region IN ('local', 'vps_sg')
      AND authority_scope = 'region:' || worker_region
    ),
  CONSTRAINT tier_a_execution_write_guards_node_check
    CHECK (
      worker_node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND pg_catalog.btrim(worker_node_id) = worker_node_id
    ),
  CONSTRAINT tier_a_execution_write_guards_release_check
    CHECK (
      release_id ~ '^[0-9a-f]{64}$'
      AND release_id <> pg_catalog.repeat('0', 64)
      AND git_sha ~ '^[0-9a-f]{40}$'
      AND git_sha <> pg_catalog.repeat('0', 40)
    ),
  CONSTRAINT tier_a_execution_write_guards_time_check
    CHECK (
      asserted_at = pg_catalog.date_trunc('milliseconds', asserted_at)
      AND lease_expires_at_at_assertion > asserted_at
    )
);

CREATE TABLE IF NOT EXISTS arena.tier_a_execution_window_receipts (
  contract text NOT NULL,
  source_id smallint NOT NULL,
  queue_name text NOT NULL,
  queue_job_id text NOT NULL,
  observation_cycle_id text NOT NULL,
  timeframe smallint NOT NULL,
  generation_seq bigint NOT NULL,
  claim_id uuid NOT NULL,
  attempt_seq bigint NOT NULL,
  attempt_id uuid NOT NULL,
  snapshot_id bigint NOT NULL,
  raw_object_id bigint NOT NULL,
  source_run_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT tier_a_execution_window_receipts_pkey
    PRIMARY KEY (
      source_id, queue_name, queue_job_id, observation_cycle_id, timeframe
    ),
  CONSTRAINT tier_a_execution_window_receipts_claim_fkey
    FOREIGN KEY (source_id, generation_seq, claim_id)
    REFERENCES arena.tier_a_execution_claims(
      source_id, generation_seq, claim_id
    ) ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_receipts_attempt_seq_fkey
    FOREIGN KEY (attempt_seq)
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_receipts_attempt_id_fkey
    FOREIGN KEY (attempt_id)
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_id)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_receipts_snapshot_fkey
    FOREIGN KEY (snapshot_id)
    REFERENCES arena.leaderboard_snapshots(id)
    ON DELETE RESTRICT,
  CONSTRAINT tier_a_execution_window_receipts_contract_check
    CHECK (
      contract = 'arena.ingest.tier-a-execution-window-receipt@1'
    ),
  CONSTRAINT tier_a_execution_window_receipts_queue_name_check
    CHECK (
      pg_catalog.btrim(queue_name) = queue_name
      AND pg_catalog.length(queue_name) BETWEEN 1 AND 256
      AND queue_name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT tier_a_execution_window_receipts_queue_job_check
    CHECK (
      pg_catalog.btrim(queue_job_id) = queue_job_id
      AND pg_catalog.length(queue_job_id) BETWEEN 1 AND 512
      AND queue_job_id !~ '[[:cntrl:]]'
    ),
  CONSTRAINT tier_a_execution_window_receipts_cycle_check
    CHECK (
      pg_catalog.btrim(observation_cycle_id) = observation_cycle_id
      AND pg_catalog.length(observation_cycle_id) BETWEEN 1 AND 512
    ),
  CONSTRAINT tier_a_execution_window_receipts_timeframe_check
    CHECK (timeframe IN (7, 30, 90)),
  CONSTRAINT tier_a_execution_window_receipts_generation_check
    CHECK (generation_seq BETWEEN 1 AND 9007199254740000),
  CONSTRAINT tier_a_execution_window_receipts_ids_check
    CHECK (attempt_seq > 0 AND snapshot_id > 0 AND raw_object_id > 0),
  CONSTRAINT tier_a_execution_window_receipts_source_run_check
    CHECK (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND source_run_id <> pg_catalog.repeat('0', 64)
    ),
  CONSTRAINT tier_a_execution_window_receipts_recorded_check
    CHECK (
      pg_catalog.isfinite(recorded_at)
      AND recorded_at = pg_catalog.date_trunc('milliseconds', recorded_at)
    )
);

ALTER TABLE arena.leaderboard_acquisition_attempts
  ADD COLUMN IF NOT EXISTS execution_claim_id uuid,
  ADD COLUMN IF NOT EXISTS execution_generation_seq bigint;

DO $attempt_binding_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_pair_check'
  ) THEN
    ALTER TABLE arena.leaderboard_acquisition_attempts
      ADD CONSTRAINT leaderboard_acquisition_attempts_execution_pair_check
      CHECK (
        (execution_claim_id IS NULL) =
        (execution_generation_seq IS NULL)
        AND (
          execution_generation_seq IS NULL
          OR execution_generation_seq BETWEEN 1 AND 9007199254740000
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_claim_fkey'
  ) THEN
    ALTER TABLE arena.leaderboard_acquisition_attempts
      ADD CONSTRAINT leaderboard_acquisition_attempts_execution_claim_fkey
      FOREIGN KEY (source_id, execution_generation_seq, execution_claim_id)
      REFERENCES arena.tier_a_execution_claims(
        source_id, generation_seq, claim_id
      ) ON DELETE RESTRICT;
  END IF;
END
$attempt_binding_constraints$;

CREATE INDEX IF NOT EXISTS idx_leaderboard_acquisition_attempts_execution_claim
  ON arena.leaderboard_acquisition_attempts (
    source_id, execution_generation_seq, execution_claim_id, attempt_seq
  )
  WHERE execution_claim_id IS NOT NULL;

ALTER TABLE arena.tier_a_execution_claims OWNER TO postgres;
ALTER TABLE arena.tier_a_execution_heads OWNER TO postgres;
ALTER TABLE arena.tier_a_execution_write_guards OWNER TO postgres;
ALTER TABLE arena.tier_a_execution_window_receipts OWNER TO postgres;

ALTER TABLE arena.tier_a_execution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.tier_a_execution_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.tier_a_execution_write_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.tier_a_execution_window_receipts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION arena.reject_tier_a_execution_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Tier-A execution ledgers are immutable (% %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

ALTER FUNCTION arena.reject_tier_a_execution_immutable_mutation()
  OWNER TO postgres;

DO $immutable_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'arena.tier_a_execution_claims'::pg_catalog.regclass
       AND tgname = 'tier_a_execution_claims_immutable'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tier_a_execution_claims_immutable
      BEFORE UPDATE OR DELETE ON arena.tier_a_execution_claims
      FOR EACH ROW
      EXECUTE FUNCTION arena.reject_tier_a_execution_immutable_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid =
           'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
       AND tgname = 'tier_a_execution_window_receipts_immutable'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tier_a_execution_window_receipts_immutable
      BEFORE UPDATE OR DELETE ON arena.tier_a_execution_window_receipts
      FOR EACH ROW
      EXECUTE FUNCTION arena.reject_tier_a_execution_immutable_mutation();
  END IF;
END
$immutable_triggers$;

CREATE OR REPLACE FUNCTION arena.require_current_tier_a_worker_guard(
  p_source_id integer
)
RETURNS arena.ingest_worker_write_guards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_source arena.sources%ROWTYPE;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'Tier-A execution writes require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;
  IF p_source_id IS NULL OR p_source_id NOT BETWEEN 1 AND 32767 THEN
    RAISE EXCEPTION 'invalid Tier-A source identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT source.*
    INTO v_source
    FROM arena.sources AS source
   WHERE source.id = p_source_id;

  IF NOT FOUND
     OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.fetch_region NOT IN ('local', 'vps_sg') THEN
    RAISE EXCEPTION 'Tier-A source is absent, inactive, or has no DB authority region'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:region:' || v_source.fetch_region,
      0
    )
  );

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  SELECT guard.*
    INTO v_guard
    FROM arena.ingest_worker_write_guards AS guard
    JOIN arena.ingest_worker_authorities AS authority
      ON authority.authority_scope = guard.authority_scope
    JOIN arena.ingest_worker_instances AS instance
      ON instance.instance_id = guard.instance_id
    JOIN arena.ingest_worker_activations AS activation
      ON activation.authority_scope = guard.authority_scope
     AND activation.epoch = guard.epoch
   WHERE guard.top_xid8_text = pg_catalog.pg_current_xact_id()::text
     AND guard.authority_scope = 'region:' || v_source.fetch_region
     AND guard.worker_region = v_source.fetch_region
     AND guard.lease_expires_at_at_assertion > v_now
     AND authority.active_epoch = guard.epoch
     AND authority.active_instance_id = guard.instance_id
     AND authority.active_node_id = guard.node_id
     AND authority.active_control_epoch = guard.control_epoch
     AND authority.lease_expires_at > v_now
     AND instance.node_id = guard.node_id
     AND instance.worker_region = guard.worker_region
     AND instance.control_epoch = guard.control_epoch
     AND instance.release_id = guard.release_id
     AND instance.git_sha = guard.git_sha
     AND activation.instance_id = guard.instance_id
     AND activation.node_id = guard.node_id
     AND activation.worker_region = guard.worker_region
     AND activation.control_epoch = guard.control_epoch
     AND activation.release_id = guard.release_id
     AND activation.git_sha = guard.git_sha
     AND activation.status = 'active'
     AND activation.ended_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'current transaction lacks live Tier-A worker authority'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_guard;
END
$function$;

ALTER FUNCTION arena.require_current_tier_a_worker_guard(integer)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.tier_a_execution_claim_json(
  p_claim arena.tier_a_execution_claims
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'contract', p_claim.contract,
    'source_id', p_claim.source_id,
    'generation_seq', p_claim.generation_seq,
    'claim_id', p_claim.claim_id,
    'bull_proof_contract', p_claim.bull_proof_contract,
    'queue_name', p_claim.queue_name,
    'queue_job_id', p_claim.queue_job_id,
    'queue_job_name', p_claim.queue_job_name,
    'queue_attempt', p_claim.queue_attempt,
    'queue_attempt_started', p_claim.queue_attempt_started,
    'bull_lock_token_sha256', p_claim.bull_lock_token_sha256,
    'source_lease_contract', p_claim.source_lease_contract,
    'source_lease_id', p_claim.source_lease_id,
    'source_lease_lane', p_claim.source_lease_lane,
    'source_lease_scope_id', p_claim.source_lease_scope_id,
    'source_lease_token_sha256', p_claim.source_lease_token_sha256,
    'execution_region', p_claim.execution_region,
    'authority_scope', p_claim.authority_scope,
    'authority_epoch', p_claim.authority_epoch,
    'worker_instance_id', p_claim.worker_instance_id,
    'worker_node_id', p_claim.worker_node_id,
    'worker_region', p_claim.worker_region,
    'control_epoch', p_claim.control_epoch,
    'release_id', p_claim.release_id,
    'git_sha', p_claim.git_sha,
    'lease_seconds', p_claim.lease_seconds,
    'phase', 'active',
    'claimed_at', pg_catalog.to_char(
      p_claim.claimed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'last_heartbeat_at', pg_catalog.to_char(
      p_claim.claimed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'lease_expires_at', pg_catalog.to_char(
      p_claim.initial_lease_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$function$;

ALTER FUNCTION arena.tier_a_execution_claim_json(
  arena.tier_a_execution_claims
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.claim_tier_a_execution(
  p_claim_id uuid,
  p_source_id integer,
  p_queue_name text,
  p_queue_job_id text,
  p_queue_job_name text,
  p_queue_attempt integer,
  p_queue_attempt_started integer,
  p_bull_lock_token_sha256 text,
  p_source_lease_id uuid,
  p_source_lease_token_sha256 text,
  p_execution_region text,
  p_lease_seconds integer
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
  v_source arena.sources%ROWTYPE;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
  v_head arena.tier_a_execution_heads%ROWTYPE;
  v_current arena.tier_a_execution_claims%ROWTYPE;
  v_existing arena.tier_a_execution_claims%ROWTYPE;
  v_inserted arena.tier_a_execution_claims%ROWTYPE;
  v_now timestamptz;
  v_next_generation bigint;
  v_lease_expires_at timestamptz;
BEGIN
  IF p_claim_id IS NULL
     OR p_source_id IS NULL
     OR p_source_id NOT BETWEEN 1 AND 32767
     OR p_queue_name IS NULL
     OR pg_catalog.btrim(p_queue_name) <> p_queue_name
     OR pg_catalog.length(p_queue_name) NOT BETWEEN 1 AND 256
     OR p_queue_name ~ '[[:cntrl:]]'
     OR p_queue_job_id IS NULL
     OR pg_catalog.btrim(p_queue_job_id) <> p_queue_job_id
     OR pg_catalog.length(p_queue_job_id) NOT BETWEEN 1 AND 512
     OR p_queue_job_id ~ '[[:cntrl:]]'
     OR p_queue_job_name IS DISTINCT FROM 'tiera:leaderboard'
     OR p_queue_attempt IS NULL
     OR p_queue_attempt NOT BETWEEN 0 AND 1000000
     OR p_queue_attempt_started IS NULL
     OR p_queue_attempt_started NOT BETWEEN 0 AND 1000000
     OR p_bull_lock_token_sha256 IS NULL
     OR p_bull_lock_token_sha256 !~ '^[0-9a-f]{64}$'
     OR p_bull_lock_token_sha256 = pg_catalog.repeat('0', 64)
     OR p_source_lease_id IS NULL
     OR p_source_lease_token_sha256 IS NULL
     OR p_source_lease_token_sha256 !~ '^[0-9a-f]{64}$'
     OR p_source_lease_token_sha256 = pg_catalog.repeat('0', 64)
     OR p_execution_region NOT IN ('local', 'vps_sg')
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid Tier-A execution claim input'
      USING ERRCODE = '22023';
  END IF;

  v_guard := arena.require_current_tier_a_worker_guard(p_source_id);

  -- Region authority is always acquired first by the helper.  Exclusive
  -- source locking then linearizes initial claim, takeover, and close.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.tier-a-execution-source:' || p_source_id::text,
      0
    )
  );

  -- Re-evaluate the DB clock and authority after any source-lock wait.
  v_guard := arena.require_current_tier_a_worker_guard(p_source_id);

  SELECT source.*
    INTO STRICT v_source
    FROM arena.sources AS source
   WHERE source.id = p_source_id
   FOR SHARE;

  IF v_source.status IS DISTINCT FROM 'active'
     OR v_source.fetch_region IS DISTINCT FROM p_execution_region
     OR v_guard.worker_region IS DISTINCT FROM p_execution_region
     OR v_source.slug !~ '^[a-z0-9][a-z0-9_-]{0,255}$' THEN
    RAISE EXCEPTION 'Tier-A source and execution authority do not match'
      USING ERRCODE = '55000';
  END IF;

  SELECT head.*
    INTO v_head
    FROM arena.tier_a_execution_heads AS head
   WHERE head.source_id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO arena.tier_a_execution_heads (
      source_id,
      generation_seq,
      claim_id,
      phase,
      last_heartbeat_at,
      lease_expires_at,
      updated_at
    ) VALUES (
      p_source_id,
      0,
      NULL,
      'idle',
      NULL,
      NULL,
      pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
    )
    RETURNING * INTO STRICT v_head;
  END IF;

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  SELECT claim.*
    INTO v_existing
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id;

  IF FOUND THEN
    IF v_existing.source_id IS DISTINCT FROM p_source_id
       OR v_existing.bull_proof_contract IS DISTINCT FROM
          'arena.ingest.bull-job-provenance@1'
       OR v_existing.queue_name IS DISTINCT FROM p_queue_name
       OR v_existing.queue_job_id IS DISTINCT FROM p_queue_job_id
       OR v_existing.queue_job_name IS DISTINCT FROM p_queue_job_name
       OR v_existing.queue_attempt IS DISTINCT FROM p_queue_attempt
       OR v_existing.queue_attempt_started IS DISTINCT FROM
          p_queue_attempt_started
       OR v_existing.bull_lock_token_sha256 IS DISTINCT FROM
          p_bull_lock_token_sha256
       OR v_existing.source_lease_contract IS DISTINCT FROM
          'arena.ingest.source-job-lease-provenance@1'
       OR v_existing.source_lease_id IS DISTINCT FROM p_source_lease_id
       OR v_existing.source_lease_lane IS DISTINCT FROM 'tier-a'
       OR v_existing.source_lease_scope_id IS DISTINCT FROM v_source.slug
       OR v_existing.source_lease_token_sha256 IS DISTINCT FROM
          p_source_lease_token_sha256
       OR v_existing.execution_region IS DISTINCT FROM p_execution_region
       OR v_existing.authority_scope IS DISTINCT FROM v_guard.authority_scope
       OR v_existing.authority_epoch IS DISTINCT FROM v_guard.epoch
       OR v_existing.worker_instance_id IS DISTINCT FROM v_guard.instance_id
       OR v_existing.worker_node_id IS DISTINCT FROM v_guard.node_id
       OR v_existing.worker_region IS DISTINCT FROM v_guard.worker_region
       OR v_existing.control_epoch IS DISTINCT FROM v_guard.control_epoch
       OR v_existing.release_id IS DISTINCT FROM v_guard.release_id
       OR v_existing.git_sha IS DISTINCT FROM v_guard.git_sha
       OR v_existing.lease_seconds IS DISTINCT FROM p_lease_seconds THEN
      RAISE EXCEPTION 'Tier-A claim UUID replay conflicts with frozen input'
        USING ERRCODE = '23505';
    END IF;

    IF v_head.generation_seq IS DISTINCT FROM v_existing.generation_seq
       OR v_head.claim_id IS DISTINCT FROM v_existing.claim_id
       OR v_head.phase IS DISTINCT FROM 'active'
       OR v_head.lease_expires_at <= v_now THEN
      RAISE EXCEPTION 'Tier-A claim replay is expired, closed, or superseded'
        USING ERRCODE = '55000';
    END IF;

    RETURN arena.tier_a_execution_claim_json(v_existing);
  END IF;

  IF v_head.generation_seq > 0 THEN
    SELECT claim.*
      INTO STRICT v_current
      FROM arena.tier_a_execution_claims AS claim
     WHERE claim.source_id = v_head.source_id
       AND claim.generation_seq = v_head.generation_seq
       AND claim.claim_id = v_head.claim_id;

    IF v_head.phase = 'active'
       AND v_head.lease_expires_at > v_now
       AND v_current.authority_scope = v_guard.authority_scope
       AND v_current.authority_epoch = v_guard.epoch
       AND v_current.worker_instance_id = v_guard.instance_id
       AND v_current.worker_node_id = v_guard.node_id
       AND v_current.worker_region = v_guard.worker_region
       AND v_current.control_epoch = v_guard.control_epoch
       AND v_current.release_id = v_guard.release_id
       AND v_current.git_sha = v_guard.git_sha THEN
      RAISE EXCEPTION 'another Tier-A execution owns the active source lease'
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  IF v_head.generation_seq >= 9007199254740000 THEN
    RAISE EXCEPTION 'Tier-A execution generation sequence exhausted'
      USING ERRCODE = '54000';
  END IF;

  v_next_generation := v_head.generation_seq + 1;
  v_lease_expires_at := v_now + p_lease_seconds * interval '1 second';

  INSERT INTO arena.tier_a_execution_claims (
    contract,
    source_id,
    generation_seq,
    claim_id,
    bull_proof_contract,
    queue_name,
    queue_job_id,
    queue_job_name,
    queue_attempt,
    queue_attempt_started,
    bull_lock_token_sha256,
    source_lease_contract,
    source_lease_id,
    source_lease_lane,
    source_lease_scope_id,
    source_lease_token_sha256,
    execution_region,
    authority_scope,
    authority_epoch,
    worker_instance_id,
    worker_node_id,
    worker_region,
    control_epoch,
    release_id,
    git_sha,
    lease_seconds,
    claimed_at,
    initial_lease_expires_at
  ) VALUES (
    'arena.ingest.tier-a-execution@1',
    p_source_id,
    v_next_generation,
    p_claim_id,
    'arena.ingest.bull-job-provenance@1',
    p_queue_name,
    p_queue_job_id,
    p_queue_job_name,
    p_queue_attempt,
    p_queue_attempt_started,
    p_bull_lock_token_sha256,
    'arena.ingest.source-job-lease-provenance@1',
    p_source_lease_id,
    'tier-a',
    v_source.slug,
    p_source_lease_token_sha256,
    p_execution_region,
    v_guard.authority_scope,
    v_guard.epoch,
    v_guard.instance_id,
    v_guard.node_id,
    v_guard.worker_region,
    v_guard.control_epoch,
    v_guard.release_id,
    v_guard.git_sha,
    p_lease_seconds,
    v_now,
    v_lease_expires_at
  )
  RETURNING * INTO STRICT v_inserted;

  UPDATE arena.tier_a_execution_heads AS head
     SET generation_seq = v_next_generation,
         claim_id = p_claim_id,
         phase = 'active',
         last_heartbeat_at = v_now,
         lease_expires_at = v_lease_expires_at,
         updated_at = v_now
   WHERE head.source_id = p_source_id
     AND head.generation_seq = v_head.generation_seq
     AND head.claim_id IS NOT DISTINCT FROM v_head.claim_id
     AND head.phase = v_head.phase;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN arena.tier_a_execution_claim_json(v_inserted);
END
$function$;

ALTER FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.heartbeat_tier_a_execution(
  p_claim_id uuid,
  p_generation_seq bigint
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
  v_head arena.tier_a_execution_heads%ROWTYPE;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
  v_now timestamptz;
  v_expires_at timestamptz;
BEGIN
  IF p_claim_id IS NULL
     OR p_generation_seq IS NULL
     OR p_generation_seq NOT BETWEEN 1 AND 9007199254740000 THEN
    RAISE EXCEPTION 'invalid Tier-A execution heartbeat identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT claim.* INTO v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id
     AND claim.generation_seq = p_generation_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution claim does not exist'
      USING ERRCODE = '55000';
  END IF;

  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.tier-a-execution-source:' || v_claim.source_id::text,
      0
    )
  );
  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);

  SELECT head.* INTO STRICT v_head
    FROM arena.tier_a_execution_heads AS head
   WHERE head.source_id = v_claim.source_id
   FOR UPDATE;

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.claim_id IS DISTINCT FROM p_claim_id
     OR v_head.phase IS DISTINCT FROM 'active'
     OR v_head.lease_expires_at <= v_now
     OR v_claim.authority_scope IS DISTINCT FROM v_guard.authority_scope
     OR v_claim.authority_epoch IS DISTINCT FROM v_guard.epoch
     OR v_claim.worker_instance_id IS DISTINCT FROM v_guard.instance_id
     OR v_claim.worker_node_id IS DISTINCT FROM v_guard.node_id
     OR v_claim.worker_region IS DISTINCT FROM v_guard.worker_region
     OR v_claim.control_epoch IS DISTINCT FROM v_guard.control_epoch
     OR v_claim.release_id IS DISTINCT FROM v_guard.release_id
     OR v_claim.git_sha IS DISTINCT FROM v_guard.git_sha THEN
    RAISE EXCEPTION 'Tier-A execution heartbeat was fenced'
      USING ERRCODE = '55000';
  END IF;

  v_expires_at := v_now + v_claim.lease_seconds * interval '1 second';

  UPDATE arena.tier_a_execution_heads AS head
     SET last_heartbeat_at = v_now,
         lease_expires_at = v_expires_at,
         updated_at = v_now
   WHERE head.source_id = v_claim.source_id
     AND head.generation_seq = p_generation_seq
     AND head.claim_id = p_claim_id
     AND head.phase = 'active'
     AND head.lease_expires_at > v_now;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution heartbeat compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.ingest.tier-a-execution@1',
    'source_id', v_claim.source_id,
    'generation_seq', p_generation_seq,
    'claim_id', p_claim_id,
    'phase', 'active',
    'last_heartbeat_at', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'lease_expires_at', pg_catalog.to_char(
      v_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
END
$function$;

ALTER FUNCTION arena.heartbeat_tier_a_execution(uuid, bigint)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.assert_tier_a_execution_write(
  p_claim_id uuid,
  p_generation_seq bigint
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
  v_head arena.tier_a_execution_heads%ROWTYPE;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
  v_execution_guard arena.tier_a_execution_write_guards%ROWTYPE;
  v_now timestamptz;
  v_top_xid text;
BEGIN
  IF p_claim_id IS NULL
     OR p_generation_seq IS NULL
     OR p_generation_seq NOT BETWEEN 1 AND 9007199254740000 THEN
    RAISE EXCEPTION 'invalid Tier-A execution write identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT claim.* INTO v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id
     AND claim.generation_seq = p_generation_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution claim does not exist'
      USING ERRCODE = '55000';
  END IF;

  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.tier-a-execution-source:' || v_claim.source_id::text,
      0
    )
  );
  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);
  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  SELECT head.* INTO STRICT v_head
    FROM arena.tier_a_execution_heads AS head
   WHERE head.source_id = v_claim.source_id;

  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.claim_id IS DISTINCT FROM p_claim_id
     OR v_head.phase IS DISTINCT FROM 'active'
     OR v_head.lease_expires_at <= v_now
     OR v_claim.authority_scope IS DISTINCT FROM v_guard.authority_scope
     OR v_claim.authority_epoch IS DISTINCT FROM v_guard.epoch
     OR v_claim.worker_instance_id IS DISTINCT FROM v_guard.instance_id
     OR v_claim.worker_node_id IS DISTINCT FROM v_guard.node_id
     OR v_claim.worker_region IS DISTINCT FROM v_guard.worker_region
     OR v_claim.control_epoch IS DISTINCT FROM v_guard.control_epoch
     OR v_claim.release_id IS DISTINCT FROM v_guard.release_id
     OR v_claim.git_sha IS DISTINCT FROM v_guard.git_sha THEN
    RAISE EXCEPTION 'Tier-A execution write was fenced'
      USING ERRCODE = '55000';
  END IF;

  v_top_xid := pg_catalog.pg_current_xact_id()::text;

  SELECT execution_guard.* INTO v_execution_guard
    FROM arena.tier_a_execution_write_guards AS execution_guard
   WHERE execution_guard.top_xid8_text = v_top_xid
     AND execution_guard.source_id = v_claim.source_id;

  IF FOUND THEN
    IF v_execution_guard.generation_seq IS DISTINCT FROM p_generation_seq
       OR v_execution_guard.claim_id IS DISTINCT FROM p_claim_id
       OR v_execution_guard.authority_scope IS DISTINCT FROM
          v_guard.authority_scope
       OR v_execution_guard.authority_epoch IS DISTINCT FROM v_guard.epoch
       OR v_execution_guard.worker_instance_id IS DISTINCT FROM
          v_guard.instance_id
       OR v_execution_guard.control_epoch IS DISTINCT FROM
          v_guard.control_epoch THEN
      RAISE EXCEPTION 'Tier-A execution write guard replay conflicts'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    INSERT INTO arena.tier_a_execution_write_guards (
      contract,
      top_xid8_text,
      source_id,
      generation_seq,
      claim_id,
      authority_scope,
      authority_epoch,
      worker_instance_id,
      worker_node_id,
      worker_region,
      control_epoch,
      release_id,
      git_sha,
      asserted_at,
      lease_expires_at_at_assertion
    ) VALUES (
      'arena.ingest.tier-a-execution@1',
      v_top_xid,
      v_claim.source_id,
      p_generation_seq,
      p_claim_id,
      v_guard.authority_scope,
      v_guard.epoch,
      v_guard.instance_id,
      v_guard.node_id,
      v_guard.worker_region,
      v_guard.control_epoch,
      v_guard.release_id,
      v_guard.git_sha,
      v_now,
      v_head.lease_expires_at
    )
    RETURNING * INTO STRICT v_execution_guard;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.ingest.tier-a-execution@1',
    'source_id', v_claim.source_id,
    'generation_seq', p_generation_seq,
    'claim_id', p_claim_id,
    'phase', 'active',
    'asserted_at', pg_catalog.to_char(
      v_execution_guard.asserted_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'lease_expires_at_at_assertion', pg_catalog.to_char(
      v_execution_guard.lease_expires_at_at_assertion AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
END
$function$;

ALTER FUNCTION arena.assert_tier_a_execution_write(uuid, bigint)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.assert_tier_a_execution_fence_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz;
  v_valid boolean := false;
  v_deleted integer := 0;
BEGIN
  IF NEW.top_xid8_text IS DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'Tier-A execution guard belongs to another transaction'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.tier-a-execution-source:' || NEW.source_id::text,
      0
    )
  );

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  SELECT true INTO v_valid
    FROM arena.tier_a_execution_heads AS head
    JOIN arena.tier_a_execution_claims AS claim
      ON claim.source_id = head.source_id
     AND claim.generation_seq = head.generation_seq
     AND claim.claim_id = head.claim_id
    JOIN arena.ingest_worker_authorities AS authority
      ON authority.authority_scope = NEW.authority_scope
    JOIN arena.ingest_worker_instances AS instance
      ON instance.instance_id = NEW.worker_instance_id
    JOIN arena.ingest_worker_activations AS activation
      ON activation.authority_scope = NEW.authority_scope
     AND activation.epoch = NEW.authority_epoch
   WHERE head.source_id = NEW.source_id
     AND head.generation_seq = NEW.generation_seq
     AND head.claim_id = NEW.claim_id
     AND head.phase = 'active'
     AND head.lease_expires_at > v_now
     AND claim.authority_scope = NEW.authority_scope
     AND claim.authority_epoch = NEW.authority_epoch
     AND claim.worker_instance_id = NEW.worker_instance_id
     AND claim.worker_node_id = NEW.worker_node_id
     AND claim.worker_region = NEW.worker_region
     AND claim.control_epoch = NEW.control_epoch
     AND claim.release_id = NEW.release_id
     AND claim.git_sha = NEW.git_sha
     AND authority.active_epoch = NEW.authority_epoch
     AND authority.active_instance_id = NEW.worker_instance_id
     AND authority.active_node_id = NEW.worker_node_id
     AND authority.active_control_epoch = NEW.control_epoch
     AND authority.lease_expires_at > v_now
     AND instance.node_id = NEW.worker_node_id
     AND instance.worker_region = NEW.worker_region
     AND instance.control_epoch = NEW.control_epoch
     AND instance.release_id = NEW.release_id
     AND instance.git_sha = NEW.git_sha
     AND activation.instance_id = NEW.worker_instance_id
     AND activation.node_id = NEW.worker_node_id
     AND activation.worker_region = NEW.worker_region
     AND activation.control_epoch = NEW.control_epoch
     AND activation.release_id = NEW.release_id
     AND activation.git_sha = NEW.git_sha
     AND activation.status = 'active'
     AND activation.ended_at IS NULL;

  IF NOT COALESCE(v_valid, false) THEN
    RAISE EXCEPTION 'Tier-A execution was fenced before COMMIT'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM arena.tier_a_execution_write_guards AS execution_guard
   WHERE execution_guard.top_xid8_text = NEW.top_xid8_text
     AND execution_guard.source_id = NEW.source_id
     AND execution_guard.generation_seq = NEW.generation_seq
     AND execution_guard.claim_id = NEW.claim_id
     AND execution_guard.authority_scope = NEW.authority_scope
     AND execution_guard.authority_epoch = NEW.authority_epoch
     AND execution_guard.worker_instance_id = NEW.worker_instance_id
     AND execution_guard.control_epoch = NEW.control_epoch;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'Tier-A execution guard cleanup was not exact'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.assert_tier_a_execution_fence_at_commit()
  OWNER TO postgres;

DO $commit_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND tgname = 'tier_a_execution_fence_commit_assertion'
       AND NOT tgisinternal
  ) THEN
    CREATE CONSTRAINT TRIGGER tier_a_execution_fence_commit_assertion
      AFTER INSERT ON arena.tier_a_execution_write_guards
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION arena.assert_tier_a_execution_fence_at_commit();
  END IF;
END
$commit_trigger$;

CREATE OR REPLACE FUNCTION arena.close_tier_a_execution(
  p_claim_id uuid,
  p_generation_seq bigint,
  p_terminal_phase text
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
  v_head arena.tier_a_execution_heads%ROWTYPE;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_claim_id IS NULL
     OR p_generation_seq IS NULL
     OR p_generation_seq NOT BETWEEN 1 AND 9007199254740000
     OR p_terminal_phase NOT IN ('completed', 'failed', 'revoked') THEN
    RAISE EXCEPTION 'invalid Tier-A execution close input'
      USING ERRCODE = '22023';
  END IF;

  SELECT claim.* INTO v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_claim_id
     AND claim.generation_seq = p_generation_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution claim does not exist'
      USING ERRCODE = '55000';
  END IF;

  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.tier-a-execution-source:' || v_claim.source_id::text,
      0
    )
  );
  v_guard := arena.require_current_tier_a_worker_guard(v_claim.source_id);

  SELECT head.* INTO STRICT v_head
    FROM arena.tier_a_execution_heads AS head
   WHERE head.source_id = v_claim.source_id
   FOR UPDATE;

  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.claim_id IS DISTINCT FROM p_claim_id
     OR v_claim.authority_scope IS DISTINCT FROM v_guard.authority_scope
     OR v_claim.authority_epoch IS DISTINCT FROM v_guard.epoch
     OR v_claim.worker_instance_id IS DISTINCT FROM v_guard.instance_id
     OR v_claim.worker_node_id IS DISTINCT FROM v_guard.node_id
     OR v_claim.worker_region IS DISTINCT FROM v_guard.worker_region
     OR v_claim.control_epoch IS DISTINCT FROM v_guard.control_epoch
     OR v_claim.release_id IS DISTINCT FROM v_guard.release_id
     OR v_claim.git_sha IS DISTINCT FROM v_guard.git_sha THEN
    RAISE EXCEPTION 'Tier-A execution close was fenced'
      USING ERRCODE = '55000';
  END IF;

  IF v_head.phase IN ('completed', 'failed', 'revoked') THEN
    IF v_head.phase IS DISTINCT FROM p_terminal_phase THEN
      RAISE EXCEPTION 'Tier-A execution close replay conflicts'
        USING ERRCODE = '22023';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', 'arena.ingest.tier-a-execution@1',
      'source_id', v_claim.source_id,
      'generation_seq', p_generation_seq,
      'claim_id', p_claim_id,
      'phase', v_head.phase,
      'closed_at', pg_catalog.to_char(
        v_head.updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
  END IF;

  IF v_head.phase IS DISTINCT FROM 'active'
     OR v_head.lease_expires_at <= v_now THEN
    RAISE EXCEPTION 'Tier-A execution cannot close after expiry or supersession'
      USING ERRCODE = '55000';
  END IF;

  UPDATE arena.tier_a_execution_heads AS head
     SET phase = p_terminal_phase,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE head.source_id = v_claim.source_id
     AND head.generation_seq = p_generation_seq
     AND head.claim_id = p_claim_id
     AND head.phase = 'active'
     AND head.lease_expires_at > v_now;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tier-A execution close compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.ingest.tier-a-execution@1',
    'source_id', v_claim.source_id,
    'generation_seq', p_generation_seq,
    'claim_id', p_claim_id,
    'phase', p_terminal_phase,
    'closed_at', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
END
$function$;

ALTER FUNCTION arena.close_tier_a_execution(uuid, bigint, text)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.bind_tier_a_execution_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim_text text := NULLIF(
    pg_catalog.current_setting('arena.tier_a_execution_claim_id', true), ''
  );
  v_generation_text text := NULLIF(
    pg_catalog.current_setting('arena.tier_a_execution_generation_seq', true), ''
  );
  v_claim_id uuid;
  v_generation_seq bigint;
  v_claim arena.tier_a_execution_claims%ROWTYPE;
BEGIN
  IF v_claim_text IS NULL AND v_generation_text IS NULL THEN
    IF NEW.execution_claim_id IS NOT NULL
       OR NEW.execution_generation_seq IS NOT NULL THEN
      RAISE EXCEPTION 'legacy acquisition begin cannot supply execution binding'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF v_claim_text IS NULL OR v_generation_text IS NULL
     OR pg_catalog.current_setting(
          'arena.leaderboard_acquisition_mutation_path', true
        ) IS DISTINCT FROM 'start_leaderboard_acquisition_attempt' THEN
    RAISE EXCEPTION 'Tier-A acquisition begin marker is incomplete'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_claim_id := v_claim_text::uuid;
    v_generation_seq := v_generation_text::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Tier-A acquisition begin marker is invalid'
      USING ERRCODE = '42501';
  END;

  SELECT claim.* INTO v_claim
    FROM arena.tier_a_execution_claims AS claim
    JOIN arena.tier_a_execution_write_guards AS execution_guard
      ON execution_guard.source_id = claim.source_id
     AND execution_guard.generation_seq = claim.generation_seq
     AND execution_guard.claim_id = claim.claim_id
   WHERE claim.claim_id = v_claim_id
     AND claim.generation_seq = v_generation_seq
     AND claim.source_id = NEW.source_id
     AND execution_guard.top_xid8_text =
         pg_catalog.pg_current_xact_id()::text;

  IF NOT FOUND
     OR NEW.queue_job_id IS DISTINCT FROM v_claim.queue_job_id
     OR NEW.queue_attempt IS DISTINCT FROM v_claim.queue_attempt
     OR NEW.worker_region IS DISTINCT FROM v_claim.execution_region
     OR NEW.source_slug IS DISTINCT FROM v_claim.source_lease_scope_id
     OR NEW.source_fetch_region IS DISTINCT FROM v_claim.execution_region
     OR (
       NEW.execution_claim_id IS NOT NULL
       AND NEW.execution_claim_id IS DISTINCT FROM v_claim_id
     )
     OR (
       NEW.execution_generation_seq IS NOT NULL
       AND NEW.execution_generation_seq IS DISTINCT FROM v_generation_seq
     ) THEN
    RAISE EXCEPTION 'acquisition attempt does not match current Tier-A claim'
      USING ERRCODE = '55000';
  END IF;

  NEW.execution_claim_id := v_claim_id;
  NEW.execution_generation_seq := v_generation_seq;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.bind_tier_a_execution_attempt() OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.assert_tier_a_execution_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim_text text := NULLIF(
    pg_catalog.current_setting('arena.tier_a_execution_claim_id', true), ''
  );
  v_generation_text text := NULLIF(
    pg_catalog.current_setting('arena.tier_a_execution_generation_seq', true), ''
  );
  v_claim_id uuid;
  v_generation_seq bigint;
  v_valid boolean := false;
BEGIN
  IF v_claim_text IS NULL AND v_generation_text IS NULL THEN
    SELECT
      attempt.execution_claim_id IS NULL
      AND attempt.execution_generation_seq IS NULL
      INTO v_valid
      FROM arena.leaderboard_acquisition_attempts AS attempt
     WHERE attempt.attempt_seq = NEW.attempt_seq;

    IF NOT COALESCE(v_valid, false) THEN
      RAISE EXCEPTION 'claimed acquisition attempt requires claimed finish RPC'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF v_claim_text IS NULL OR v_generation_text IS NULL
     OR pg_catalog.current_setting(
          'arena.leaderboard_acquisition_mutation_path', true
        ) IS DISTINCT FROM 'finish_leaderboard_acquisition_attempt' THEN
    RAISE EXCEPTION 'Tier-A acquisition finish marker is incomplete'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_claim_id := v_claim_text::uuid;
    v_generation_seq := v_generation_text::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Tier-A acquisition finish marker is invalid'
      USING ERRCODE = '42501';
  END;

  SELECT true INTO v_valid
    FROM arena.leaderboard_acquisition_attempts AS attempt
    JOIN arena.tier_a_execution_write_guards AS execution_guard
      ON execution_guard.source_id = attempt.source_id
     AND execution_guard.generation_seq = attempt.execution_generation_seq
     AND execution_guard.claim_id = attempt.execution_claim_id
   WHERE attempt.attempt_seq = NEW.attempt_seq
     AND attempt.execution_claim_id = v_claim_id
     AND attempt.execution_generation_seq = v_generation_seq
     AND execution_guard.top_xid8_text =
         pg_catalog.pg_current_xact_id()::text;

  IF NOT COALESCE(v_valid, false) THEN
    RAISE EXCEPTION 'acquisition outcome does not match current Tier-A claim'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.assert_tier_a_execution_outcome() OWNER TO postgres;

DO $acquisition_binding_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND tgname = 'leaderboard_acquisition_attempts_bind_tier_a_execution'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER leaderboard_acquisition_attempts_bind_tier_a_execution
      BEFORE INSERT ON arena.leaderboard_acquisition_attempts
      FOR EACH ROW EXECUTE FUNCTION arena.bind_tier_a_execution_attempt();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid =
           'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
       AND tgname = 'leaderboard_acquisition_outcomes_assert_tier_a_execution'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER leaderboard_acquisition_outcomes_assert_tier_a_execution
      BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
      FOR EACH ROW EXECUTE FUNCTION arena.assert_tier_a_execution_outcome();
  END IF;
END
$acquisition_binding_triggers$;

CREATE OR REPLACE FUNCTION arena.start_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_source_id integer,
  p_timeframe integer,
  p_observation_cycle_id text,
  p_queue_job_id text,
  p_queue_attempt integer,
  p_capture_contract text,
  p_runner_git_sha text,
  p_worker_region text,
  p_execution_claim_id uuid,
  p_execution_generation_seq bigint
)
RETURNS arena.leaderboard_acquisition_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '10s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_claim arena.tier_a_execution_claims%ROWTYPE;
  v_result arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_prior_claim text := pg_catalog.current_setting(
    'arena.tier_a_execution_claim_id', true
  );
  v_prior_generation text := pg_catalog.current_setting(
    'arena.tier_a_execution_generation_seq', true
  );
BEGIN
  PERFORM arena.assert_tier_a_execution_write(
    p_execution_claim_id, p_execution_generation_seq
  );

  SELECT claim.* INTO STRICT v_claim
    FROM arena.tier_a_execution_claims AS claim
   WHERE claim.claim_id = p_execution_claim_id
     AND claim.generation_seq = p_execution_generation_seq;

  IF v_claim.source_id IS DISTINCT FROM p_source_id
     OR v_claim.queue_job_id IS DISTINCT FROM p_queue_job_id
     OR v_claim.queue_attempt IS DISTINCT FROM p_queue_attempt
     OR v_claim.execution_region IS DISTINCT FROM p_worker_region THEN
    RAISE EXCEPTION 'claimed acquisition begin conflicts with Tier-A claim'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_claim_id', p_execution_claim_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_generation_seq',
    p_execution_generation_seq::text,
    true
  );

  BEGIN
    v_result := arena.start_leaderboard_acquisition_attempt(
      p_attempt_id,
      p_source_id,
      p_timeframe,
      p_observation_cycle_id,
      p_queue_job_id,
      p_queue_attempt,
      p_capture_contract,
      p_runner_git_sha,
      p_worker_region
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'arena.tier_a_execution_claim_id', COALESCE(v_prior_claim, ''), true
    );
    PERFORM pg_catalog.set_config(
      'arena.tier_a_execution_generation_seq',
      COALESCE(v_prior_generation, ''),
      true
    );
    RAISE;
  END;

  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_claim_id', COALESCE(v_prior_claim, ''), true
  );
  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_generation_seq',
    COALESCE(v_prior_generation, ''),
    true
  );

  IF v_result.execution_claim_id IS DISTINCT FROM p_execution_claim_id
     OR v_result.execution_generation_seq IS DISTINCT FROM
        p_execution_generation_seq THEN
    RAISE EXCEPTION 'claimed acquisition begin returned an unbound attempt'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text, uuid, bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.finish_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_terminal_state text,
  p_acquisition_state text,
  p_population_state text,
  p_capture_evidence_state text,
  p_termination_reason text,
  p_capture_started_at timestamptz,
  p_capture_completed_at timestamptz,
  p_source_run_id text,
  p_source_payload_raw_object_id bigint,
  p_manifest_raw_object_id bigint,
  p_diagnostic_raw_object_id bigint,
  p_reported_population integer,
  p_population_report_state text,
  p_source_page_count integer,
  p_reported_page_count integer,
  p_page_count_report_state text,
  p_observed_population integer,
  p_accepted_population integer,
  p_rejected_row_count integer,
  p_deduplicated_row_count integer,
  p_caller_limited boolean,
  p_safety_limited boolean,
  p_failure_stage text,
  p_reason_code text,
  p_execution_claim_id uuid,
  p_execution_generation_seq bigint
)
RETURNS arena.leaderboard_acquisition_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '10s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_result arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_prior_claim text := pg_catalog.current_setting(
    'arena.tier_a_execution_claim_id', true
  );
  v_prior_generation text := pg_catalog.current_setting(
    'arena.tier_a_execution_generation_seq', true
  );
BEGIN
  SELECT attempt.* INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_id = p_attempt_id;

  IF v_attempt.execution_claim_id IS DISTINCT FROM p_execution_claim_id
     OR v_attempt.execution_generation_seq IS DISTINCT FROM
        p_execution_generation_seq THEN
    RAISE EXCEPTION 'claimed acquisition finish conflicts with attempt binding'
      USING ERRCODE = '22023';
  END IF;

  PERFORM arena.assert_tier_a_execution_write(
    p_execution_claim_id, p_execution_generation_seq
  );

  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_claim_id', p_execution_claim_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_generation_seq',
    p_execution_generation_seq::text,
    true
  );

  BEGIN
    v_result := arena.finish_leaderboard_acquisition_attempt(
      p_attempt_id,
      p_terminal_state,
      p_acquisition_state,
      p_population_state,
      p_capture_evidence_state,
      p_termination_reason,
      p_capture_started_at,
      p_capture_completed_at,
      p_source_run_id,
      p_source_payload_raw_object_id,
      p_manifest_raw_object_id,
      p_diagnostic_raw_object_id,
      p_reported_population,
      p_population_report_state,
      p_source_page_count,
      p_reported_page_count,
      p_page_count_report_state,
      p_observed_population,
      p_accepted_population,
      p_rejected_row_count,
      p_deduplicated_row_count,
      p_caller_limited,
      p_safety_limited,
      p_failure_stage,
      p_reason_code
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'arena.tier_a_execution_claim_id', COALESCE(v_prior_claim, ''), true
    );
    PERFORM pg_catalog.set_config(
      'arena.tier_a_execution_generation_seq',
      COALESCE(v_prior_generation, ''),
      true
    );
    RAISE;
  END;

  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_claim_id', COALESCE(v_prior_claim, ''), true
  );
  PERFORM pg_catalog.set_config(
    'arena.tier_a_execution_generation_seq',
    COALESCE(v_prior_generation, ''),
    true
  );

  RETURN v_result;
END
$function$;

ALTER FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text,
  uuid, bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.tier_a_execution_receipt_json(
  p_receipt arena.tier_a_execution_window_receipts
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'contract', p_receipt.contract,
    'source_id', p_receipt.source_id,
    'queue_name', p_receipt.queue_name,
    'queue_job_id', p_receipt.queue_job_id,
    'observation_cycle_id', p_receipt.observation_cycle_id,
    'timeframe', p_receipt.timeframe,
    'generation_seq', p_receipt.generation_seq,
    'claim_id', p_receipt.claim_id,
    'attempt_seq', p_receipt.attempt_seq,
    'attempt_id', p_receipt.attempt_id,
    'snapshot_id', p_receipt.snapshot_id,
    'raw_object_id', p_receipt.raw_object_id,
    'source_run_id', p_receipt.source_run_id,
    'recorded_at', pg_catalog.to_char(
      p_receipt.recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
$function$;

ALTER FUNCTION arena.tier_a_execution_receipt_json(
  arena.tier_a_execution_window_receipts
) OWNER TO postgres;

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
     OR v_outcome.terminal_state IS DISTINCT FROM 'complete'
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

ALTER FUNCTION arena.record_tier_a_execution_window_receipt(
  uuid, bigint, uuid, bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.get_tier_a_execution_window_receipt(
  p_source_id integer,
  p_queue_name text,
  p_queue_job_id text,
  p_observation_cycle_id text,
  p_timeframe integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_receipt arena.tier_a_execution_window_receipts%ROWTYPE;
BEGIN
  IF p_source_id IS NULL
     OR p_source_id NOT BETWEEN 1 AND 32767
     OR p_queue_name IS NULL
     OR pg_catalog.btrim(p_queue_name) <> p_queue_name
     OR pg_catalog.length(p_queue_name) NOT BETWEEN 1 AND 256
     OR p_queue_name ~ '[[:cntrl:]]'
     OR p_queue_job_id IS NULL
     OR pg_catalog.btrim(p_queue_job_id) <> p_queue_job_id
     OR pg_catalog.length(p_queue_job_id) NOT BETWEEN 1 AND 512
     OR p_queue_job_id ~ '[[:cntrl:]]'
     OR p_observation_cycle_id IS NULL
     OR pg_catalog.btrim(p_observation_cycle_id) <> p_observation_cycle_id
     OR pg_catalog.length(p_observation_cycle_id) NOT BETWEEN 1 AND 512
     OR p_timeframe NOT IN (7, 30, 90) THEN
    RAISE EXCEPTION 'invalid Tier-A window receipt lookup'
      USING ERRCODE = '22023';
  END IF;

  SELECT receipt.* INTO v_receipt
    FROM arena.tier_a_execution_window_receipts AS receipt
   WHERE receipt.source_id = p_source_id
     AND receipt.queue_name = p_queue_name
     AND receipt.queue_job_id = p_queue_job_id
     AND receipt.observation_cycle_id = p_observation_cycle_id
     AND receipt.timeframe = p_timeframe;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN arena.tier_a_execution_receipt_json(v_receipt);
END
$function$;

ALTER FUNCTION arena.get_tier_a_execution_window_receipt(
  integer, text, text, text, integer
) OWNER TO postgres;

DO $closed_table_acl$
DECLARE
  v_table pg_catalog.regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.tier_a_execution_claims'::pg_catalog.regclass,
    'arena.tier_a_execution_heads'::pg_catalog.regclass,
    'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
    'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.pg_class AS table_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            table_row.relacl,
            pg_catalog.acldefault('r', table_row.relowner)
          )
        ) AS expanded
       WHERE table_row.oid = v_table
         AND expanded.grantee <> table_row.relowner
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC CASCADE', v_table
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I CASCADE',
          v_table,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_table_acl$;

REVOKE ALL ON TABLE arena.tier_a_execution_claims
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.tier_a_execution_heads
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.tier_a_execution_write_guards
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.tier_a_execution_window_receipts
  FROM PUBLIC, anon, authenticated, service_role;

DO $closed_function_acl$
DECLARE
  v_function pg_catalog.regprocedure;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure,
    'arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure,
    'arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure,
    'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure,
    'arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure,
    'arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure,
    'arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure,
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure,
    'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
       WHERE function_row.oid = v_function
         AND expanded.grantee <> function_row.proowner
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_function,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_function_acl$;

REVOKE ALL ON FUNCTION arena.reject_tier_a_execution_immutable_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.require_current_tier_a_worker_guard(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.tier_a_execution_claim_json(
  arena.tier_a_execution_claims
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.assert_tier_a_execution_fence_at_commit()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.bind_tier_a_execution_attempt()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.assert_tier_a_execution_outcome()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.tier_a_execution_receipt_json(
  arena.tier_a_execution_window_receipts
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.heartbeat_tier_a_execution(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.assert_tier_a_execution_write(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.close_tier_a_execution(uuid, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text, uuid, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text,
  uuid, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.record_tier_a_execution_window_receipt(
  uuid, bigint, uuid, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.get_tier_a_execution_window_receipt(
  integer, text, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.heartbeat_tier_a_execution(uuid, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.assert_tier_a_execution_write(uuid, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.close_tier_a_execution(uuid, bigint, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text, uuid, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text,
  uuid, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.record_tier_a_execution_window_receipt(
  uuid, bigint, uuid, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.get_tier_a_execution_window_receipt(
  integer, text, text, text, integer
) TO service_role;

COMMENT ON TABLE arena.tier_a_execution_claims IS
  'Immutable per-source Tier-A execution claim ledger with Bull, source lease, and DB-region provenance.';
COMMENT ON TABLE arena.tier_a_execution_heads IS
  'One monotonic current Tier-A execution generation per live source.';
COMMENT ON TABLE arena.tier_a_execution_write_guards IS
  'Ephemeral current-xid Tier-A write assertions revalidated and deleted by a deferred COMMIT trigger.';
COMMENT ON TABLE arena.tier_a_execution_window_receipts IS
  'Immutable DB authority for an exact completed queue/source/observation-cycle/timeframe window; Redis hints alone never authorize skipping.';

DO $postflight$
DECLARE
  v_state tier_a_execution_install_state%ROWTYPE;
  v_new_start oid := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'
  );
  v_new_finish oid := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'
  );
BEGIN
  SELECT * INTO STRICT v_state FROM tier_a_execution_install_state;

  IF v_state.old_start_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
     )
     OR v_state.old_finish_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
     )
     OR v_state.old_start_source IS DISTINCT FROM (
       SELECT function_row.prosrc FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_start_oid
     )
     OR v_state.old_finish_source IS DISTINCT FROM (
       SELECT function_row.prosrc FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_finish_oid
     )
     OR v_state.old_start_acl IS DISTINCT FROM (
       SELECT function_row.proacl FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_start_oid
     )
     OR v_state.old_finish_acl IS DISTINCT FROM (
       SELECT function_row.proacl FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_finish_oid
     ) THEN
    RAISE EXCEPTION 'legacy acquisition RPC identity, body, or ACL drifted';
  END IF;

  IF v_new_start IS NULL
     OR v_new_finish IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.heartbeat_tier_a_execution(uuid,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.assert_tier_a_execution_write(uuid,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.close_tier_a_execution(uuid,bigint,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Tier-A execution RPC postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('arena.tier_a_execution_claims'::pg_catalog.regclass),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass)
      ) AS expected(table_oid)
      JOIN pg_catalog.pg_class AS table_row
        ON table_row.oid = expected.table_oid
     WHERE table_row.relowner <> 'postgres'::pg_catalog.regrole
        OR table_row.relkind <> 'r'
        OR NOT table_row.relrowsecurity
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS expanded
     WHERE table_row.oid IN (
       'arena.tier_a_execution_claims'::pg_catalog.regclass,
       'arena.tier_a_execution_heads'::pg_catalog.regclass,
       'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
       'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
     )
       AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'Tier-A execution table ownership or closed ACL failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Tier-A execution RPC ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure, false),
          ('arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure, false),
          ('arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure, true),
          ('arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure, false),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure, false),
          ('arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure, true)
      ) AS expected(function_oid, service_allowed)
      JOIN pg_catalog.pg_proc AS function_row
        ON function_row.oid = expected.function_oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS expanded
     WHERE expanded.privilege_type = 'EXECUTE'
       AND expanded.grantee <> function_row.proowner
       AND NOT (
         expected.service_allowed
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND NOT expanded.is_grantable
       )
  ) OR EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure, false),
          ('arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure, false),
          ('arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure, true),
          ('arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure, false),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure, false),
          ('arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure, true)
      ) AS expected(function_oid, service_allowed)
     WHERE pg_catalog.has_function_privilege(
       'service_role', expected.function_oid, 'EXECUTE'
     ) IS DISTINCT FROM expected.service_allowed
  ) THEN
    RAISE EXCEPTION 'Tier-A execution function ACL is not a closed set';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND trigger_row.tgname = 'tier_a_execution_fence_commit_assertion'
       AND trigger_row.tgdeferrable
       AND trigger_row.tginitdeferred
       AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Tier-A deferred COMMIT fence trigger is missing';
  END IF;
END
$postflight$;

COMMIT;
