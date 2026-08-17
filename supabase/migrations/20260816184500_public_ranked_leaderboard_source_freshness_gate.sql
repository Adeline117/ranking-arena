-- Migration: 20260816184500_public_ranked_leaderboard_source_freshness_gate.sql
--
-- A public leaderboard must be a single, globally ordered sealed population.
-- The prior successor implementation re-ran the full publication proof for
-- every browser read. That proof intentionally scans the complete season and
-- recomputes ROW_NUMBER, which makes a public read path unbounded. This
-- migration moves that work to the already-authoritative seal transaction.
--
-- A successful full seal creates a private serving head plus one private tuple
-- per expected source. A statement-level freshness trigger can only create
-- that authority when it observes the seal's local cohort marker *and* the
-- immutable publication was inserted by the current transaction. A caller
-- cannot revive a historical receipt by setting the marker themselves.
--
-- Reads validate only the bounded (<=256) captured source set, its immutable
-- proof tuples, current freshness, per-source fences, and a season-global
-- rank fence. Any rank mutation in any source invalidates the whole season,
-- preserving the seal's global rank-order guarantee. `rank_valid_until`
-- additionally invalidates the whole head once any sealed row's computed_at
-- leaves the 48h public-eligibility window without requiring a rank mutation.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_proof oid := pg_catalog.to_regprocedure(
    'public.arena_leaderboard_publication_proofs(text,text[])'
  );
  v_expected_sources oid := pg_catalog.to_regprocedure(
    'public.arena_freshness_expected_sources()'
  );
  v_row_eligibility oid := pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );
  v_seal oid := pg_catalog.to_regprocedure(
    'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
  );
  v_immutability_guard oid := pg_catalog.to_regprocedure(
    'arena.reject_leaderboard_rank_publication_mutation()'
  );
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles are required';
  END IF;

  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_mutation_fences') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL THEN
    RAISE EXCEPTION 'public leaderboard freshness/proof relations are required';
  END IF;

  IF v_proof IS NULL
     OR v_expected_sources IS NULL
     OR v_row_eligibility IS NULL
     OR v_seal IS NULL
     OR v_immutability_guard IS NULL THEN
    RAISE EXCEPTION 'sealed publication authorities are required';
  END IF;

  -- A compact serving head is meaningful only while the receipt it references
  -- cannot be revised or deleted after the seal transaction.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'arena.leaderboard_rank_publications'::pg_catalog.regclass
      AND trigger_row.tgname = 'leaderboard_rank_publication_immutable'
      AND trigger_row.tgfoid = v_immutability_guard
      AND trigger_row.tgtype = 27
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'leaderboard publication receipt must be immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND attribute.attname = 'rank_publication_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'leaderboard ranks require rank_publication_id before source freshness gating';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id'::text),
        ('season_id'),
        ('request_sha256'),
        ('source_count'),
        ('trader_count'),
        ('proofs'),
        ('published_at')
    ) AS expected(attname)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
           'arena.leaderboard_rank_publications'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
  ) THEN
    RAISE EXCEPTION 'immutable publication receipt contract is incomplete';
  END IF;

  -- The full proof remains a service-only diagnostic/replay authority. It is
  -- deliberately never called by the browser-readable serving function.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_proof
      AND procedure_row.proowner = 'postgres'::pg_catalog.regrole
      AND procedure_row.prosecdef
      AND procedure_row.provolatile = 's'
      AND procedure_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::pg_catalog.text[]
  ) OR pg_catalog.has_function_privilege('anon', v_proof, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_proof, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role', v_proof, 'EXECUTE')
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure_row.proacl,
          pg_catalog.acldefault('f', procedure_row.proowner)
        )
      ) AS privilege_row
      WHERE procedure_row.oid = v_proof
        AND privilege_row.privilege_type = 'EXECUTE'
        AND privilege_row.grantee <> procedure_row.proowner
        AND privilege_row.grantee <> 'service_role'::pg_catalog.regrole
    ) THEN
    RAISE EXCEPTION 'leaderboard publication proof ACL or security contract is unsafe';
  END IF;

  -- The existing full seal sets this transaction-local marker only after all
  -- rank/order/identity validation and after inserting its immutable receipt.
  -- Refuse to install a head-capture trigger if that seal protocol drifted.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_seal
      AND procedure_row.proowner = 'postgres'::pg_catalog.regrole
      AND procedure_row.prosecdef
      AND procedure_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::pg_catalog.text[]
      AND procedure_row.prosrc LIKE '%arena.leaderboard_seal_cohort%'
      AND procedure_row.prosrc LIKE '%INSERT INTO public.leaderboard_source_freshness%'
  ) THEN
    RAISE EXCEPTION 'full seal does not expose the required sealed freshness protocol';
  END IF;
END
$preflight$;

-- Match the full seal's registry -> rank locking order. The migration never
-- manufactures a serving head for historical raw data; existing boards remain
-- fail-closed until the next real full seal transaction.
LOCK TABLE ONLY public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY public.leaderboard_source_freshness IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_mutation_fences IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_publications IN SHARE MODE;
LOCK TABLE ONLY arena.sources IN SHARE MODE;
LOCK TABLE ONLY arena.exchanges IN SHARE MODE;

-- The source freshness table used to publish receipt tokens to anonymous
-- readers. The public view is the only supported reader now; server workers
-- retain service_role access needed by the existing writer and health checks.
DROP POLICY IF EXISTS "leaderboard_source_freshness_public_read"
  ON public.leaderboard_source_freshness;
REVOKE SELECT ON public.leaderboard_source_freshness
  FROM PUBLIC, anon, authenticated;

-- One season epoch is required in addition to the existing per-source fence:
-- a mutation in source B changes source A's global rank position too.
CREATE TABLE arena.leaderboard_rank_season_mutation_fences (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  mutation_seq bigint NOT NULL DEFAULT 0
    CHECK (mutation_seq >= 0),
  mutated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
    CHECK (pg_catalog.isfinite(mutated_at)),
  PRIMARY KEY (season_id)
);

CREATE TABLE arena.public_ranked_leaderboard_serving_heads (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  score_cohort_id uuid NOT NULL,
  rank_mutation_epoch bigint NOT NULL
    CHECK (rank_mutation_epoch >= 0),
  rank_valid_until timestamptz NOT NULL
    CHECK (pg_catalog.isfinite(rank_valid_until)),
  expected_sources text[] NOT NULL,
  sealed_at timestamptz NOT NULL
    CHECK (pg_catalog.isfinite(sealed_at)),
  PRIMARY KEY (season_id),
  UNIQUE (season_id, score_cohort_id),
  CONSTRAINT prl_serving_heads_expected_sources_shape_check
    CHECK (
      COALESCE(
        pg_catalog.array_ndims(expected_sources) = 1
        AND pg_catalog.array_lower(expected_sources, 1) = 1
        AND pg_catalog.cardinality(expected_sources) BETWEEN 1 AND 256,
        false
      )
    ),
  CONSTRAINT public_ranked_leaderboard_serving_heads_publication_fkey
    FOREIGN KEY (score_cohort_id, season_id)
    REFERENCES arena.leaderboard_rank_publications (id, season_id)
);

CREATE TABLE arena.public_ranked_leaderboard_serving_sources (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  source text NOT NULL
    CHECK (
      source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND source = pg_catalog.lower(pg_catalog.btrim(source))
      AND pg_catalog.char_length(source) <= 128
    ),
  score_cohort_id uuid NOT NULL,
  source_as_of timestamptz NOT NULL
    CHECK (pg_catalog.isfinite(source_as_of)),
  recorded_at timestamptz NOT NULL
    CHECK (pg_catalog.isfinite(recorded_at)),
  rank_mutation_seq bigint NOT NULL
    CHECK (rank_mutation_seq >= 0),
  published_rank_count integer NOT NULL
    CHECK (published_rank_count >= 0),
  published_identity_sha256 text NOT NULL
    CHECK (published_identity_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (season_id, source),
  CONSTRAINT public_ranked_leaderboard_serving_sources_head_fkey
    FOREIGN KEY (season_id, score_cohort_id)
    REFERENCES arena.public_ranked_leaderboard_serving_heads (
      season_id,
      score_cohort_id
    )
    ON DELETE CASCADE
);

ALTER TABLE arena.leaderboard_rank_season_mutation_fences OWNER TO postgres;
ALTER TABLE arena.public_ranked_leaderboard_serving_heads OWNER TO postgres;
ALTER TABLE arena.public_ranked_leaderboard_serving_sources OWNER TO postgres;

ALTER TABLE arena.leaderboard_rank_season_mutation_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.public_ranked_leaderboard_serving_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.public_ranked_leaderboard_serving_sources ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.leaderboard_rank_season_mutation_fences,
  arena.public_ranked_leaderboard_serving_heads,
  arena.public_ranked_leaderboard_serving_sources
  FROM PUBLIC, anon, authenticated, service_role;

-- Parent-only statement triggers preserve the existing partition-DML boundary
-- and increase one epoch per affected season, not once per affected row.
CREATE FUNCTION arena.bump_leaderboard_rank_season_insert_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_season_mutation_fences (
    season_id,
    mutation_seq,
    mutated_at
  )
  SELECT DISTINCT
    changed.season_id,
    1,
    pg_catalog.statement_timestamp()
  FROM new_rank_rows AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
  ORDER BY changed.season_id
  ON CONFLICT (season_id) DO UPDATE
  SET
    mutation_seq =
      arena.leaderboard_rank_season_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION arena.bump_leaderboard_rank_season_update_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_season_mutation_fences (
    season_id,
    mutation_seq,
    mutated_at
  )
  SELECT
    changed.season_id,
    1,
    pg_catalog.statement_timestamp()
  FROM (
    SELECT old_row.season_id FROM old_rank_rows AS old_row
    UNION
    SELECT new_row.season_id FROM new_rank_rows AS new_row
  ) AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
  ORDER BY changed.season_id
  ON CONFLICT (season_id) DO UPDATE
  SET
    mutation_seq =
      arena.leaderboard_rank_season_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION arena.bump_leaderboard_rank_season_delete_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_season_mutation_fences (
    season_id,
    mutation_seq,
    mutated_at
  )
  SELECT DISTINCT
    changed.season_id,
    1,
    pg_catalog.statement_timestamp()
  FROM old_rank_rows AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
  ORDER BY changed.season_id
  ON CONFLICT (season_id) DO UPDATE
  SET
    mutation_seq =
      arena.leaderboard_rank_season_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION arena.bump_leaderboard_rank_season_insert_fence() OWNER TO postgres;
ALTER FUNCTION arena.bump_leaderboard_rank_season_update_fence() OWNER TO postgres;
ALTER FUNCTION arena.bump_leaderboard_rank_season_delete_fence() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_season_insert_fence()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_season_update_fence()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_season_delete_fence()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER leaderboard_rank_season_insert_fence
AFTER INSERT ON public.leaderboard_ranks
REFERENCING NEW TABLE AS new_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_season_insert_fence();

CREATE TRIGGER leaderboard_rank_season_update_fence
AFTER UPDATE ON public.leaderboard_ranks
REFERENCING OLD TABLE AS old_rank_rows NEW TABLE AS new_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_season_update_fence();

CREATE TRIGGER leaderboard_rank_season_delete_fence
AFTER DELETE ON public.leaderboard_ranks
REFERENCING OLD TABLE AS old_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_season_delete_fence();

-- This trigger is intentionally a seal-time operation. The full seal already
-- holds the rank table lock and has validated membership, current eligibility,
-- and season-global ROW_NUMBER. The trigger records a compact witness of that
-- result after its all-source freshness UPSERT has succeeded.
CREATE FUNCTION arena.capture_public_ranked_leaderboard_serving_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_marker text;
  v_score_cohort_id uuid;
  v_publication arena.leaderboard_rank_publications%ROWTYPE;
  v_expected_sources text[];
  v_expected_count integer;
  v_rank_mutation_epoch bigint;
  v_rank_valid_until timestamptz;
BEGIN
  v_marker := NULLIF(pg_catalog.current_setting(
    'arena.leaderboard_seal_cohort',
    true
  ), '');

  -- Legacy freshness writes remain legal during the deployed compatibility
  -- window, but may never establish or refresh serving authority.
  IF v_marker IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_score_cohort_id := v_marker::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;

  -- A custom GUC is not authority by itself: only the security-definer full
  -- seal can insert an immutable publication. `xmin` ties this capture to the
  -- same top-level transaction, so an old receipt cannot be raw-backfilled.
  SELECT publication.*
  INTO v_publication
  FROM ONLY arena.leaderboard_rank_publications AS publication
  WHERE publication.id = v_score_cohort_id
    AND publication.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_publication.season_id NOT IN ('7D', '30D', '90D')
     OR NOT pg_catalog.isfinite(v_publication.published_at)
     OR v_publication.source_count < 1
     OR v_publication.source_count > 256
     OR pg_catalog.jsonb_typeof(v_publication.proofs) <> 'array' THEN
    RAISE EXCEPTION 'new sealed publication has an unsafe serving contract'
      USING ERRCODE = '23514';
  END IF;

  -- This is the one registry read at seal time. Store its C-collated exact
  -- set; a later add/remove/quarantine changes the reader's set and invalidates
  -- the complete season rather than silently publishing a rank subset.
  SELECT pg_catalog.array_agg(
    authority.source
    ORDER BY authority.source COLLATE "C"
  )
  INTO v_expected_sources
  FROM (
    SELECT DISTINCT expected.filter_source COLLATE "C" AS source
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id = v_publication.season_id
  ) AS authority;

  v_expected_count := pg_catalog.cardinality(v_expected_sources);
  IF v_expected_count < 1
     OR v_expected_count > 256
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(v_expected_sources) AS authority(source)
       WHERE authority.source IS NULL
          OR pg_catalog.char_length(authority.source) > 128
          OR authority.source COLLATE "C" !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
     ) THEN
    RAISE EXCEPTION 'sealed publication expected source set is unsafe'
      USING ERRCODE = '23514';
  END IF;

  -- Verify every captured tuple against both current freshness/fences and the
  -- immutable receipt. The count plus both membership directions rejects a
  -- duplicate, omitted, cross-season, or invented source without a rank scan.
  IF v_publication.source_count IS DISTINCT FROM v_expected_count
     OR pg_catalog.jsonb_array_length(v_publication.proofs)
          IS DISTINCT FROM v_expected_count
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(v_expected_sources) AS authority(source)
       LEFT JOIN public.leaderboard_source_freshness AS freshness
         ON freshness.season_id = v_publication.season_id
        AND freshness.source = authority.source
       LEFT JOIN arena.leaderboard_rank_mutation_fences AS fence
         ON fence.season_id = v_publication.season_id
        AND fence.source = authority.source
       WHERE freshness.source IS NULL
          OR freshness.score_cohort_id IS DISTINCT FROM v_score_cohort_id
          OR freshness.rank_mutation_seq IS NULL
          OR freshness.rank_mutation_seq IS DISTINCT FROM fence.mutation_seq
          OR freshness.published_rank_count IS NULL
          OR freshness.published_identity_sha256 !~ '^[0-9a-f]{64}$'
          OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_publication.proofs)
              AS audit(proof)
            WHERE audit.proof = pg_catalog.jsonb_build_object(
              'source', freshness.source,
              'source_as_of', pg_catalog.to_char(
                freshness.source_as_of AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'recorded_at', pg_catalog.to_char(
                freshness.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'score_cohort_id', freshness.score_cohort_id,
              'rank_mutation_seq', freshness.rank_mutation_seq,
              'published_rank_count', freshness.published_rank_count,
              'published_identity_sha256', freshness.published_identity_sha256
            )
          )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_publication.proofs) AS audit(proof)
       LEFT JOIN pg_catalog.unnest(v_expected_sources) AS authority(source)
         ON authority.source = audit.proof->>'source'
       WHERE authority.source IS NULL
     ) THEN
    RAISE EXCEPTION 'sealed publication freshness witness is incomplete or drifted'
      USING ERRCODE = '23514';
  END IF;

  -- Rechecking eligibility here is seal-time work only. It makes the compact
  -- lease fail closed if a future seal implementation ever omits this check.
  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    JOIN pg_catalog.unnest(v_expected_sources) AS authority(source)
      ON authority.source = rank_row.source
    WHERE rank_row.season_id = v_publication.season_id
      AND (
        rank_row.rank_publication_id IS DISTINCT FROM v_score_cohort_id
        OR NOT arena.leaderboard_rank_row_is_public_eligible(
          rank_row,
          pg_catalog.statement_timestamp()
        )
      )
  ) THEN
    RAISE EXCEPTION 'sealed publication no longer has one eligible cohort'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.min(
    rank_row.computed_at + interval '48 hours'
  )
  INTO v_rank_valid_until
  FROM public.leaderboard_ranks AS rank_row
  JOIN pg_catalog.unnest(v_expected_sources) AS authority(source)
    ON authority.source = rank_row.source
  WHERE rank_row.season_id = v_publication.season_id;

  -- Empty but otherwise valid publications expose no ranks. Give their head a
  -- finite lease; the source freshness checks still control any serving state.
  v_rank_valid_until := COALESCE(
    v_rank_valid_until,
    v_publication.published_at + interval '48 hours'
  );

  IF NOT pg_catalog.isfinite(v_rank_valid_until) THEN
    RAISE EXCEPTION 'sealed publication rank-valid lease is unsafe'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO arena.leaderboard_rank_season_mutation_fences (
    season_id,
    mutation_seq,
    mutated_at
  ) VALUES (
    v_publication.season_id,
    0,
    pg_catalog.statement_timestamp()
  )
  ON CONFLICT (season_id) DO NOTHING;

  SELECT fence.mutation_seq
  INTO STRICT v_rank_mutation_epoch
  FROM ONLY arena.leaderboard_rank_season_mutation_fences AS fence
  WHERE fence.season_id = v_publication.season_id
  -- A full seal already holds SHARE on the rank parent, so legitimate rank
  -- DML cannot race this read.  SHARE also makes the fence itself a complete
  -- mutation boundary: an administrative UPDATE of its non-key epoch waits
  -- until the head has captured the same tuple it will later serve.
  FOR SHARE;

  -- ON CONFLICT DO UPDATE can run both statement-level trigger event kinds.
  -- Replacing the tiny source witness first makes that duplicate invocation
  -- idempotent and avoids a transient mismatched head/source FK.
  DELETE FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
  WHERE serving.season_id = v_publication.season_id;

  INSERT INTO arena.public_ranked_leaderboard_serving_heads (
    season_id,
    score_cohort_id,
    rank_mutation_epoch,
    rank_valid_until,
    expected_sources,
    sealed_at
  ) VALUES (
    v_publication.season_id,
    v_score_cohort_id,
    v_rank_mutation_epoch,
    v_rank_valid_until,
    v_expected_sources,
    v_publication.published_at
  )
  ON CONFLICT (season_id) DO UPDATE
  SET
    score_cohort_id = EXCLUDED.score_cohort_id,
    rank_mutation_epoch = EXCLUDED.rank_mutation_epoch,
    rank_valid_until = EXCLUDED.rank_valid_until,
    expected_sources = EXCLUDED.expected_sources,
    sealed_at = EXCLUDED.sealed_at;

  INSERT INTO arena.public_ranked_leaderboard_serving_sources (
    season_id,
    source,
    score_cohort_id,
    source_as_of,
    recorded_at,
    rank_mutation_seq,
    published_rank_count,
    published_identity_sha256
  )
  SELECT
    freshness.season_id,
    freshness.source,
    freshness.score_cohort_id,
    freshness.source_as_of,
    freshness.recorded_at,
    freshness.rank_mutation_seq,
    freshness.published_rank_count,
    freshness.published_identity_sha256
  FROM public.leaderboard_source_freshness AS freshness
  JOIN pg_catalog.unnest(v_expected_sources) AS authority(source)
    ON authority.source = freshness.source
  WHERE freshness.season_id = v_publication.season_id
  ORDER BY freshness.source COLLATE "C";

  IF (SELECT pg_catalog.count(*)
      FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
      WHERE serving.season_id = v_publication.season_id)
       IS DISTINCT FROM v_expected_count THEN
    RAISE EXCEPTION 'sealed publication serving witness write was incomplete'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION arena.capture_public_ranked_leaderboard_serving_authority()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.capture_public_ranked_leaderboard_serving_authority()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER leaderboard_source_freshness_capture_serving_authority
AFTER INSERT OR UPDATE ON public.leaderboard_source_freshness
FOR EACH STATEMENT
EXECUTE FUNCTION arena.capture_public_ranked_leaderboard_serving_authority();

-- Browser callers may learn only whether a season has a current authority;
-- they cannot call the full proof or obtain a cohort token/proof tuple. This
-- performs bounded, snapshot-consistent validation across every expected
-- source before a view joins any rank row.
CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(
  p_observed_at timestamptz
)
RETURNS TABLE (
  season_id text
)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NOT pg_catalog.isfinite(p_observed_at) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH expected_source_rows AS MATERIALIZED (
    SELECT
      expected.season_id,
      expected.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id IN ('7D', '30D', '90D')
  ),
  invalid_expected_sources AS MATERIALIZED (
    SELECT DISTINCT expected.season_id
    FROM expected_source_rows AS expected
    WHERE expected.source IS NULL
       OR pg_catalog.char_length(expected.source) > 128
       OR expected.source COLLATE "C" !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR expected.source IS DISTINCT FROM
            pg_catalog.lower(pg_catalog.btrim(expected.source))
  ),
  expected_sources AS MATERIALIZED (
    SELECT DISTINCT
      expected.season_id,
      expected.source COLLATE "C" AS source
    FROM expected_source_rows AS expected
  ),
  expected_sets AS MATERIALIZED (
    SELECT
      expected.season_id,
      pg_catalog.array_agg(
        expected.source
        ORDER BY expected.source COLLATE "C"
      ) AS sources
    FROM expected_sources AS expected
    GROUP BY expected.season_id
    HAVING pg_catalog.count(*) BETWEEN 1 AND 256
  )
  SELECT head.season_id
  FROM ONLY arena.public_ranked_leaderboard_serving_heads AS head
  JOIN expected_sets AS expected
    ON expected.season_id = head.season_id
   AND expected.sources = head.expected_sources
  JOIN ONLY arena.leaderboard_rank_season_mutation_fences AS season_fence
    ON season_fence.season_id = head.season_id
   AND season_fence.mutation_seq = head.rank_mutation_epoch
  JOIN ONLY arena.leaderboard_rank_publications AS publication
    ON publication.id = head.score_cohort_id
   AND publication.season_id = head.season_id
   AND publication.published_at IS NOT DISTINCT FROM head.sealed_at
  WHERE NOT EXISTS (
          SELECT 1
          FROM invalid_expected_sources AS invalid
          WHERE invalid.season_id = head.season_id
        )
    AND head.rank_valid_until >= p_observed_at
    AND publication.source_count = pg_catalog.cardinality(head.expected_sources)
    AND publication.source_count =
        pg_catalog.jsonb_array_length(publication.proofs)
    AND (SELECT pg_catalog.count(*)
         FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
         WHERE serving.season_id = head.season_id)
        = pg_catalog.cardinality(head.expected_sources)
    AND NOT EXISTS (
      SELECT 1
      FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
      LEFT JOIN public.leaderboard_source_freshness AS freshness
        ON freshness.season_id = serving.season_id
       AND freshness.source = serving.source
      LEFT JOIN ONLY arena.leaderboard_rank_mutation_fences AS source_fence
        ON source_fence.season_id = serving.season_id
       AND source_fence.source = serving.source
      WHERE serving.season_id = head.season_id
        AND (
          serving.score_cohort_id IS DISTINCT FROM head.score_cohort_id
          OR NOT (serving.source = ANY (head.expected_sources))
          OR freshness.source IS NULL
          OR freshness.source_as_of IS DISTINCT FROM serving.source_as_of
          OR freshness.recorded_at IS DISTINCT FROM serving.recorded_at
          OR freshness.score_cohort_id IS DISTINCT FROM serving.score_cohort_id
          OR freshness.rank_mutation_seq IS DISTINCT FROM serving.rank_mutation_seq
          OR freshness.published_rank_count
               IS DISTINCT FROM serving.published_rank_count
          OR freshness.published_identity_sha256
               IS DISTINCT FROM serving.published_identity_sha256
          OR source_fence.mutation_seq IS DISTINCT FROM serving.rank_mutation_seq
          OR NOT pg_catalog.isfinite(serving.source_as_of)
          OR serving.source_as_of <= p_observed_at - interval '48 hours'
          OR serving.source_as_of > p_observed_at + interval '5 minutes'
          OR NOT pg_catalog.isfinite(serving.recorded_at)
          OR serving.recorded_at > p_observed_at + interval '5 minutes'
          OR publication.published_at IS DISTINCT FROM serving.recorded_at
          OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(publication.proofs)
              AS audit(proof)
            WHERE audit.proof = pg_catalog.jsonb_build_object(
              'source', serving.source,
              'source_as_of', pg_catalog.to_char(
                serving.source_as_of AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'recorded_at', pg_catalog.to_char(
                serving.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'score_cohort_id', serving.score_cohort_id,
              'rank_mutation_seq', serving.rank_mutation_seq,
              'published_rank_count', serving.published_rank_count,
              'published_identity_sha256', serving.published_identity_sha256
            )
          )
        )
    )
  ORDER BY head.season_id COLLATE "C";
END;
$function$;

ALTER FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz)
  TO anon, authenticated, service_role;

-- Materialize one statement clock and the bounded season authority before the
-- rank relation. No full proof/ROW_NUMBER path is reachable from this view.
CREATE OR REPLACE VIEW public.public_ranked_leaderboard
WITH (security_barrier = true, security_invoker = false)
AS
WITH observed AS MATERIALIZED (
  SELECT pg_catalog.statement_timestamp() AS observed_at
),
serving_seasons AS MATERIALIZED (
  SELECT serving.season_id
  FROM observed
  CROSS JOIN LATERAL arena.public_ranked_leaderboard_serving_seasons(
    observed.observed_at
  ) AS serving
)
SELECT
  rank_row.id,
  rank_row.season_id,
  rank_row.source,
  rank_row.source_type,
  rank_row.source_trader_id,
  rank_row.rank,
  rank_row.arena_score,
  rank_row.arena_score_v3,
  rank_row.arena_score_v4,
  rank_row.roi,
  rank_row.pnl,
  rank_row.win_rate,
  rank_row.max_drawdown,
  rank_row.followers,
  rank_row.copiers,
  rank_row.trades_count,
  rank_row.handle,
  rank_row.avatar_url,
  rank_row.computed_at,
  rank_row.profitability_score,
  rank_row.risk_control_score,
  rank_row.execution_score,
  rank_row.score_completeness,
  rank_row.trading_style,
  rank_row.avg_holding_hours,
  rank_row.style_confidence,
  rank_row.sharpe_ratio,
  rank_row.sortino_ratio,
  rank_row.profit_factor,
  rank_row.calmar_ratio,
  rank_row.trader_type,
  rank_row.is_outlier,
  rank_row.metrics_estimated,
  rank_row.rank_change,
  rank_row.is_new
FROM public.leaderboard_ranks AS rank_row
JOIN serving_seasons AS serving
  ON serving.season_id = rank_row.season_id
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = rank_row.season_id
 AND head.score_cohort_id = rank_row.rank_publication_id
JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS source_witness
  ON source_witness.season_id = rank_row.season_id
 AND source_witness.source = rank_row.source
 AND source_witness.score_cohort_id = rank_row.rank_publication_id
CROSS JOIN observed
WHERE rank_row.rank IS NOT NULL
  AND arena.public_ranked_leaderboard_row_is_eligible(
    rank_row,
    observed.observed_at
  );

ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;

COMMENT ON TABLE arena.public_ranked_leaderboard_serving_heads IS
  'Private seal-time authority for one globally ordered public leaderboard season. Historical data is never backfilled into this table.';
COMMENT ON TABLE arena.public_ranked_leaderboard_serving_sources IS
  'Private bounded witness tuples copied only from a same-transaction full seal receipt.';
COMMENT ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz) IS
  'Browser-callable season-only capability. It validates the bounded sealed witness set, current registry, source freshness, immutable receipts, and both rank mutation fences without running the full proof.';
COMMENT ON VIEW public.public_ranked_leaderboard IS
  'Only current, globally sealed, source-fresh, full/non-estimated public leaderboard rows. Any expected-source, freshness, cohort, or rank-mutation drift hides the entire affected season.';

DO $postflight$
DECLARE
  v_proof oid := pg_catalog.to_regprocedure(
    'public.arena_leaderboard_publication_proofs(text,text[])'
  );
  v_serving_seasons oid := pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_serving_seasons(timestamp with time zone)'
  );
  v_view_options text[];
BEGIN
  IF v_serving_seasons IS NULL THEN
    RAISE EXCEPTION 'public serving-season capability was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_serving_seasons
      AND procedure_row.proowner = 'postgres'::pg_catalog.regrole
      AND procedure_row.prosecdef
      AND procedure_row.provolatile = 's'
      AND procedure_row.proisstrict
      AND procedure_row.proretset
      AND procedure_row.proargnames = ARRAY[
        'p_observed_at',
        'season_id'
      ]::pg_catalog.text[]
      AND procedure_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off'
      ]::pg_catalog.text[]
      AND procedure_row.prosrc NOT LIKE '%arena_leaderboard_publication_proofs%'
  ) THEN
    RAISE EXCEPTION 'serving-season capability security or bounded-read contract drifted';
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_proof, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_proof, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_proof, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('anon', v_serving_seasons, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_serving_seasons, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_serving_seasons, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS privilege_row
       WHERE procedure_row.oid = v_serving_seasons
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> procedure_row.proowner
         AND privilege_row.grantee NOT IN (
           'anon'::pg_catalog.regrole,
           'authenticated'::pg_catalog.regrole,
           'service_role'::pg_catalog.regrole
         )
     ) THEN
    RAISE EXCEPTION 'public serving capability or full proof EXECUTE boundary is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_season_mutation_fences'::pg_catalog.regclass),
        ('arena.public_ranked_leaderboard_serving_heads'::pg_catalog.regclass),
        ('arena.public_ranked_leaderboard_serving_sources'::pg_catalog.regclass)
    ) AS expected(table_oid)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = expected.table_oid
    WHERE relation.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT relation.relrowsecurity
       OR relation.relforcerowsecurity
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy AS policy_row
         WHERE policy_row.polrelid = relation.oid
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             relation.relacl,
             pg_catalog.acldefault('r', relation.relowner)
           )
         ) AS privilege_row
         WHERE privilege_row.grantee <> relation.relowner
       )
  ) THEN
    RAISE EXCEPTION 'serving authority tables are not private postgres-owned RLS relations';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon',
       'public.leaderboard_source_freshness',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.leaderboard_source_freshness',
       'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid =
             'public.leaderboard_source_freshness'::pg_catalog.regclass
         AND policy_row.polcmd IN ('r'::"char", '*'::"char")
     ) THEN
    RAISE EXCEPTION 'source freshness proof tuples remain publicly readable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND trigger_row.tgname = 'leaderboard_rank_season_insert_fence'
      AND trigger_row.tgfoid =
          'arena.bump_leaderboard_rank_season_insert_fence()'
            ::pg_catalog.regprocedure
      AND trigger_row.tgnewtable = 'new_rank_rows'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND trigger_row.tgname = 'leaderboard_rank_season_update_fence'
      AND trigger_row.tgfoid =
          'arena.bump_leaderboard_rank_season_update_fence()'
            ::pg_catalog.regprocedure
      AND trigger_row.tgoldtable = 'old_rank_rows'
      AND trigger_row.tgnewtable = 'new_rank_rows'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND trigger_row.tgname = 'leaderboard_rank_season_delete_fence'
      AND trigger_row.tgfoid =
          'arena.bump_leaderboard_rank_season_delete_fence()'
            ::pg_catalog.regprocedure
      AND trigger_row.tgoldtable = 'old_rank_rows'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'public.leaderboard_source_freshness'::pg_catalog.regclass
      AND trigger_row.tgname =
          'leaderboard_source_freshness_capture_serving_authority'
      AND trigger_row.tgfoid =
          'arena.capture_public_ranked_leaderboard_serving_authority()'
            ::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'serving authority mutation-fence triggers are incomplete';
  END IF;

  SELECT relation.reloptions
  INTO v_view_options
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.public_ranked_leaderboard'::pg_catalog.regclass;

  IF v_view_options IS NULL
     OR NOT (v_view_options @> ARRAY[
       'security_barrier=true',
       'security_invoker=false'
     ]::pg_catalog.text[])
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'public.public_ranked_leaderboard'::pg_catalog.regclass
         AND attribute.attname IN ('rank_publication_id', 'score_factors')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'public ranked leaderboard security barrier or projection regressed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
