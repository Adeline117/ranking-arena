-- Expand phase for proof-carrying leaderboard publications.
--
-- Every INSERT/UPDATE/DELETE against the partitioned parent advances a
-- durable per-(season, source) sequence. A publication receipt seals the exact
-- identity set, the writer cohort token, and that sequence. Legacy freshness
-- upserts remain available during the rolling deployment window, but a guard
-- strips any old seal from every legacy write so it can never masquerade as a
-- proof-carrying publication. A later POSTDEPLOY contract removes that legacy
-- write capability after the new writer/reader have been drained and verified.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL THEN
    RAISE EXCEPTION 'leaderboard ranks, freshness, and source authority must exist';
  END IF;
  IF pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) must exist';
  END IF;
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles must exist';
  END IF;
END
$preflight$;

ALTER TABLE public.leaderboard_source_freshness
  ADD COLUMN IF NOT EXISTS score_cohort_id uuid,
  ADD COLUMN IF NOT EXISTS rank_mutation_seq bigint,
  ADD COLUMN IF NOT EXISTS published_rank_count integer,
  ADD COLUMN IF NOT EXISTS published_identity_sha256 text;

ALTER TABLE public.leaderboard_ranks
  ADD COLUMN IF NOT EXISTS rank_publication_id uuid;

ALTER TABLE public.leaderboard_source_freshness
  DROP CONSTRAINT IF EXISTS leaderboard_source_freshness_mutation_seq_check,
  DROP CONSTRAINT IF EXISTS leaderboard_source_freshness_rank_count_check,
  DROP CONSTRAINT IF EXISTS leaderboard_source_freshness_identity_digest_check,
  DROP CONSTRAINT IF EXISTS leaderboard_source_freshness_proof_tuple_check;
ALTER TABLE public.leaderboard_source_freshness
  ADD CONSTRAINT leaderboard_source_freshness_mutation_seq_check
    CHECK (rank_mutation_seq IS NULL OR rank_mutation_seq >= 0),
  ADD CONSTRAINT leaderboard_source_freshness_rank_count_check
    CHECK (published_rank_count IS NULL OR published_rank_count >= 0),
  ADD CONSTRAINT leaderboard_source_freshness_identity_digest_check
    CHECK (
      published_identity_sha256 IS NULL
      OR published_identity_sha256 ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT leaderboard_source_freshness_proof_tuple_check
    CHECK (
      pg_catalog.num_nonnulls(
        score_cohort_id,
        rank_mutation_seq,
        published_rank_count,
        published_identity_sha256
      ) IN (0, 4)
    );

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_mutation_fences (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  source text NOT NULL,
  mutation_seq bigint NOT NULL DEFAULT 0 CHECK (mutation_seq >= 0),
  mutated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (season_id, source)
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY,
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  source_count integer NOT NULL CHECK (source_count > 0),
  trader_count integer NOT NULL CHECK (trader_count >= 0),
  proofs jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(proofs) = 'array'),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  UNIQUE (id, season_id)
);

ALTER TABLE arena.leaderboard_rank_publications
  DROP CONSTRAINT IF EXISTS leaderboard_rank_publications_source_count_exact;
ALTER TABLE arena.leaderboard_rank_publications
  ADD CONSTRAINT leaderboard_rank_publications_source_count_exact
  CHECK (source_count = pg_catalog.jsonb_array_length(proofs));

ALTER TABLE public.leaderboard_source_freshness
  DROP CONSTRAINT IF EXISTS leaderboard_source_freshness_score_cohort_fkey;
ALTER TABLE public.leaderboard_source_freshness
  ADD CONSTRAINT leaderboard_source_freshness_score_cohort_fkey
  FOREIGN KEY (score_cohort_id, season_id)
  REFERENCES arena.leaderboard_rank_publications(id, season_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE arena.leaderboard_rank_mutation_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_rank_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.leaderboard_rank_mutation_fences
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON arena.leaderboard_rank_publications
  FROM PUBLIC, anon, authenticated, service_role;

-- Expand-phase compatibility: the deployed legacy writer still needs SELECT,
-- INSERT, and UPDATE on freshness. The seal guard installed below clears all
-- proof fields on every such legacy write, including value-identical upserts.
REVOKE ALL ON public.leaderboard_source_freshness FROM service_role;
GRANT SELECT, INSERT, UPDATE
  ON public.leaderboard_source_freshness TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_source_freshness
  FROM PUBLIC, anon, authenticated;

-- Application rank DML must target only the partitioned parent so the parent
-- statement triggers cannot be bypassed. Keep public read grants untouched.
REVOKE ALL ON public.leaderboard_ranks FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.leaderboard_ranks TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_ranks
  FROM PUBLIC, anon, authenticated;

DO $partition_acl$
DECLARE
  v_partition regclass;
BEGIN
  FOR v_partition IN
    SELECT inheritance.inhrelid::regclass
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent = 'public.leaderboard_ranks'::regclass
    ORDER BY inheritance.inhrelid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM PUBLIC, anon, authenticated, service_role',
      v_partition
    );
  END LOOP;
END
$partition_acl$;

-- One database-native row policy is shared by requested-source validation and
-- the season-global ROW_NUMBER population. Ineligible observations may remain
-- available to profile/raw-data paths, but they never consume a public rank.
CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND (p_rank).source = pg_catalog.lower(pg_catalog.btrim((p_rank).source))
    AND pg_catalog.btrim((p_rank).source_trader_id) <> ''
    AND (p_rank).source_trader_id = pg_catalog.btrim((p_rank).source_trader_id)
    AND (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).arena_score <= 100
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).roi >= -10000
    AND (p_rank).roi <= 10000
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).pnl >= -100000000
    AND (p_rank).pnl <= 1000000000
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).win_rate >= 0
    AND (p_rank).win_rate <= 100
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).max_drawdown >= 0
    AND (p_rank).max_drawdown < 100
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;
REVOKE ALL
  ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
    public.leaderboard_ranks,
    timestamptz
  )
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION arena.bump_leaderboard_rank_insert_fences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_mutation_fences (
    season_id,
    source,
    mutation_seq,
    mutated_at
  )
  SELECT DISTINCT
    changed.season_id,
    changed.source,
    1,
    pg_catalog.statement_timestamp()
  FROM new_rank_rows AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
    AND changed.source IS NOT NULL
  ORDER BY changed.season_id, changed.source
  ON CONFLICT (season_id, source) DO UPDATE
  SET
    mutation_seq = arena.leaderboard_rank_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION arena.bump_leaderboard_rank_update_fences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_mutation_fences (
    season_id,
    source,
    mutation_seq,
    mutated_at
  )
  SELECT
    changed.season_id,
    changed.source,
    1,
    pg_catalog.statement_timestamp()
  FROM (
    SELECT old_row.season_id, old_row.source FROM old_rank_rows AS old_row
    UNION
    SELECT new_row.season_id, new_row.source FROM new_rank_rows AS new_row
  ) AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
    AND changed.source IS NOT NULL
  ORDER BY changed.season_id, changed.source
  ON CONFLICT (season_id, source) DO UPDATE
  SET
    mutation_seq = arena.leaderboard_rank_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION arena.bump_leaderboard_rank_delete_fences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO arena.leaderboard_rank_mutation_fences (
    season_id,
    source,
    mutation_seq,
    mutated_at
  )
  SELECT DISTINCT
    changed.season_id,
    changed.source,
    1,
    pg_catalog.statement_timestamp()
  FROM old_rank_rows AS changed
  WHERE changed.season_id IN ('7D', '30D', '90D')
    AND changed.source IS NOT NULL
  ORDER BY changed.season_id, changed.source
  ON CONFLICT (season_id, source) DO UPDATE
  SET
    mutation_seq = arena.leaderboard_rank_mutation_fences.mutation_seq + 1,
    mutated_at = EXCLUDED.mutated_at;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION arena.bump_leaderboard_rank_insert_fences() OWNER TO postgres;
ALTER FUNCTION arena.bump_leaderboard_rank_update_fences() OWNER TO postgres;
ALTER FUNCTION arena.bump_leaderboard_rank_delete_fences() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_insert_fences()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_update_fences()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.bump_leaderboard_rank_delete_fences()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS leaderboard_rank_insert_fence
  ON public.leaderboard_ranks;
CREATE TRIGGER leaderboard_rank_insert_fence
AFTER INSERT ON public.leaderboard_ranks
REFERENCING NEW TABLE AS new_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_insert_fences();

DROP TRIGGER IF EXISTS leaderboard_rank_update_fence
  ON public.leaderboard_ranks;
CREATE TRIGGER leaderboard_rank_update_fence
AFTER UPDATE ON public.leaderboard_ranks
REFERENCING OLD TABLE AS old_rank_rows NEW TABLE AS new_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_update_fences();

DROP TRIGGER IF EXISTS leaderboard_rank_delete_fence
  ON public.leaderboard_ranks;
CREATE TRIGGER leaderboard_rank_delete_fence
AFTER DELETE ON public.leaderboard_ranks
REFERENCING OLD TABLE AS old_rank_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.bump_leaderboard_rank_delete_fences();

CREATE OR REPLACE FUNCTION arena.reject_leaderboard_rank_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication receipts are immutable'
    USING ERRCODE = '55000';
END;
$function$;

ALTER FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS leaderboard_rank_publication_immutable
  ON arena.leaderboard_rank_publications;
CREATE TRIGGER leaderboard_rank_publication_immutable
BEFORE UPDATE OR DELETE ON arena.leaderboard_rank_publications
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE OR REPLACE FUNCTION arena.guard_leaderboard_source_freshness_seal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_exact_proof jsonb;
  v_seal_marker text;
BEGIN
  v_seal_marker := pg_catalog.current_setting(
    'arena.leaderboard_seal_cohort',
    true
  );

  -- A delayed legacy writer must never move a source watermark backwards.
  -- This check is repeated by the seal UPSERT's conflict predicate so a
  -- concurrent higher watermark that was invisible to seal's first snapshot
  -- still wins.
  IF TG_OP = 'UPDATE' AND NEW.source_as_of < OLD.source_as_of THEN
    RAISE EXCEPTION 'source freshness watermark cannot regress'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.score_cohort_id IS NULL
     OR NEW.rank_mutation_seq IS NULL
     OR NEW.published_rank_count IS NULL
     OR NEW.published_identity_sha256 IS NULL
     OR v_seal_marker IS DISTINCT FROM NEW.score_cohort_id::text
     OR (
       TG_OP = 'UPDATE'
       AND NEW.score_cohort_id IS NOT DISTINCT FROM OLD.score_cohort_id
     ) THEN
    NEW.score_cohort_id := NULL;
    NEW.rank_mutation_seq := NULL;
    NEW.published_rank_count := NULL;
    NEW.published_identity_sha256 := NULL;
    RETURN NEW;
  END IF;

  v_exact_proof := pg_catalog.jsonb_build_object(
    'source', NEW.source,
    'source_as_of', pg_catalog.to_char(
      NEW.source_as_of AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'recorded_at', pg_catalog.to_char(
      NEW.recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'score_cohort_id', NEW.score_cohort_id,
    'rank_mutation_seq', NEW.rank_mutation_seq,
    'published_rank_count', NEW.published_rank_count,
    'published_identity_sha256', NEW.published_identity_sha256
  );

  IF NOT EXISTS (
    SELECT 1
    FROM arena.leaderboard_rank_publications AS publication
    CROSS JOIN LATERAL
      pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
    WHERE publication.id = NEW.score_cohort_id
      AND publication.season_id = NEW.season_id
      AND audit.proof = v_exact_proof
  ) THEN
    RAISE EXCEPTION 'freshness seal is not backed by an immutable receipt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION arena.guard_leaderboard_source_freshness_seal()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.guard_leaderboard_source_freshness_seal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS leaderboard_source_freshness_seal_guard
  ON public.leaderboard_source_freshness;
CREATE TRIGGER leaderboard_source_freshness_seal_guard
BEFORE INSERT OR UPDATE ON public.leaderboard_source_freshness
FOR EACH ROW
EXECUTE FUNCTION arena.guard_leaderboard_source_freshness_seal();

CREATE OR REPLACE FUNCTION public.rerank_leaderboard_publication(
  p_season_id text,
  p_score_cohort_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_eligible_count integer;
  v_updated_count integer;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard rerank season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'score cohort id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Match seal's registry -> rank lock order. SHARE ROW EXCLUSIVE serializes
  -- this terminal rank assignment with every parent INSERT/UPDATE/DELETE.
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;
  LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

  WITH rank_authority AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ),
  eligible AS MATERIALIZED (
    SELECT ranks.id, ranks.rank_publication_id
    FROM public.leaderboard_ranks AS ranks
    JOIN rank_authority ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND arena.leaderboard_rank_row_is_public_eligible(
        ranks,
        pg_catalog.statement_timestamp()
      )
  )
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_eligible_count
  FROM eligible;

  IF v_eligible_count > 250000 THEN
    RAISE EXCEPTION 'leaderboard rerank exceeds 250000 eligible rows'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    WITH rank_authority AS MATERIALIZED (
      SELECT DISTINCT authority.filter_source AS source
      FROM public.arena_freshness_expected_sources() AS authority
      WHERE authority.season_id = p_season_id
    )
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN rank_authority ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND arena.leaderboard_rank_row_is_public_eligible(
        ranks,
        pg_catalog.statement_timestamp()
      )
      AND ranks.rank_publication_id IS DISTINCT FROM p_score_cohort_id
  ) THEN
    RAISE EXCEPTION 'eligible leaderboard rows were not fully written by the score cohort'
      USING ERRCODE = '23514';
  END IF;

  WITH rank_authority AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ),
  classified AS MATERIALIZED (
    SELECT
      ranks.id,
      ranks.arena_score,
      rank_authority.source IS NOT NULL
        AND arena.leaderboard_rank_row_is_public_eligible(
          ranks,
          pg_catalog.statement_timestamp()
        ) AS is_eligible
    FROM public.leaderboard_ranks AS ranks
    LEFT JOIN rank_authority ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
  ),
  ordered AS MATERIALIZED (
    SELECT
      classified.id,
      pg_catalog.row_number() OVER (
        ORDER BY classified.arena_score DESC NULLS LAST, classified.id
      )::integer AS expected_rank
    FROM classified
    WHERE classified.is_eligible
  ),
  desired AS MATERIALIZED (
    SELECT classified.id, ordered.expected_rank
    FROM classified
    LEFT JOIN ordered ON ordered.id = classified.id
  )
  UPDATE public.leaderboard_ranks AS ranks
  SET rank = desired.expected_rank
  FROM desired
  WHERE ranks.season_id = p_season_id
    AND ranks.id = desired.id
    AND ranks.rank IS DISTINCT FROM desired.expected_rank;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-public-rerank@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'eligible_rank_count', v_eligible_count,
    'updated_rank_count', v_updated_count
  );
END;
$function$;

ALTER FUNCTION public.rerank_leaderboard_publication(text, uuid)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.rerank_leaderboard_publication(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.rerank_leaderboard_publication(text, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.seal_leaderboard_rank_publication(
  p_season_id text,
  p_score_cohort_id uuid,
  p_source_publications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_existing arena.leaderboard_rank_publications%ROWTYPE;
  v_publication record;
  v_source_as_of timestamptz;
  v_source_count integer;
  v_trader_count integer := 0;
  v_written_count integer;
  v_request_sha256 text;
  v_canonical_sources jsonb;
  v_proofs jsonb;
  v_published_at timestamptz;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard publication season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'score cohort id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_publications IS NULL
     OR pg_catalog.jsonb_typeof(p_source_publications) <> 'array'
     OR pg_catalog.jsonb_array_length(p_source_publications) = 0
     OR pg_catalog.jsonb_array_length(p_source_publications) > 256 THEN
    RAISE EXCEPTION 'source publications must be an array with 1..256 members'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(
       pg_catalog.convert_to(p_source_publications::text, 'UTF8')
     ) > 67108864 THEN
    RAISE EXCEPTION 'source publication request exceeds 64 MiB'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
      OR NOT item.value ?& ARRAY['source', 'source_as_of', 'trader_ids']
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(item.value)
      ) <> 3
      OR pg_catalog.jsonb_typeof(item.value->'source') <> 'string'
      OR pg_catalog.jsonb_typeof(item.value->'source_as_of') <> 'string'
      OR pg_catalog.jsonb_typeof(item.value->'trader_ids') <> 'array'
  ) THEN
    RAISE EXCEPTION 'source publication members have an invalid shape'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE item.value->>'source' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR item.value->>'source' IS DISTINCT FROM
            pg_catalog.lower(pg_catalog.btrim(item.value->>'source'))
  ) OR EXISTS (
    SELECT item.value->>'source'
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    GROUP BY item.value->>'source'
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'source publications contain invalid or duplicate sources'
      USING ERRCODE = '22023';
  END IF;

  FOR v_publication IN
    SELECT
      item.value->>'source' AS source,
      item.value->>'source_as_of' AS source_as_of,
      item.value->'trader_ids' AS trader_ids
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    ORDER BY item.value->>'source'
  LOOP
    BEGIN
      IF v_publication.source_as_of !~
           '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
        RAISE EXCEPTION 'invalid timestamp';
      END IF;
      v_source_as_of := v_publication.source_as_of::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid source_as_of for %', v_publication.source
        USING ERRCODE = '22023';
    END;
    IF NOT pg_catalog.isfinite(v_source_as_of)
       OR v_source_as_of > pg_catalog.statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'unsafe source_as_of for %', v_publication.source
        USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_array_length(v_publication.trader_ids) > 250000 THEN
      RAISE EXCEPTION 'source % exceeds the trader identity bound', v_publication.source
        USING ERRCODE = '54000';
    END IF;
    v_trader_count := v_trader_count
      + pg_catalog.jsonb_array_length(v_publication.trader_ids);
  END LOOP;
  IF v_trader_count > 250000 THEN
    RAISE EXCEPTION 'publication exceeds 250000 trader identities'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    CROSS JOIN LATERAL
      pg_catalog.jsonb_array_elements(item.value->'trader_ids') AS trader(value)
    WHERE pg_catalog.jsonb_typeof(trader.value) <> 'string'
       OR pg_catalog.btrim(trader.value #>> '{}') = ''
       OR trader.value #>> '{}' IS DISTINCT FROM
            pg_catalog.btrim(trader.value #>> '{}')
  ) OR EXISTS (
    SELECT item.value->>'source', trader.value #>> '{}'
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    CROSS JOIN LATERAL
      pg_catalog.jsonb_array_elements(item.value->'trader_ids') AS trader(value)
    GROUP BY item.value->>'source', trader.value #>> '{}'
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'publication contains invalid or duplicate trader identities'
      USING ERRCODE = '22023';
  END IF;

  -- Freeze the independent source registry before authority validation, then
  -- acquire the rank table lock later. Registry quarantine flows update
  -- sources before deleting ranks, so this common order also avoids deadlock.
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.arena_freshness_expected_sources() AS authority
      WHERE authority.season_id = p_season_id
        AND authority.filter_source = item.value->>'source'
    )
  ) THEN
    RAISE EXCEPTION 'publication contains a source outside season authority'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'source', item.value->>'source',
      'source_as_of', pg_catalog.to_char(
        (item.value->>'source_as_of')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'trader_ids', COALESCE((
        SELECT pg_catalog.jsonb_agg(identity.value ORDER BY identity.value COLLATE "C")
        FROM pg_catalog.jsonb_array_elements_text(
          item.value->'trader_ids'
        ) AS identity(value)
      ), '[]'::jsonb)
    )
    ORDER BY item.value->>'source'
  )
  INTO STRICT v_canonical_sources
  FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value);

  v_source_count := pg_catalog.jsonb_array_length(v_canonical_sources);
  v_request_sha256 := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'leaderboard-rank-publication@1',
          'season_id', p_season_id,
          'sources', v_canonical_sources
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Serialize response-loss retries for the same caller-generated cohort.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_score_cohort_id::text, 0)
  );

  -- Take the table lock before any source-fence lock. Rank is season-global:
  -- freezing all parent/partition DML makes the validation and receipt one
  -- atomic observation. This ordering also prevents a deadlock with a writer
  -- that already holds RowExclusiveLock and is entering its AFTER trigger.
  LOCK TABLE public.leaderboard_ranks IN SHARE MODE;

  SELECT publication.*
  INTO v_existing
  FROM arena.leaderboard_rank_publications AS publication
  WHERE publication.id = p_score_cohort_id;
  IF FOUND THEN
    IF v_existing.season_id IS DISTINCT FROM p_season_id
       OR v_existing.request_sha256 IS DISTINCT FROM v_request_sha256 THEN
      RAISE EXCEPTION 'score cohort id was reused with different publication input'
        USING ERRCODE = '23505';
    END IF;

    -- Linearize response-loss replay against the expand-phase legacy writer.
    -- A plain MVCC read can still see the old sealed tuple while a concurrent
    -- UPDATE has already locked it and is about to clear the proof in the
    -- guard. Wait for every receipt source in deterministic order, then let
    -- the checks below take a new READ COMMITTED snapshot.
    PERFORM freshness.source
    FROM public.leaderboard_source_freshness AS freshness
    JOIN pg_catalog.jsonb_array_elements(v_existing.proofs) AS audit(proof)
      ON audit.proof->>'source' = freshness.source
    WHERE freshness.season_id = v_existing.season_id
    ORDER BY freshness.source
    FOR UPDATE OF freshness;

    IF v_existing.source_count IS DISTINCT FROM
         pg_catalog.jsonb_array_length(v_existing.proofs)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_existing.proofs) AS audit(proof)
         LEFT JOIN public.leaderboard_source_freshness AS freshness
           ON freshness.season_id = v_existing.season_id
          AND freshness.source = audit.proof->>'source'
         LEFT JOIN arena.leaderboard_rank_mutation_fences AS fence
           ON fence.season_id = v_existing.season_id
          AND fence.source = audit.proof->>'source'
         WHERE audit.proof IS DISTINCT FROM pg_catalog.jsonb_build_object(
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
            OR freshness.rank_mutation_seq IS DISTINCT FROM
                 COALESCE(fence.mutation_seq, 0)
            OR freshness.published_rank_count IS DISTINCT FROM (
                 SELECT pg_catalog.count(*)::integer
                 FROM public.leaderboard_ranks AS ranks
                 WHERE ranks.season_id = v_existing.season_id
                   AND ranks.source = audit.proof->>'source'
               )
            OR EXISTS (
                 SELECT 1
                 FROM public.leaderboard_ranks AS ranks
                 WHERE ranks.season_id = v_existing.season_id
                   AND ranks.source = audit.proof->>'source'
                   AND (
                     ranks.rank_publication_id IS DISTINCT FROM v_existing.id
                     OR NOT arena.leaderboard_rank_row_is_public_eligible(
                       ranks,
                       pg_catalog.statement_timestamp()
                     )
                   )
               )
       ) THEN
      RAISE EXCEPTION 'score cohort receipt is no longer the current sealed publication'
        USING ERRCODE = '55000';
    END IF;

    -- `rank` is a season-global order, not a per-source order. Recompute it
    -- from the same deterministic contract as rerank_leaderboard so a retry
    -- cannot bless a receipt after another source changed the global order.
    IF EXISTS (
      WITH ordered AS MATERIALIZED (
        SELECT
          ranks.id,
          pg_catalog.row_number() OVER (
            ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id
          ) AS expected_rank
        FROM public.leaderboard_ranks AS ranks
        JOIN (
          SELECT DISTINCT authority.filter_source AS source
          FROM public.arena_freshness_expected_sources() AS authority
          WHERE authority.season_id = v_existing.season_id
        ) AS rank_authority ON rank_authority.source = ranks.source
        WHERE ranks.season_id = v_existing.season_id
          AND arena.leaderboard_rank_row_is_public_eligible(
            ranks,
            pg_catalog.statement_timestamp()
          )
      ),
      corrupt_rank AS MATERIALIZED (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        JOIN ordered ON ordered.id = ranks.id
        WHERE ranks.season_id = v_existing.season_id
          AND ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank
      )
      SELECT 1
      FROM corrupt_rank
    ) THEN
      RAISE EXCEPTION 'score cohort receipt is no longer the current sealed publication'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-rank-publication@1',
      'season_id', v_existing.season_id,
      'score_cohort_id', v_existing.id,
      'source_count', v_existing.source_count,
      'trader_count', v_existing.trader_count,
      'published_at', v_existing.published_at,
      'is_sealed', true,
      'proofs', v_existing.proofs
    );
  END IF;

  INSERT INTO arena.leaderboard_rank_mutation_fences (
    season_id,
    source,
    mutation_seq,
    mutated_at
  )
  SELECT
    p_season_id,
    item.value->>'source',
    0,
    pg_catalog.statement_timestamp()
  FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
  ORDER BY item.value->>'source'
  ON CONFLICT (season_id, source) DO NOTHING;

  -- Lock all requested sources before reading any mutable rank/freshness state.
  -- A writer that raced before the lock is visible to the checks below; one
  -- that races afterwards advances the fence immediately after this seal.
  PERFORM fence.source
  FROM arena.leaderboard_rank_mutation_fences AS fence
  JOIN (
    SELECT item.value->>'source' AS source
    FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
  ) AS requested ON requested.source = fence.source
  WHERE fence.season_id = p_season_id
  ORDER BY fence.source
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_source_freshness AS current_proof
    JOIN pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
      ON item.value->>'source' = current_proof.source
    WHERE current_proof.season_id = p_season_id
      AND (item.value->>'source_as_of')::timestamptz
          < current_proof.source_as_of
  ) THEN
    RAISE EXCEPTION 'publication cannot regress a source watermark'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN (
      SELECT item.value->>'source' AS source
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    ) AS requested ON requested.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND ranks.rank_publication_id IS DISTINCT FROM p_score_cohort_id
  ) THEN
    RAISE EXCEPTION 'leaderboard rows were not fully written by the score cohort'
      USING ERRCODE = '23514';
  END IF;

  -- A seal is only for the exact public-ranking population. Partial,
  -- estimated, outlier, non-positive, or malformed metric rows remain valid
  -- upstream/profile observations but cannot live in a sealed rank source.
  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN (
      SELECT item.value->>'source' AS source
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    ) AS requested ON requested.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND NOT arena.leaderboard_rank_row_is_public_eligible(
        ranks,
        pg_catalog.statement_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'leaderboard publication contains a non-rank-eligible row'
      USING ERRCODE = '23514';
  END IF;

  -- Ranking is global across the season's public-eligible population. Validate
  -- every eligible stored row so an ineligible high score consumes no rank and
  -- one bad source cannot leave another looking individually sealed.
  -- The writer must perform all cleanup first and a final fatal rerank last.
  IF EXISTS (
    WITH ordered AS MATERIALIZED (
      SELECT
        ranks.id,
        pg_catalog.row_number() OVER (
          ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id
        ) AS expected_rank
      FROM public.leaderboard_ranks AS ranks
      JOIN (
        SELECT DISTINCT authority.filter_source AS source
        FROM public.arena_freshness_expected_sources() AS authority
        WHERE authority.season_id = p_season_id
      ) AS rank_authority ON rank_authority.source = ranks.source
      WHERE ranks.season_id = p_season_id
        AND arena.leaderboard_rank_row_is_public_eligible(
          ranks,
          pg_catalog.statement_timestamp()
        )
    )
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN ordered ON ordered.id = ranks.id
    WHERE ranks.season_id = p_season_id
      AND ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank
  ) THEN
    RAISE EXCEPTION 'leaderboard publication rank order is not current'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT
        item.value->>'source' AS source,
        trader.value #>> '{}' AS source_trader_id
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
      CROSS JOIN LATERAL
        pg_catalog.jsonb_array_elements(item.value->'trader_ids') AS trader(value)
    ),
    requested_sources AS MATERIALIZED (
      SELECT item.value->>'source' AS source
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    ),
    actual AS MATERIALIZED (
      SELECT ranks.source, ranks.source_trader_id
      FROM public.leaderboard_ranks AS ranks
      JOIN requested_sources AS requested ON requested.source = ranks.source
      WHERE ranks.season_id = p_season_id
    ),
    differences AS (
      (SELECT expected.source, expected.source_trader_id FROM expected
       EXCEPT
       SELECT actual.source, actual.source_trader_id FROM actual)
      UNION ALL
      (SELECT actual.source, actual.source_trader_id FROM actual
       EXCEPT
       SELECT expected.source, expected.source_trader_id FROM expected)
    )
    SELECT 1 FROM differences
  ) THEN
    RAISE EXCEPTION 'published trader identities do not match leaderboard rows'
      USING ERRCODE = '23514';
  END IF;

  v_published_at := pg_catalog.statement_timestamp();
  WITH publications AS MATERIALIZED (
    SELECT
      item.value->>'source' AS source,
      (item.value->>'source_as_of')::timestamptz AS source_as_of,
      item.value->'trader_ids' AS trader_ids
    FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
  ),
  proof_rows AS MATERIALIZED (
    SELECT
      publication.source,
      publication.source_as_of,
      fence.mutation_seq,
      pg_catalog.jsonb_array_length(publication.trader_ids) AS published_rank_count,
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(publication.trader_ids::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      ) AS identity_sha256
    FROM publications AS publication
    JOIN arena.leaderboard_rank_mutation_fences AS fence
      ON fence.season_id = p_season_id
     AND fence.source = publication.source
  )
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'source', proof.source,
      'source_as_of', pg_catalog.to_char(
        proof.source_as_of AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'recorded_at', pg_catalog.to_char(
        v_published_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'score_cohort_id', p_score_cohort_id,
      'rank_mutation_seq', proof.mutation_seq,
      'published_rank_count', proof.published_rank_count,
      'published_identity_sha256', proof.identity_sha256
    )
    ORDER BY proof.source
  )
  INTO STRICT v_proofs
  FROM proof_rows AS proof;

  INSERT INTO arena.leaderboard_rank_publications (
    id,
    season_id,
    request_sha256,
    source_count,
    trader_count,
    proofs,
    published_at
  ) VALUES (
    p_score_cohort_id,
    p_season_id,
    v_request_sha256,
    v_source_count,
    v_trader_count,
    v_proofs,
    v_published_at
  );

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_seal_cohort',
    p_score_cohort_id::text,
    true
  );

  INSERT INTO public.leaderboard_source_freshness (
    season_id,
    source,
    source_as_of,
    recorded_at,
    score_cohort_id,
    rank_mutation_seq,
    published_rank_count,
    published_identity_sha256
  )
  SELECT
    p_season_id,
    proof.value->>'source',
    (proof.value->>'source_as_of')::timestamptz,
    v_published_at,
    p_score_cohort_id,
    (proof.value->>'rank_mutation_seq')::bigint,
    (proof.value->>'published_rank_count')::integer,
    proof.value->>'published_identity_sha256'
  FROM pg_catalog.jsonb_array_elements(v_proofs) AS proof(value)
  ON CONFLICT (season_id, source) DO UPDATE
  SET
    source_as_of = EXCLUDED.source_as_of,
    recorded_at = EXCLUDED.recorded_at,
    score_cohort_id = EXCLUDED.score_cohort_id,
    rank_mutation_seq = EXCLUDED.rank_mutation_seq,
    published_rank_count = EXCLUDED.published_rank_count,
    published_identity_sha256 = EXCLUDED.published_identity_sha256
  WHERE EXCLUDED.source_as_of
        >= public.leaderboard_source_freshness.source_as_of;

  GET DIAGNOSTICS v_written_count = ROW_COUNT;
  IF v_written_count IS DISTINCT FROM v_source_count THEN
    RAISE EXCEPTION 'freshness seal wrote % of % source proofs',
      v_written_count, v_source_count
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-publication@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'source_count', v_source_count,
    'trader_count', v_trader_count,
    'published_at', v_published_at,
    'is_sealed', true,
    'proofs', v_proofs
  );
END;
$function$;

ALTER FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.arena_leaderboard_publication_proofs(
  p_season_id text,
  p_sources text[]
)
RETURNS TABLE (
  season_id text,
  source text,
  source_as_of timestamptz,
  recorded_at timestamptz,
  score_cohort_id uuid,
  rank_mutation_seq bigint,
  current_mutation_seq bigint,
  published_rank_count integer,
  published_identity_sha256 text,
  is_sealed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard proof season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_sources IS NULL OR pg_catalog.cardinality(p_sources) = 0
     OR pg_catalog.cardinality(p_sources) > 256
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_sources) AS requested(value)
       WHERE requested.value IS NULL
          OR requested.value !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT requested.value)
       FROM pg_catalog.unnest(p_sources) AS requested(value)
     ) <> pg_catalog.cardinality(p_sources) THEN
    RAISE EXCEPTION 'proof sources are invalid or duplicated'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH rank_authority AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ),
  ordered AS MATERIALIZED (
    SELECT
      ranks.id,
      pg_catalog.row_number() OVER (
        ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id
      ) AS expected_rank
    FROM public.leaderboard_ranks AS ranks
    JOIN rank_authority ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND arena.leaderboard_rank_row_is_public_eligible(
        ranks,
        pg_catalog.statement_timestamp()
      )
  )
  SELECT
    p_season_id,
    requested.source,
    freshness.source_as_of,
    freshness.recorded_at,
    freshness.score_cohort_id,
    freshness.rank_mutation_seq,
    COALESCE(fence.mutation_seq, 0),
    freshness.published_rank_count,
    freshness.published_identity_sha256,
    COALESCE((
      publication.id IS NOT NULL
      AND publication.season_id = p_season_id
      AND publication.published_at IS NOT DISTINCT FROM freshness.recorded_at
      AND publication.source_count =
            pg_catalog.jsonb_array_length(publication.proofs)
      AND freshness.score_cohort_id IS NOT NULL
      AND freshness.rank_mutation_seq IS NOT NULL
      AND freshness.rank_mutation_seq = COALESCE(fence.mutation_seq, 0)
      AND freshness.published_rank_count IS NOT NULL
      AND freshness.published_identity_sha256 ~ '^[0-9a-f]{64}$'
      AND EXISTS (
        SELECT 1
        FROM rank_authority
        WHERE rank_authority.source = freshness.source
      )
      AND 1 = (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
        WHERE audit.proof->>'source' = freshness.source
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
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
      AND freshness.published_rank_count = (
        SELECT pg_catalog.count(*)::integer
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = freshness.source
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = freshness.source
          AND (
            ranks.rank_publication_id IS DISTINCT FROM freshness.score_cohort_id
            OR NOT arena.leaderboard_rank_row_is_public_eligible(
              ranks,
              pg_catalog.statement_timestamp()
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        JOIN ordered ON ordered.id = ranks.id
        WHERE ranks.season_id = p_season_id
          AND ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank
      )
    ), false) AS is_sealed
  FROM (
    SELECT requested_source.value AS source
    FROM pg_catalog.unnest(p_sources) AS requested_source(value)
  ) AS requested
  LEFT JOIN public.leaderboard_source_freshness AS freshness
    ON freshness.season_id = p_season_id
   AND freshness.source = requested.source
  LEFT JOIN arena.leaderboard_rank_mutation_fences AS fence
    ON fence.season_id = p_season_id
   AND fence.source = requested.source
  LEFT JOIN arena.leaderboard_rank_publications AS publication
    ON publication.id = freshness.score_cohort_id
   AND publication.season_id = p_season_id
  ORDER BY requested.source;
END;
$function$;

ALTER FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  OWNER TO postgres;

REVOKE ALL
  ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  TO service_role;

REVOKE ALL
  ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  TO service_role;

COMMENT ON TABLE arena.leaderboard_rank_mutation_fences IS
  'Durable per-source mutation sequence advanced by every parent leaderboard rank INSERT, UPDATE, or DELETE statement.';
COMMENT ON TABLE arena.leaderboard_rank_publications IS
  'Immutable receipts for exact, cohort-tagged leaderboard rank publications.';
COMMENT ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) IS
  'Canonical database row policy shared by seal, replay, proof, and the season-global public ROW_NUMBER population.';
COMMENT ON FUNCTION public.rerank_leaderboard_publication(text, uuid) IS
  'Terminal fatal rerank for one full authority cohort. Ineligible/non-authority rows receive NULL rank; every eligible authority row must already carry the caller cohort.';
COMMENT ON COLUMN public.leaderboard_ranks.rank_publication_id IS
  'Caller-generated score cohort token; a source is public only when every row matches its immutable publication receipt.';
COMMENT ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb) IS
  'Validate exact rank eligibility, season-global order, and membership, then atomically bind source freshness to the current mutation fence. Callers must enforce the RPC request deadline; a function-local statement_timeout cannot arm the already-running statement.';
COMMENT ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[]) IS
  'Service-only proof read anchored to immutable receipts, exact row counts, season-global rank order, writer cohort tokens, and current mutation fences. Callers must enforce the RPC request deadline.';

DO $postflight$
DECLARE
  v_partition regclass;
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.seal_leaderboard_rank_publication(text,uuid,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_leaderboard_publication_proofs(text,text[])',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.seal_leaderboard_rank_publication(text,uuid,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.arena_leaderboard_publication_proofs(text,text[])',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.rerank_leaderboard_publication(text,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.rerank_leaderboard_publication(text,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'leaderboard publication RPC ACL postflight failed';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_source_freshness', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_source_freshness', 'INSERT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_source_freshness', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_source_freshness',
       'DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_ranks', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_ranks', 'INSERT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_ranks', 'UPDATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_ranks', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.leaderboard_ranks',
       'TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'leaderboard expand-phase table ACL postflight failed';
  END IF;

  IF pg_catalog.has_table_privilege(
       'service_role', 'arena.leaderboard_rank_mutation_fences',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.leaderboard_rank_publications',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'public.leaderboard_source_freshness',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.leaderboard_ranks',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'leaderboard internal/public ACL postflight failed';
  END IF;

  FOR v_partition IN
    SELECT inheritance.inhrelid::regclass
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent = 'public.leaderboard_ranks'::regclass
    ORDER BY inheritance.inhrelid
  LOOP
    IF pg_catalog.has_table_privilege(
         'service_role', v_partition,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_table_privilege(
         'anon', v_partition,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_table_privilege(
         'authenticated', v_partition,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
      RAISE EXCEPTION 'partition % retains direct API mutation privilege', v_partition;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'rerank_leaderboard_publication',
        'seal_leaderboard_rank_publication',
        'arena_leaderboard_publication_proofs'
      )
      AND (
        NOT procedure.prosecdef
        OR procedure.proowner <> 'postgres'::regrole
        OR NOT COALESCE(
          procedure.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'],
          false
        )
      )
  ) THEN
    RAISE EXCEPTION 'leaderboard publication RPC owner/security postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'arena'
      AND procedure.proname = 'leaderboard_rank_row_is_public_eligible'
      AND (
        procedure.proowner <> 'postgres'::regrole
        OR procedure.provolatile <> 'i'
        OR procedure.proparallel <> 's'
        OR NOT COALESCE(
          procedure.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'],
          false
        )
      )
  ) THEN
    RAISE EXCEPTION 'leaderboard row eligibility helper postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
