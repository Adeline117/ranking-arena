-- Durable, monotonically fenced leaderboard generation claims.
--
-- This is an expand-only, dormant substrate. It does not yet authorize rank
-- DML. A permanent claim ledger prevents UUID ABA while one pre-seeded head
-- row per season linearizes first claim, response-loss replay, expiry, and
-- takeover without relying on connection-scoped advisory locks.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TEMP TABLE leaderboard_generation_install_state (
  claims_existed boolean NOT NULL,
  heads_existed boolean NOT NULL,
  claim_function_oid oid,
  claim_function_source text
) ON COMMIT DROP;

INSERT INTO leaderboard_generation_install_state (
  claims_existed,
  heads_existed,
  claim_function_oid,
  claim_function_source
)
SELECT
  pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_claims'
  ) IS NOT NULL,
  pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_heads'
  ) IS NOT NULL,
  function_row.oid,
  function_row.prosrc
FROM (SELECT 1) AS singleton
LEFT JOIN pg_catalog.pg_proc AS function_row
  ON function_row.oid = pg_catalog.to_regprocedure(
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
  );

DO $preflight$
DECLARE
  v_claims_existed boolean;
  v_heads_existed boolean;
  v_function oid;
BEGIN
  SELECT
    install.claims_existed,
    install.heads_existed,
    install.claim_function_oid
  INTO STRICT v_claims_existed, v_heads_existed, v_function
  FROM leaderboard_generation_install_state AS install;

  IF v_claims_existed IS DISTINCT FROM v_heads_existed THEN
    RAISE EXCEPTION 'leaderboard generation tables are only partially installed';
  END IF;
  IF v_claims_existed IS DISTINCT FROM (v_function IS NOT NULL) THEN
    RAISE EXCEPTION 'leaderboard generation schema and claim RPC disagree';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_leaderboard_rank_publication_mutation()'
     ) IS NULL THEN
    RAISE EXCEPTION 'generation owner, API roles, schema, and immutable guard must exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid =
      'arena.reject_leaderboard_rank_publication_mutation()'
        ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND pg_catalog.btrim(
        pg_catalog.regexp_replace(
          function_row.prosrc,
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) =
        'BEGIN RAISE EXCEPTION ''leaderboard publication receipts are immutable'' USING ERRCODE = ''55000''; END;'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
        WHERE expanded.grantee <> function_row.proowner
      )
  ) THEN
    RAISE EXCEPTION 'leaderboard immutable receipt guard drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'claim_leaderboard_rank_generation'
      AND function_row.oid IS DISTINCT FROM v_function
  ) THEN
    RAISE EXCEPTION 'leaderboard generation claim RPC has an unsupported overload';
  END IF;

  IF v_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
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
    RAISE EXCEPTION 'leaderboard generation claim RPC contract drifted';
  END IF;

  -- Replays attest closed ownership and ACL state before any converging DDL.
  -- Otherwise ALTER OWNER / REVOKE could silently repair evidence of drift and
  -- make a compromised installation look canonical.
  IF v_claims_existed THEN
    IF EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('arena.leaderboard_rank_generation_claims'::regclass),
          ('arena.leaderboard_rank_generation_heads'::regclass)
      ) AS expected(table_oid)
      JOIN pg_catalog.pg_class AS table_row
        ON table_row.oid = expected.table_oid
      WHERE table_row.relkind <> 'r'
         OR table_row.relpersistence <> 'p'
         OR table_row.relowner <> 'postgres'::pg_catalog.regrole
         OR NOT table_row.relrowsecurity
         OR table_row.relforcerowsecurity
         OR table_row.relispartition
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
        'arena.leaderboard_rank_generation_claims'::regclass,
        'arena.leaderboard_rank_generation_heads'::regclass
      )
        AND expanded.grantee <> table_row.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid IN (
        'arena.leaderboard_rank_generation_claims'::regclass,
        'arena.leaderboard_rank_generation_heads'::regclass
      )
         OR inheritance.inhparent IN (
           'arena.leaderboard_rank_generation_claims'::regclass,
           'arena.leaderboard_rank_generation_heads'::regclass
         )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid IN (
        'arena.leaderboard_rank_generation_claims'::regclass,
        'arena.leaderboard_rank_generation_heads'::regclass
      )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'leaderboard generation table owner, RLS, or ACL drifted';
    END IF;
  END IF;

  IF v_function IS NOT NULL THEN
    IF NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
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
      WHERE function_row.oid = v_function
        AND expanded.privilege_type = 'EXECUTE'
        AND expanded.grantee <> function_row.proowner
        AND expanded.grantee <> 'service_role'::pg_catalog.regrole
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS expanded
      WHERE function_row.oid = v_function
        AND expanded.grantee = 'service_role'::pg_catalog.regrole
        AND expanded.privilege_type = 'EXECUTE'
        AND expanded.is_grantable
    ) THEN
      RAISE EXCEPTION 'leaderboard generation claim RPC ACL drifted';
    END IF;
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_generation_claims (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  write_set_sha256 text NOT NULL,
  expected_rank_count integer NOT NULL,
  expected_batch_count integer NOT NULL,
  computed_at timestamptz NOT NULL,
  lease_seconds integer NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  CONSTRAINT leaderboard_rank_generation_claims_pkey
    PRIMARY KEY (season_id, generation_seq),
  CONSTRAINT leaderboard_rank_generation_claims_cohort_key
    UNIQUE (score_cohort_id),
  CONSTRAINT leaderboard_rank_generation_claims_identity_key
    UNIQUE (season_id, generation_seq, score_cohort_id),
  CONSTRAINT leaderboard_rank_generation_claims_contract_check
    CHECK (contract = 'leaderboard-rank-generation-claim@1'),
  CONSTRAINT leaderboard_rank_generation_claims_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT leaderboard_rank_generation_claims_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT leaderboard_rank_generation_claims_digest_check
    CHECK (write_set_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leaderboard_rank_generation_claims_rank_count_check
    CHECK (expected_rank_count >= 0 AND expected_rank_count <= 250000),
  CONSTRAINT leaderboard_rank_generation_claims_batch_count_check
    CHECK (
      (expected_rank_count = 0 AND expected_batch_count = 0)
      OR (
        expected_rank_count > 0
        AND expected_batch_count > 0
        AND expected_batch_count <= expected_rank_count
      )
    ),
  CONSTRAINT leaderboard_rank_generation_claims_computed_at_check
    CHECK (pg_catalog.isfinite(computed_at)),
  CONSTRAINT leaderboard_rank_generation_claims_lease_seconds_check
    CHECK (lease_seconds >= 15 AND lease_seconds <= 300),
  CONSTRAINT leaderboard_rank_generation_claims_claimed_at_check
    CHECK (pg_catalog.isfinite(claimed_at)),
  CONSTRAINT leaderboard_rank_generation_claims_lease_expiry_check
    CHECK (
      pg_catalog.isfinite(lease_expires_at)
      AND lease_expires_at = claimed_at + lease_seconds * interval '1 second'
    )
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_generation_heads (
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid,
  phase text NOT NULL,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT leaderboard_rank_generation_heads_pkey
    PRIMARY KEY (season_id),
  CONSTRAINT leaderboard_rank_generation_heads_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT leaderboard_rank_generation_heads_sequence_check
    CHECK (generation_seq >= 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT leaderboard_rank_generation_heads_phase_check
    CHECK (phase IN (
      'idle', 'claimed', 'writing', 'cleaned', 'reranked', 'sealed', 'failed'
    )),
  CONSTRAINT leaderboard_rank_generation_heads_state_check
    CHECK (
      (
        generation_seq = 0
        AND score_cohort_id IS NULL
        AND phase = 'idle'
        AND lease_expires_at IS NULL
      )
      OR (
        generation_seq > 0
        AND score_cohort_id IS NOT NULL
        AND (
          (
            phase IN ('claimed', 'writing', 'cleaned', 'reranked')
            AND lease_expires_at IS NOT NULL
            AND pg_catalog.isfinite(lease_expires_at)
          )
          OR (
            phase IN ('sealed', 'failed')
            AND lease_expires_at IS NULL
          )
        )
      )
    ),
  CONSTRAINT leaderboard_rank_generation_heads_updated_at_check
    CHECK (pg_catalog.isfinite(updated_at)),
  CONSTRAINT leaderboard_rank_generation_heads_claim_fkey
    FOREIGN KEY (season_id, generation_seq, score_cohort_id)
    REFERENCES arena.leaderboard_rank_generation_claims (
      season_id, generation_seq, score_cohort_id
    )
);

ALTER TABLE arena.leaderboard_rank_generation_claims OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_generation_heads OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_generation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_rank_generation_heads ENABLE ROW LEVEL SECURITY;

DO $first_install$
DECLARE
  v_claims_existed boolean;
BEGIN
  SELECT install.claims_existed
  INTO STRICT v_claims_existed
  FROM leaderboard_generation_install_state AS install;

  IF NOT v_claims_existed THEN
    EXECUTE $trigger$
      CREATE TRIGGER leaderboard_rank_generation_claim_immutable
      BEFORE UPDATE OR DELETE
      ON arena.leaderboard_rank_generation_claims
      FOR EACH ROW
      EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation()
    $trigger$;

    INSERT INTO arena.leaderboard_rank_generation_heads (
      season_id,
      generation_seq,
      score_cohort_id,
      phase,
      lease_expires_at,
      updated_at
    ) VALUES
      ('7D', 0, NULL, 'idle', NULL, pg_catalog.clock_timestamp()),
      ('30D', 0, NULL, 'idle', NULL, pg_catalog.clock_timestamp()),
      ('90D', 0, NULL, 'idle', NULL, pg_catalog.clock_timestamp());
  END IF;
END
$first_install$;

DO $revoke_table_acl$
DECLARE
  v_table regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_rank_generation_heads'::regclass
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
      ORDER BY expanded.grantee
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC CASCADE',
          v_table
        );
      ELSE
        SELECT role_row.rolname
        INTO STRICT v_role_name
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
$revoke_table_acl$;

REVOKE ALL ON TABLE arena.leaderboard_rank_generation_claims
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_rank_generation_heads
  FROM PUBLIC, anon, authenticated, service_role;

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
     OR p_expected_rank_count < 0
     OR p_expected_rank_count > 250000
     OR p_expected_batch_count IS NULL
     OR NOT (
       (p_expected_rank_count = 0 AND p_expected_batch_count = 0)
       OR (
         p_expected_rank_count > 0
         AND p_expected_batch_count > 0
         AND p_expected_batch_count <= p_expected_rank_count
       )
     ) THEN
    RAISE EXCEPTION 'generation rank and batch counts are inconsistent'
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
  text, uuid, text, integer, integer, timestamptz, integer
) OWNER TO postgres;

DO $revoke_rpc_acl$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
      'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
        ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(text, uuid, text, integer, integer, timestamptz, integer) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(text, uuid, text, integer, integer, timestamptz, integer) FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$revoke_rpc_acl$;

REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) FROM service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) TO service_role;

COMMENT ON TABLE arena.leaderboard_rank_generation_claims IS
  'Immutable leaderboard generation claim ledger; UUIDs and sequence numbers are never reused.';
COMMENT ON TABLE arena.leaderboard_rank_generation_heads IS
  'One durable current-generation fencing head per public ranking season.';
COMMENT ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) IS
  'Service-only monotonic leaderboard generation claim with frozen response-loss replay and DB-clock lease takeover.';

DO $postflight$
DECLARE
  v_before_function oid;
  v_before_source text;
  v_after_function oid := pg_catalog.to_regprocedure(
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
  );
BEGIN
  SELECT install.claim_function_oid, install.claim_function_source
  INTO STRICT v_before_function, v_before_source
  FROM leaderboard_generation_install_state AS install;

  IF v_after_function IS NULL
     OR (v_before_function IS NOT NULL AND v_after_function IS DISTINCT FROM v_before_function)
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND function_row.proname = 'claim_leaderboard_rank_generation'
         AND function_row.oid IS DISTINCT FROM v_after_function
     ) THEN
    RAISE EXCEPTION 'generation claim RPC identity or overload postflight failed';
  END IF;

  IF v_before_source IS NOT NULL AND v_before_source IS DISTINCT FROM (
    SELECT function_row.prosrc
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_after_function
  ) THEN
    RAISE EXCEPTION 'generation claim RPC body drifted before migration replay';
  END IF;

  IF NOT EXISTS (
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
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
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
    RAISE EXCEPTION 'generation claim RPC catalog postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_after_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_after_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after_function, 'EXECUTE'
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
       WHERE function_row.oid = v_after_function
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS expanded
       WHERE function_row.oid = v_after_function
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.is_grantable
     ) THEN
    RAISE EXCEPTION 'generation claim RPC EXECUTE ACL is not a closed set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass, 11),
        ('arena.leaderboard_rank_generation_heads'::regclass, 6)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row ON table_row.oid = expected.table_oid
    WHERE table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR table_row.relispartition
       OR table_row.reloptions IS NOT NULL
       OR table_row.relreplident <> 'd'
       OR table_row.relam IS DISTINCT FROM (
         SELECT access_method.oid
         FROM pg_catalog.pg_am AS access_method
         WHERE access_method.amname = 'heap'
       )
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
    )
      AND attribute.attnum > 0
      AND attribute.attisdropped
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
    )
       OR inheritance.inhparent IN (
         'arena.leaderboard_rank_generation_claims'::regclass,
         'arena.leaderboard_rank_generation_heads'::regclass
       )
  ) THEN
    RAISE EXCEPTION 'generation table identity, owner, RLS, or column count drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         1, 'contract', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         2, 'season_id', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         3, 'generation_seq', 'pg_catalog.int8'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         4, 'score_cohort_id', 'pg_catalog.uuid'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         5, 'write_set_sha256', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         6, 'expected_rank_count', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         7, 'expected_batch_count', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         8, 'computed_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         9, 'lease_seconds', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         10, 'claimed_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         11, 'lease_expires_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         1, 'season_id', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         2, 'generation_seq', 'pg_catalog.int8'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         3, 'score_cohort_id', 'pg_catalog.uuid'::regtype, false),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         4, 'phase', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         5, 'lease_expires_at', 'pg_catalog.timestamptz'::regtype, false),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         6, 'updated_at', 'pg_catalog.timestamptz'::regtype, true)
    ) AS expected(table_oid, column_number, column_name, type_oid, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = expected.table_oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR attribute.attnum IS DISTINCT FROM expected.column_number
       OR attribute.atttypid IS DISTINCT FROM expected.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atthasdef
       OR attribute.attgenerated <> ''
       OR attribute.attidentity <> ''
       OR attribute.atttypmod <> -1
       OR attribute.attndims <> 0
       OR attribute.attacl IS NOT NULL
       OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
       OR (
         expected.type_oid = 'pg_catalog.text'::regtype
         AND attribute.attcollation IS DISTINCT FROM
           'pg_catalog."default"'::regcollation
       )
       OR (
         expected.type_oid <> 'pg_catalog.text'::regtype
         AND attribute.attcollation <> 0
       )
  ) THEN
    RAISE EXCEPTION 'generation table column contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
  ) <> 13 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_heads'::regclass
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_pkey', 'p'::"char",
         'PRIMARY KEY (season_id, generation_seq)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_cohort_key', 'u'::"char",
         'UNIQUE (score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_identity_key', 'u'::"char",
         'UNIQUE (season_id, generation_seq, score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_contract_check', 'c'::"char",
         'CHECK (contract = ''leaderboard-rank-generation-claim@1''::text)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_season_check', 'c'::"char",
         'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_sequence_check', 'c'::"char",
         'CHECK (generation_seq > 0 AND generation_seq <= ''9007199254740000''::bigint)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_digest_check', 'c'::"char",
         'CHECK (write_set_sha256 ~ ''^[0-9a-f]{64}$''::text)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_rank_count_check', 'c'::"char",
         'CHECK (expected_rank_count >= 0 AND expected_rank_count <= 250000)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_batch_count_check', 'c'::"char",
         'CHECK (expected_rank_count = 0 AND expected_batch_count = 0 OR expected_rank_count > 0 AND expected_batch_count > 0 AND expected_batch_count <= expected_rank_count)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_computed_at_check', 'c'::"char",
         'CHECK (isfinite(computed_at))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_lease_seconds_check', 'c'::"char",
         'CHECK (lease_seconds >= 15 AND lease_seconds <= 300)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_claimed_at_check', 'c'::"char",
         'CHECK (isfinite(claimed_at))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_lease_expiry_check', 'c'::"char",
         'CHECK (isfinite(lease_expires_at) AND lease_expires_at = (claimed_at + lease_seconds::double precision * ''00:00:01''::interval))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_pkey', 'p'::"char",
         'PRIMARY KEY (season_id)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_season_check', 'c'::"char",
         'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_sequence_check', 'c'::"char",
         'CHECK (generation_seq >= 0 AND generation_seq <= ''9007199254740000''::bigint)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_phase_check', 'c'::"char",
         'CHECK (phase = ANY (ARRAY[''idle''::text, ''claimed''::text, ''writing''::text, ''cleaned''::text, ''reranked''::text, ''sealed''::text, ''failed''::text]))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_state_check', 'c'::"char",
         'CHECK (generation_seq = 0 AND score_cohort_id IS NULL AND phase = ''idle''::text AND lease_expires_at IS NULL OR generation_seq > 0 AND score_cohort_id IS NOT NULL AND ((phase = ANY (ARRAY[''claimed''::text, ''writing''::text, ''cleaned''::text, ''reranked''::text])) AND lease_expires_at IS NOT NULL AND isfinite(lease_expires_at) OR (phase = ANY (ARRAY[''sealed''::text, ''failed''::text])) AND lease_expires_at IS NULL))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_updated_at_check', 'c'::"char",
         'CHECK (isfinite(updated_at))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_claim_fkey', 'f'::"char",
         'FOREIGN KEY (season_id, generation_seq, score_cohort_id) REFERENCES arena.leaderboard_rank_generation_claims(season_id, generation_seq, score_cohort_id)')
    ) AS expected(
      table_oid,
      constraint_name,
      constraint_type,
      constraint_definition
    )
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = expected.table_oid
     AND constraint_row.conname = expected.constraint_name
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype IS DISTINCT FROM expected.constraint_type
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
            IS DISTINCT FROM expected.constraint_definition
  ) THEN
    RAISE EXCEPTION 'generation table constraint contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_heads'::regclass
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_pkey',
         '2 3'::pg_catalog.int2vector, true, true, 2,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_pkey ON arena.leaderboard_rank_generation_claims USING btree (season_id, generation_seq)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_cohort_key',
         '4'::pg_catalog.int2vector, true, false, 1,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_cohort_key ON arena.leaderboard_rank_generation_claims USING btree (score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_identity_key',
         '2 3 4'::pg_catalog.int2vector, true, false, 3,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_identity_key ON arena.leaderboard_rank_generation_claims USING btree (season_id, generation_seq, score_cohort_id)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_pkey',
         '1'::pg_catalog.int2vector, true, true, 1,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_heads_pkey ON arena.leaderboard_rank_generation_heads USING btree (season_id)')
    ) AS expected(
      table_oid,
      index_name,
      key_columns,
      is_unique,
      is_primary,
      key_count,
      index_definition
    )
    LEFT JOIN pg_catalog.pg_class AS catalog_index
      ON catalog_index.relname = expected.index_name
     AND catalog_index.relnamespace = 'arena'::regnamespace
    LEFT JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = catalog_index.oid
     AND index_row.indrelid = expected.table_oid
    LEFT JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = catalog_index.relam
    WHERE index_row.indexrelid IS NULL
       OR catalog_index.relkind <> 'i'
       OR catalog_index.relowner <> 'postgres'::regrole
       OR access_method.amname IS DISTINCT FROM 'btree'
       OR index_row.indkey IS DISTINCT FROM expected.key_columns
       OR index_row.indisunique IS DISTINCT FROM expected.is_unique
       OR index_row.indisprimary IS DISTINCT FROM expected.is_primary
       OR index_row.indnkeyatts IS DISTINCT FROM expected.key_count
       OR index_row.indnatts IS DISTINCT FROM expected.key_count
       OR NOT index_row.indisvalid
       OR NOT index_row.indisready
       OR NOT index_row.indislive
       OR NOT index_row.indimmediate
       OR index_row.indisclustered
       OR index_row.indisreplident
       OR index_row.indexprs IS NOT NULL
       OR index_row.indpred IS NOT NULL
       OR pg_catalog.pg_get_indexdef(index_row.indexrelid)
            IS DISTINCT FROM expected.index_definition
  ) THEN
    RAISE EXCEPTION 'generation table index contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
    )
      AND trigger_row.tgisinternal
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'RI_FKey_noaction_del', 9::smallint),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'RI_FKey_noaction_upd', 17::smallint),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'RI_FKey_check_ins', 5::smallint),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'RI_FKey_check_upd', 17::smallint)
    ) AS expected(table_oid, function_name, trigger_type)
    LEFT JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.proname = expected.function_name
     AND trigger_function.pronamespace = 'pg_catalog'::regnamespace
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.table_oid
     AND trigger_row.tgisinternal
     AND trigger_row.tgfoid = trigger_function.oid
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgtype IS DISTINCT FROM expected.trigger_type
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgconstraint IS DISTINCT FROM (
         SELECT constraint_row.oid
         FROM pg_catalog.pg_constraint AS constraint_row
         WHERE constraint_row.conrelid =
             'arena.leaderboard_rank_generation_heads'::regclass
           AND constraint_row.conname =
             'leaderboard_rank_generation_heads_claim_fkey'
       )
       OR trigger_row.tgqual IS NOT NULL
       OR trigger_row.tgoldtable IS NOT NULL
       OR trigger_row.tgnewtable IS NOT NULL
       OR trigger_row.tgdeferrable
       OR trigger_row.tginitdeferred
       OR trigger_row.tgnargs <> 0
  ) THEN
    RAISE EXCEPTION 'generation foreign-key trigger contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
      AND trigger_row.tgname = 'leaderboard_rank_generation_claim_immutable'
      AND trigger_row.tgfoid =
        'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure
      AND trigger_row.tgtype = 27
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgoldtable IS NULL
      AND trigger_row.tgnewtable IS NULL
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_heads'::regclass
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
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
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass
    )
      AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'generation table trigger, rule, policy, or ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
  ) <> 3 OR EXISTS (
    SELECT expected.season_id
    FROM (VALUES ('7D'), ('30D'), ('90D')) AS expected(season_id)
    LEFT JOIN ONLY arena.leaderboard_rank_generation_heads AS head
      ON head.season_id = expected.season_id
    WHERE head.season_id IS NULL
  ) THEN
    RAISE EXCEPTION 'generation head season set is not exact';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
