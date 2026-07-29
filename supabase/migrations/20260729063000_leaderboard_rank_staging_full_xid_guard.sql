-- Migration: 20260729063000_leaderboard_rank_staging_full_xid_guard.sql
-- Created: 2026-07-29T06:30:00Z
-- Description: Preserve the top-level-only private-stage contract across
--   PostgreSQL transaction-ID epochs. Tuple xmin is deliberately retained as
--   the subtransaction guard, while a persisted xid8 closes 32-bit wrap and
--   epoch ambiguity without granting serving authority.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

-- Drain every admitted writer before taking the stage rewrite lock. The
-- staging-only writer takes RowShareLock on this relation before private DML.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_batches
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_rows IN SHARE MODE;

DO $preflight$
DECLARE
  v_writer regprocedure := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'
  );
  v_validator regprocedure := pg_catalog.to_regprocedure(
    'arena.validate_leaderboard_rank_generation_stage_batch_v1()'
  );
  v_reject regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_leaderboard_rank_publication_mutation()'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR v_writer IS NULL
     OR v_guard IS NULL
     OR v_validator IS NULL
     OR v_reject IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'full-XID stage guard dependencies are incomplete';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
     ) IS DISTINCT FROM v_writer
     OR (
       SELECT pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
         'hex'
       )
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_writer
     ) IS DISTINCT FROM
       '7247740feba0f910aa010f7d9d0f79230a8438944742027a7e699240cfe7a89f'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_writer
         AND (
           function_row.proowner <> 'postgres'::pg_catalog.regrole
           OR function_row.prokind <> 'f'
           OR function_row.provolatile <> 'v'
           OR function_row.prosecdef
           OR function_row.proisstrict
           OR function_row.proparallel <> 'u'
           OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
           OR function_row.proconfig IS DISTINCT FROM ARRAY[
                'search_path=pg_catalog, pg_temp',
                'TimeZone=UTC',
                'lock_timeout=10s'
              ]::text[]
           OR language_row.lanname <> 'plpgsql'
         )
     )
  THEN
    RAISE EXCEPTION 'staging-only writer baseline drifted before XID repair';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'guard_leaderboard_rank_generation_stage_row_insert_v1',
        'validate_leaderboard_rank_generation_stage_batch_v1',
        'reject_leaderboard_rank_publication_mutation'
      )
  ) <> 3
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           (
             v_guard,
             'ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9'
           ),
           (
             v_validator,
             '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0'
           ),
           (
             v_reject,
             '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e'
           )
       ) AS expected(function_oid, body_sha256)
       JOIN pg_catalog.pg_proc AS function_row
         ON function_row.oid = expected.function_oid
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.proowner <> 'postgres'::pg_catalog.regrole
          OR function_row.prokind <> 'f'
          OR function_row.provolatile <> 'v'
          OR NOT function_row.prosecdef
          OR function_row.proisstrict
          OR function_row.proparallel <> 'u'
          OR function_row.prorettype <> 'trigger'::pg_catalog.regtype
          OR function_row.proconfig IS DISTINCT FROM CASE
               WHEN function_row.oid = v_validator THEN ARRAY[
                 'search_path=pg_catalog, pg_temp',
                 'TimeZone=UTC',
                 'lock_timeout=10s'
               ]::text[]
               ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[]
             END
          OR language_row.lanname <> 'plpgsql'
          OR pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(function_row.prosrc, 'UTF8')
               ),
               'hex'
             ) <> expected.body_sha256
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
       WHERE function_row.oid = ANY (
         ARRAY[v_writer::oid, v_guard::oid, v_validator::oid, v_reject::oid]
       )
         AND privilege_row.grantee <> function_row.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
       CROSS JOIN LATERAL (
         VALUES (v_writer), (v_guard), (v_validator), (v_reject)
       ) AS protected(function_oid)
       WHERE pg_catalog.has_function_privilege(
         api.role_name,
         protected.function_oid,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'stage helper metadata or ACL drifted before XID repair';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_stage_batches'::regclass, 16),
        ('arena.leaderboard_rank_generation_stage_rows'::regclass, 10)
    ) AS expected(relation_oid, column_count)
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = expected.relation_oid
    WHERE relation_row.relkind <> 'r'
       OR relation_row.relpersistence <> 'p'
       OR relation_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT relation_row.relrowsecurity
       OR relation_row.relforcerowsecurity
       OR relation_row.relispartition
       OR relation_row.reloptions IS NOT NULL
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.relation_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.leaderboard_rank_generation_stage_batches'::regclass
      AND attribute.attname = 'stage_write_top_xid'
      AND NOT attribute.attisdropped
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_row
    WHERE rewrite_row.ev_class = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
      AND rewrite_row.rulename <> '_RETURN'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS privilege_row
    WHERE relation_row.oid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
      AND privilege_row.grantee <> relation_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege_row
    WHERE attribute.attrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege_row.grantee <> 'postgres'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
    CROSS JOIN LATERAL (
      VALUES
        ('arena.leaderboard_rank_generation_stage_batches'::regclass),
        ('arena.leaderboard_rank_generation_stage_rows'::regclass)
    ) AS protected(relation_oid)
    WHERE pg_catalog.has_table_privilege(
            api.role_name,
            protected.relation_oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
       OR pg_catalog.has_any_column_privilege(
            api.role_name,
            protected.relation_oid,
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
       OR inheritance.inhparent = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) THEN
    RAISE EXCEPTION 'private stage relation shape drifted before XID repair';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
      AND NOT trigger_row.tgisinternal
  ) <> 6
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_complete'::name,
             v_validator,
             5::smallint,
             true,
             true,
             true,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_immutable'::name,
             v_reject,
             27::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_no_truncate'::name,
             v_reject,
             34::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_insert_guard'::name,
             v_guard,
             4::smallint,
             false,
             false,
             false,
             NULL::name,
             'new_stage_rows'::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_immutable'::name,
             v_reject,
             27::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_no_truncate'::name,
             v_reject,
             34::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           )
       ) AS expected(
         relation_oid,
         trigger_name,
         function_oid,
         trigger_type,
         is_constraint,
         is_deferrable,
         initially_deferred,
         old_transition_table,
         new_transition_table
       )
       LEFT JOIN pg_catalog.pg_trigger AS trigger_row
         ON trigger_row.tgrelid = expected.relation_oid
        AND trigger_row.tgname = expected.trigger_name
       WHERE trigger_row.oid IS NULL
          OR trigger_row.tgfoid <> expected.function_oid
          OR trigger_row.tgtype <> expected.trigger_type
          OR (trigger_row.tgconstraint <> 0) IS DISTINCT FROM
               expected.is_constraint
          OR trigger_row.tgenabled <> 'O'
          OR trigger_row.tgdeferrable <> expected.is_deferrable
          OR trigger_row.tginitdeferred <> expected.initially_deferred
          OR trigger_row.tgoldtable IS DISTINCT FROM
               expected.old_transition_table
          OR trigger_row.tgnewtable IS DISTINCT FROM expected.new_transition_table
          OR trigger_row.tgisinternal
          OR trigger_row.tgparentid <> 0
          OR trigger_row.tgnargs <> 0
          OR trigger_row.tgargs <> '\x'::bytea
          OR trigger_row.tgattr <> ''::pg_catalog.int2vector
          OR trigger_row.tgqual IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'private stage trigger topology drifted before XID repair';
  END IF;

  -- A committed legacy header was accepted only when every row had the same
  -- top-level tuple xid under the pinned epoch-zero helper. Refuse to annotate
  -- any graph that no longer proves that exact invariant.
  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
    LEFT JOIN LATERAL (
      SELECT
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.min(staged.batch_position)::integer AS min_position,
        pg_catalog.max(staged.batch_position)::integer AS max_position,
        COALESCE(
          pg_catalog.bool_and(
            staged.xmin = batch.xmin
            AND staged.score_cohort_id = batch.score_cohort_id
            AND staged.staged_at = batch.staged_at
          ),
          false
        ) AS exact_transaction
      FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
      WHERE staged.season_id = batch.season_id
        AND staged.generation_seq = batch.generation_seq
        AND staged.batch_index = batch.batch_index
    ) AS staged ON true
    WHERE staged.row_count IS DISTINCT FROM batch.row_count
       OR staged.min_position IS DISTINCT FROM 1
       OR staged.max_position IS DISTINCT FROM batch.row_count
       OR NOT staged.exact_transaction
  ) THEN
    RAISE EXCEPTION 'legacy private stage graph lacks one exact top-level xid';
  END IF;
END
$preflight$;

ALTER TABLE arena.leaderboard_rank_generation_stage_batches
  ADD COLUMN stage_write_top_xid pg_catalog.xid8;

-- This one-time annotation is derived solely from the already-pinned legacy
-- acceptance proof. Disable only the existing immutable UPDATE guard while the
-- AccessExclusive lock is held; every old payload byte remains unchanged.
ALTER TABLE arena.leaderboard_rank_generation_stage_batches
  DISABLE TRIGGER leaderboard_rank_generation_stage_batches_immutable;
UPDATE ONLY arena.leaderboard_rank_generation_stage_batches AS batch
SET stage_write_top_xid = batch.xmin::text::pg_catalog.xid8;
ALTER TABLE arena.leaderboard_rank_generation_stage_batches
  ENABLE TRIGGER leaderboard_rank_generation_stage_batches_immutable;

ALTER TABLE arena.leaderboard_rank_generation_stage_batches
  ALTER COLUMN stage_write_top_xid
    SET DEFAULT pg_catalog.pg_current_xact_id(),
  ALTER COLUMN stage_write_top_xid SET NOT NULL;

CREATE OR REPLACE FUNCTION arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_current_xid xid := pg_catalog.pg_current_xact_id()::xid;
  v_current_top_xid xid8 := pg_catalog.pg_current_xact_id();
BEGIN
  IF EXISTS (
    SELECT 1
    FROM new_stage_rows AS staged
    LEFT JOIN ONLY arena.leaderboard_rank_generation_stage_batches AS batch
      ON batch.season_id = staged.season_id
     AND batch.generation_seq = staged.generation_seq
     AND batch.batch_index = staged.batch_index
     AND batch.score_cohort_id = staged.score_cohort_id
    WHERE batch.season_id IS NULL
       OR batch.xmin IS DISTINCT FROM v_current_xid
       OR batch.stage_write_top_xid IS DISTINCT FROM v_current_top_xid
       OR batch.staged_at IS DISTINCT FROM staged.staged_at
  ) THEN
    RAISE EXCEPTION
      'stage rows require their exact batch header from the current top-level transaction'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$body$;

CREATE OR REPLACE FUNCTION arena.validate_leaderboard_rank_generation_stage_batch_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_chunk arena.leaderboard_rank_manifest_attestation_chunks%ROWTYPE;
  v_attestation arena.leaderboard_rank_manifest_attestations%ROWTYPE;
  v_current_xid xid := pg_catalog.pg_current_xact_id()::xid;
  v_current_top_xid xid8 := pg_catalog.pg_current_xact_id();
  v_header_xid xid;
  v_header_top_xid xid8;
  v_rows arena.leaderboard_rank_batch_row_v1[];
  v_row_count integer;
  v_min_position integer;
  v_max_position integer;
  v_all_current_xid boolean;
  v_all_same_staged_at boolean;
  v_identities jsonb;
  v_field_commitments jsonb;
  v_evidence jsonb;
  v_expected_write_set text;
  v_prior_batch_count integer;
  v_prior_row_count integer;
  v_prior_last_source text;
  v_prior_last_source_trader_id text;
  v_now timestamptz;
BEGIN
  SELECT batch.xmin, batch.stage_write_top_xid
  INTO STRICT v_header_xid, v_header_top_xid
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
  WHERE batch.season_id = NEW.season_id
    AND batch.generation_seq = NEW.generation_seq
    AND batch.batch_index = NEW.batch_index;

  IF v_header_xid IS DISTINCT FROM v_current_xid
     OR v_header_top_xid IS DISTINCT FROM v_current_top_xid THEN
    RAISE EXCEPTION 'stage batch header is not top-level transaction-atomic'
      USING ERRCODE = '55000';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = NEW.season_id
  FOR SHARE;

  SELECT claim.*
  INTO STRICT v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = NEW.season_id
    AND claim.generation_seq = NEW.generation_seq
    AND claim.score_cohort_id = NEW.score_cohort_id
  FOR SHARE;

  SELECT header.*
  INTO STRICT v_attestation
  FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
  WHERE header.season_id = NEW.season_id
    AND header.generation_seq = NEW.generation_seq
    AND header.score_cohort_id = NEW.score_cohort_id
    AND header.score_input_manifest_id = NEW.score_input_manifest_id
    AND header.score_input_manifest_digest =
          NEW.score_input_manifest_digest;

  SELECT chunk.*
  INTO STRICT v_chunk
  FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
  WHERE chunk.season_id = NEW.season_id
    AND chunk.generation_seq = NEW.generation_seq
    AND chunk.score_cohort_id = NEW.score_cohort_id
    AND chunk.score_input_manifest_id = NEW.score_input_manifest_id
    AND chunk.score_input_manifest_digest = NEW.score_input_manifest_digest
    AND chunk.chunk_index = NEW.batch_index;

  v_now := pg_catalog.clock_timestamp();
  v_expected_write_set :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      NEW.season_id,
      NEW.score_cohort_id,
      NEW.score_input_manifest_digest,
      v_claim.computed_at,
      v_claim.expected_rank_count,
      NEW.batch_sha256_plan
    );
  IF v_claim.expected_rank_count < 1
     OR v_claim.expected_rank_count > 64000
     OR v_claim.expected_batch_count IS DISTINCT FROM
          (v_claim.expected_rank_count + 999) / 1000
     OR NEW.batch_index >= v_claim.expected_batch_count
     OR pg_catalog.cardinality(NEW.batch_sha256_plan) IS DISTINCT FROM
          v_claim.expected_batch_count
     OR NEW.batch_sha256_plan[NEW.batch_index + 1] IS DISTINCT FROM
          NEW.batch_sha256
     OR v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256
     OR NEW.row_count IS DISTINCT FROM
          LEAST(
            1000,
            v_claim.expected_rank_count - NEW.batch_index * 1000
          )
     OR v_head.generation_seq IS DISTINCT FROM NEW.generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM NEW.score_cohort_id
     OR v_head.phase NOT IN ('claimed', 'writing')
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_now
     OR v_attestation.manifest_valid_until <= v_now
     OR v_attestation.positive_count IS DISTINCT FROM
          v_claim.expected_rank_count
     OR v_attestation.chunk_count IS DISTINCT FROM
          v_claim.expected_batch_count
     OR NEW.staged_at < v_claim.claimed_at
     OR NEW.staged_at > v_now
     OR NEW.staged_at >= v_claim.lease_expires_at
     OR NEW.staged_at >= v_attestation.manifest_valid_until THEN
    RAISE EXCEPTION 'stage batch lost its exact generation authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.min(staged.batch_position)::integer,
    pg_catalog.max(staged.batch_position)::integer,
    COALESCE(
      pg_catalog.bool_and(staged.xmin = v_current_xid),
      false
    ),
    COALESCE(
      pg_catalog.bool_and(staged.staged_at = NEW.staged_at),
      false
    ),
    pg_catalog.array_agg(
      staged.row_payload ORDER BY staged.batch_position
    ),
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        staged.source,
        staged.source_trader_id
      )
      ORDER BY staged.batch_position
    ),
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(
        arena.build_leaderboard_rank_typed_field_commitment_v1(
          (staged.row_payload).source,
          (staged.row_payload).source_trader_id,
          (staged.row_payload).roi,
          (staged.row_payload).pnl,
          (staged.row_payload).win_rate,
          (staged.row_payload).max_drawdown,
          (staged.row_payload).sharpe_ratio,
          (staged.row_payload).profit_factor,
          (staged.row_payload).trades_count,
          (staged.row_payload).arena_score,
          (staged.row_payload).score_factors,
          (staged.row_payload).profitability_score,
          (staged.row_payload).risk_control_score,
          (staged.row_payload).execution_score
        )
      )
      ORDER BY staged.batch_position
    )
  INTO STRICT
    v_row_count,
    v_min_position,
    v_max_position,
    v_all_current_xid,
    v_all_same_staged_at,
    v_rows,
    v_identities,
    v_field_commitments
  FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
  WHERE staged.season_id = NEW.season_id
    AND staged.generation_seq = NEW.generation_seq
    AND staged.batch_index = NEW.batch_index
    AND staged.score_cohort_id = NEW.score_cohort_id;

  IF v_row_count IS DISTINCT FROM NEW.row_count
     OR v_min_position IS DISTINCT FROM 1
     OR v_max_position IS DISTINCT FROM NEW.row_count
     OR NOT v_all_current_xid
     OR NOT v_all_same_staged_at
     OR pg_catalog.cardinality(v_rows) IS DISTINCT FROM NEW.row_count THEN
    RAISE EXCEPTION 'stage batch is incomplete or not transaction-atomic'
      USING ERRCODE = '55000';
  END IF;

  v_evidence := arena.build_leaderboard_rank_typed_batch_evidence_v1(
    NEW.season_id,
    NEW.score_cohort_id,
    v_claim.computed_at,
    v_rows
  );

  IF v_evidence->>'batch_sha256' IS DISTINCT FROM NEW.batch_sha256
     OR (v_evidence->>'row_count')::integer IS DISTINCT FROM NEW.row_count
     OR (v_evidence->>'source_count')::integer IS DISTINCT FROM
          NEW.source_count
     OR v_evidence->>'first_source' IS DISTINCT FROM NEW.first_source
     OR v_evidence->>'first_source_trader_id' IS DISTINCT FROM
          NEW.first_source_trader_id
     OR v_evidence->>'last_source' IS DISTINCT FROM NEW.last_source
     OR v_evidence->>'last_source_trader_id' IS DISTINCT FROM
          NEW.last_source_trader_id
     OR v_chunk.row_count IS DISTINCT FROM NEW.row_count
     OR v_chunk.first_position IS DISTINCT FROM
          NEW.batch_index * 1000 + 1
     OR v_chunk.identities IS DISTINCT FROM v_identities
     OR v_chunk.field_commitments IS DISTINCT FROM v_field_commitments THEN
    RAISE EXCEPTION 'stage batch diverges from typed or manifest evidence'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(prior.row_count), 0)::integer
  INTO STRICT v_prior_batch_count, v_prior_row_count
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
  WHERE prior.season_id = NEW.season_id
    AND prior.generation_seq = NEW.generation_seq
    AND prior.batch_index < NEW.batch_index;

  IF v_prior_batch_count IS DISTINCT FROM NEW.batch_index
     OR v_prior_row_count IS DISTINCT FROM NEW.batch_index * 1000
     OR EXISTS (
       SELECT 1
       FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
       WHERE prior.season_id = NEW.season_id
         AND prior.generation_seq = NEW.generation_seq
         AND prior.batch_index < NEW.batch_index
         AND prior.batch_sha256_plan IS DISTINCT FROM NEW.batch_sha256_plan
     ) THEN
    RAISE EXCEPTION 'stage batches are not a contiguous canonical prefix'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.batch_index > 0 THEN
    SELECT prior.last_source, prior.last_source_trader_id
    INTO STRICT v_prior_last_source, v_prior_last_source_trader_id
    FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
    WHERE prior.season_id = NEW.season_id
      AND prior.generation_seq = NEW.generation_seq
      AND prior.batch_index = NEW.batch_index - 1;

    IF ROW(
         v_prior_last_source COLLATE pg_catalog."C",
         v_prior_last_source_trader_id COLLATE pg_catalog."C"
       ) >= ROW(
         NEW.first_source COLLATE pg_catalog."C",
         NEW.first_source_trader_id COLLATE pg_catalog."C"
       ) THEN
      RAISE EXCEPTION 'stage batch identity range overlaps its predecessor'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NULL;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'stage batch is missing immutable generation evidence'
      USING ERRCODE = '23503';
END;
$body$;

ALTER FUNCTION arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.validate_leaderboard_rank_generation_stage_batch_v1()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.validate_leaderboard_rank_generation_stage_batch_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN
  arena.leaderboard_rank_generation_stage_batches.stage_write_top_xid IS
  'Full top-level xid8 of the immutable stage append. Paired with tuple xmin: xid8 prevents epoch/wrap ambiguity; xmin deliberately rejects SAVEPOINT and PL/pgSQL subtransactions.';
COMMENT ON FUNCTION
  arena.guard_leaderboard_rank_generation_stage_row_insert_v1() IS
  'Requires every private row to share its header timestamp, complete top-level xid8, and direct tuple xmin. This prevents post-commit backfill, epoch collision, and subtransaction admission.';
COMMENT ON FUNCTION
  arena.validate_leaderboard_rank_generation_stage_batch_v1() IS
  'Deferred validator for one complete private typed batch, including exact full/top-level transaction identity, live lease, claimed plan, immutable scorer attestation, and canonical prefix.';

DO $postflight$
DECLARE
  v_writer regprocedure := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'
  );
  v_validator regprocedure := pg_catalog.to_regprocedure(
    'arena.validate_leaderboard_rank_generation_stage_batch_v1()'
  );
  v_reject regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_leaderboard_rank_publication_mutation()'
  );
BEGIN
  IF (
       SELECT pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
         'hex'
       )
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_writer
     ) IS DISTINCT FROM
       '7247740feba0f910aa010f7d9d0f79230a8438944742027a7e699240cfe7a89f'
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           (
             v_guard,
             'd1abc770cf419bda8a1b3d92d7dc9b04e46078a1e5888dffb59597576fa21963'
           ),
           (
             v_validator,
             'a0f2728c70d95c7bc55897e1e939090ec2ad741e95a545cd705f60c22cbb1202'
           ),
           (
             v_reject,
             '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e'
           )
       ) AS expected(function_oid, body_sha256)
       JOIN pg_catalog.pg_proc AS function_row
         ON function_row.oid = expected.function_oid
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.proowner <> 'postgres'::pg_catalog.regrole
          OR function_row.prokind <> 'f'
          OR function_row.provolatile <> 'v'
          OR NOT function_row.prosecdef
          OR function_row.proisstrict
          OR function_row.proparallel <> 'u'
          OR function_row.prorettype <> 'trigger'::pg_catalog.regtype
          OR function_row.proconfig IS DISTINCT FROM CASE
               WHEN function_row.oid = v_validator THEN ARRAY[
                 'search_path=pg_catalog, pg_temp',
                 'TimeZone=UTC',
                 'lock_timeout=10s'
               ]::text[]
               ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[]
             END
          OR language_row.lanname <> 'plpgsql'
          OR pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(function_row.prosrc, 'UTF8')
               ),
               'hex'
             ) <> expected.body_sha256
          OR function_row.prosrc ~ 'xmin::text::(?:pg_catalog\.)?xid8'
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
       WHERE function_row.oid = ANY (
         ARRAY[v_writer::oid, v_guard::oid, v_validator::oid, v_reject::oid]
       )
         AND privilege_row.grantee <> function_row.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
       CROSS JOIN LATERAL (
         VALUES (v_writer), (v_guard), (v_validator), (v_reject)
       ) AS protected(function_oid)
       WHERE pg_catalog.has_function_privilege(
         api.role_name,
         protected.function_oid,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'full-XID stage helper postflight drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'guard_leaderboard_rank_generation_stage_row_insert_v1',
        'validate_leaderboard_rank_generation_stage_batch_v1',
        'reject_leaderboard_rank_publication_mutation'
      )
  ) <> 3
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_attrdef AS default_row
         ON default_row.adrelid = attribute.attrelid
        AND default_row.adnum = attribute.attnum
       WHERE attribute.attrelid =
             'arena.leaderboard_rank_generation_stage_batches'::regclass
         AND attribute.attnum = 17
         AND attribute.attname = 'stage_write_top_xid'
         AND attribute.atttypid = 'pg_catalog.xid8'::regtype
         AND attribute.atttypmod = -1
         AND attribute.attnotnull
         AND NOT attribute.attisdropped
         AND attribute.attidentity = ''
         AND attribute.attgenerated = ''
         AND attribute.attacl IS NULL
         AND pg_catalog.pg_get_expr(
               default_row.adbin,
               default_row.adrelid,
               false
             ) = 'pg_current_xact_id()'
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'arena.leaderboard_rank_generation_stage_batches'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 17
     OR EXISTS (
       SELECT 1
       FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
       JOIN ONLY arena.leaderboard_rank_generation_stage_rows AS staged
         USING (season_id, generation_seq, batch_index)
       WHERE batch.stage_write_top_xid IS NULL
          OR batch.stage_write_top_xid::xid <> staged.xmin
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation_row.relacl,
           pg_catalog.acldefault('r', relation_row.relowner)
         )
       ) AS privilege_row
       WHERE relation_row.oid = ANY (ARRAY[
         'arena.leaderboard_rank_generation_stage_batches'::regclass,
         'arena.leaderboard_rank_generation_stage_rows'::regclass
       ]::regclass[])
         AND privilege_row.grantee <> relation_row.relowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege_row
       WHERE attribute.attrelid = ANY (ARRAY[
         'arena.leaderboard_rank_generation_stage_batches'::regclass,
         'arena.leaderboard_rank_generation_stage_rows'::regclass
       ]::regclass[])
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND privilege_row.grantee <> 'postgres'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
       CROSS JOIN LATERAL (
         VALUES
           ('arena.leaderboard_rank_generation_stage_batches'::regclass),
           ('arena.leaderboard_rank_generation_stage_rows'::regclass)
       ) AS protected(relation_oid)
       WHERE pg_catalog.has_table_privilege(
               api.role_name,
               protected.relation_oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             )
          OR pg_catalog.has_any_column_privilege(
               api.role_name,
               protected.relation_oid,
               'SELECT,INSERT,UPDATE,REFERENCES'
             )
     ) THEN
    RAISE EXCEPTION 'full-XID stage column postflight drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
      AND NOT trigger_row.tgisinternal
  ) <> 6
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_complete'::name,
             v_validator,
             5::smallint,
             true,
             true,
             true,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_immutable'::name,
             v_reject,
             27::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_batches'::regclass,
             'leaderboard_rank_generation_stage_batches_no_truncate'::name,
             v_reject,
             34::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_insert_guard'::name,
             v_guard,
             4::smallint,
             false,
             false,
             false,
             NULL::name,
             'new_stage_rows'::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_immutable'::name,
             v_reject,
             27::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           ),
           (
             'arena.leaderboard_rank_generation_stage_rows'::regclass,
             'leaderboard_rank_generation_stage_rows_no_truncate'::name,
             v_reject,
             34::smallint,
             false,
             false,
             false,
             NULL::name,
             NULL::name
           )
       ) AS expected(
         relation_oid,
         trigger_name,
         function_oid,
         trigger_type,
         is_constraint,
         is_deferrable,
         initially_deferred,
         old_transition_table,
         new_transition_table
       )
       LEFT JOIN pg_catalog.pg_trigger AS trigger_row
         ON trigger_row.tgrelid = expected.relation_oid
        AND trigger_row.tgname = expected.trigger_name
       WHERE trigger_row.oid IS NULL
          OR trigger_row.tgfoid <> expected.function_oid
          OR trigger_row.tgtype <> expected.trigger_type
          OR (trigger_row.tgconstraint <> 0) IS DISTINCT FROM
               expected.is_constraint
          OR trigger_row.tgenabled <> 'O'
          OR trigger_row.tgdeferrable <> expected.is_deferrable
          OR trigger_row.tginitdeferred <> expected.initially_deferred
          OR trigger_row.tgoldtable IS DISTINCT FROM
               expected.old_transition_table
          OR trigger_row.tgnewtable IS DISTINCT FROM
               expected.new_transition_table
          OR trigger_row.tgisinternal
          OR trigger_row.tgparentid <> 0
          OR trigger_row.tgnargs <> 0
          OR trigger_row.tgargs <> '\x'::bytea
          OR trigger_row.tgattr <> ''::pg_catalog.int2vector
          OR trigger_row.tgqual IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'full-XID stage trigger postflight drifted';
  END IF;
END
$postflight$;

COMMIT;
