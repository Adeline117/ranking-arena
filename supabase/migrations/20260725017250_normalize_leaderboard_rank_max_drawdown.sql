-- Normalize the partitioned leaderboard to the product-wide positive
-- max-drawdown convention before the proof-carrying batch writer is installed.
--
-- The May partition rebuild accidentally recreated the obsolete [-100, 0]
-- CHECK after the product had moved to positive drawdown magnitudes. Existing
-- negative values therefore have one deterministic meaning: the same observed
-- percentage with the legacy sign. This migration converts only those values
-- with abs(), rejects every non-finite/out-of-range value, and installs one
-- validated [0, 100] parent CHECK. Rankability remains narrower (< 100) in the
-- persisted codec; a total-loss observation may stay available to non-ranking
-- product surfaces but cannot enter a public rank.
--
-- OPERATOR NOTE: dropping the contradictory inherited CHECK and normalizing
-- existing rows must remain one transaction; otherwise there is an unguarded
-- write window. PostgreSQL therefore retains ACCESS EXCLUSIVE through commit.
-- Run this candidate in the leaderboard maintenance window. lock_timeout=10s
-- makes a busy deployment fail instead of waiting behind live traffic.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

DO $dependency_preflight$
DECLARE
  v_column_count integer;
  v_column_contract_sha256 text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION
      'leaderboard max-drawdown normalization requires PG17 and the rank parent';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relpersistence = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'
  ) THEN
    RAISE EXCEPTION 'leaderboard max-drawdown target parent drifted';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            attribute.attname || '|' ||
            pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ) || '|' || attribute.attnotnull::text || '|' ||
            attribute.attidentity::text || '|' ||
            attribute.attgenerated::text || '|' ||
            COALESCE(
              collation_namespace.nspname || '.' || collation_row.collname,
              '-'
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_column_count, v_column_contract_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_collation AS collation_row
    ON collation_row.oid = attribute.attcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE attribute.attrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_count <> 37
     OR v_column_contract_sha256 IS DISTINCT FROM
          '153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514' THEN
    RAISE EXCEPTION
      'leaderboard max-drawdown 37-column target drifted: columns %, digest %',
      v_column_count,
      v_column_contract_sha256;
  END IF;
END
$dependency_preflight$;

-- ALTER TABLE needs a stronger lock internally. Taking the recursive lock
-- explicitly makes the parent/partition write stop visible and deterministic
-- before any legacy value or constraint is inspected.
LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE;

DO $install_preflight$
DECLARE
  v_canonical oid;
  v_mdd_attnum smallint;
  v_mdd_constraint_count integer;
BEGIN
  SELECT attribute.attnum
  INTO STRICT v_mdd_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::regclass
    AND attribute.attname = 'max_drawdown'
    AND attribute.atttypid = 'pg_catalog.numeric'::pg_catalog.regtype
    AND attribute.atttypmod = 327686
    AND NOT attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT constraint_row.oid
  INTO v_canonical
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_ranks_max_drawdown_positive_check';

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_mdd_constraint_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.contype = 'c'
    AND constraint_row.conkey @> ARRAY[v_mdd_attnum]::smallint[];

  IF v_canonical IS NOT NULL THEN
    IF v_mdd_constraint_count <> 1
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
         WHERE constraint_row.oid = v_canonical
           AND constraint_row.contype = 'c'
           AND constraint_row.convalidated
           AND NOT constraint_row.condeferrable
           AND NOT constraint_row.condeferred
           AND constraint_row.connoinherit = false
           AND constraint_row.conkey = ARRAY[v_mdd_attnum]::smallint[]
           AND pg_catalog.pg_get_expr(
                 constraint_row.conbin,
                 constraint_row.conrelid,
                 false
               ) = '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
       ) THEN
      RAISE EXCEPTION
        'canonical leaderboard max-drawdown constraint drifted';
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey @> ARRAY[v_mdd_attnum]::smallint[]
      AND (
        constraint_row.conname NOT IN (
          'leaderboard_ranks_max_drawdown_check',
          'leaderboard_ranks_max_drawdown_check_pos',
          'leaderboard_ranks_mdd_check',
          'leaderboard_ranks_partitioned_max_drawdown_check'
        )
        OR NOT constraint_row.convalidated
        OR constraint_row.condeferrable
        OR constraint_row.condeferred
        OR constraint_row.connoinherit
        OR constraint_row.conkey IS DISTINCT FROM
             ARRAY[v_mdd_attnum]::smallint[]
        OR pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             false
           ) NOT IN (
             '((max_drawdown IS NULL) OR ((max_drawdown >= (''-100''::integer)::numeric) AND (max_drawdown <= (0)::numeric)))',
             '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
           )
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected or drifted leaderboard max-drawdown constraint requires audit';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.max_drawdown IS NOT NULL
      AND (
        rank_row.max_drawdown::text = ANY (
          ARRAY['NaN', 'Infinity', '-Infinity']
        )
        OR pg_catalog.abs(rank_row.max_drawdown) > 100
      )
  ) THEN
    RAISE EXCEPTION
      'leaderboard max-drawdown contains non-finite or out-of-range values';
  END IF;
END
$install_preflight$;

DO $install$
DECLARE
  v_constraint_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_ranks_max_drawdown_positive_check'
  ) THEN
    FOR v_constraint_name IN
      SELECT constraint_row.conname
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attname = 'max_drawdown'
       AND attribute.attnum = ANY(constraint_row.conkey)
      WHERE constraint_row.conrelid =
            'public.leaderboard_ranks'::pg_catalog.regclass
        AND constraint_row.contype = 'c'
      ORDER BY constraint_row.conname COLLATE pg_catalog."C"
    LOOP
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT %I',
        v_constraint_name
      );
    END LOOP;

    -- The old sign is representational, not a new estimate. Preserve the exact
    -- observed magnitude and touch no NULL/already-positive observation.
    UPDATE public.leaderboard_ranks AS rank_row
    SET max_drawdown = pg_catalog.abs(rank_row.max_drawdown)
    WHERE rank_row.max_drawdown < 0;

    ALTER TABLE public.leaderboard_ranks
      ADD CONSTRAINT leaderboard_ranks_max_drawdown_positive_check
      CHECK (
        max_drawdown IS NULL
        OR (max_drawdown >= 0 AND max_drawdown <= 100)
      ) NOT VALID;

    ALTER TABLE public.leaderboard_ranks
      VALIDATE CONSTRAINT leaderboard_ranks_max_drawdown_positive_check;

    COMMENT ON CONSTRAINT
      leaderboard_ranks_max_drawdown_positive_check
      ON public.leaderboard_ranks IS
      'Observed max-drawdown magnitude in positive percentage form [0,100]. Public rank eligibility is narrower and rejects 100.';
  END IF;
END
$install$;

DO $postflight$
DECLARE
  v_parent_constraint oid;
  v_mdd_attnum smallint;
  v_descendant_mdd_total integer;
  v_descendant_mdd_count integer;
  v_partition_count integer;
BEGIN
  SELECT attribute.attnum
  INTO STRICT v_mdd_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::regclass
    AND attribute.attname = 'max_drawdown'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT constraint_row.oid
  INTO STRICT v_parent_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_ranks_max_drawdown_positive_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND constraint_row.conkey = ARRAY[v_mdd_attnum]::smallint[]
    AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          false
        ) = '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))';

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_partition_count
  FROM pg_catalog.pg_inherits AS inheritance
  WHERE inheritance.inhparent =
        'public.leaderboard_ranks'::pg_catalog.regclass;

  WITH RECURSIVE descendants(relation_oid) AS (
    SELECT inheritance.inhrelid
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent =
          'public.leaderboard_ranks'::pg_catalog.regclass
    UNION ALL
    SELECT inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relation_oid
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE NOT constraint_row.convalidated
         OR pg_catalog.pg_get_expr(
              constraint_row.conbin,
              constraint_row.conrelid,
              false
            ) IS DISTINCT FROM
              '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
    )::integer
  INTO STRICT v_descendant_mdd_total, v_descendant_mdd_count
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN descendants
    ON descendants.relation_oid = constraint_row.conrelid
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = constraint_row.conrelid
   AND attribute.attname = 'max_drawdown'
   AND attribute.attnum = ANY(constraint_row.conkey)
  WHERE constraint_row.contype = 'c';

  IF v_partition_count <> 4
     OR v_descendant_mdd_total <> v_partition_count
     OR v_descendant_mdd_count <> 0
     OR EXISTS (
       SELECT 1
       FROM public.leaderboard_ranks AS rank_row
       WHERE rank_row.max_drawdown IS NOT NULL
         AND (
           rank_row.max_drawdown::text = ANY (
             ARRAY['NaN', 'Infinity', '-Infinity']
           )
           OR rank_row.max_drawdown < 0
           OR rank_row.max_drawdown > 100
         )
     ) THEN
    RAISE EXCEPTION
      'leaderboard max-drawdown normalization postcondition failed';
  END IF;
END
$postflight$;

COMMIT;
