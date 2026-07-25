-- Migration: 20260725011000_durable_ingest_worker_fence_substrate.sql
-- Created: 2026-07-25T01:10:00Z
-- Description: Install the inert PostgreSQL authority substrate for ingest
--   worker fencing. PostgreSQL allocates a non-reusable monotonic epoch for
--   each committed activation, while one active node/instance/token tuple owns
--   each explicitly registered authority scope. Fenced write transactions hold
--   a shared transaction advisory lock and record an ephemeral top-level xid8
--   guard whose deferred constraint trigger re-attests the owner at COMMIT.
--   Stage A (Migration A) does not enforce any business-table write gate.
--   This migration deliberately changes no existing worker RPC, privilege, or
--   business-table trigger. A separately reviewed enforcement migration may
--   require these guards only after every authoritative writer is compatible.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_055_count bigint := 0;
  v_055_exact boolean := false;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'ingest worker fence substrate requires PostgreSQL 17';
  END IF;

  IF pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regnamespace('extensions') IS NULL
     OR pg_catalog.to_regnamespace('supabase_migrations') IS NULL
     OR pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NULL
     OR pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'ingest worker fence substrate schemas, ledger, or SHA-256 digest are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'ingest worker fence substrate roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_metric_trust_release_readiness()'
     ) IS NULL THEN
    RAISE EXCEPTION 'ingest worker fence substrate requires metric-trust readiness migration 055';
  END IF;

  -- The production migration ledger is historically drifted. Serialize this
  -- one-file ratchet with every approved schema write and require the exact 055
  -- release body rather than assuming directory order implies production state.
  EXECUTE
    'LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE';

  SELECT
    pg_catalog.count(*),
    pg_catalog.bool_or(
      ledger.name = 'metric_trust_source_page_lineage_forward_repair'
      AND ledger.version = '20260722055000'
      AND pg_catalog.array_length(ledger.statements, 1) = 1
      AND pg_catalog.encode(
            extensions.digest(
              pg_catalog.convert_to(ledger.statements[1], 'UTF8'),
              'sha256'
            ),
            'hex'
          ) = 'ed630f6f9f152a3b135569eda39f0cb4221894f7366d4a87954042f3f8b01271'
    )
  INTO STRICT v_055_count, v_055_exact
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.name = 'metric_trust_source_page_lineage_forward_repair'
     OR ledger.version = '20260722055000';

  IF v_055_count <> 1 OR NOT COALESCE(v_055_exact, false) THEN
    RAISE EXCEPTION 'ingest worker fence substrate requires the exact immutable 055 ledger';
  END IF;

  IF pg_catalog.to_regclass('arena.ingest_worker_fence_epoch_seq') IS NOT NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_instances') IS NOT NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_authorities') IS NOT NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_activations') IS NOT NULL
     OR pg_catalog.to_regclass('arena.ingest_worker_write_guards') IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.assert_ingest_worker_fence_at_commit()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'public.arena_ingest_worker_fence_release_readiness()'
        ) IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = function_row.pronamespace
        WHERE (
          namespace_row.nspname = 'arena'
          AND function_row.proname IN (
            'activate_ingest_worker_authority',
            'renew_ingest_worker_authority',
            'release_ingest_worker_authority',
            'begin_ingest_worker_fenced_write',
            'assert_ingest_worker_fence_at_commit'
          )
        ) OR (
          namespace_row.nspname = 'public'
          AND function_row.proname =
              'arena_ingest_worker_fence_release_readiness'
        )
     ) THEN
    RAISE EXCEPTION 'ingest worker fence substrate target objects must be wholly absent';
  END IF;
END
$preflight$;

-- nextval() is intentionally non-transactional. A failed activation may leave
-- a gap, but no caller can ever observe the same authority epoch assigned to a
-- later instance. The maximum matches the Redis/TypeScript safe-integer fence.
CREATE SEQUENCE arena.ingest_worker_fence_epoch_seq
  AS bigint
  INCREMENT BY 1
  MINVALUE 1
  MAXVALUE 9007199254740000
  START WITH 1
  CACHE 1
  NO CYCLE
  OWNED BY NONE;

CREATE TABLE arena.ingest_worker_instances (
  instance_id uuid PRIMARY KEY,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  initial_control_server_time_ms bigint NOT NULL,
  owner_token_digest bytea NOT NULL UNIQUE,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  registered_at timestamptz NOT NULL,
  UNIQUE (node_id, control_epoch),
  CONSTRAINT ingest_worker_instances_instance_id_canonical CHECK (
    instance_id::text ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT ingest_worker_instances_node_id_canonical CHECK (
    node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND pg_catalog.btrim(node_id) = node_id
  ),
  CONSTRAINT ingest_worker_instances_region_canonical CHECK (
    worker_region IN ('local', 'vps_sg')
  ),
  CONSTRAINT ingest_worker_instances_control_epoch_safe CHECK (
    control_epoch BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_instances_control_server_time_safe CHECK (
    initial_control_server_time_ms BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_instances_token_digest_sha256 CHECK (
    pg_catalog.octet_length(owner_token_digest) = 32
  ),
  CONSTRAINT ingest_worker_instances_release_id_canonical CHECK (
    release_id ~ '^[0-9a-f]{64}$'
    AND release_id <> pg_catalog.repeat('0', 64)
  ),
  CONSTRAINT ingest_worker_instances_git_sha_canonical CHECK (
    git_sha ~ '^[0-9a-f]{40}$'
    AND git_sha <> pg_catalog.repeat('0', 40)
  ),
  CONSTRAINT ingest_worker_instances_registered_at_millisecond CHECK (
    registered_at = pg_catalog.date_trunc('milliseconds', registered_at)
  )
);

CREATE TABLE arena.ingest_worker_authorities (
  authority_scope text PRIMARY KEY,
  epoch_high_water bigint NOT NULL DEFAULT 0,
  active_epoch bigint,
  active_instance_id uuid REFERENCES arena.ingest_worker_instances(instance_id)
    ON DELETE RESTRICT,
  active_node_id text,
  active_control_epoch bigint,
  active_control_server_time_ms bigint,
  lease_expires_at timestamptz,
  activated_at timestamptz,
  renewed_at timestamptz,
  CONSTRAINT ingest_worker_authorities_scope_registered CHECK (
    authority_scope IN ('region:local', 'region:vps_sg')
  ),
  CONSTRAINT ingest_worker_authorities_epoch_high_water_safe CHECK (
    epoch_high_water BETWEEN 0 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_authorities_active_epoch_safe CHECK (
    active_epoch IS NULL
    OR active_epoch BETWEEN 1 AND epoch_high_water
  ),
  CONSTRAINT ingest_worker_authorities_active_node_canonical CHECK (
    active_node_id IS NULL
    OR (
      active_node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND pg_catalog.btrim(active_node_id) = active_node_id
    )
  ),
  CONSTRAINT ingest_worker_authorities_active_control_safe CHECK (
    (active_control_epoch IS NULL OR active_control_epoch BETWEEN 1 AND 9007199254740000)
    AND (
      active_control_server_time_ms IS NULL
      OR active_control_server_time_ms BETWEEN 1 AND 9007199254740000
    )
  ),
  CONSTRAINT ingest_worker_authorities_active_tuple_complete CHECK (
    (
      active_epoch IS NULL
      AND active_instance_id IS NULL
      AND active_node_id IS NULL
      AND active_control_epoch IS NULL
      AND active_control_server_time_ms IS NULL
      AND lease_expires_at IS NULL
      AND activated_at IS NULL
      AND renewed_at IS NULL
    )
    OR
    (
      active_epoch IS NOT NULL
      AND active_instance_id IS NOT NULL
      AND active_node_id IS NOT NULL
      AND active_control_epoch IS NOT NULL
      AND active_control_server_time_ms IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND activated_at IS NOT NULL
      AND renewed_at IS NOT NULL
      AND renewed_at >= activated_at
      AND lease_expires_at > renewed_at
    )
  ),
  CONSTRAINT ingest_worker_authorities_active_times_millisecond CHECK (
    (activated_at IS NULL OR activated_at = pg_catalog.date_trunc('milliseconds', activated_at))
    AND (renewed_at IS NULL OR renewed_at = pg_catalog.date_trunc('milliseconds', renewed_at))
    AND (
      lease_expires_at IS NULL
      OR lease_expires_at = pg_catalog.date_trunc('milliseconds', lease_expires_at)
    )
  )
);

CREATE TABLE arena.ingest_worker_activations (
  authority_scope text NOT NULL REFERENCES arena.ingest_worker_authorities(authority_scope)
    ON DELETE RESTRICT,
  epoch bigint NOT NULL,
  instance_id uuid NOT NULL REFERENCES arena.ingest_worker_instances(instance_id)
    ON DELETE RESTRICT,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  control_server_time_ms bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  status text NOT NULL,
  activated_at timestamptz NOT NULL,
  last_renewed_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (authority_scope, epoch),
  UNIQUE (epoch),
  UNIQUE (authority_scope, instance_id),
  CONSTRAINT ingest_worker_activations_epoch_safe CHECK (
    epoch BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_activations_node_id_canonical CHECK (
    node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND pg_catalog.btrim(node_id) = node_id
  ),
  CONSTRAINT ingest_worker_activations_scope_region_exact CHECK (
    worker_region IN ('local', 'vps_sg')
    AND authority_scope = 'region:' || worker_region
  ),
  CONSTRAINT ingest_worker_activations_control_proof_safe CHECK (
    control_epoch BETWEEN 1 AND 9007199254740000
    AND control_server_time_ms BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_activations_release_id_canonical CHECK (
    release_id ~ '^[0-9a-f]{64}$'
    AND release_id <> pg_catalog.repeat('0', 64)
  ),
  CONSTRAINT ingest_worker_activations_git_sha_canonical CHECK (
    git_sha ~ '^[0-9a-f]{40}$'
    AND git_sha <> pg_catalog.repeat('0', 40)
  ),
  CONSTRAINT ingest_worker_activations_status_canonical CHECK (
    status IN ('active', 'released', 'expired')
  ),
  CONSTRAINT ingest_worker_activations_lifecycle_complete CHECK (
    last_renewed_at >= activated_at
    AND (
      (status = 'active' AND ended_at IS NULL)
      OR
      (
        status IN ('released', 'expired')
        AND ended_at IS NOT NULL
        AND ended_at >= activated_at
      )
    )
  ),
  CONSTRAINT ingest_worker_activations_times_millisecond CHECK (
    activated_at = pg_catalog.date_trunc('milliseconds', activated_at)
    AND last_renewed_at = pg_catalog.date_trunc('milliseconds', last_renewed_at)
    AND (
      ended_at IS NULL
      OR ended_at = pg_catalog.date_trunc('milliseconds', ended_at)
    )
  )
);

ALTER TABLE arena.ingest_worker_authorities
  ADD CONSTRAINT ingest_worker_authorities_active_activation_fk
  FOREIGN KEY (authority_scope, active_epoch)
  REFERENCES arena.ingest_worker_activations(authority_scope, epoch)
  ON DELETE RESTRICT;

CREATE TABLE arena.ingest_worker_write_guards (
  top_xid8_text text NOT NULL,
  authority_scope text NOT NULL,
  epoch bigint NOT NULL,
  instance_id uuid NOT NULL,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  asserted_at timestamptz NOT NULL,
  lease_expires_at_at_assertion timestamptz NOT NULL,
  PRIMARY KEY (top_xid8_text, authority_scope),
  CONSTRAINT ingest_worker_write_guards_xid8_canonical CHECK (
    top_xid8_text ~ '^[1-9][0-9]*$'
    AND pg_catalog.length(top_xid8_text) <= 20
  ),
  CONSTRAINT ingest_worker_write_guards_activation_fk
    FOREIGN KEY (authority_scope, epoch)
    REFERENCES arena.ingest_worker_activations(authority_scope, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT ingest_worker_write_guards_instance_fk
    FOREIGN KEY (instance_id)
    REFERENCES arena.ingest_worker_instances(instance_id)
    ON DELETE RESTRICT,
  CONSTRAINT ingest_worker_write_guards_epoch_safe CHECK (
    epoch BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_write_guards_node_id_canonical CHECK (
    node_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND pg_catalog.btrim(node_id) = node_id
  ),
  CONSTRAINT ingest_worker_write_guards_scope_region_exact CHECK (
    worker_region IN ('local', 'vps_sg')
    AND authority_scope = 'region:' || worker_region
  ),
  CONSTRAINT ingest_worker_write_guards_control_epoch_safe CHECK (
    control_epoch BETWEEN 1 AND 9007199254740000
  ),
  CONSTRAINT ingest_worker_write_guards_release_id_canonical CHECK (
    release_id ~ '^[0-9a-f]{64}$'
    AND release_id <> pg_catalog.repeat('0', 64)
  ),
  CONSTRAINT ingest_worker_write_guards_git_sha_canonical CHECK (
    git_sha ~ '^[0-9a-f]{40}$'
    AND git_sha <> pg_catalog.repeat('0', 40)
  ),
  CONSTRAINT ingest_worker_write_guards_times_canonical CHECK (
    asserted_at = pg_catalog.date_trunc('milliseconds', asserted_at)
    AND lease_expires_at_at_assertion =
        pg_catalog.date_trunc('milliseconds', lease_expires_at_at_assertion)
    AND lease_expires_at_at_assertion > asserted_at
  )
);

INSERT INTO arena.ingest_worker_authorities (authority_scope)
VALUES ('region:local'), ('region:vps_sg');

COMMENT ON SEQUENCE arena.ingest_worker_fence_epoch_seq IS
  'Global non-cycling allocator for database-authoritative ingest worker fencing epochs. Gaps are intentional; values are never reused after rollback.';
COMMENT ON TABLE arena.ingest_worker_instances IS
  'Private immutable authority-handle identities and one-way owner-token digests. One UUID is permanently bound to one region scope; cross-region failover requires a fresh Redis generation and UUID.';
COMMENT ON TABLE arena.ingest_worker_authorities IS
  'Private current owner and committed epoch high-water for each explicitly registered ingest authority scope.';
COMMENT ON TABLE arena.ingest_worker_activations IS
  'Private immutable-per-epoch activation history. A released or expired instance can never reactivate the same scope.';
COMMENT ON TABLE arena.ingest_worker_write_guards IS
  'Ephemeral top-level xid8 assertions made by fenced authoritative write transactions. The deferred assertion deletes its exact guard before a successful COMMIT; inert until business-table enforcement is deployed separately.';

CREATE FUNCTION arena.activate_ingest_worker_authority(
  p_scope text,
  p_region text,
  p_node_id text,
  p_instance_id uuid,
  p_owner_token text,
  p_control_epoch bigint,
  p_control_server_time_ms bigint,
  p_release_id text,
  p_git_sha text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz;
  v_expires_at timestamptz;
  v_token_digest bytea;
  v_instance arena.ingest_worker_instances%ROWTYPE;
  v_authority arena.ingest_worker_authorities%ROWTYPE;
  v_activation arena.ingest_worker_activations%ROWTYPE;
  v_epoch bigint;
  v_changed bigint;
  v_control_high_water bigint := 0;
  v_instance_exists boolean := false;
  v_activation_exists boolean := false;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'ingest worker authority activation requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  IF p_scope IS NULL
     OR p_scope NOT IN ('region:local', 'region:vps_sg')
     OR p_region IS NULL
     OR p_region NOT IN ('local', 'vps_sg')
     OR p_scope IS DISTINCT FROM 'region:' || p_region
     OR p_node_id IS NULL
     OR p_node_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR pg_catalog.btrim(p_node_id) <> p_node_id
     OR p_instance_id IS NULL
     OR p_instance_id::text !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_owner_token IS NULL
     OR p_owner_token !~ '^[0-9a-f]{64}$'
     OR p_owner_token = pg_catalog.repeat('0', 64)
     OR p_control_epoch IS NULL
     OR p_control_epoch NOT BETWEEN 1 AND 9007199254740000
     OR p_control_server_time_ms IS NULL
     OR p_control_server_time_ms NOT BETWEEN 1 AND 9007199254740000
     OR p_release_id IS NULL
     OR p_release_id !~ '^[0-9a-f]{64}$'
     OR p_release_id = pg_catalog.repeat('0', 64)
     OR p_git_sha IS NULL
     OR p_git_sha !~ '^[0-9a-f]{40}$'
     OR p_git_sha = pg_catalog.repeat('0', 40) THEN
    RAISE EXCEPTION 'invalid ingest worker authority activation identity'
      USING ERRCODE = '22023';
  END IF;

  v_token_digest := extensions.digest(
    pg_catalog.convert_to(p_owner_token, 'UTF8'),
    'sha256'
  );
  -- Exclusive activation/release and shared renew/write locks use this exact
  -- namespace. A hash collision can only add serialization; it cannot weaken
  -- fencing.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:' || p_scope,
      0
    )
  );

  -- Serialize the Redis control generation across every scope owned by this
  -- physical node. Instance rows are append-only, so MAX(control_epoch) is the
  -- durable per-node high-water without a fifth mutable registry table.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-control-node:' || p_node_id,
      0
    )
  );

  SELECT *
    INTO v_authority
    FROM arena.ingest_worker_authorities
   WHERE authority_scope = p_scope
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest worker authority scope is not registered'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
    INTO v_instance
    FROM arena.ingest_worker_instances
   WHERE instance_id = p_instance_id;
  v_instance_exists := FOUND;

  IF v_instance_exists THEN
    IF v_instance.node_id IS DISTINCT FROM p_node_id
       OR v_instance.worker_region IS DISTINCT FROM p_region
       OR v_instance.control_epoch IS DISTINCT FROM p_control_epoch
       OR v_instance.initial_control_server_time_ms IS DISTINCT FROM
          p_control_server_time_ms
       OR v_instance.owner_token_digest IS DISTINCT FROM v_token_digest
       OR v_instance.release_id IS DISTINCT FROM p_release_id
       OR v_instance.git_sha IS DISTINCT FROM p_git_sha THEN
      RAISE EXCEPTION 'ingest worker instance replay conflicts with its registered identity'
        USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_activation
      FROM arena.ingest_worker_activations
     WHERE authority_scope = p_scope
       AND epoch = v_authority.active_epoch;
    v_activation_exists := FOUND;

    -- Set wall time only after every potentially blocking scope/state lock.
    v_now := pg_catalog.date_trunc(
      'milliseconds',
      pg_catalog.clock_timestamp()
    );

    IF v_authority.active_instance_id IS DISTINCT FROM p_instance_id
       OR v_authority.active_control_epoch IS DISTINCT FROM p_control_epoch
       OR v_authority.active_control_server_time_ms IS DISTINCT FROM
          v_activation.control_server_time_ms
       OR NOT v_activation_exists
       OR v_authority.active_node_id IS DISTINCT FROM p_node_id
       OR v_activation.instance_id IS DISTINCT FROM p_instance_id
       OR v_activation.node_id IS DISTINCT FROM p_node_id
       OR v_activation.worker_region IS DISTINCT FROM p_region
       OR v_activation.control_epoch IS DISTINCT FROM p_control_epoch
       OR v_activation.control_server_time_ms < p_control_server_time_ms
       OR v_activation.release_id IS DISTINCT FROM p_release_id
       OR v_activation.git_sha IS DISTINCT FROM p_git_sha
       OR v_activation.status IS DISTINCT FROM 'active'
       OR v_activation.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'fenced ingest worker instance cannot create a new activation'
        USING ERRCODE = '55000';
    END IF;

    IF v_authority.lease_expires_at <= v_now THEN
      RAISE EXCEPTION 'expired ingest worker instance cannot reactivate its authority handle'
        USING ERRCODE = '55000';
    END IF;

    -- Exact activation replay handles an uncertain COMMIT response. It never
    -- renews or changes the Redis proof; only renew may extend a live lease.
    RETURN pg_catalog.jsonb_build_object(
      'authority_scope', p_scope,
      'contract', 'arena.worker-db-fence@1',
      'control_epoch', p_control_epoch::text,
      'control_server_time_ms', v_activation.control_server_time_ms::text,
      'epoch', v_authority.active_epoch::text,
      'instance_id', p_instance_id::text,
      'lease_expires_at', pg_catalog.to_char(
        v_authority.lease_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'node_id', p_node_id,
      'region', p_region,
      'server_time', pg_catalog.to_char(
        v_now AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'active'
    );
  END IF;

  SELECT COALESCE(pg_catalog.max(instance.control_epoch), 0)
    INTO STRICT v_control_high_water
    FROM arena.ingest_worker_instances AS instance
   WHERE instance.node_id = p_node_id;

  -- The node high-water query can wait on an uncommitted registration.
  -- Refresh time afterwards so an expired owner can never appear live because
  -- this activation waited behind another transaction.
  v_now := pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp()
  );
  v_expires_at := v_now + interval '180 seconds';

  IF p_control_epoch <= v_control_high_water THEN
    RAISE EXCEPTION 'ingest worker control epoch is not strictly above the node high-water'
      USING ERRCODE = '55000';
  END IF;

  IF v_authority.active_epoch IS NOT NULL
     AND v_authority.lease_expires_at > v_now THEN
    RAISE EXCEPTION 'ingest worker authority scope already has a live owner'
      USING ERRCODE = '55P03';
  END IF;

  IF v_authority.active_epoch IS NOT NULL THEN
    UPDATE arena.ingest_worker_activations
       SET status = 'expired',
           ended_at = v_now
     WHERE authority_scope = p_scope
       AND epoch = v_authority.active_epoch
       AND instance_id = v_authority.active_instance_id
       AND node_id = v_authority.active_node_id
       AND status = 'active'
       AND ended_at IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN
      RAISE EXCEPTION 'expired ingest worker authority history is not exact'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO arena.ingest_worker_instances (
    instance_id,
    node_id,
    worker_region,
    control_epoch,
    initial_control_server_time_ms,
    owner_token_digest,
    release_id,
    git_sha,
    registered_at
  ) VALUES (
    p_instance_id,
    p_node_id,
    p_region,
    p_control_epoch,
    p_control_server_time_ms,
    v_token_digest,
    p_release_id,
    p_git_sha,
    v_now
  );

  v_epoch := pg_catalog.nextval(
    'arena.ingest_worker_fence_epoch_seq'::pg_catalog.regclass
  );
  IF v_epoch <= v_authority.epoch_high_water
     OR v_epoch > 9007199254740000 THEN
    RAISE EXCEPTION 'ingest worker database epoch allocator is behind its committed high-water'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO arena.ingest_worker_activations (
    authority_scope,
    epoch,
    instance_id,
    node_id,
    worker_region,
    control_epoch,
    control_server_time_ms,
    release_id,
    git_sha,
    status,
    activated_at,
    last_renewed_at,
    ended_at
  ) VALUES (
    p_scope,
    v_epoch,
    p_instance_id,
    p_node_id,
    p_region,
    p_control_epoch,
    p_control_server_time_ms,
    p_release_id,
    p_git_sha,
    'active',
    v_now,
    v_now,
    NULL
  );

  UPDATE arena.ingest_worker_authorities
     SET epoch_high_water = v_epoch,
         active_epoch = v_epoch,
         active_instance_id = p_instance_id,
         active_node_id = p_node_id,
         active_control_epoch = p_control_epoch,
         active_control_server_time_ms = p_control_server_time_ms,
         lease_expires_at = v_expires_at,
         activated_at = v_now,
         renewed_at = v_now
   WHERE authority_scope = p_scope;

  RETURN pg_catalog.jsonb_build_object(
    'authority_scope', p_scope,
    'contract', 'arena.worker-db-fence@1',
    'control_epoch', p_control_epoch::text,
    'control_server_time_ms', p_control_server_time_ms::text,
    'epoch', v_epoch::text,
    'instance_id', p_instance_id::text,
    'lease_expires_at', pg_catalog.to_char(
      v_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'node_id', p_node_id,
    'region', p_region,
    'server_time', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', 'active'
  );
END
$function$;

CREATE FUNCTION arena.renew_ingest_worker_authority(
  p_scope text,
  p_region text,
  p_node_id text,
  p_instance_id uuid,
  p_owner_token text,
  p_control_epoch bigint,
  p_control_server_time_ms bigint,
  p_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz;
  v_expires_at timestamptz;
  v_token_digest bytea;
  v_instance arena.ingest_worker_instances%ROWTYPE;
  v_authority arena.ingest_worker_authorities%ROWTYPE;
  v_activation arena.ingest_worker_activations%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'ingest worker authority renewal requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  IF p_scope IS NULL
     OR p_scope NOT IN ('region:local', 'region:vps_sg')
     OR p_region IS NULL
     OR p_region NOT IN ('local', 'vps_sg')
     OR p_scope IS DISTINCT FROM 'region:' || p_region
     OR p_node_id IS NULL
     OR p_node_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR pg_catalog.btrim(p_node_id) <> p_node_id
     OR p_instance_id IS NULL
     OR p_instance_id::text !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_owner_token IS NULL
     OR p_owner_token !~ '^[0-9a-f]{64}$'
     OR p_owner_token = pg_catalog.repeat('0', 64)
     OR p_control_epoch IS NULL
     OR p_control_epoch NOT BETWEEN 1 AND 9007199254740000
     OR p_control_server_time_ms IS NULL
     OR p_control_server_time_ms NOT BETWEEN 1 AND 9007199254740000
     OR p_epoch IS NULL
     OR p_epoch NOT BETWEEN 1 AND 9007199254740000 THEN
    RAISE EXCEPTION 'invalid ingest worker authority renewal identity'
      USING ERRCODE = '22023';
  END IF;

  v_token_digest := extensions.digest(
    pg_catalog.convert_to(p_owner_token, 'UTF8'),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:' || p_scope,
      0
    )
  );

  SELECT *
    INTO v_authority
    FROM arena.ingest_worker_authorities
   WHERE authority_scope = p_scope
   FOR UPDATE;

  SELECT *
    INTO v_instance
    FROM arena.ingest_worker_instances
   WHERE instance_id = p_instance_id;

  SELECT *
    INTO v_activation
    FROM arena.ingest_worker_activations
   WHERE authority_scope = p_scope
     AND epoch = p_epoch;

  -- Renew may wait for another renewer's row lock. Never judge liveness from
  -- a timestamp sampled before that wait.
  v_now := pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp()
  );

  IF v_authority.authority_scope IS NULL
     OR v_instance.instance_id IS NULL
     OR v_activation.authority_scope IS NULL
     OR v_instance.node_id IS DISTINCT FROM p_node_id
     OR v_instance.worker_region IS DISTINCT FROM p_region
     OR v_instance.control_epoch IS DISTINCT FROM p_control_epoch
     OR v_instance.owner_token_digest IS DISTINCT FROM v_token_digest
     OR v_authority.active_epoch IS DISTINCT FROM p_epoch
     OR v_authority.active_instance_id IS DISTINCT FROM p_instance_id
     OR v_authority.active_node_id IS DISTINCT FROM p_node_id
     OR v_authority.active_control_epoch IS DISTINCT FROM p_control_epoch
     OR v_authority.lease_expires_at <= v_now
     OR v_activation.instance_id IS DISTINCT FROM p_instance_id
     OR v_activation.node_id IS DISTINCT FROM p_node_id
     OR v_activation.worker_region IS DISTINCT FROM p_region
     OR v_activation.control_epoch IS DISTINCT FROM p_control_epoch
     OR v_authority.active_control_server_time_ms IS DISTINCT FROM
        v_activation.control_server_time_ms
     OR v_activation.release_id IS DISTINCT FROM v_instance.release_id
     OR v_activation.git_sha IS DISTINCT FROM v_instance.git_sha
     OR v_activation.status IS DISTINCT FROM 'active'
     OR v_activation.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ingest worker authority renewal was fenced'
      USING ERRCODE = '55000';
  END IF;

  IF p_control_server_time_ms < v_activation.control_server_time_ms THEN
    RAISE EXCEPTION 'ingest worker authority renewal control proof regressed'
      USING ERRCODE = '55000';
  END IF;

  IF p_control_server_time_ms = v_activation.control_server_time_ms THEN
    -- Exact retry after an uncertain renewal response. Never extend from an
    -- equal or delayed Redis TIME proof.
    RETURN pg_catalog.jsonb_build_object(
      'authority_scope', p_scope,
      'contract', 'arena.worker-db-fence@1',
      'control_epoch', p_control_epoch::text,
      'control_server_time_ms', p_control_server_time_ms::text,
      'epoch', p_epoch::text,
      'instance_id', p_instance_id::text,
      'lease_expires_at', pg_catalog.to_char(
        v_authority.lease_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'node_id', p_node_id,
      'region', p_region,
      'server_time', pg_catalog.to_char(
        v_now AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'active'
    );
  END IF;

  v_expires_at := v_now + interval '180 seconds';

  UPDATE arena.ingest_worker_authorities
     SET lease_expires_at = v_expires_at,
         active_control_server_time_ms = p_control_server_time_ms,
         renewed_at = v_now
   WHERE authority_scope = p_scope;

  UPDATE arena.ingest_worker_activations
     SET control_server_time_ms = p_control_server_time_ms,
         last_renewed_at = v_now
   WHERE authority_scope = p_scope
     AND epoch = p_epoch;

  RETURN pg_catalog.jsonb_build_object(
    'authority_scope', p_scope,
    'contract', 'arena.worker-db-fence@1',
    'control_epoch', p_control_epoch::text,
    'control_server_time_ms', p_control_server_time_ms::text,
    'epoch', p_epoch::text,
    'instance_id', p_instance_id::text,
    'lease_expires_at', pg_catalog.to_char(
      v_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'node_id', p_node_id,
    'region', p_region,
    'server_time', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', 'active'
  );
END
$function$;

CREATE FUNCTION arena.release_ingest_worker_authority(
  p_scope text,
  p_region text,
  p_node_id text,
  p_instance_id uuid,
  p_owner_token text,
  p_control_epoch bigint,
  p_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz;
  v_token_digest bytea;
  v_instance arena.ingest_worker_instances%ROWTYPE;
  v_authority arena.ingest_worker_authorities%ROWTYPE;
  v_activation arena.ingest_worker_activations%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'ingest worker authority release requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  IF p_scope IS NULL
     OR p_scope NOT IN ('region:local', 'region:vps_sg')
     OR p_region IS NULL
     OR p_region NOT IN ('local', 'vps_sg')
     OR p_scope IS DISTINCT FROM 'region:' || p_region
     OR p_node_id IS NULL
     OR p_node_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR pg_catalog.btrim(p_node_id) <> p_node_id
     OR p_instance_id IS NULL
     OR p_instance_id::text !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_owner_token IS NULL
     OR p_owner_token !~ '^[0-9a-f]{64}$'
     OR p_owner_token = pg_catalog.repeat('0', 64)
     OR p_control_epoch IS NULL
     OR p_control_epoch NOT BETWEEN 1 AND 9007199254740000
     OR p_epoch IS NULL
     OR p_epoch NOT BETWEEN 1 AND 9007199254740000 THEN
    RAISE EXCEPTION 'invalid ingest worker authority release identity'
      USING ERRCODE = '22023';
  END IF;

  v_token_digest := extensions.digest(
    pg_catalog.convert_to(p_owner_token, 'UTF8'),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:' || p_scope,
      0
    )
  );

  SELECT *
    INTO v_authority
    FROM arena.ingest_worker_authorities
   WHERE authority_scope = p_scope
   FOR UPDATE;

  SELECT *
    INTO v_instance
    FROM arena.ingest_worker_instances
   WHERE instance_id = p_instance_id;

  SELECT *
    INTO v_activation
    FROM arena.ingest_worker_activations
   WHERE authority_scope = p_scope
     AND epoch = p_epoch
     AND instance_id = p_instance_id;

  v_now := pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp()
  );

  IF v_authority.authority_scope IS NOT NULL
     AND v_instance.instance_id IS NOT NULL
     AND v_instance.node_id IS NOT DISTINCT FROM p_node_id
     AND v_instance.worker_region IS NOT DISTINCT FROM p_region
     AND v_instance.control_epoch IS NOT DISTINCT FROM p_control_epoch
     AND v_instance.owner_token_digest IS NOT DISTINCT FROM v_token_digest
     AND v_activation.authority_scope IS NOT NULL
     AND v_activation.node_id IS NOT DISTINCT FROM p_node_id
     AND v_activation.worker_region IS NOT DISTINCT FROM p_region
     AND v_activation.control_epoch IS NOT DISTINCT FROM p_control_epoch
     AND v_activation.release_id IS NOT DISTINCT FROM v_instance.release_id
     AND v_activation.git_sha IS NOT DISTINCT FROM v_instance.git_sha
     AND v_activation.status = 'released'
     AND v_activation.ended_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'authority_scope', p_scope,
      'contract', 'arena.worker-db-fence@1',
      'control_epoch', p_control_epoch::text,
      'epoch', p_epoch::text,
      'instance_id', p_instance_id::text,
      'node_id', p_node_id,
      'region', p_region,
      'released', true,
      'server_time', pg_catalog.to_char(
        v_now AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'released'
    );
  END IF;

  IF v_authority.authority_scope IS NULL
     OR v_instance.instance_id IS NULL
     OR v_activation.authority_scope IS NULL
     OR v_instance.node_id IS DISTINCT FROM p_node_id
     OR v_instance.worker_region IS DISTINCT FROM p_region
     OR v_instance.control_epoch IS DISTINCT FROM p_control_epoch
     OR v_instance.owner_token_digest IS DISTINCT FROM v_token_digest
     OR v_authority.active_epoch IS DISTINCT FROM p_epoch
     OR v_authority.active_instance_id IS DISTINCT FROM p_instance_id
     OR v_authority.active_node_id IS DISTINCT FROM p_node_id
     OR v_authority.active_control_epoch IS DISTINCT FROM p_control_epoch
     OR v_authority.active_control_server_time_ms IS DISTINCT FROM
        v_activation.control_server_time_ms
     OR v_activation.node_id IS DISTINCT FROM p_node_id
     OR v_activation.worker_region IS DISTINCT FROM p_region
     OR v_activation.control_epoch IS DISTINCT FROM p_control_epoch
     OR v_activation.release_id IS DISTINCT FROM v_instance.release_id
     OR v_activation.git_sha IS DISTINCT FROM v_instance.git_sha
     OR v_activation.status IS DISTINCT FROM 'active'
     OR v_activation.ended_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'authority_scope', p_scope,
      'contract', 'arena.worker-db-fence@1',
      'control_epoch', p_control_epoch::text,
      'epoch', p_epoch::text,
      'instance_id', p_instance_id::text,
      'node_id', p_node_id,
      'region', p_region,
      'released', false,
      'server_time', pg_catalog.to_char(
        v_now AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'fenced'
    );
  END IF;

  UPDATE arena.ingest_worker_activations
     SET status = 'released',
         ended_at = v_now
   WHERE authority_scope = p_scope
     AND epoch = p_epoch;

  UPDATE arena.ingest_worker_authorities
     SET active_epoch = NULL,
         active_instance_id = NULL,
         active_node_id = NULL,
         active_control_epoch = NULL,
         active_control_server_time_ms = NULL,
         lease_expires_at = NULL,
         activated_at = NULL,
         renewed_at = NULL
   WHERE authority_scope = p_scope;

  RETURN pg_catalog.jsonb_build_object(
    'authority_scope', p_scope,
    'contract', 'arena.worker-db-fence@1',
    'control_epoch', p_control_epoch::text,
    'epoch', p_epoch::text,
    'instance_id', p_instance_id::text,
    'node_id', p_node_id,
    'region', p_region,
    'released', true,
    'server_time', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', 'released'
  );
END
$function$;

CREATE FUNCTION arena.begin_ingest_worker_fenced_write(
  p_scope text,
  p_region text,
  p_node_id text,
  p_instance_id uuid,
  p_owner_token text,
  p_control_epoch bigint,
  p_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz;
  v_token_digest bytea;
  v_top_xid8_text text;
  v_proof record;
  v_guard arena.ingest_worker_write_guards%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'ingest worker fenced write requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  IF p_scope IS NULL
     OR p_scope NOT IN ('region:local', 'region:vps_sg')
     OR p_region IS NULL
     OR p_region NOT IN ('local', 'vps_sg')
     OR p_scope IS DISTINCT FROM 'region:' || p_region
     OR p_node_id IS NULL
     OR p_node_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR pg_catalog.btrim(p_node_id) <> p_node_id
     OR p_instance_id IS NULL
     OR p_instance_id::text !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_owner_token IS NULL
     OR p_owner_token !~ '^[0-9a-f]{64}$'
     OR p_owner_token = pg_catalog.repeat('0', 64)
     OR p_control_epoch IS NULL
     OR p_control_epoch NOT BETWEEN 1 AND 9007199254740000
     OR p_epoch IS NULL
     OR p_epoch NOT BETWEEN 1 AND 9007199254740000 THEN
    RAISE EXCEPTION 'invalid ingest worker fenced write identity'
      USING ERRCODE = '22023';
  END IF;

  v_token_digest := extensions.digest(
    pg_catalog.convert_to(p_owner_token, 'UTF8'),
    'sha256'
  );

  -- Held until COMMIT/ROLLBACK. An activation or release for this scope takes
  -- the exclusive form and therefore cannot overtake an authorized write.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:' || p_scope,
      0
    )
  );

  -- One statement snapshot is mandatory here: renew uses the same shared
  -- advisory lock and may commit between separate SPI statements. Reading the
  -- three proof rows independently could combine an older authority row with a
  -- newer activation row and falsely fence a valid consumer write.
  SELECT
    authority.authority_scope AS a_scope,
    authority.active_epoch AS a_epoch,
    authority.active_instance_id AS a_instance_id,
    authority.active_node_id AS a_node_id,
    authority.active_control_epoch AS a_control_epoch,
    authority.active_control_server_time_ms AS a_control_server_time_ms,
    authority.lease_expires_at AS a_lease_expires_at,
    instance.instance_id AS i_instance_id,
    instance.node_id AS i_node_id,
    instance.worker_region AS i_region,
    instance.control_epoch AS i_control_epoch,
    instance.owner_token_digest AS i_owner_token_digest,
    instance.release_id AS i_release_id,
    instance.git_sha AS i_git_sha,
    activation.authority_scope AS x_scope,
    activation.instance_id AS x_instance_id,
    activation.node_id AS x_node_id,
    activation.worker_region AS x_region,
    activation.control_epoch AS x_control_epoch,
    activation.control_server_time_ms AS x_control_server_time_ms,
    activation.release_id AS x_release_id,
    activation.git_sha AS x_git_sha,
    activation.status AS x_status,
    activation.ended_at AS x_ended_at
    INTO v_proof
    FROM arena.ingest_worker_authorities AS authority
    LEFT JOIN arena.ingest_worker_instances AS instance
      ON instance.instance_id = p_instance_id
    LEFT JOIN arena.ingest_worker_activations AS activation
      ON activation.authority_scope = p_scope
     AND activation.epoch = p_epoch
   WHERE authority.authority_scope = p_scope;

  v_now := pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp()
  );

  IF v_proof.a_scope IS NULL
     OR v_proof.i_instance_id IS NULL
     OR v_proof.x_scope IS NULL
     OR v_proof.i_node_id IS DISTINCT FROM p_node_id
     OR v_proof.i_region IS DISTINCT FROM p_region
     OR v_proof.i_control_epoch IS DISTINCT FROM p_control_epoch
     OR v_proof.i_owner_token_digest IS DISTINCT FROM v_token_digest
     OR v_proof.a_epoch IS DISTINCT FROM p_epoch
     OR v_proof.a_instance_id IS DISTINCT FROM p_instance_id
     OR v_proof.a_node_id IS DISTINCT FROM p_node_id
     OR v_proof.a_control_epoch IS DISTINCT FROM p_control_epoch
     OR v_proof.a_control_server_time_ms IS DISTINCT FROM
        v_proof.x_control_server_time_ms
     OR v_proof.a_lease_expires_at <= v_now
     OR v_proof.x_instance_id IS DISTINCT FROM p_instance_id
     OR v_proof.x_node_id IS DISTINCT FROM p_node_id
     OR v_proof.x_region IS DISTINCT FROM p_region
     OR v_proof.x_control_epoch IS DISTINCT FROM p_control_epoch
     OR v_proof.x_release_id IS DISTINCT FROM v_proof.i_release_id
     OR v_proof.x_git_sha IS DISTINCT FROM v_proof.i_git_sha
     OR v_proof.x_status IS DISTINCT FROM 'active'
     OR v_proof.x_ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ingest worker fenced write authority is stale or expired'
      USING ERRCODE = '55000';
  END IF;

  v_top_xid8_text := pg_catalog.pg_current_xact_id()::text;

  SELECT *
    INTO v_guard
    FROM arena.ingest_worker_write_guards
   WHERE top_xid8_text = v_top_xid8_text
     AND authority_scope = p_scope;

  IF FOUND THEN
    IF v_guard.epoch IS DISTINCT FROM p_epoch
       OR v_guard.instance_id IS DISTINCT FROM p_instance_id
       OR v_guard.node_id IS DISTINCT FROM p_node_id
       OR v_guard.worker_region IS DISTINCT FROM p_region
       OR v_guard.control_epoch IS DISTINCT FROM p_control_epoch
       OR v_guard.release_id IS DISTINCT FROM v_proof.i_release_id
       OR v_guard.git_sha IS DISTINCT FROM v_proof.i_git_sha THEN
      RAISE EXCEPTION 'ingest worker write transaction guard replay conflicts with prior assertion'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    INSERT INTO arena.ingest_worker_write_guards (
      top_xid8_text,
      authority_scope,
      epoch,
      instance_id,
      node_id,
      worker_region,
      control_epoch,
      release_id,
      git_sha,
      asserted_at,
      lease_expires_at_at_assertion
    ) VALUES (
      v_top_xid8_text,
      p_scope,
      p_epoch,
      p_instance_id,
      p_node_id,
      p_region,
      p_control_epoch,
      v_proof.i_release_id,
      v_proof.i_git_sha,
      v_now,
      v_proof.a_lease_expires_at
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'authority_scope', p_scope,
    'contract', 'arena.worker-db-fence@1',
    'control_epoch', p_control_epoch::text,
    'control_server_time_ms', v_proof.x_control_server_time_ms::text,
    'epoch', p_epoch::text,
    'instance_id', p_instance_id::text,
    'lease_expires_at', pg_catalog.to_char(
      v_proof.a_lease_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'node_id', p_node_id,
    'region', p_region,
    'server_time', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', 'asserted',
    'transaction_id', v_top_xid8_text
  );
END
$function$;

CREATE FUNCTION arena.assert_ingest_worker_fence_at_commit()
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
  v_deleted bigint := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
       'read committed' THEN
    RAISE EXCEPTION 'ingest worker fence commit assertion requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  IF NEW.top_xid8_text IS DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ingest worker write guard does not belong to the committing transaction'
      USING ERRCODE = '55000';
  END IF;

  -- begin_ingest_worker_fenced_write already holds this lock. Re-acquisition
  -- is intentional and also protects a guard whose constraint was forced
  -- IMMEDIATE: transaction advisory locks remain held until transaction end.
  -- The wall-clock expiry check below makes a transaction that crosses expiry
  -- fail closed in the normal deferred path, but the shared lock--not trigger
  -- timing--is what prevents an activation/commit race.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'arena.ingest-worker-authority:' || NEW.authority_scope,
      0
    )
  );

  v_now := pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp()
  );

  SELECT true
    INTO v_valid
    FROM arena.ingest_worker_authorities AS authority
    JOIN arena.ingest_worker_instances AS instance
      ON instance.instance_id = authority.active_instance_id
    JOIN arena.ingest_worker_activations AS activation
      ON activation.authority_scope = authority.authority_scope
     AND activation.epoch = authority.active_epoch
   WHERE authority.authority_scope = NEW.authority_scope
     AND authority.active_epoch = NEW.epoch
     AND authority.active_instance_id = NEW.instance_id
     AND authority.active_node_id = NEW.node_id
     AND authority.active_control_epoch = NEW.control_epoch
     AND authority.active_control_server_time_ms = activation.control_server_time_ms
     AND authority.lease_expires_at > v_now
     AND instance.node_id = NEW.node_id
     AND instance.worker_region = NEW.worker_region
     AND instance.control_epoch = NEW.control_epoch
     AND instance.release_id = NEW.release_id
     AND instance.git_sha = NEW.git_sha
     AND activation.instance_id = NEW.instance_id
     AND activation.node_id = NEW.node_id
     AND activation.worker_region = NEW.worker_region
     AND activation.control_epoch = NEW.control_epoch
     AND activation.release_id = NEW.release_id
     AND activation.git_sha = NEW.git_sha
     AND activation.status = 'active'
     AND activation.ended_at IS NULL
  -- Do not row-lock either joined proof row here. Renewals take the same shared
  -- scope advisory lock and may safely strengthen this exact owner's proof in
  -- parallel. A row-lock wait would let READ COMMITTED EvalPlanQual combine a
  -- post-wait authority row with the statement's pre-wait activation snapshot,
  -- falsely fencing an otherwise valid writer. The one joined MVCC snapshot is
  -- internally consistent, while activation/release remain excluded by the
  -- shared-versus-exclusive scope advisory lock.
  ;

  IF NOT COALESCE(v_valid, false) THEN
    RAISE EXCEPTION 'ingest worker write transaction was fenced before commit'
      USING ERRCODE = '55000';
  END IF;

  -- A visible guard is needed only until this deferred check succeeds. Delete
  -- the exact row in the same transaction so the substrate has a hard zero-row
  -- steady-state instead of an unbounded commit-audit table.
  DELETE FROM arena.ingest_worker_write_guards
   WHERE top_xid8_text = NEW.top_xid8_text
     AND authority_scope = NEW.authority_scope
     AND epoch = NEW.epoch
     AND instance_id = NEW.instance_id
     AND node_id = NEW.node_id
     AND worker_region = NEW.worker_region
     AND control_epoch = NEW.control_epoch
     AND release_id = NEW.release_id
     AND git_sha = NEW.git_sha;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted <> 1 THEN
    RAISE EXCEPTION 'ingest worker write guard cleanup was not exact'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion
AFTER INSERT ON arena.ingest_worker_write_guards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION arena.assert_ingest_worker_fence_at_commit();

CREATE FUNCTION public.arena_ingest_worker_fence_release_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_release_migration_count bigint := 0;
  v_release_migration_sha256 text := '';
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_epoch_sequence oid := pg_catalog.to_regclass(
    'arena.ingest_worker_fence_epoch_seq'
  );
  v_instances_table oid := pg_catalog.to_regclass(
    'arena.ingest_worker_instances'
  );
  v_authorities_table oid := pg_catalog.to_regclass(
    'arena.ingest_worker_authorities'
  );
  v_activations_table oid := pg_catalog.to_regclass(
    'arena.ingest_worker_activations'
  );
  v_guards_table oid := pg_catalog.to_regclass(
    'arena.ingest_worker_write_guards'
  );
  v_activate_rpc oid := pg_catalog.to_regprocedure(
    'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)'
  );
  v_renew_rpc oid := pg_catalog.to_regprocedure(
    'arena.renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)'
  );
  v_release_rpc oid := pg_catalog.to_regprocedure(
    'arena.release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)'
  );
  v_begin_write_rpc oid := pg_catalog.to_regprocedure(
    'arena.begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)'
  );
  v_assert_rpc oid := pg_catalog.to_regprocedure(
    'arena.assert_ingest_worker_fence_at_commit()'
  );
  v_readiness_rpc oid := pg_catalog.to_regprocedure(
    'public.arena_ingest_worker_fence_release_readiness()'
  );
  v_enforcement boolean := false;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    v_missing := pg_catalog.array_append(v_missing, 'postgresql:17');
  END IF;

  IF v_epoch_sequence IS NULL
     OR v_instances_table IS NULL
     OR v_authorities_table IS NULL
     OR v_activations_table IS NULL
     OR v_guards_table IS NULL
     OR v_activate_rpc IS NULL
     OR v_renew_rpc IS NULL
     OR v_release_rpc IS NULL
     OR v_begin_write_rpc IS NULL
     OR v_assert_rpc IS NULL
     OR v_readiness_rpc IS NULL THEN
    v_missing := pg_catalog.array_append(v_missing, 'objects:worker-db-fence');
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS sequence_relation
         JOIN pg_catalog.pg_sequence AS sequence_row
           ON sequence_row.seqrelid = sequence_relation.oid
        WHERE sequence_relation.oid = v_epoch_sequence
          AND sequence_relation.relkind = 'S'
          AND sequence_relation.relpersistence = 'p'
          AND sequence_relation.relowner = v_postgres
          AND sequence_row.seqtypid = 'bigint'::pg_catalog.regtype
          AND sequence_row.seqstart = 1
          AND sequence_row.seqmin = 1
          AND sequence_row.seqmax = 9007199254740000
          AND sequence_row.seqincrement = 1
          AND NOT sequence_row.seqcycle
          AND sequence_row.seqcache = 1
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_depend AS dependency_row
        WHERE dependency_row.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency_row.objid = v_epoch_sequence
          AND dependency_row.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency_row.deptype IN ('a', 'i')
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'sequence:exact');
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_class AS relation_row
        WHERE relation_row.oid = ANY (ARRAY[
          v_instances_table,
          v_authorities_table,
          v_activations_table,
          v_guards_table
        ]::oid[])
          AND relation_row.relkind = 'r'
          AND relation_row.relpersistence = 'p'
          AND relation_row.relowner = v_postgres
          AND NOT relation_row.relispartition
          AND NOT relation_row.relrowsecurity
          AND NOT relation_row.relforcerowsecurity
     ) <> 4 THEN
    v_missing := pg_catalog.array_append(v_missing, 'relations:durable-private');
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = ANY (ARRAY[
          v_activate_rpc,
          v_renew_rpc,
          v_release_rpc,
          v_begin_write_rpc
        ]::oid[])
          AND function_row.proowner = v_postgres
          AND function_row.prolang = (
            SELECT language_row.oid
              FROM pg_catalog.pg_language AS language_row
             WHERE language_row.lanname = 'plpgsql'
          )
          AND function_row.prokind = 'f'
          AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
          AND NOT function_row.proretset
          AND NOT function_row.proisstrict
          AND function_row.proargmodes IS NULL
          AND function_row.proallargtypes IS NULL
          AND function_row.provariadic = 0
          AND function_row.prosecdef
          AND function_row.provolatile = 'v'
          AND function_row.proparallel = 'u'
          AND NOT function_row.proleakproof
          AND function_row.pronargdefaults = 0
          AND function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC',
            'lock_timeout=5s',
            'statement_timeout=30s'
          ]::text[]
          AND pg_catalog.cardinality(function_row.proconfig) = 4
     ) <> 4
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           (
             v_activate_rpc,
             ARRAY[
               'p_scope',
               'p_region',
               'p_node_id',
               'p_instance_id',
               'p_owner_token',
               'p_control_epoch',
               'p_control_server_time_ms',
               'p_release_id',
               'p_git_sha'
             ]::text[]
           ),
           (
             v_renew_rpc,
             ARRAY[
               'p_scope',
               'p_region',
               'p_node_id',
               'p_instance_id',
               'p_owner_token',
               'p_control_epoch',
               'p_control_server_time_ms',
               'p_epoch'
             ]::text[]
           ),
           (
             v_release_rpc,
             ARRAY[
               'p_scope',
               'p_region',
               'p_node_id',
               'p_instance_id',
               'p_owner_token',
               'p_control_epoch',
               'p_epoch'
             ]::text[]
           ),
           (
             v_begin_write_rpc,
             ARRAY[
               'p_scope',
               'p_region',
               'p_node_id',
               'p_instance_id',
               'p_owner_token',
               'p_control_epoch',
               'p_epoch'
             ]::text[]
           )
         ) AS expected(function_oid, argument_names)
         LEFT JOIN pg_catalog.pg_proc AS function_row
           ON function_row.oid = expected.function_oid
        WHERE function_row.oid IS NULL
           OR function_row.proargnames IS DISTINCT FROM expected.argument_names
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_assert_rpc
          AND function_row.proowner = v_postgres
          AND function_row.prolang = (
            SELECT language_row.oid
              FROM pg_catalog.pg_language AS language_row
             WHERE language_row.lanname = 'plpgsql'
          )
          AND function_row.prokind = 'f'
          AND function_row.prorettype = 'trigger'::pg_catalog.regtype
          AND NOT function_row.proretset
          AND NOT function_row.proisstrict
          AND function_row.proargnames IS NULL
          AND function_row.proargmodes IS NULL
          AND function_row.proallargtypes IS NULL
          AND function_row.provariadic = 0
          AND function_row.prosecdef
          AND function_row.provolatile = 'v'
          AND function_row.proparallel = 'u'
          AND NOT function_row.proleakproof
          AND function_row.pronargs = 0
          AND function_row.pronargdefaults = 0
          AND function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC',
            'lock_timeout=5s',
            'statement_timeout=30s'
          ]::text[]
          AND pg_catalog.cardinality(function_row.proconfig) = 4
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_readiness_rpc
          AND function_row.proowner = v_postgres
          AND function_row.prolang = (
            SELECT language_row.oid
              FROM pg_catalog.pg_language AS language_row
             WHERE language_row.lanname = 'plpgsql'
          )
          AND function_row.prokind = 'f'
          AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
          AND NOT function_row.proretset
          AND NOT function_row.proisstrict
          AND function_row.proargnames IS NULL
          AND function_row.proargmodes IS NULL
          AND function_row.proallargtypes IS NULL
          AND function_row.provariadic = 0
          AND function_row.prosecdef
          AND function_row.provolatile = 's'
          AND function_row.proparallel = 'u'
          AND NOT function_row.proleakproof
          AND function_row.pronargs = 0
          AND function_row.pronargdefaults = 0
          AND function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC',
            'statement_timeout=30s'
          ]::text[]
          AND pg_catalog.cardinality(function_row.proconfig) = 3
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'functions:exact');
  END IF;

  -- A same-name overload can make RPC resolution ambiguous even when the exact
  -- intended identity still exists.
  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = function_row.pronamespace
        WHERE (
          (
            namespace_row.nspname = 'arena'
            AND function_row.proname IN (
              'activate_ingest_worker_authority',
              'renew_ingest_worker_authority',
              'release_ingest_worker_authority',
              'begin_ingest_worker_fenced_write',
              'assert_ingest_worker_fence_at_commit'
            )
          ) OR (
            namespace_row.nspname = 'public'
            AND function_row.proname =
                'arena_ingest_worker_fence_release_readiness'
          )
        )
          AND function_row.oid <> ALL (ARRAY[
            v_activate_rpc,
            v_renew_rpc,
            v_release_rpc,
            v_begin_write_rpc,
            v_assert_rpc,
            v_readiness_rpc
          ]::oid[])
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'functions:overloads');
  END IF;

  -- Seal the five private mutation/enforcement bodies independently of their
  -- catalog attributes. The public readiness body cannot safely attest its own
  -- source; release tooling must compare the returned migration digest with the
  -- exact Git object before wiring or enforcement.
  IF EXISTS (
       SELECT 1
         FROM (VALUES
           (
             v_activate_rpc,
             '16e12c5de8e92eb04dfcb35993f1f8f3a2339e64d5e05dd841b1a8ef530ac768'
           ),
           (
             v_renew_rpc,
             'ebfdc2a7973458ef8a8581ef37be10078f061180326818e94ff919fff082f829'
           ),
           (
             v_release_rpc,
             '7bffa53e5b6faa734e7acb9c2a64016c4508e3e23668d1fd4cb93a61d84d1de9'
           ),
           (
             v_begin_write_rpc,
             'c1851781cdd05d09a45edd69371fdcbbc662d9368a0d4db195fbb75171ed25b7'
           ),
           (
             v_assert_rpc,
             'fb8f579165a8b3bec296ff12a57a49a3c48fad8edf395a48dca8df1e837c859b'
           )
         ) AS expected(function_oid, body_sha256)
         LEFT JOIN pg_catalog.pg_proc AS function_row
           ON function_row.oid = expected.function_oid
        WHERE pg_catalog.encode(
                extensions.digest(
                  pg_catalog.convert_to(function_row.prosrc, 'UTF8'),
                  'sha256'
                ),
                'hex'
              ) IS DISTINCT FROM expected.body_sha256
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'functions:body-sha256');
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM arena.ingest_worker_authorities
     ) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM arena.ingest_worker_authorities
        WHERE authority_scope = 'region:local'
     )
     OR NOT EXISTS (
       SELECT 1 FROM arena.ingest_worker_authorities
        WHERE authority_scope = 'region:vps_sg'
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'scopes:exact');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgfoid = v_assert_rpc
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgrelid IS DISTINCT FROM
           v_guards_table
  ) INTO STRICT v_enforcement;

  IF v_enforcement
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_guards_table
          AND NOT trigger_row.tgisinternal
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_guards_table
          AND trigger_row.tgname = 'ingest_worker_fence_commit_assertion'
          AND trigger_row.tgfoid = v_assert_rpc
          AND trigger_row.tgtype = 5
          AND trigger_row.tgattr = ''::pg_catalog.int2vector
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgconstraint <> 0
          AND trigger_row.tgparentid = 0
          AND trigger_row.tgoldtable IS NULL
          AND trigger_row.tgnewtable IS NULL
          AND trigger_row.tgdeferrable
          AND trigger_row.tginitdeferred
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND NOT trigger_row.tgisinternal
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint AS constraint_row
             WHERE constraint_row.oid = trigger_row.tgconstraint
               AND constraint_row.contype = 't'
               AND constraint_row.connamespace =
                   pg_catalog.to_regnamespace('arena')
               AND constraint_row.conrelid = v_guards_table
               AND constraint_row.condeferrable
               AND constraint_row.condeferred
               AND constraint_row.convalidated
               AND constraint_row.conparentid = 0
          )
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'trigger:inert-commit-assertion');
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             relation_row.relacl,
             pg_catalog.acldefault(
               (
                 CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END
               )::pg_catalog."char",
               relation_row.relowner
             )
           )
         ) AS privilege_row
        WHERE relation_row.oid = ANY (ARRAY[
          v_epoch_sequence,
          v_instances_table,
          v_authorities_table,
          v_activations_table,
          v_guards_table
        ]::oid[])
          AND privilege_row.grantee <> relation_row.relowner
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
        WHERE function_row.oid = ANY (ARRAY[
          v_activate_rpc,
          v_renew_rpc,
          v_release_rpc,
          v_begin_write_rpc,
          v_assert_rpc
        ]::oid[])
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee <> function_row.proowner
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee = v_service_role
          AND privilege_row.grantor = function_row.proowner
          AND NOT privilege_row.is_grantable
     ) <> 1
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee = v_service_role
          AND (
            privilege_row.grantor <> function_row.proowner
            OR privilege_row.is_grantable
          )
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
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee NOT IN (
            function_row.proowner,
            v_service_role
          )
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'acl:private-substrate');
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation_row
        WHERE relation_row.oid = ANY (ARRAY[
          v_epoch_sequence,
          v_instances_table,
          v_authorities_table,
          v_activations_table,
          v_guards_table
        ]::oid[])
          AND relation_row.relowner IS DISTINCT FROM v_postgres
     ) OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = ANY (ARRAY[
          v_activate_rpc,
          v_renew_rpc,
          v_release_rpc,
          v_begin_write_rpc,
          v_assert_rpc,
          v_readiness_rpc
        ]::oid[])
          AND (
            function_row.proowner IS DISTINCT FROM v_postgres
            OR NOT function_row.prosecdef
          )
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'owner:postgres');
  END IF;

  SELECT
    pg_catalog.count(*),
    COALESCE(
      pg_catalog.max(
        CASE
          WHEN ledger.name = 'durable_ingest_worker_fence_substrate'
           AND ledger.version = '20260725011000'
           AND pg_catalog.array_length(ledger.statements, 1) = 1
          THEN pg_catalog.encode(
            extensions.digest(
              pg_catalog.convert_to(ledger.statements[1], 'UTF8'),
              'sha256'
            ),
            'hex'
          )
        END
      ),
      ''
    )
    INTO STRICT v_release_migration_count, v_release_migration_sha256
    FROM supabase_migrations.schema_migrations AS ledger
   WHERE ledger.name = 'durable_ingest_worker_fence_substrate'
      OR ledger.version = '20260725011000';

  IF v_release_migration_count <> 1
     OR v_release_migration_sha256 !~ '^[0-9a-f]{64}$' THEN
    v_missing := pg_catalog.array_append(
      v_missing,
      'ledger:20260725011000'
    );
  END IF;

  SELECT COALESCE(
           pg_catalog.array_agg(item ORDER BY item),
           ARRAY[]::text[]
         )
    INTO STRICT v_missing
    FROM (
      SELECT DISTINCT pg_catalog.unnest(v_missing) AS item
    ) AS unique_missing;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.worker-db-fence-readiness@1',
    'enforcement', v_enforcement,
    'lease_ttl_seconds', 180,
    'legacy_failover_compatible', false,
    'missing', pg_catalog.to_jsonb(v_missing),
    'ready', pg_catalog.cardinality(v_missing) = 0,
    'release_migration_sha256', v_release_migration_sha256,
    'required_scopes', pg_catalog.to_jsonb(
      ARRAY['region:local', 'region:vps_sg']::text[]
    ),
    'scope_handle_model', 'one-instance-per-scope'
  );
END
$function$;

ALTER SEQUENCE arena.ingest_worker_fence_epoch_seq OWNER TO postgres;
ALTER TABLE arena.ingest_worker_instances OWNER TO postgres;
ALTER TABLE arena.ingest_worker_authorities OWNER TO postgres;
ALTER TABLE arena.ingest_worker_activations OWNER TO postgres;
ALTER TABLE arena.ingest_worker_write_guards OWNER TO postgres;

ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) OWNER TO postgres;
ALTER FUNCTION arena.renew_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, bigint
) OWNER TO postgres;
ALTER FUNCTION arena.release_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint
) OWNER TO postgres;
ALTER FUNCTION arena.begin_ingest_worker_fenced_write(
  text, text, text, uuid, text, bigint, bigint
) OWNER TO postgres;
ALTER FUNCTION arena.assert_ingest_worker_fence_at_commit() OWNER TO postgres;
ALTER FUNCTION public.arena_ingest_worker_fence_release_readiness()
  OWNER TO postgres;

REVOKE ALL PRIVILEGES ON SEQUENCE arena.ingest_worker_fence_epoch_seq
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE
  arena.ingest_worker_instances,
  arena.ingest_worker_authorities,
  arena.ingest_worker_activations,
  arena.ingest_worker_write_guards
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.renew_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.release_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.begin_ingest_worker_fenced_write(
  text, text, text, uuid, text, bigint, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.assert_ingest_worker_fence_at_commit()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_ingest_worker_fence_release_readiness()
  FROM PUBLIC, anon, authenticated, service_role;

-- Explicit revokes above cover the platform roles and PUBLIC. Converge every
-- named grantee too so hostile ALTER DEFAULT PRIVILEGES cannot expose the
-- sequence, state tables, private mutation functions, trigger function, or
-- readiness attestation at object creation time.
DO $owner_only_acl$
DECLARE
  v_relation record;
  v_role record;
  v_signature text;
BEGIN
  FOR v_relation IN
    SELECT
      relation_row.oid,
      relation_row.relkind,
      pg_catalog.format(
        '%I.%I',
        namespace_row.nspname,
        relation_row.relname
      ) AS qualified_name
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.oid = ANY (ARRAY[
      'arena.ingest_worker_fence_epoch_seq'::pg_catalog.regclass,
      'arena.ingest_worker_instances'::pg_catalog.regclass,
      'arena.ingest_worker_authorities'::pg_catalog.regclass,
      'arena.ingest_worker_activations'::pg_catalog.regclass,
      'arena.ingest_worker_write_guards'::pg_catalog.regclass
    ]::oid[])
  LOOP
    FOR v_role IN
      SELECT DISTINCT
             pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
        FROM pg_catalog.pg_class AS relation_acl
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation_acl.relacl,
            pg_catalog.acldefault(
              (
                CASE WHEN relation_acl.relkind = 'S' THEN 'S' ELSE 'r' END
              )::pg_catalog."char",
              relation_acl.relowner
            )
          )
        ) AS privilege_row
       WHERE relation_acl.oid = v_relation.oid
         AND privilege_row.grantee NOT IN (0, relation_acl.relowner)
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON %s %s FROM %I',
        CASE WHEN v_relation.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
        v_relation.qualified_name,
        v_role.role_name
      );
    END LOOP;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)',
    'arena.renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)',
    'arena.release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)',
    'arena.begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)',
    'arena.assert_ingest_worker_fence_at_commit()',
    'public.arena_ingest_worker_fence_release_readiness()'
  ]
  LOOP
    FOR v_role IN
      SELECT DISTINCT
             pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
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

GRANT EXECUTE ON FUNCTION public.arena_ingest_worker_fence_release_readiness()
  TO service_role;

COMMENT ON FUNCTION public.arena_ingest_worker_fence_release_readiness() IS
  'Service-role substrate attestation. Stage A is intentionally unenforced and one instance UUID is bound to one scope; legacy cross-region failover must mint a new Redis generation and UUID before later wiring.';

DO $postflight$
DECLARE
  v_assert_rpc oid := pg_catalog.to_regprocedure(
    'arena.assert_ingest_worker_fence_at_commit()'
  );
  v_readiness_rpc oid := pg_catalog.to_regprocedure(
    'public.arena_ingest_worker_fence_release_readiness()'
  );
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_readiness jsonb;
BEGIN
  v_readiness := public.arena_ingest_worker_fence_release_readiness();

  IF pg_catalog.to_regprocedure(
       'public.arena_ingest_worker_fence_release_readiness()'
     ) IS NULL
     OR v_readiness->>'contract' IS DISTINCT FROM
        'arena.worker-db-fence-readiness@1'
     OR v_readiness->'missing' IS DISTINCT FROM
        '["ledger:20260725011000"]'::jsonb
     OR (v_readiness->>'ready')::boolean IS DISTINCT FROM false
     OR (v_readiness->>'enforcement')::boolean IS DISTINCT FROM false
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.ingest_worker_authorities
     ) <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgfoid = v_assert_rpc
          AND NOT trigger_row.tgisinternal
     ) <> 1
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgfoid = v_assert_rpc
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgrelid IS DISTINCT FROM
              'arena.ingest_worker_write_guards'::pg_catalog.regclass
     )
     OR EXISTS (
       SELECT 1 FROM arena.ingest_worker_write_guards
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             relation_row.relacl,
             pg_catalog.acldefault(
               (
                 CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END
               )::pg_catalog."char",
               relation_row.relowner
             )
           )
         ) AS privilege_row
        WHERE relation_row.oid = ANY (ARRAY[
          'arena.ingest_worker_fence_epoch_seq'::pg_catalog.regclass,
          'arena.ingest_worker_instances'::pg_catalog.regclass,
          'arena.ingest_worker_authorities'::pg_catalog.regclass,
          'arena.ingest_worker_activations'::pg_catalog.regclass,
          'arena.ingest_worker_write_guards'::pg_catalog.regclass
        ]::oid[])
          AND privilege_row.grantee <> relation_row.relowner
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
        WHERE function_row.oid = ANY (ARRAY[
          pg_catalog.to_regprocedure('arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)'),
          pg_catalog.to_regprocedure('arena.renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)'),
          pg_catalog.to_regprocedure('arena.release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)'),
          pg_catalog.to_regprocedure('arena.begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)'),
          v_assert_rpc
        ]::oid[])
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee <> function_row.proowner
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
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee NOT IN (
            function_row.proowner,
            v_service_role
          )
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee = v_service_role
          AND privilege_row.grantor = function_row.proowner
          AND NOT privilege_row.is_grantable
     ) <> 1
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_readiness_rpc
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee = v_service_role
          AND (
            privilege_row.grantor <> function_row.proowner
            OR privilege_row.is_grantable
          )
     ) THEN
    RAISE EXCEPTION 'ingest worker fence substrate postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
