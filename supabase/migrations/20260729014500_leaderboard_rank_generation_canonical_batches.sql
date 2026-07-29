-- Canonicalize every rank-generation claim to fixed 1,000-row chunks.
--
-- The manifest attestation contract has one immutable chunk per writer batch.
-- Therefore a claim is admissible only when its positive population is
-- 1..64,000 rows and its batch count is exactly ceil(rows / 1,000). This
-- migration refuses to reinterpret historical claims: any legacy 0/0 or
-- any other noncanonical claim aborts the entire upgrade before catalog DDL.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

DO $dependency_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_heads'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_claims'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestations'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestation_chunks'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
        ) IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['postgres', 'anon', 'authenticated', 'service_role']::name[]
       ) AS required_role(role_name)
       LEFT JOIN pg_catalog.pg_roles AS role_row
         ON role_row.rolname = required_role.role_name
       WHERE role_row.oid IS NULL
     ) THEN
    RAISE EXCEPTION
      'canonical generation batches require PG17, the attestation substrate, and exact API roles';
  END IF;
END
$dependency_preflight$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena:leaderboard-rank-generation-canonical-batches:v1',
    0
  )
);

-- The claim ledger is the only relation changed by this upgrade. Take its
-- strongest lock before reading history: every old-body reader/writer drains,
-- and every new call blocks before it can observe or persist a claim. Do not
-- also wait on the head after taking this lock. A concurrent old RPC may hold a
-- head row lock while waiting here; a claims-only barrier therefore cannot form
-- a head/claims lock-upgrade cycle.
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims
  IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE leaderboard_generation_canonical_install_state (
  claim_function_oid oid NOT NULL,
  claim_function_sha256 text NOT NULL,
  capacity_constraint_oid oid NOT NULL
) ON COMMIT DROP;

INSERT INTO leaderboard_generation_canonical_install_state (
  claim_function_oid,
  claim_function_sha256,
  capacity_constraint_oid
)
SELECT
  function_row.oid,
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  ),
  constraint_row.oid
FROM pg_catalog.pg_proc AS function_row
JOIN pg_catalog.pg_constraint AS constraint_row
  ON constraint_row.conrelid =
       'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
 AND constraint_row.conname =
       'leaderboard_rank_generation_claims_batch_capacity_check'
WHERE function_row.oid =
  'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
    ::pg_catalog.regprocedure;

DO $preflight$
DECLARE
  v_claim_function oid;
  v_claim_function_sha256 text;
  v_capacity_constraint oid;
BEGIN
  SELECT
    install.claim_function_oid,
    install.claim_function_sha256,
    install.capacity_constraint_oid
  INTO STRICT
    v_claim_function,
    v_claim_function_sha256,
    v_capacity_constraint
  FROM leaderboard_generation_canonical_install_state AS install;

  IF v_claim_function_sha256 IS DISTINCT FROM
       '09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND function_row.proname =
               'claim_leaderboard_rank_generation'
         AND function_row.oid IS DISTINCT FROM v_claim_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_claim_function
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prokind = 'f'
         AND language_row.lanname = 'plpgsql'
         AND function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND NOT function_row.proretset
         AND function_row.prorettype =
               'pg_catalog.jsonb'::pg_catalog.regtype
         AND function_row.pronargs = 7
         AND function_row.pronargdefaults = 0
         AND function_row.proargtypes = ARRAY[
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.uuid'::pg_catalog.regtype,
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype,
           'pg_catalog.timestamptz'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype
         ]::pg_catalog.oidvector
         AND function_row.proargnames = ARRAY[
           'p_season_id',
           'p_score_cohort_id',
           'p_write_set_sha256',
           'p_expected_rank_count',
           'p_expected_batch_count',
           'p_computed_at',
           'p_lease_seconds'
         ]::pg_catalog.text[]
         AND function_row.proargmodes IS NULL
         AND function_row.proallargtypes IS NULL
         AND function_row.prosupport = 0
         AND function_row.prosqlbody IS NULL
         AND function_row.probin IS NULL
         AND function_row.procost = 100
         AND function_row.prorows = 0
         AND function_row.proconfig = ARRAY[
           'search_path=pg_catalog, pg_temp',
           'lock_timeout=10s'
         ]::pg_catalog.text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(function_row.prosrc, 'UTF8')
               ),
               'hex'
             ) = v_claim_function_sha256
     ) THEN
    RAISE EXCEPTION
      'canonical generation batches require the exact prior claim RPC';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_claim_function
  ) <> 2
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_claim_function
         AND expanded.grantor = 'postgres'::pg_catalog.regrole
         AND expanded.grantee = 'postgres'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND NOT expanded.is_grantable
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_claim_function
         AND expanded.grantor = 'postgres'::pg_catalog.regrole
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND NOT expanded.is_grantable
     )
     OR NOT pg_catalog.has_function_privilege(
          'service_role', v_claim_function, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'anon', v_claim_function, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated', v_claim_function, 'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'canonical generation claim RPC ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> 'postgres'::pg_catalog.regrole
        OR NOT relation.relrowsecurity
        OR relation.relforcerowsecurity
        OR relation.reloptions IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
       OR inheritance.inhparent IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
      AND rule_row.rulename <> '_RETURN'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS expanded
    WHERE relation.oid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
      AND expanded.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
    WHERE attribute.attrelid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'canonical generation table owner, RLS, inheritance, policy, or ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 6 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 12 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 12 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (6, 'expected_rank_count'::name, 'integer'::pg_catalog.regtype),
        (7, 'expected_batch_count'::name, 'integer'::pg_catalog.regtype)
    ) AS expected(attnum, attname, atttypid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
           'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
     AND attribute.attnum = expected.attnum
     AND attribute.attname = expected.attname
     AND attribute.atttypid = expected.atttypid
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR NOT attribute.attnotnull
       OR attribute.atthasdef
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'canonical generation column substrate drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
  ) <> 14 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
  ) <> 23 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::pg_catalog.regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::pg_catalog.regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 6 THEN
    RAISE EXCEPTION 'canonical generation constraint or trigger substrate drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.oid = v_capacity_constraint
      AND constraint_row.conrelid =
            'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND constraint_row.conname =
            'leaderboard_rank_generation_claims_batch_capacity_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND NOT constraint_row.connoinherit
      AND constraint_row.conkey = ARRAY[7, 6]::pg_catalog.int2[]
      AND pg_catalog.pg_get_expr(
            constraint_row.conbin,
            constraint_row.conrelid,
            false
          ) =
            '((expected_batch_count <= 4096) AND (expected_rank_count <= 64000) AND ((expected_rank_count)::bigint <= ((expected_batch_count)::bigint * 1000)))'
  ) THEN
    RAISE EXCEPTION 'prior generation capacity constraint drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_claims AS claim
    WHERE claim.expected_rank_count < 1
       OR claim.expected_rank_count > 64000
       OR claim.expected_batch_count < 1
       OR claim.expected_batch_count > 64
       OR claim.expected_batch_count::bigint IS DISTINCT FROM
            (claim.expected_rank_count::bigint + 999) / 1000
  ) THEN
    RAISE EXCEPTION
      'historical generation claim is incompatible with canonical 1000-row chunks'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  DROP CONSTRAINT
    leaderboard_rank_generation_claims_batch_capacity_check;

ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check
  CHECK (
    expected_rank_count >= 1
    AND expected_rank_count <= 64000
    AND expected_batch_count >= 1
    AND expected_batch_count <= 64
    AND expected_batch_count::bigint =
          (expected_rank_count::bigint + 999) / 1000
  ) NOT VALID;

ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  VALIDATE CONSTRAINT
    leaderboard_rank_generation_claims_batch_capacity_check;

CREATE OR REPLACE FUNCTION public.claim_leaderboard_rank_generation(
  p_season_id text,
  p_score_cohort_id uuid,
  p_write_set_sha256 text,
  p_expected_rank_count integer,
  p_expected_batch_count integer,
  p_computed_at timestamptz,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_current arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_existing arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_now timestamptz;
  v_lease_expires_at timestamptz;
  v_next_generation_seq bigint;
  v_updated_count integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'generation claims require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid generation season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'generation score cohort is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_write_set_sha256 IS NULL
     OR p_write_set_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'generation write-set digest must be lowercase sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_rank_count IS NULL
     OR p_expected_rank_count < 1
     OR p_expected_rank_count > 64000
     OR p_expected_batch_count IS NULL
     OR p_expected_batch_count < 1
     OR p_expected_batch_count > 64
     OR p_expected_batch_count::bigint IS DISTINCT FROM
          (p_expected_rank_count::bigint + 999) / 1000 THEN
    RAISE EXCEPTION
      'generation counts require canonical 1000-row batches'
      USING ERRCODE = '22023';
  END IF;
  IF p_computed_at IS NULL OR NOT pg_catalog.isfinite(p_computed_at) THEN
    RAISE EXCEPTION 'generation computed_at must be finite'
      USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL
     OR p_lease_seconds < 15
     OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'generation lease must be between 15 and 300 seconds'
      USING ERRCODE = '22023';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id
  FOR UPDATE;

  -- Take the one authorization clock only after the potentially blocking row
  -- lock. A waiter that began before expiry must evaluate takeover at lock
  -- acquisition time, never statement-start time.
  v_now := pg_catalog.clock_timestamp();
  IF p_computed_at > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'generation computed_at is too far in the future'
      USING ERRCODE = '22023';
  END IF;

  IF v_head.generation_seq > 0 THEN
    SELECT claim.*
    INTO STRICT v_current
    FROM ONLY arena.leaderboard_rank_generation_claims AS claim
    WHERE claim.season_id = v_head.season_id
      AND claim.generation_seq = v_head.generation_seq
      AND claim.score_cohort_id = v_head.score_cohort_id;

    IF v_head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')
       AND v_head.lease_expires_at IS DISTINCT FROM v_current.lease_expires_at THEN
      RAISE EXCEPTION 'active generation head lease disagrees with its claim'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT claim.*
  INTO v_existing
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.score_cohort_id = p_score_cohort_id;

  IF FOUND THEN
    IF v_existing.season_id IS DISTINCT FROM p_season_id
       OR v_existing.write_set_sha256 IS DISTINCT FROM p_write_set_sha256
       OR v_existing.expected_rank_count IS DISTINCT FROM p_expected_rank_count
       OR v_existing.expected_batch_count IS DISTINCT FROM p_expected_batch_count
       OR v_existing.computed_at IS DISTINCT FROM p_computed_at
       OR v_existing.lease_seconds IS DISTINCT FROM p_lease_seconds THEN
      RAISE EXCEPTION 'generation cohort UUID was reused with different input'
        USING ERRCODE = '23505';
    END IF;

    IF v_head.generation_seq IS DISTINCT FROM v_existing.generation_seq
       OR v_head.score_cohort_id IS DISTINCT FROM v_existing.score_cohort_id
       OR v_head.phase NOT IN ('claimed', 'writing', 'cleaned', 'reranked')
       OR v_head.lease_expires_at IS DISTINCT FROM v_existing.lease_expires_at
       OR v_head.lease_expires_at <= v_now THEN
      RAISE EXCEPTION 'generation claim is expired, terminal, or superseded'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', v_existing.contract,
      'season_id', v_existing.season_id,
      'score_cohort_id', v_existing.score_cohort_id,
      'generation_seq', v_existing.generation_seq,
      'phase', 'claimed',
      'write_set_sha256', v_existing.write_set_sha256,
      'expected_rank_count', v_existing.expected_rank_count,
      'expected_batch_count', v_existing.expected_batch_count,
      'computed_at', pg_catalog.to_char(
        v_existing.computed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'claimed_at', pg_catalog.to_char(
        v_existing.claimed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'lease_expires_at', pg_catalog.to_char(
        v_existing.lease_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  END IF;

  IF v_head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')
     AND v_head.lease_expires_at > v_now THEN
    RAISE EXCEPTION 'another leaderboard generation owns the active lease'
      USING ERRCODE = '55P03';
  END IF;
  IF v_head.generation_seq >= 9007199254740000 THEN
    RAISE EXCEPTION 'leaderboard generation sequence exhausted'
      USING ERRCODE = '54000';
  END IF;

  v_next_generation_seq := v_head.generation_seq + 1;
  v_lease_expires_at := v_now + p_lease_seconds * interval '1 second';

  INSERT INTO arena.leaderboard_rank_generation_claims (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    write_set_sha256,
    expected_rank_count,
    expected_batch_count,
    computed_at,
    lease_seconds,
    claimed_at,
    lease_expires_at
  ) VALUES (
    'leaderboard-rank-generation-claim@1',
    p_season_id,
    v_next_generation_seq,
    p_score_cohort_id,
    p_write_set_sha256,
    p_expected_rank_count,
    p_expected_batch_count,
    p_computed_at,
    p_lease_seconds,
    v_now,
    v_lease_expires_at
  );

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET
    generation_seq = v_next_generation_seq,
    score_cohort_id = p_score_cohort_id,
    phase = 'claimed',
    lease_expires_at = v_lease_expires_at,
    updated_at = v_now
  WHERE head.season_id = p_season_id;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'generation head compare-and-set did not update exactly one row'
      USING ERRCODE = '55000';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id;
  IF v_head.generation_seq IS DISTINCT FROM v_next_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM 'claimed'
     OR v_head.lease_expires_at IS DISTINCT FROM v_lease_expires_at
     OR v_head.updated_at IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'generation head compare-and-set postcondition failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-claim@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'generation_seq', v_next_generation_seq,
    'phase', 'claimed',
    'write_set_sha256', p_write_set_sha256,
    'expected_rank_count', p_expected_rank_count,
    'expected_batch_count', p_expected_batch_count,
    'computed_at', pg_catalog.to_char(
      p_computed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'claimed_at', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'lease_expires_at', pg_catalog.to_char(
      v_lease_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
END;
$function$;

ALTER FUNCTION public.claim_leaderboard_rank_generation(
  text,
  uuid,
  text,
  integer,
  integer,
  timestamptz,
  integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_leaderboard_rank_generation(
  text,
  uuid,
  text,
  integer,
  integer,
  timestamptz,
  integer
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text,
  uuid,
  text,
  integer,
  integer,
  timestamptz,
  integer
) TO service_role;

DO $postflight$
DECLARE
  v_before_function oid;
  v_before_constraint oid;
  v_after_function oid := pg_catalog.to_regprocedure(
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
  );
  v_after_constraint oid;
  v_function_body_sha256 text;
BEGIN
  SELECT
    install.claim_function_oid,
    install.capacity_constraint_oid
  INTO STRICT v_before_function, v_before_constraint
  FROM leaderboard_generation_canonical_install_state AS install;

  SELECT constraint_row.oid
  INTO v_after_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_rank_generation_claims_batch_capacity_check';

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  )
  INTO v_function_body_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_after_function;

  IF v_after_function IS NULL
     OR v_after_function IS DISTINCT FROM v_before_function
     OR v_function_body_sha256 IS DISTINCT FROM
          '5ad11771903cd9828c5911c0e534143a4b2d99285864abee63203ec40c1725f2'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND function_row.proname =
               'claim_leaderboard_rank_generation'
         AND function_row.oid IS DISTINCT FROM v_after_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_after_function
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prokind = 'f'
         AND language_row.lanname = 'plpgsql'
         AND function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND NOT function_row.proretset
         AND function_row.prorettype =
               'pg_catalog.jsonb'::pg_catalog.regtype
         AND function_row.pronargs = 7
         AND function_row.pronargdefaults = 0
         AND function_row.proargtypes = ARRAY[
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.uuid'::pg_catalog.regtype,
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype,
           'pg_catalog.timestamptz'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype
         ]::pg_catalog.oidvector
         AND function_row.proargnames = ARRAY[
           'p_season_id',
           'p_score_cohort_id',
           'p_write_set_sha256',
           'p_expected_rank_count',
           'p_expected_batch_count',
           'p_computed_at',
           'p_lease_seconds'
         ]::pg_catalog.text[]
         AND function_row.proargmodes IS NULL
         AND function_row.proallargtypes IS NULL
         AND function_row.prosupport = 0
         AND function_row.prosqlbody IS NULL
         AND function_row.probin IS NULL
         AND function_row.procost = 100
         AND function_row.prorows = 0
         AND function_row.proconfig = ARRAY[
           'search_path=pg_catalog, pg_temp',
           'lock_timeout=10s'
         ]::pg_catalog.text[]
     ) THEN
    RAISE EXCEPTION
      'canonical generation claim RPC postflight drifted: %',
      COALESCE(v_function_body_sha256, '-');
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_after_function
  ) <> 2
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after_function
         AND expanded.grantor = 'postgres'::pg_catalog.regrole
         AND expanded.grantee = 'postgres'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND NOT expanded.is_grantable
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after_function
         AND expanded.grantor = 'postgres'::pg_catalog.regrole
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND NOT expanded.is_grantable
     )
     OR NOT pg_catalog.has_function_privilege(
          'service_role', v_after_function, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'anon', v_after_function, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated', v_after_function, 'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'canonical generation claim RPC ACL postflight drifted';
  END IF;

  IF v_after_constraint IS NULL
     OR v_after_constraint IS NOT DISTINCT FROM v_before_constraint
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
     ) <> 14
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.oid = v_after_constraint
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND NOT constraint_row.connoinherit
         AND constraint_row.conkey = ARRAY[6, 7]::pg_catalog.int2[]
         AND pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               false
             ) =
               '((expected_rank_count >= 1) AND (expected_rank_count <= 64000) AND (expected_batch_count >= 1) AND (expected_batch_count <= 64) AND ((expected_batch_count)::bigint = (((expected_rank_count)::bigint + 999) / 1000)))'
     )
     OR EXISTS (
       SELECT 1
       FROM ONLY arena.leaderboard_rank_generation_claims AS claim
       WHERE claim.expected_rank_count < 1
          OR claim.expected_rank_count > 64000
          OR claim.expected_batch_count < 1
          OR claim.expected_batch_count > 64
          OR claim.expected_batch_count::bigint IS DISTINCT FROM
               (claim.expected_rank_count::bigint + 999) / 1000
     ) THEN
    RAISE EXCEPTION
      'canonical generation capacity constraint or stored rows postflight drifted';
  END IF;
END
$postflight$;

COMMIT;
