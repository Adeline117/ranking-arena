-- Forward replacement for 20260729061000_tier_a_execution_claim_enforcement.sql
-- (never applied to production). The launch plan runs this contract
-- POSTDEPLOY, after migrations dated later than it. Three of those add
-- reviewed BEFORE INSERT/UPDATE/DELETE row guards on arena.raw_objects
-- (20260803100000, 20260804053000, 20260808010000), so the original exact
-- trigger allowlist rejects them. The body is identical except that those three
-- guards are added to the allowlist with their exact function bindings and
-- trigger type 27, like the existing raw-object guards. Any other trigger still
-- fails closed. Apply it in the original's POSTDEPLOY slot; the original is
-- superseded.
--
-- Post-cutover Tier-A execution enforcement.
--
-- Operations must drain every legacy Tier-A worker/queue before applying this
-- migration. SQL cannot observe a legacy worker between database transactions;
-- the locks below only linearize the cutover and drain in-flight write
-- transactions. Active claimed executions may continue after the cutover.
-- This migration intentionally keeps
-- the legacy 9/25-argument RPC bodies and OIDs because the claimed overloads
-- call those owner-only bodies internally; it only retires their external ACL
-- and rejects every new unclaimed attempt/outcome.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

CREATE TEMP TABLE tier_a_claim_enforcement_install_state (
  old_start_oid oid NOT NULL,
  old_start_source text NOT NULL,
  old_finish_oid oid NOT NULL,
  old_finish_source text NOT NULL,
  claimed_start_oid oid NOT NULL,
  claimed_finish_oid oid NOT NULL,
  marker_oid oid
) ON COMMIT DROP;

CREATE TEMP TABLE tier_a_claim_enforcement_expected_triggers (
  table_oid oid NOT NULL,
  trigger_name text NOT NULL,
  function_oid oid NOT NULL,
  trigger_type smallint NOT NULL,
  is_deferrable boolean NOT NULL DEFAULT false,
  is_initially_deferred boolean NOT NULL DEFAULT false,
  is_constraint boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_oid, trigger_name)
) ON COMMIT DROP;

DO $preflight$
DECLARE
  v_old_start oid := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_old_finish oid := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
  );
  v_claimed_start oid := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'
  );
  v_claimed_finish oid := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer
       NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Tier-A claim enforcement requires PostgreSQL 17';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.upstream_field_inventory') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_claims') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_heads') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_write_guards') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_window_receipts') IS NULL
     OR v_old_start IS NULL
     OR v_old_finish IS NULL
     OR v_claimed_start IS NULL
     OR v_claimed_finish IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.reject_direct_leaderboard_acquisition_mutation()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.protect_metric_trust_raw_object()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.protect_leaderboard_acquisition_raw_evidence()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.serialize_leaderboard_terminal_publication()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.reject_tier_a_execution_immutable_mutation()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.require_current_tier_a_worker_guard(integer)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.assert_tier_a_execution_fence_at_commit()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'
        ) IS NULL
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
    RAISE EXCEPTION 'Tier-A claim enforcement prerequisites are missing';
  END IF;

  IF NOT EXISTS (
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
     ) THEN
    RAISE EXCEPTION 'Tier-A claim enforcement attempt binding is missing';
  END IF;

  INSERT INTO tier_a_claim_enforcement_install_state (
    old_start_oid,
    old_start_source,
    old_finish_oid,
    old_finish_source,
    claimed_start_oid,
    claimed_finish_oid,
    marker_oid
  )
  SELECT
    old_start.oid,
    old_start.prosrc,
    old_finish.oid,
    old_finish.prosrc,
    claimed_start.oid,
    claimed_finish.oid,
    pg_catalog.to_regprocedure(
      'arena.tier_a_execution_claim_enforcement_state()'
    )
  FROM pg_catalog.pg_proc AS old_start
  CROSS JOIN pg_catalog.pg_proc AS old_finish
  CROSS JOIN pg_catalog.pg_proc AS claimed_start
  CROSS JOIN pg_catalog.pg_proc AS claimed_finish
  WHERE old_start.oid = v_old_start
    AND old_finish.oid = v_old_finish
    AND claimed_start.oid = v_claimed_start
    AND claimed_finish.oid = v_claimed_finish;
END
$preflight$;

-- Workers acquire shared region authority before shared source execution.
-- Take the exact reverse-compatible exclusive order, then drain legacy table
-- writers before installing triggers. A non-drained cutover times out and
-- rolls the whole migration back instead of partially enforcing the boundary.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.tier-a-execution-claim-enforcement-install',
    0
  )
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.ingest-worker-authority:region:local',
    0
  )
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.ingest-worker-authority:region:vps_sg',
    0
  )
);

LOCK TABLE arena.sources IN SHARE MODE;

DO $source_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
      FROM arena.sources AS source
     WHERE source.status = 'active'
       AND source.fetch_region IN ('local', 'vps_sg')
     ORDER BY source.id ASC
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena.tier-a-execution-source:' || v_source_id::text,
        0
      )
    );
  END LOOP;
END
$source_locks$;

LOCK TABLE arena.leaderboard_acquisition_attempts,
  arena.leaderboard_acquisition_outcomes,
  arena.leaderboard_snapshots,
  arena.raw_objects,
  arena.upstream_field_inventory,
  arena.tier_a_execution_claims,
  arena.tier_a_execution_heads,
  arena.tier_a_execution_write_guards,
  arena.tier_a_execution_window_receipts
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE arena.tier_a_execution_write_guards
  ADD COLUMN IF NOT EXISTS verification_round smallint NOT NULL DEFAULT 0;
ALTER TABLE arena.tier_a_execution_write_guards
  ALTER COLUMN verification_round SET DEFAULT 0,
  ALTER COLUMN verification_round SET NOT NULL;

DO $verification_round_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND constraint_row.conname =
           'tier_a_execution_write_guards_verification_check'
  ) THEN
    ALTER TABLE arena.tier_a_execution_write_guards
      ADD CONSTRAINT tier_a_execution_write_guards_verification_check
      CHECK (verification_round IN (0, 1));
  END IF;
END
$verification_round_constraint$;

-- PL/pgSQL resolves record fields lazily. Run the catalog proof only after all
-- dependent relations are locked, so concurrent DDL cannot pass the check and
-- drift a field before the marker commits.
DO $dependent_column_contract$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('arena.sources'::pg_catalog.regclass, 'id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.sources'::pg_catalog.regclass, 'status'::name, 'text'::pg_catalog.regtype, true),
        ('arena.sources'::pg_catalog.regclass, 'fetch_region'::name, 'text'::pg_catalog.regtype, true),
        ('arena.leaderboard_snapshots'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.leaderboard_snapshots'::pg_catalog.regclass, 'is_derived'::name, 'boolean'::pg_catalog.regtype, true),
        ('arena.raw_objects'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.raw_objects'::pg_catalog.regclass, 'job_type'::name, 'text'::pg_catalog.regtype, true),
        ('arena.upstream_field_inventory'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.upstream_field_inventory'::pg_catalog.regclass, 'job_type'::name, 'text'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'attempt_seq'::name, 'bigint'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_slug'::name, 'text'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'queue_job_id'::name, 'text'::pg_catalog.regtype, false),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'queue_attempt'::name, 'integer'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'worker_region'::name, 'text'::pg_catalog.regtype, false),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_fetch_region'::name, 'text'::pg_catalog.regtype, true),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'execution_claim_id'::name, 'uuid'::pg_catalog.regtype, false),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'execution_generation_seq'::name, 'bigint'::pg_catalog.regtype, false),
        ('arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass, 'attempt_seq'::name, 'bigint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'generation_seq'::name, 'bigint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'claim_id'::name, 'uuid'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'queue_job_id'::name, 'text'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'queue_attempt'::name, 'integer'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'execution_region'::name, 'text'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'source_lease_scope_id'::name, 'text'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'top_xid8_text'::name, 'text'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'generation_seq'::name, 'bigint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'claim_id'::name, 'uuid'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'verification_round'::name, 'smallint'::pg_catalog.regtype, true),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'worker_region'::name, 'text'::pg_catalog.regtype, true)
      ) AS expected(table_oid, column_name, type_oid, is_not_null)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = expected.table_oid
       AND attribute.attname = expected.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     WHERE attribute.attrelid IS NULL
        OR attribute.atttypid IS DISTINCT FROM expected.type_oid
        OR attribute.attnotnull IS DISTINCT FROM expected.is_not_null
  ) THEN
    RAISE EXCEPTION 'Tier-A enforcement dependent column contract drifted';
  END IF;
END
$dependent_column_contract$;

DO $drain_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM arena.tier_a_execution_write_guards
  ) THEN
    RAISE EXCEPTION 'Tier-A execution writes were not fully drained'
      USING ERRCODE = '55006';
  END IF;
END
$drain_check$;

-- PostgreSQL lets callers force a deferred constraint trigger with
-- SET CONSTRAINTS ... IMMEDIATE. A single event that deletes its guard can
-- therefore be consumed before COMMIT. Use two rounds instead: round zero
-- updates the sentinel, which queues a second deferred event for COMMIT. If a
-- caller forces the constraint early, that second event fires recursively and
-- aborts the transaction instead of removing the guard.
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
  v_changed integer := 0;
BEGIN
  IF NEW.top_xid8_text IS DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'Tier-A execution guard belongs to another transaction'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.verification_round NOT IN (0, 1) THEN
    RAISE EXCEPTION 'Tier-A execution guard verification round is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.verification_round = 1 AND pg_catalog.pg_trigger_depth() > 1 THEN
    RAISE EXCEPTION 'Tier-A execution COMMIT fence cannot be forced early'
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

  IF NEW.verification_round = 0 THEN
    UPDATE arena.tier_a_execution_write_guards AS execution_guard
       SET verification_round = 1
     WHERE execution_guard.top_xid8_text = NEW.top_xid8_text
       AND execution_guard.source_id = NEW.source_id
       AND execution_guard.generation_seq = NEW.generation_seq
       AND execution_guard.claim_id = NEW.claim_id
       AND execution_guard.authority_scope = NEW.authority_scope
       AND execution_guard.authority_epoch = NEW.authority_epoch
       AND execution_guard.worker_instance_id = NEW.worker_instance_id
       AND execution_guard.control_epoch = NEW.control_epoch
       AND execution_guard.verification_round = 0;
  ELSE
    DELETE FROM arena.tier_a_execution_write_guards AS execution_guard
     WHERE execution_guard.top_xid8_text = NEW.top_xid8_text
       AND execution_guard.source_id = NEW.source_id
       AND execution_guard.generation_seq = NEW.generation_seq
       AND execution_guard.claim_id = NEW.claim_id
       AND execution_guard.authority_scope = NEW.authority_scope
       AND execution_guard.authority_epoch = NEW.authority_epoch
       AND execution_guard.worker_instance_id = NEW.worker_instance_id
       AND execution_guard.control_epoch = NEW.control_epoch
       AND execution_guard.verification_round = 1;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'Tier-A execution guard transition was not exact'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.assert_tier_a_execution_fence_at_commit()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS tier_a_execution_fence_commit_assertion
  ON arena.tier_a_execution_write_guards;
CREATE CONSTRAINT TRIGGER tier_a_execution_fence_commit_assertion
  AFTER INSERT OR UPDATE ON arena.tier_a_execution_write_guards
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION arena.assert_tier_a_execution_fence_at_commit();

CREATE OR REPLACE FUNCTION arena.require_current_tier_a_execution_guard(
  p_source_id integer
)
RETURNS arena.tier_a_execution_write_guards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_guard arena.tier_a_execution_write_guards%ROWTYPE;
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

  SELECT execution_guard.*
    INTO v_guard
    FROM arena.tier_a_execution_write_guards AS execution_guard
    JOIN arena.sources AS source
      ON source.id = execution_guard.source_id
   WHERE execution_guard.top_xid8_text =
         pg_catalog.pg_current_xact_id()::text
     AND execution_guard.source_id = p_source_id
     AND source.status = 'active'
     AND source.fetch_region IN ('local', 'vps_sg')
     AND source.fetch_region = execution_guard.worker_region
   FOR SHARE OF source;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'current transaction lacks a claimed Tier-A execution guard'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_guard;
END
$function$;

ALTER FUNCTION arena.require_current_tier_a_execution_guard(integer)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.require_tier_a_snapshot_execution_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT COALESCE(OLD.is_derived, false) THEN
    PERFORM arena.require_current_tier_a_execution_guard(OLD.source_id);
  END IF;
  IF NOT COALESCE(NEW.is_derived, false) THEN
    PERFORM arena.require_current_tier_a_execution_guard(NEW.source_id);
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.require_tier_a_snapshot_execution_guard()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.require_tier_a_raw_execution_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.job_type IN ('tier_a', 'tier_a_manifest', 'tier_a_failure') THEN
    PERFORM arena.require_current_tier_a_execution_guard(OLD.source_id);
  END IF;
  IF NEW.job_type IN ('tier_a', 'tier_a_manifest', 'tier_a_failure') THEN
    PERFORM arena.require_current_tier_a_execution_guard(NEW.source_id);
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.require_tier_a_raw_execution_guard()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.require_tier_a_field_inventory_execution_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.job_type = 'tier_a' THEN
    PERFORM arena.require_current_tier_a_execution_guard(OLD.source_id);
  END IF;
  IF NEW.job_type = 'tier_a' THEN
    PERFORM arena.require_current_tier_a_execution_guard(NEW.source_id);
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.require_tier_a_field_inventory_execution_guard()
  OWNER TO postgres;

-- A source row is held FOR SHARE by every guarded business write. Concurrent
-- deactivation therefore waits, while this final-row trigger rejects an
-- active/region transition attempted later by the guarded transaction itself.
CREATE OR REPLACE FUNCTION arena.reject_guarded_tier_a_source_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.fetch_region IS DISTINCT FROM OLD.fetch_region
     )
     AND EXISTS (
       SELECT 1
         FROM arena.tier_a_execution_write_guards AS execution_guard
        WHERE execution_guard.top_xid8_text =
              pg_catalog.pg_current_xact_id()::text
          AND execution_guard.source_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'guarded Tier-A source authority cannot change before COMMIT'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.reject_guarded_tier_a_source_transition()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS sources_reject_guarded_tier_a_transition
  ON arena.sources;
CREATE TRIGGER sources_reject_guarded_tier_a_transition
  AFTER UPDATE ON arena.sources
  FOR EACH ROW
  EXECUTE FUNCTION arena.reject_guarded_tier_a_source_transition();

DROP TRIGGER IF EXISTS leaderboard_snapshots_require_tier_a_execution
  ON arena.leaderboard_snapshots;
CREATE TRIGGER leaderboard_snapshots_require_tier_a_execution
  BEFORE INSERT OR UPDATE ON arena.leaderboard_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_snapshot_execution_guard();

DROP TRIGGER IF EXISTS zz_leaderboard_snapshots_verify_tier_a_execution
  ON arena.leaderboard_snapshots;
CREATE TRIGGER zz_leaderboard_snapshots_verify_tier_a_execution
  AFTER INSERT OR UPDATE ON arena.leaderboard_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_snapshot_execution_guard();

DROP TRIGGER IF EXISTS raw_objects_require_tier_a_execution
  ON arena.raw_objects;
CREATE TRIGGER raw_objects_require_tier_a_execution
  BEFORE INSERT OR UPDATE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_raw_execution_guard();

DROP TRIGGER IF EXISTS zz_raw_objects_verify_tier_a_execution
  ON arena.raw_objects;
CREATE TRIGGER zz_raw_objects_verify_tier_a_execution
  AFTER INSERT OR UPDATE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_raw_execution_guard();

DROP TRIGGER IF EXISTS upstream_field_inventory_require_tier_a_execution
  ON arena.upstream_field_inventory;
CREATE TRIGGER upstream_field_inventory_require_tier_a_execution
  BEFORE INSERT OR UPDATE ON arena.upstream_field_inventory
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_field_inventory_execution_guard();

DROP TRIGGER IF EXISTS zz_upstream_field_inventory_verify_tier_a_execution
  ON arena.upstream_field_inventory;
CREATE TRIGGER zz_upstream_field_inventory_verify_tier_a_execution
  AFTER INSERT OR UPDATE ON arena.upstream_field_inventory
  FOR EACH ROW
  EXECUTE FUNCTION arena.require_tier_a_field_inventory_execution_guard();

-- Remove the expand-only unclaimed branches. The marker pair remains bound to
-- the claimed overload, and the existing bodies/OIDs remain untouched.
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
    RAISE EXCEPTION 'unclaimed acquisition begin is retired'
      USING ERRCODE = '42501';
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

  PERFORM arena.require_current_tier_a_execution_guard(v_claim.source_id);

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
  v_source_id smallint;
BEGIN
  IF v_claim_text IS NULL AND v_generation_text IS NULL THEN
    RAISE EXCEPTION 'unclaimed acquisition finish is retired'
      USING ERRCODE = '42501';
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

  SELECT true, attempt.source_id INTO v_valid, v_source_id
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

  PERFORM arena.require_current_tier_a_execution_guard(v_source_id);

  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.assert_tier_a_execution_outcome() OWNER TO postgres;

-- BEFORE triggers bind the row used by the legacy RPC bodies. Re-run their
-- validation as AFTER triggers against the final stored NEW tuple so a
-- pre-existing or future BEFORE trigger cannot launder execution identity,
-- source identity, or outcome authority after the first check.
DROP TRIGGER IF EXISTS zz_leaderboard_acquisition_attempts_verify_tier_a_execution
  ON arena.leaderboard_acquisition_attempts;
CREATE TRIGGER zz_leaderboard_acquisition_attempts_verify_tier_a_execution
  AFTER INSERT ON arena.leaderboard_acquisition_attempts
  FOR EACH ROW
  EXECUTE FUNCTION arena.bind_tier_a_execution_attempt();

DROP TRIGGER IF EXISTS zz_leaderboard_acquisition_outcomes_verify_tier_a_execution
  ON arena.leaderboard_acquisition_outcomes;
CREATE TRIGGER zz_leaderboard_acquisition_outcomes_verify_tier_a_execution
  AFTER INSERT ON arena.leaderboard_acquisition_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION arena.assert_tier_a_execution_outcome();

INSERT INTO tier_a_claim_enforcement_expected_triggers (
  table_oid,
  trigger_name,
  function_oid,
  trigger_type,
  is_deferrable,
  is_initially_deferred
) VALUES
  (
    'arena.sources'::pg_catalog.regclass,
    'sources_reject_guarded_tier_a_transition',
    'arena.reject_guarded_tier_a_source_transition()'::pg_catalog.regprocedure,
    17,
    false,
    false
  ),
  (
    'arena.leaderboard_snapshots'::pg_catalog.regclass,
    'leaderboard_snapshots_require_tier_a_execution',
    'arena.require_tier_a_snapshot_execution_guard()'::pg_catalog.regprocedure,
    23,
    false,
    false
  ),
  (
    'arena.leaderboard_snapshots'::pg_catalog.regclass,
    'zz_leaderboard_snapshots_verify_tier_a_execution',
    'arena.require_tier_a_snapshot_execution_guard()'::pg_catalog.regprocedure,
    21,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_metric_trust_raw_object_before_write',
    'arena.protect_metric_trust_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_leaderboard_acquisition_raw_evidence_before_write',
    'arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  -- Reviewed raw-object guards installed by later launch migrations.
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_record_surface_publication_raw_before_write',
    'arena.protect_record_surface_publication_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_copier_snapshot_raw_before_write',
    'arena.protect_copier_snapshot_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_copier_snapshot_trust_raw_before_write',
    'arena.protect_copier_snapshot_trust_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'raw_objects_require_tier_a_execution',
    'arena.require_tier_a_raw_execution_guard()'::pg_catalog.regprocedure,
    23,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'zz_raw_objects_verify_tier_a_execution',
    'arena.require_tier_a_raw_execution_guard()'::pg_catalog.regprocedure,
    21,
    false,
    false
  ),
  (
    'arena.upstream_field_inventory'::pg_catalog.regclass,
    'upstream_field_inventory_require_tier_a_execution',
    'arena.require_tier_a_field_inventory_execution_guard()'::pg_catalog.regprocedure,
    23,
    false,
    false
  ),
  (
    'arena.upstream_field_inventory'::pg_catalog.regclass,
    'zz_upstream_field_inventory_verify_tier_a_execution',
    'arena.require_tier_a_field_inventory_execution_guard()'::pg_catalog.regprocedure,
    21,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
    'leaderboard_acquisition_attempts_bind_tier_a_execution',
    'arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure,
    7,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
    'leaderboard_acquisition_attempts_reject_direct_row_mutation',
    'arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure,
    31,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
    'leaderboard_acquisition_attempts_reject_truncate',
    'arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure,
    34,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
    'zz_leaderboard_acquisition_attempts_verify_tier_a_execution',
    'arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure,
    5,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass,
    'leaderboard_acquisition_outcomes_assert_tier_a_execution',
    'arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure,
    7,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass,
    'leaderboard_acquisition_outcomes_reject_direct_row_mutation',
    'arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure,
    31,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass,
    'leaderboard_acquisition_outcomes_reject_truncate',
    'arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure,
    34,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass,
    'leaderboard_acquisition_outcomes_serialize_terminal_publication',
    'arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure,
    7,
    false,
    false
  ),
  (
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass,
    'zz_leaderboard_acquisition_outcomes_verify_tier_a_execution',
    'arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure,
    5,
    false,
    false
  ),
  (
    'arena.tier_a_execution_claims'::pg_catalog.regclass,
    'tier_a_execution_claims_immutable',
    'arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
    'tier_a_execution_fence_commit_assertion',
    'arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure,
    21,
    true,
    true
  ),
  (
    'arena.tier_a_execution_window_receipts'::pg_catalog.regclass,
    'tier_a_execution_window_receipts_immutable',
    'arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure,
    27,
    false,
    false
  );

UPDATE tier_a_claim_enforcement_expected_triggers
   SET is_constraint = true
 WHERE table_oid =
       'arena.tier_a_execution_write_guards'::pg_catalog.regclass
   AND trigger_name = 'tier_a_execution_fence_commit_assertion';

DO $attempt_constraint$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_required'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_required'
       AND constraint_row.contype = 'c'
       AND NOT constraint_row.convalidated
       AND NOT constraint_row.connoinherit
       AND constraint_row.conislocal
       AND constraint_row.coninhcount = 0
       AND constraint_row.conparentid = 0
       AND pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             true
           ) =
           'execution_claim_id IS NOT NULL AND execution_generation_seq IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'Tier-A attempt execution requirement is already drifted';
  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_required'
  ) THEN
    ALTER TABLE arena.leaderboard_acquisition_attempts
      ADD CONSTRAINT leaderboard_acquisition_attempts_execution_required
      CHECK (
        execution_claim_id IS NOT NULL
        AND execution_generation_seq IS NOT NULL
      ) NOT VALID;
  END IF;
END
$attempt_constraint$;

-- This exact body is part of worker startup readiness. Keep whitespace,
-- metadata, and ACL synchronized with attempt-bound-capture-readiness.ts.
CREATE OR REPLACE FUNCTION arena.tier_a_execution_claim_enforcement_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'arena.ingest.tier-a-execution-claim-enforcement@1',
    'state', 'enforced'
  )
$function$;

ALTER FUNCTION arena.tier_a_execution_claim_enforcement_state()
  OWNER TO postgres;

-- Remove every write-shaped direct table grant while preserving existing
-- SELECT grants used by readiness and service diagnostics.
DO $closed_table_write_acl$
DECLARE
  v_table pg_catalog.regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.leaderboard_snapshots'::pg_catalog.regclass,
    'arena.raw_objects'::pg_catalog.regclass,
    'arena.upstream_field_inventory'::pg_catalog.regclass,
    'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
    'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
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
         AND expanded.privilege_type IN (
           'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
           'MAINTAIN'
         )
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM PUBLIC CASCADE',
          v_table
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM %I CASCADE',
          v_table,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_table_write_acl$;

-- Table-level REVOKE does not remove column-level grants. Close every
-- write-shaped per-column ACL while preserving any diagnostic SELECT grant.
DO $closed_column_write_acl$
DECLARE
  v_column record;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_column IN
    SELECT attribute.attrelid::pg_catalog.regclass AS table_oid,
           attribute.attname,
           attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid IN (
       'arena.leaderboard_snapshots'::pg_catalog.regclass,
       'arena.raw_objects'::pg_catalog.regclass,
       'arena.upstream_field_inventory'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.aclexplode(v_column.attacl) AS expanded
       WHERE expanded.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM PUBLIC CASCADE',
          v_column.attname,
          v_column.attname,
          v_column.attname,
          v_column.table_oid
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM %I CASCADE',
          v_column.attname,
          v_column.attname,
          v_column.attname,
          v_column.table_oid,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_column_write_acl$;

-- The execution substrate is private implementation state. Remove every
-- non-owner table grant, including hostile ALTER DEFAULT PRIVILEGES residue.
DO $closed_execution_substrate_acl$
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
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC CASCADE',
          v_table
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
$closed_execution_substrate_acl$;

DO $closed_execution_substrate_column_acl$
DECLARE
  v_column record;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_column IN
    SELECT attribute.attrelid::pg_catalog.regclass AS table_oid,
           attribute.attname,
           attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid IN (
       'arena.tier_a_execution_claims'::pg_catalog.regclass,
       'arena.tier_a_execution_heads'::pg_catalog.regclass,
       'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
       'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.aclexplode(v_column.attacl) AS expanded
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM PUBLIC CASCADE',
          v_column.attname,
          v_column.table_oid
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %I CASCADE',
          v_column.attname,
          v_column.table_oid,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_execution_substrate_column_acl$;

-- Source metadata has legitimate service-owned UPDATE paths, but no runtime
-- role needs authority to install triggers, create FK dependencies, or run
-- table maintenance. Close only those control-plane privileges.
DO $closed_source_control_acl$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS expanded
     WHERE table_row.oid = 'arena.sources'::pg_catalog.regclass
       AND expanded.grantee <> table_row.relowner
       AND expanded.privilege_type IN ('TRIGGER', 'REFERENCES', 'MAINTAIN')
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE TRIGGER, REFERENCES, MAINTAIN ON TABLE arena.sources FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE TRIGGER, REFERENCES, MAINTAIN ON TABLE arena.sources FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$closed_source_control_acl$;

DO $closed_source_reference_column_acl$
DECLARE
  v_column record;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_column IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.aclexplode(v_column.attacl) AS expanded
       WHERE expanded.privilege_type = 'REFERENCES'
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE REFERENCES (%I) ON TABLE arena.sources FROM PUBLIC CASCADE',
          v_column.attname
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE REFERENCES (%I) ON TABLE arena.sources FROM %I CASCADE',
          v_column.attname,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_source_reference_column_acl$;

-- Close every callable to its owner first. Re-open only the claimed worker
-- RPCs and the enforcement marker to service_role. The legacy bodies remain
-- present but owner-only for internal calls from the claimed overloads.
DO $closed_function_acl$
DECLARE
  v_function pg_catalog.regprocedure;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure,
    'arena.protect_metric_trust_raw_object()'::pg_catalog.regprocedure,
    'arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure,
    'arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure,
    'arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure,
    'arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure,
    'arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure,
    'arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure,
    'arena.require_current_tier_a_execution_guard(integer)'::pg_catalog.regprocedure,
    'arena.require_tier_a_snapshot_execution_guard()'::pg_catalog.regprocedure,
    'arena.require_tier_a_raw_execution_guard()'::pg_catalog.regprocedure,
    'arena.require_tier_a_field_inventory_execution_guard()'::pg_catalog.regprocedure,
    'arena.reject_guarded_tier_a_source_transition()'::pg_catalog.regprocedure,
    'arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure,
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure,
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure,
    'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure,
    'arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure,
    'arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure,
    'arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure,
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure,
    'arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure,
    'arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure
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
GRANT EXECUTE ON FUNCTION arena.tier_a_execution_claim_enforcement_state()
  TO service_role;

COMMENT ON FUNCTION arena.tier_a_execution_claim_enforcement_state() IS
  'Exact readiness marker proving post-cutover Tier-A claimed execution enforcement and legacy RPC retirement.';
COMMENT ON FUNCTION arena.require_current_tier_a_execution_guard(integer) IS
  'Requires a current-xid/source Tier-A execution guard created by the claimed write assertion RPC.';

DO $postflight$
DECLARE
  v_state tier_a_claim_enforcement_install_state%ROWTYPE;
  v_marker pg_catalog.pg_proc%ROWTYPE;
  v_marker_hash text;
  v_marker_payload jsonb;
BEGIN
  SELECT * INTO STRICT v_state
    FROM tier_a_claim_enforcement_install_state;

  IF v_state.old_start_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
     )
     OR v_state.old_finish_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
     )
     OR v_state.claimed_start_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'
     )
     OR v_state.claimed_finish_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'
     )
     OR v_state.old_start_source IS DISTINCT FROM (
       SELECT function_row.prosrc
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_start_oid
     )
     OR v_state.old_finish_source IS DISTINCT FROM (
       SELECT function_row.prosrc
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_state.old_finish_oid
     ) THEN
    RAISE EXCEPTION 'Tier-A acquisition RPC body or identity changed';
  END IF;

  IF v_state.marker_oid IS NOT NULL
     AND v_state.marker_oid IS DISTINCT FROM pg_catalog.to_regprocedure(
       'arena.tier_a_execution_claim_enforcement_state()'
     ) THEN
    RAISE EXCEPTION 'Tier-A enforcement marker identity changed on replay';
  END IF;

  SELECT function_row.* INTO STRICT v_marker
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
         'arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure;
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(v_marker.prosrc, 'UTF8')),
           'hex'
         )
    INTO STRICT v_marker_hash;
  SELECT arena.tier_a_execution_claim_enforcement_state()
    INTO STRICT v_marker_payload;

  IF v_marker.proowner IS DISTINCT FROM 'postgres'::pg_catalog.regrole
     OR NOT v_marker.prosecdef
     OR v_marker.provolatile IS DISTINCT FROM 's'
     OR v_marker.prokind IS DISTINCT FROM 'f'
     OR v_marker.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp',
       'statement_timeout=10s'
     ]::text[]
     OR v_marker_hash IS DISTINCT FROM
        '2fdc85842b2bc68331217a820de324ae274395778ab87fb072c787df251db8a4'
     OR v_marker_payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'contract', 'arena.ingest.tier-a-execution-claim-enforcement@1',
       'state', 'enforced'
     ) THEN
    RAISE EXCEPTION 'Tier-A enforcement marker contract is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          (
            'arena.reject_direct_leaderboard_acquisition_mutation()'::text,
            '79757dc5b663d38bf00aa5f19675d765eb6d6863a2cfc9fb99e797854fb234b0'::text,
            false,
            'v'::text,
            'plpgsql'::text,
            'trigger'::text,
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.protect_metric_trust_raw_object()',
            'ae03cfdeb594edba511c6bffbb425e971c273626c0571c7522e2f942c242c8a0',
            false,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.protect_leaderboard_acquisition_raw_evidence()',
            '3967f6e165ffeecb8c15b1df38802c74edd201f9bd4aac6fcddee8a6fa6384e2',
            false,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.serialize_leaderboard_terminal_publication()',
            '3059e24b558fea0d12872eeb9892325e029e1112ca2729cbc728a8edb426430a',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.reject_tier_a_execution_immutable_mutation()'::text,
            '04828313d06a9f21b8a5c68fd0715b2116003aa8ce05d3c2159f81cc82c20f51'::text,
            true,
            'v'::text,
            'plpgsql'::text,
            'trigger'::text,
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.require_current_tier_a_worker_guard(integer)',
            '1ff3691191ca63e70bfed4bf13f4dc97a7a515db5f732e9ddb181ae4b65d40f2',
            true,
            'v',
            'plpgsql',
            'arena.ingest_worker_write_guards',
            ARRAY[
              'search_path=pg_catalog, pg_temp',
              'TimeZone=UTC',
              'lock_timeout=5s',
              'statement_timeout=30s'
            ]::text[]
          ),
          (
            'arena.require_current_tier_a_execution_guard(integer)',
            '0d551e74da91c88f245eb09002b2a16b3f11f2c7009302a866f0dc7e71c9208a',
            true,
            'v',
            'plpgsql',
            'arena.tier_a_execution_write_guards',
            ARRAY[
              'search_path=pg_catalog, pg_temp',
              'TimeZone=UTC',
              'statement_timeout=30s'
            ]::text[]
          ),
          (
            'arena.require_tier_a_snapshot_execution_guard()',
            'e12f729b62503b1dd236e580d50069e9224575229fbfe6adb5040715689fecc9',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.require_tier_a_raw_execution_guard()',
            '16d5e537b4cb086657f0641f72ed5f569564870756fa22063c5bb6f3a8e44be7',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.require_tier_a_field_inventory_execution_guard()',
            '60cf710a84926fdc7e84cb2321cb357a97a95ae83025a54f5c1f90f74fcf5033',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.reject_guarded_tier_a_source_transition()',
            '092fb4f654b1aa9a282416af46c172ad100bcbd3cf06c08a14369420b70dbd9c',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.bind_tier_a_execution_attempt()',
            '41a9579b95e204ad09597c0cd044bad4ebcebeffc55682f8ca626d5eabf4f45b',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.assert_tier_a_execution_outcome()',
            '8515ac2f89771ecd386e7f2120287faccd64a0d8f3987b78fe93ec9e954c1db0',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ),
          (
            'arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)',
            'f9274aae424c4a9d2f99ccc77feeeee9f5fd3de2d51e6bbf3fa217784184be62',
            false,
            's',
            'sql',
            'jsonb',
            ARRAY[
              'search_path=pg_catalog, pg_temp',
              'TimeZone=UTC'
            ]::text[]
          ),
          (
            'arena.assert_tier_a_execution_fence_at_commit()',
            '376421b57d55b7d4638952fb538df9a255bb0441c78e0fccb22f431b3cb4933d',
            true,
            'v',
            'plpgsql',
            'trigger',
            ARRAY[
              'search_path=pg_catalog, pg_temp',
              'TimeZone=UTC',
              'lock_timeout=5s',
              'statement_timeout=30s'
            ]::text[]
          ),
          (
            'arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)',
            'b988b5aeb72c7078a50fbbb267aac981be653de83db7cce955f872d2446277a9',
            false,
            's',
            'sql',
            'jsonb',
            ARRAY[
              'search_path=pg_catalog, pg_temp',
              'TimeZone=UTC'
            ]::text[]
          )
      ) AS expected(
        signature,
        source_sha256,
        security_definer,
        volatility,
        language_name,
        return_type,
        config
      )
      LEFT JOIN pg_catalog.pg_proc AS function_row
        ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
      LEFT JOIN pg_catalog.pg_language AS language_row
        ON language_row.oid = function_row.prolang
     WHERE function_row.oid IS NULL
        OR function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR function_row.prosecdef IS DISTINCT FROM expected.security_definer
        OR function_row.provolatile::text IS DISTINCT FROM expected.volatility
        OR language_row.lanname IS DISTINCT FROM expected.language_name
        OR function_row.prorettype IS DISTINCT FROM
           pg_catalog.to_regtype(expected.return_type)
        OR function_row.proconfig IS DISTINCT FROM expected.config
        OR pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(function_row.prosrc, 'UTF8')
             ),
             'hex'
           ) IS DISTINCT FROM expected.source_sha256
  ) THEN
    RAISE EXCEPTION 'Tier-A execution substrate function contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tier_a_claim_enforcement_expected_triggers AS expected
      LEFT JOIN pg_catalog.pg_trigger AS trigger_row
        ON trigger_row.tgrelid = expected.table_oid
       AND trigger_row.tgname = expected.trigger_name
     WHERE trigger_row.oid IS NULL
        OR trigger_row.tgisinternal
        OR trigger_row.tgenabled IS DISTINCT FROM 'O'
        OR trigger_row.tgfoid IS DISTINCT FROM expected.function_oid
        OR trigger_row.tgtype IS DISTINCT FROM expected.trigger_type
        OR trigger_row.tgdeferrable IS DISTINCT FROM expected.is_deferrable
        OR trigger_row.tginitdeferred IS DISTINCT FROM
           expected.is_initially_deferred
        OR (
          expected.is_constraint
          AND trigger_row.tgconstraint = 0
        )
        OR (
          NOT expected.is_constraint
          AND trigger_row.tgconstraint <> 0
        )
        OR trigger_row.tgconstrrelid <> 0
        OR trigger_row.tgparentid <> 0
        OR trigger_row.tgattr::text <> ''
        OR trigger_row.tgqual IS NOT NULL
        OR pg_catalog.octet_length(trigger_row.tgargs) <> 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      LEFT JOIN tier_a_claim_enforcement_expected_triggers AS expected
        ON expected.table_oid = trigger_row.tgrelid
       AND expected.trigger_name = trigger_row.tgname
     WHERE trigger_row.tgrelid IN (
       SELECT expected_table.table_oid
         FROM tier_a_claim_enforcement_expected_triggers AS expected_table
       UNION ALL
       SELECT 'arena.tier_a_execution_heads'::pg_catalog.regclass
     )
       AND NOT trigger_row.tgisinternal
       AND expected.trigger_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Tier-A execution trigger allowlist is not exact'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
       AND constraint_row.conname =
           'leaderboard_acquisition_attempts_execution_required'
       AND constraint_row.contype = 'c'
       AND NOT constraint_row.convalidated
       AND NOT constraint_row.connoinherit
       AND constraint_row.conislocal
       AND constraint_row.coninhcount = 0
       AND constraint_row.conparentid = 0
       AND pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             true
           ) =
           'execution_claim_id IS NOT NULL AND execution_generation_seq IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'Tier-A attempt execution requirement is missing or drifted';
  END IF;

  IF EXISTS (
    WITH manifest(
      table_oid,
      constraint_name,
      constraint_type,
      definition_sha256
    ) AS (
      VALUES
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'leaderboard_acquisition_attempts_execution_claim_fkey', 'f', '36d350b0ac71c76410553ccd02b23f6fd5b6ff8b446ff7d8db546ac1438ab1bb'),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'leaderboard_acquisition_attempts_execution_pair_check', 'c', '8ce0876a5990c31fd350a56523f70af01574527e75e166533ff6cba207a10915'),
        ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'leaderboard_acquisition_attempts_execution_required', 'c', '8d802d31a89bc48c842116acd9ec9d11ede1378ca3072e77a8eee6fbd9fcabfe'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_activation_fkey', 'f', 'ae9ce3de869ad03a431a433e6fbe58ee1a2978c8da761e664127dcad3822606d'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_authority_epoch_check', 'c', '3857812c8a08e1bf811547609fd01e23084f867d22d984bc22025cbc416f9d31'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_bull_contract_check', 'c', '828b174403739f268877954564bf1488dc6cd4cddcdb800d4504d0416e0c987b'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_bull_digest_check', 'c', 'fb80c48c796e3e0638cb99595ade807b2e4f98c18761dca8828f7a6a6aed744c'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_claim_id_key', 'u', 'e25929901b8bbc7d95bd0f50e5599055214fb636917791f9fe70c3a64feb9e30'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_contract_check', 'c', 'b73ff455379750003c1400d14d960742c59e79899f36d85480eb3fe0efa5718f'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_control_epoch_check', 'c', '354bce0c2d8f7f00ab640c0820dc56c03e2c9b5efc0fa8d20657d3081141f39e'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_generation_check', 'c', '2a1927bee8b64de6084f1cd758c6957d0fbfb128a1193cc44041c1d32931fb87'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_git_check', 'c', '1d278eaee97a7e3bc326d183f6914a7bad2e25c902911752459524807a48e0d0'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_identity_key', 'u', 'fb4a4bc991e4fb03a38844d314d178585f0a1f63603909326e9917d106135fab'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_instance_fkey', 'f', '1bcf81e0c1182f07d7974bd1b2787115d1721f971777cfb499e19f9315987ee8'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_lease_seconds_check', 'c', '64eb62599d9ed6e162fbee84e40b5e21196be78e1a8204a215f9b8465bb245ec'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_node_check', 'c', '3e6be58a1d5d43b7b47f2e6f48597c1d14226671e5ed5fb55fdc017bd1b76e9b'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_pkey', 'p', 'c14aaa10ad6c8c01926c85c065d00e25a2aab0d3c44b953a59579da9d674e33f'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_queue_attempt_check', 'c', '80d27d81141d2b79a5eba6e49279770cfaec7eebdcc8ca105286697950131e2f'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_queue_job_id_check', 'c', '6db84ee7c47b272d332eec9356196a8852728692c87cff79aaad2b329f3f0cdf'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_queue_job_name_check', 'c', '4fd7cca45d162c78b23b7062ca600e0c0c53f806e09491f76259013c65163517'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_queue_name_check', 'c', '0c65647e2eff18d94af960199e2c7f5e7b0108f622b74fff4abe934297c2e294'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_queue_started_check', 'c', '709ba732fb4d00cd5b7da29991470fb787c17ca0a24c0f49f90ce166b67d3a99'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_region_check', 'c', '6b498cc4cb89acb4383fb2ea0bd8a430b2ccfb6146104d1d090af28103252ec5'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_release_check', 'c', 'e594209b41afc470028741d5c5b87a659e9444281c0c14740dd0f07fdb3978ec'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_contract_check', 'c', '149ee9bf9ee6412e6cdb1e94cb4b39f8a7d3d185a272be465c4b14ce50f99001'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_digest_check', 'c', '03a3216bd645f4ba956a19e7ad11fd33d8a426d8d979b31dcf8b99a1672d8417'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_fkey', 'f', '83fe940bcd342f7ae33aca4f4072c1541bf2a54426e2cd8f381cc1295b123031'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_lane_check', 'c', '945b0b2143d2303a64d933ce6aa30a74a55e5bb17d4a398cabd38ef8f20b66e3'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_lease_key', 'u', 'fa9fd9b34d33432fb93bd531036e8660bb9ec4a589405eb4ef26df70033d2325'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_source_scope_check', 'c', 'a1369d420bf02f87099a51221475c2d4183f87b2be17224314d04dbbfe8d7fa8'),
        ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'tier_a_execution_claims_time_check', 'c', '351825b4220c52edc0e6235d8ae9535974e14d2d5f87dc90951693f2fcfcc57b'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_claim_fkey', 'f', '5760c243e7c67e5aba02d324a2ba1deeb13ddf376ccda983491795764bbb9a19'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_generation_check', 'c', 'c5f6b99a37767fa17674810247adc95db6efc29b91d073c922c5e4c85760ba6c'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_phase_check', 'c', '667056f3cdf0e3bebe9ef0b7157aa17d67e0816e326013daa2c9e4b283d27fbf'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_pkey', 'p', '546830637bb203aa0810f58b2071c5b159dcbfd74a42904366a661e6eed55fec'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_source_fkey', 'f', '83fe940bcd342f7ae33aca4f4072c1541bf2a54426e2cd8f381cc1295b123031'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_state_check', 'c', 'a0e188cfcc6674761d81f13763277754f5162f0020b2a242cfc232f24305c82e'),
        ('arena.tier_a_execution_heads'::pg_catalog.regclass, 'tier_a_execution_heads_updated_check', 'c', '0d11144c3397f2f35309dd60d6c9c4a687c536b52a64c3010f23cd1c35239e26'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_attempt_id_fkey', 'f', '59cea3d5d1e6134fe923c6ff78bbe09df035866da15e8268fc65e93c9ac71e28'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_attempt_seq_fkey', 'f', 'c45f475447a5d1de880da618562fcff0083a92e7242732d8af12fee20b2c1da9'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_claim_fkey', 'f', '5760c243e7c67e5aba02d324a2ba1deeb13ddf376ccda983491795764bbb9a19'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_contract_check', 'c', 'c4bf97547cea39a12fd2c857fd1948df85a6bb00d97f7f6481a40477ddbf63e7'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_cycle_check', 'c', '04008d396cbc537ef22f15a14a951392a0e53ac418e4dded9d9891f90bf4ff33'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_generation_check', 'c', '2a1927bee8b64de6084f1cd758c6957d0fbfb128a1193cc44041c1d32931fb87'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_ids_check', 'c', '8f6b2ceadb239e8711224cae28629bcaaf6bb226de86e15c7cda95245f3b22f6'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_pkey', 'p', 'b3606f2499a89d61303a20e0dc24767177847fc42b9abce359f45d5039c889ea'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_queue_job_check', 'c', '6db84ee7c47b272d332eec9356196a8852728692c87cff79aaad2b329f3f0cdf'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_queue_name_check', 'c', '0c65647e2eff18d94af960199e2c7f5e7b0108f622b74fff4abe934297c2e294'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_recorded_check', 'c', 'aa460c5eb1920536f6aa7f635818490631505bb7c9861bdec1ebf484c1d179b6'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_snapshot_fkey', 'f', 'd62ef7c1fe02030c9984f57705e37a6577b5a49dff2a59dbef3cd21f4eed8123'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_source_run_check', 'c', '77affcf8f1e7e953bf01416fd8bfc979d9ed76933a54a9e962b8ced279820652'),
        ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass, 'tier_a_execution_window_receipts_timeframe_check', 'c', '89cc4252e219f2638203eb15075e577561b16c3e6f8540c9a97c89c717106f2a'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_fence_commit_assertion', 't', '698fc09045e7267eeb19c5b09473ec8c40f237145be8c1cbd97b9dde2451ddc1'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_activation_fkey', 'f', 'ae9ce3de869ad03a431a433e6fbe58ee1a2978c8da761e664127dcad3822606d'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_authority_check', 'c', '23d791c4d097158bb6eebe2f6e40b3e0264aa9a0cbb4a8659e02f136ed5181c7'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_claim_fkey', 'f', '5760c243e7c67e5aba02d324a2ba1deeb13ddf376ccda983491795764bbb9a19'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_contract_check', 'c', 'b73ff455379750003c1400d14d960742c59e79899f36d85480eb3fe0efa5718f'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_generation_check', 'c', '2a1927bee8b64de6084f1cd758c6957d0fbfb128a1193cc44041c1d32931fb87'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_instance_fkey', 'f', '1bcf81e0c1182f07d7974bd1b2787115d1721f971777cfb499e19f9315987ee8'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_node_check', 'c', '3e6be58a1d5d43b7b47f2e6f48597c1d14226671e5ed5fb55fdc017bd1b76e9b'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_pkey', 'p', 'f3b6a17a6506af2d88ab7e532ba5b14039d15e31a89c1c381e8aab1519bdf5c3'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_release_check', 'c', '141bf196804bf5f2b74bd6d6d1b7d0067cac45e6ce74a5a3f5417b1842e38a76'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_time_check', 'c', '73358fae4ab65041ebf2c9aec481613c61c2478cae0b5adcb7c1653947ca6dd0'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_verification_check', 'c', '0570dc05191d03c2f30b8056003ae76ab72ea0008eda77abd02654bedaaa9cec'),
        ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'tier_a_execution_write_guards_xid_check', 'c', '327014b24f0905e7bcf76e71957bef6800fea981c3a1e3e9e579d65a4a9b42e8')
    ),
    expected AS (
      SELECT
        manifest.table_oid,
        manifest.constraint_name,
        manifest.constraint_type,
        manifest.constraint_name <>
          'leaderboard_acquisition_attempts_execution_required'
          AS is_validated,
        manifest.constraint_type <> 'c' AS is_no_inherit,
        true AS is_local,
        0::smallint AS inherit_count,
        0::oid AS parent_oid,
        manifest.constraint_type = 't' AS is_deferrable,
        manifest.constraint_type = 't' AS is_initially_deferred,
        manifest.definition_sha256
      FROM manifest
    ),
    attempt_execution_columns AS (
      SELECT COALESCE(
        pg_catalog.array_agg(attribute.attnum ORDER BY attribute.attnum),
        ARRAY[]::smallint[]
      ) AS attnums
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
            'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
        AND attribute.attname IN (
          'execution_claim_id',
          'execution_generation_seq'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ),
    actual AS (
      SELECT
        constraint_row.conrelid::pg_catalog.regclass AS table_oid,
        constraint_row.conname::text AS constraint_name,
        constraint_row.contype::text AS constraint_type,
        constraint_row.convalidated AS is_validated,
        constraint_row.connoinherit AS is_no_inherit,
        constraint_row.conislocal AS is_local,
        constraint_row.coninhcount AS inherit_count,
        constraint_row.conparentid AS parent_oid,
        constraint_row.condeferrable AS is_deferrable,
        constraint_row.condeferred AS is_initially_deferred,
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
              'UTF8'
            )
          ),
          'hex'
        ) AS definition_sha256
      FROM pg_catalog.pg_constraint AS constraint_row
      CROSS JOIN attempt_execution_columns
      WHERE constraint_row.conrelid IN (
        'arena.tier_a_execution_claims'::pg_catalog.regclass,
        'arena.tier_a_execution_heads'::pg_catalog.regclass,
        'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
        'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
      )
      OR (
        constraint_row.conrelid =
          'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
        AND (
          pg_catalog.starts_with(
            constraint_row.conname::text,
            'leaderboard_acquisition_attempts_execution_'
          )
          OR COALESCE(
               constraint_row.conkey,
               ARRAY[]::smallint[]
             ) && attempt_execution_columns.attnums
          OR constraint_row.confrelid =
             'arena.tier_a_execution_claims'::pg_catalog.regclass
        )
      )
    ),
    drift AS (
      (
        SELECT * FROM expected
        EXCEPT
        SELECT * FROM actual
      )
      UNION ALL
      (
        SELECT * FROM actual
        EXCEPT
        SELECT * FROM expected
      )
    )
    SELECT 1 FROM drift LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Tier-A execution constraint allowlist is not exact'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid IN (
       'arena.leaderboard_snapshots'::pg_catalog.regclass,
       'arena.raw_objects'::pg_catalog.regclass,
       'arena.upstream_field_inventory'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     )
       AND table_row.relowner <> 'postgres'::pg_catalog.regrole
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
       'arena.leaderboard_snapshots'::pg_catalog.regclass,
       'arena.raw_objects'::pg_catalog.regclass,
       'arena.upstream_field_inventory'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     )
       AND expanded.grantee <> table_row.relowner
       AND expanded.privilege_type IN (
         'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
         'MAINTAIN'
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
     WHERE attribute.attrelid IN (
       'arena.leaderboard_snapshots'::pg_catalog.regclass,
       'arena.raw_objects'::pg_catalog.regclass,
       'arena.upstream_field_inventory'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass,
       'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
       AND expanded.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION 'Tier-A write table ACL is not closed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid IN (
       'arena.tier_a_execution_claims'::pg_catalog.regclass,
       'arena.tier_a_execution_heads'::pg_catalog.regclass,
       'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
       'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
     )
       AND (
         table_row.relowner <> 'postgres'::pg_catalog.regrole
         OR table_row.relkind <> 'r'
         OR NOT table_row.relrowsecurity
       )
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
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
      JOIN pg_catalog.pg_class AS table_row
        ON table_row.oid = attribute.attrelid
     WHERE attribute.attrelid IN (
       'arena.tier_a_execution_claims'::pg_catalog.regclass,
       'arena.tier_a_execution_heads'::pg_catalog.regclass,
       'arena.tier_a_execution_write_guards'::pg_catalog.regclass,
       'arena.tier_a_execution_window_receipts'::pg_catalog.regclass
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
       AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'Tier-A execution substrate authority is not closed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid = 'arena.sources'::pg_catalog.regclass
       AND (
         table_row.relowner <> 'postgres'::pg_catalog.regrole
         OR table_row.relkind <> 'r'
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS expanded
     WHERE table_row.oid = 'arena.sources'::pg_catalog.regclass
       AND expanded.grantee <> table_row.relowner
       AND expanded.privilege_type IN ('TRIGGER', 'REFERENCES', 'MAINTAIN')
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
     WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
       AND expanded.privilege_type = 'REFERENCES'
  ) THEN
    RAISE EXCEPTION 'Tier-A source control-plane ACL is not closed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure, false),
          ('arena.protect_metric_trust_raw_object()'::pg_catalog.regprocedure, false),
          ('arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure, false),
          ('arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure, false),
          ('arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_execution_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_snapshot_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_raw_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_field_inventory_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.reject_guarded_tier_a_source_transition()'::pg_catalog.regprocedure, false),
          ('arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure, false),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure, false),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure, false),
          ('arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure, true),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure, true)
      ) AS expected(function_oid, service_allowed)
      JOIN pg_catalog.pg_proc AS function_row
        ON function_row.oid = expected.function_oid
      LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS expanded ON true
     WHERE function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR (
          expanded.privilege_type = 'EXECUTE'
          AND expanded.grantee <> function_row.proowner
          AND NOT (
            expected.service_allowed
            AND expanded.grantee = 'service_role'::pg_catalog.regrole
            AND NOT expanded.is_grantable
          )
        )
  ) OR EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('arena.reject_direct_leaderboard_acquisition_mutation()'::pg_catalog.regprocedure, false),
          ('arena.protect_metric_trust_raw_object()'::pg_catalog.regprocedure, false),
          ('arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure, false),
          ('arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure, false),
          ('arena.reject_tier_a_execution_immutable_mutation()'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_worker_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_fence_at_commit()'::pg_catalog.regprocedure, false),
          ('arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)'::pg_catalog.regprocedure, false),
          ('arena.require_current_tier_a_execution_guard(integer)'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_snapshot_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_raw_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.require_tier_a_field_inventory_execution_guard()'::pg_catalog.regprocedure, false),
          ('arena.reject_guarded_tier_a_source_transition()'::pg_catalog.regprocedure, false),
          ('arena.bind_tier_a_execution_attempt()'::pg_catalog.regprocedure, false),
          ('arena.assert_tier_a_execution_outcome()'::pg_catalog.regprocedure, false),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure, false),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure, false),
          ('arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure, true),
          ('arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure, true),
          ('arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure, true),
          ('arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure, true)
      ) AS expected(function_oid, service_allowed)
     WHERE pg_catalog.has_function_privilege(
       'service_role', expected.function_oid, 'EXECUTE'
     ) IS DISTINCT FROM expected.service_allowed
  ) THEN
    RAISE EXCEPTION 'Tier-A enforcement function ACL is not a closed set';
  END IF;

  IF EXISTS (
    SELECT 1 FROM arena.tier_a_execution_write_guards
  ) THEN
    RAISE EXCEPTION 'Tier-A execution write guard survived enforcement install';
  END IF;
END
$postflight$;

COMMIT;
