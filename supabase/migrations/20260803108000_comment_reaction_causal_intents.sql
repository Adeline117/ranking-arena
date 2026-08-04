-- Migration: 20260803108000_comment_reaction_causal_intents.sql
-- Created: 2026-08-03T11:20:00Z
-- Description: Expand comment reactions with a service-issued, monotonically
--   ordered intent ticket. The fence is deliberately defined by reservation
--   order at the database, not by an unobservable physical click order. Once
--   a newer ticket is reserved for one actor/comment pair, a delayed apply of
--   any older ticket is stale and cannot mutate canonical reaction state.
--
-- This is an expand migration. The four-argument 1070 authority remains for
-- rolling application compatibility, so the launch gate must stay open until
-- every caller uses the causal boundary and a later contract migration closes
-- the legacy execute path.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_gate$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'comment reaction causal-intent migration gate is busy';
  END IF;
END
$migration_gate$;

LOCK TABLE auth.users,
  public.posts,
  public.groups,
  public.comments,
  public.comment_likes,
  public.blocked_users,
  public.group_members,
  public.group_bans,
  public.user_follows,
  public.comment_reaction_count_repair_queue
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_function regprocedure;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_source text;
  v_comment text;
  v_expected record;
  v_existing regprocedure;
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('authenticator') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'comment reaction causal-intent foundations are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
      AND function_row.oid IS DISTINCT FROM CASE function_row.proname
        WHEN 'reserve_comment_reaction_intent_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'
          )::oid
        WHEN 'set_comment_reaction_desired_state_causal_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
          )::oid
        WHEN 'cleanup_comment_reaction_intents_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.cleanup_comment_reaction_intents_atomic(integer)'
          )::oid
      END
  ) THEN
    RAISE EXCEPTION 'incompatible comment reaction causal-intent overload exists';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
          'comment-reaction-causal-intent:reserve-v1:'
        ),
        (
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
          'comment-reaction-causal-intent:apply-v1:'
        ),
        (
          'public.cleanup_comment_reaction_intents_atomic(integer)',
          'comment-reaction-causal-intent:cleanup-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    v_existing := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_existing IS NOT NULL THEN
      SELECT function_row.prosrc,
             pg_catalog.obj_description(function_row.oid, 'pg_proc')
      INTO STRICT v_source, v_comment
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_existing;
      IF v_comment IS DISTINCT FROM
           v_expected.comment_prefix || pg_catalog.md5(v_source)
      THEN
        RAISE EXCEPTION
          'existing comment reaction causal-intent function source seal drifted: %',
          v_existing;
      END IF;
    END IF;
  END LOOP;

  v_function :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_comment_id',
      'p_desired_reaction'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-desired-state:v1:' || pg_catalog.md5(v_source)
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
         AND function_row.proname =
           'set_comment_reaction_desired_state_atomic'
         AND function_row.oid <> v_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_function
         AND acl_entry.grantee = v_service
         AND acl_entry.privilege_type = 'EXECUTE'
         AND NOT acl_entry.is_grantable
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_function
         AND acl_entry.grantee NOT IN (function_row.proowner, v_service)
     )
  THEN
    RAISE EXCEPTION
      '1070 desired-state composed authority metadata, source seal, overload, or ACL drifted';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.comment_reaction_intent_heads (
  actor_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  latest_issued_sequence bigint NOT NULL DEFAULT 0,
  latest_applied_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT comment_reaction_intent_heads_pkey
    PRIMARY KEY (actor_id, comment_id),
  CONSTRAINT comment_reaction_intent_heads_actor_fkey
    FOREIGN KEY (actor_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
  CONSTRAINT comment_reaction_intent_heads_comment_fkey
    FOREIGN KEY (comment_id)
    REFERENCES public.comments(id)
    ON DELETE CASCADE,
  CONSTRAINT comment_reaction_intent_heads_sequence_check CHECK (
    latest_applied_sequence >= 0
    AND latest_issued_sequence >= latest_applied_sequence
    AND latest_issued_sequence < 9223372036854775807
  )
);

CREATE TABLE IF NOT EXISTS public.comment_reaction_intent_operations (
  actor_id uuid NOT NULL,
  request_id text NOT NULL,
  comment_id uuid NOT NULL,
  post_id uuid NOT NULL,
  intent_sequence bigint NOT NULL,
  desired_reaction text,
  intent_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'issued',
  result jsonb,
  issued_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT comment_reaction_intent_operations_pkey
    PRIMARY KEY (actor_id, request_id),
  CONSTRAINT comment_reaction_intent_operations_sequence_key
    UNIQUE (actor_id, comment_id, intent_sequence),
  CONSTRAINT comment_reaction_intent_operations_head_fkey
    FOREIGN KEY (actor_id, comment_id)
    REFERENCES public.comment_reaction_intent_heads(actor_id, comment_id)
    ON DELETE CASCADE,
  CONSTRAINT comment_reaction_intent_operations_request_check
    CHECK (request_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT comment_reaction_intent_operations_sequence_check
    CHECK (intent_sequence > 0),
  CONSTRAINT comment_reaction_intent_operations_desired_check
    CHECK (desired_reaction IS NULL OR desired_reaction IN ('like', 'dislike')),
  CONSTRAINT comment_reaction_intent_operations_fingerprint_check
    CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT comment_reaction_intent_operations_state_check
    CHECK (state IN ('issued', 'applied', 'stale', 'expired')),
  CONSTRAINT comment_reaction_intent_operations_time_check CHECK (
    expires_at > issued_at
    AND retain_until > expires_at
    AND (
      (state = 'issued' AND completed_at IS NULL AND result IS NULL)
      OR (state = 'applied' AND completed_at IS NOT NULL AND result IS NOT NULL)
      OR (state IN ('stale', 'expired') AND completed_at IS NOT NULL AND result IS NULL)
    )
  ),
  CONSTRAINT comment_reaction_intent_operations_result_check CHECK (
    result IS NULL OR (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ->> 'status' IN ('added', 'removed', 'changed', 'unchanged')
      AND result ->> 'action' = result ->> 'status'
      AND result ->> 'intent_sequence' = intent_sequence::text
      AND result ->> 'replayed' = 'false'
      AND result ?& ARRAY[
        'status',
        'action',
        'reaction',
        'liked',
        'disliked',
        'like_count',
        'dislike_count',
        'intent_sequence',
        'replayed'
      ]::text[]
      AND result - ARRAY[
        'status',
        'action',
        'reaction',
        'liked',
        'disliked',
        'like_count',
        'dislike_count',
        'intent_sequence',
        'replayed'
      ]::text[] = '{}'::jsonb
    )
  )
);

CREATE INDEX IF NOT EXISTS comment_reaction_intent_operations_retention_idx
  ON public.comment_reaction_intent_operations (
    retain_until,
    actor_id,
    request_id
  );

CREATE INDEX IF NOT EXISTS comment_reaction_intent_heads_cleanup_idx
  ON public.comment_reaction_intent_heads (updated_at, actor_id, comment_id);

DO $table_shape_preflight$
DECLARE
  v_invalid text[];
  v_constraints text[];
  v_indexes text[];
BEGIN
  SELECT pg_catalog.array_agg(required.table_name || '.' || required.column_name)
  INTO v_invalid
  FROM (
    VALUES
      ('comment_reaction_intent_heads', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 2, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 3, 'latest_issued_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 4, 'latest_applied_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 5, 'updated_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 2, 'request_id', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 3, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 4, 'post_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 5, 'intent_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 6, 'desired_reaction', 'text'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 7, 'intent_fingerprint', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 8, 'state', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 9, 'result', 'jsonb'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 10, 'issued_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 11, 'expires_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 12, 'retain_until', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 13, 'completed_at', 'timestamptz'::pg_catalog.regtype, false)
  ) AS required(table_name, ordinal, column_name, type_oid, not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass('public.' || required.table_name)
   AND attribute.attnum = required.ordinal
   AND attribute.attname = required.column_name
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR attribute.attnotnull IS DISTINCT FROM required.not_null;

  IF v_invalid IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_heads'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 5
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_operations'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 13
  THEN
    RAISE EXCEPTION 'comment reaction causal-intent columns drifted: %', v_invalid;
  END IF;

  IF (
    SELECT pg_catalog.array_agg(
      relation.relname || '.' || attribute.attname || '=' ||
        pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
      ORDER BY relation.relname, attribute.attname
    )
    FROM pg_catalog.pg_attrdef AS default_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = default_row.adrelid
     AND attribute.attnum = default_row.adnum
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = default_row.adrelid
    WHERE default_row.adrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
  ) IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads.latest_applied_sequence=0',
    'comment_reaction_intent_heads.latest_issued_sequence=0',
    'comment_reaction_intent_heads.updated_at=statement_timestamp()',
    'comment_reaction_intent_operations.issued_at=statement_timestamp()',
    'comment_reaction_intent_operations.state=''issued''::text'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal-intent defaults drifted';
  END IF;

  SELECT pg_catalog.array_agg(constraint_row.conname ORDER BY constraint_row.conname)
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_actor_fkey',
    'comment_reaction_intent_heads_comment_fkey',
    'comment_reaction_intent_heads_pkey',
    'comment_reaction_intent_heads_sequence_check'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal head constraints drifted: %',
      v_constraints;
  END IF;

  IF (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c5eaa3f9fc4a9a682ce5ede3fd1a6ca' THEN
    RAISE EXCEPTION 'comment reaction causal head constraint definitions drifted';
  END IF;

  SELECT pg_catalog.array_agg(constraint_row.conname ORDER BY constraint_row.conname)
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_desired_check',
    'comment_reaction_intent_operations_fingerprint_check',
    'comment_reaction_intent_operations_head_fkey',
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_request_check',
    'comment_reaction_intent_operations_result_check',
    'comment_reaction_intent_operations_sequence_check',
    'comment_reaction_intent_operations_sequence_key',
    'comment_reaction_intent_operations_state_check',
    'comment_reaction_intent_operations_time_check'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal operation constraints drifted: %',
      v_constraints;
  END IF;

  IF (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c85c4c638d898935eec524084a73b6e' THEN
    RAISE EXCEPTION
      'comment reaction causal operation constraint definitions drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
      AND NOT constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname = 'comment_reaction_intent_heads_actor_fkey'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname = 'comment_reaction_intent_heads_comment_fkey'
      AND constraint_row.confrelid = 'public.comments'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname = 'comment_reaction_intent_operations_head_fkey'
      AND constraint_row.confrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'comment reaction causal-intent FK boundary drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_cleanup_idx',
    'comment_reaction_intent_heads_pkey'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal head indexes drifted: %', v_indexes;
  END IF;
  IF (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '6db551c8f0e870195efb3e5341e0050a' THEN
    RAISE EXCEPTION 'comment reaction causal head index definitions drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_retention_idx',
    'comment_reaction_intent_operations_sequence_key'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal operation indexes drifted: %',
      v_indexes;
  END IF;
  IF (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '1a0886f337f4c19cdd9b46c42a130b2b' THEN
    RAISE EXCEPTION 'comment reaction causal operation index definitions drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
       OR inheritance.inhparent IN (
         'public.comment_reaction_intent_heads'::pg_catalog.regclass,
         'public.comment_reaction_intent_operations'::pg_catalog.regclass
       )
  ) THEN
    RAISE EXCEPTION 'comment reaction causal-intent relation topology drifted';
  END IF;
END
$table_shape_preflight$;

ALTER TABLE public.comment_reaction_intent_heads OWNER TO postgres;
ALTER TABLE public.comment_reaction_intent_operations OWNER TO postgres;
ALTER TABLE public.comment_reaction_intent_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reaction_intent_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reaction_intent_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reaction_intent_operations FORCE ROW LEVEL SECURITY;

DO $converge_table_acl$
DECLARE
  v_relation regclass;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
  v_column record;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ]
  LOOP
    SELECT relation.relowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation;

    FOR v_grantee IN
      SELECT DISTINCT grantee_set.grantee, role_row.rolname
      FROM (
        SELECT acl_entry.grantee
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS acl_entry
        WHERE relation.oid = v_relation
        UNION
        SELECT acl_entry.grantee
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      ) AS grantee_set
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = grantee_set.grantee
      WHERE grantee_set.grantee <> v_owner
    LOOP
      IF v_grantee.grantee <> 0 AND v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION 'causal-intent ACL references missing role oid %',
          v_grantee.grantee;
      END IF;
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE %s FROM %s CASCADE',
        v_relation,
        v_grantee_sql
      );
      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s CASCADE',
          v_column.attname,
          v_relation,
          v_grantee_sql
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$converge_table_acl$;

CREATE OR REPLACE FUNCTION public.reserve_comment_reaction_intent_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_comment_id uuid,
  p_request_id text,
  p_desired_reaction text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_group_id uuid;
  v_current_reaction text;
  v_has_current boolean;
  v_head public.comment_reaction_intent_heads%ROWTYPE;
  v_existing public.comment_reaction_intent_operations%ROWTYPE;
  v_sequence bigint;
  v_issued_at timestamptz := pg_catalog.statement_timestamp();
  v_expires_at timestamptz := v_issued_at + interval '30 minutes';
  v_retain_until timestamptz := v_expires_at + interval '7 days';
  v_fingerprint text;
  v_authorization jsonb;
  v_is_replay boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_comment_id IS NULL
     OR p_request_id IS NULL
     OR p_request_id !~ '^[0-9a-f]{32}$'
     OR (
       p_desired_reaction IS NOT NULL
       AND p_desired_reaction NOT IN ('like', 'dislike')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'comment reaction causal-intent migration gate is busy';
  END IF;

  PERFORM 1
  FROM auth.users AS actor_account
  WHERE actor_account.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'comment-reaction-intent-request:' || p_actor_id::text || ':' || p_request_id,
      0
    )
  );

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'comment-reaction-causal-intent:v1',
        p_post_id,
        p_comment_id,
        p_desired_reaction
      )::text,
      'UTF8'
    )),
    'hex'
  );

  -- Read an immutable existing operation before current audience/source
  -- authorization. This is intentionally a non-locking MVCC read: the
  -- request advisory lock excludes causal writers, and cleanup cannot select
  -- an unexpired retained row. A lost-response replay therefore remains exact
  -- after the original removal changed source state or audience access was
  -- revoked, without taking a child FK row lock before its comment parent.
  SELECT operation_row.*
  INTO v_existing
  FROM public.comment_reaction_intent_operations AS operation_row
  WHERE operation_row.actor_id = p_actor_id
    AND operation_row.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.post_id IS DISTINCT FROM p_post_id
       OR v_existing.comment_id IS DISTINCT FROM p_comment_id
       OR v_existing.desired_reaction IS DISTINCT FROM p_desired_reaction
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
    END IF;
    IF v_existing.expires_at <= v_issued_at THEN
      RETURN pg_catalog.jsonb_build_object('status', 'expired');
    END IF;
    v_is_replay := true;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'comment-reaction-intent-head:' || p_actor_id::text || ':' || p_comment_id::text,
      0
    )
  );

  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    p_comment_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT target_post.group_id
  INTO v_group_id
  FROM public.posts AS target_post
  WHERE target_post.id = p_post_id
    AND target_post.deleted_at IS NULL
    AND target_post.status = 'active'::public.post_status
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_group_id IS NOT NULL THEN
    PERFORM 1
    FROM public.groups AS interaction_group
    WHERE interaction_group.id = v_group_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  PERFORM 1
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id
    AND target_comment.post_id = p_post_id
    AND target_comment.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT reaction.reaction_type
  INTO v_current_reaction
  FROM public.comment_likes AS reaction
  WHERE reaction.comment_id = p_comment_id
    AND reaction.user_id = p_actor_id
  FOR UPDATE;
  v_has_current := FOUND;

  IF v_is_replay THEN
    SELECT operation_row.*
    INTO v_existing
    FROM public.comment_reaction_intent_operations AS operation_row
    WHERE operation_row.actor_id = p_actor_id
      AND operation_row.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'unknown_ticket');
    END IF;
    IF v_existing.post_id IS DISTINCT FROM p_post_id
       OR v_existing.comment_id IS DISTINCT FROM p_comment_id
       OR v_existing.desired_reaction IS DISTINCT FROM p_desired_reaction
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
    END IF;
    IF v_existing.expires_at <= v_issued_at THEN
      RETURN pg_catalog.jsonb_build_object('status', 'expired');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'replayed',
      'intent_sequence', v_existing.intent_sequence::text,
      'expires_at', pg_catalog.to_char(
        v_existing.expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
  END IF;

  -- A desired NULL with an existing source row is a withdrawal and remains
  -- reservable after audience access is revoked. Every other ticket is a
  -- current interaction. Calling 1070 with the already-held current state
  -- exercises its unchanged authorization path without changing the source.
  IF NOT (p_desired_reaction IS NULL AND v_has_current) THEN
    v_authorization := public.set_comment_reaction_desired_state_atomic(
      p_actor_id,
      p_post_id,
      p_comment_id,
      CASE WHEN v_has_current THEN v_current_reaction ELSE NULL END
    );
    IF v_authorization ->> 'status' IS DISTINCT FROM 'unchanged'
       OR v_authorization -> 'reaction' IS DISTINCT FROM (CASE
         WHEN v_has_current THEN pg_catalog.to_jsonb(v_current_reaction)
         ELSE 'null'::jsonb
       END)
    THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'comment reaction reservation authorization drifted';
    END IF;
  END IF;

  INSERT INTO public.comment_reaction_intent_heads (
    actor_id,
    comment_id
  ) VALUES (
    p_actor_id,
    p_comment_id
  )
  ON CONFLICT (actor_id, comment_id) DO NOTHING;

  SELECT head_row.*
  INTO STRICT v_head
  FROM public.comment_reaction_intent_heads AS head_row
  WHERE head_row.actor_id = p_actor_id
    AND head_row.comment_id = p_comment_id
  FOR UPDATE;

  IF v_head.latest_issued_sequence >= 9223372036854775806 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'too_many_pending');
  END IF;
  IF (
    SELECT pg_catalog.count(*)
    FROM public.comment_reaction_intent_operations AS retained_operation
    WHERE retained_operation.actor_id = p_actor_id
      AND retained_operation.comment_id = p_comment_id
      AND retained_operation.retain_until >= v_issued_at
  ) >= 256 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'too_many_pending');
  END IF;
  v_sequence := v_head.latest_issued_sequence + 1;

  UPDATE public.comment_reaction_intent_operations AS older_operation
  SET state = 'stale',
      result = NULL,
      completed_at = v_issued_at
  WHERE older_operation.actor_id = p_actor_id
    AND older_operation.comment_id = p_comment_id
    AND older_operation.state IN ('issued', 'applied');

  UPDATE public.comment_reaction_intent_heads AS head_row
  SET latest_issued_sequence = v_sequence,
      updated_at = v_issued_at
  WHERE head_row.actor_id = p_actor_id
    AND head_row.comment_id = p_comment_id;

  INSERT INTO public.comment_reaction_intent_operations (
    actor_id,
    request_id,
    comment_id,
    post_id,
    intent_sequence,
    desired_reaction,
    intent_fingerprint,
    issued_at,
    expires_at,
    retain_until
  ) VALUES (
    p_actor_id,
    p_request_id,
    p_comment_id,
    p_post_id,
    v_sequence,
    p_desired_reaction,
    v_fingerprint,
    v_issued_at,
    v_expires_at,
    v_retain_until
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'issued',
    'intent_sequence', v_sequence::text,
    'expires_at', pg_catalog.to_char(
      v_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.set_comment_reaction_desired_state_causal_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_comment_id uuid,
  p_request_id text,
  p_intent_sequence bigint,
  p_desired_reaction text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_group_id uuid;
  v_head public.comment_reaction_intent_heads%ROWTYPE;
  v_operation public.comment_reaction_intent_operations%ROWTYPE;
  v_base_result jsonb;
  v_result jsonb;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_fingerprint text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_comment_id IS NULL
     OR p_request_id IS NULL
     OR p_request_id !~ '^[0-9a-f]{32}$'
     OR p_intent_sequence IS NULL
     OR p_intent_sequence <= 0
     OR (
       p_desired_reaction IS NOT NULL
       AND p_desired_reaction NOT IN ('like', 'dislike')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'comment reaction causal-intent migration gate is busy';
  END IF;

  PERFORM 1
  FROM auth.users AS actor_account
  WHERE actor_account.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'comment-reaction-intent-request:' || p_actor_id::text || ':' || p_request_id,
      0
    )
  );

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'comment-reaction-causal-intent:v1',
        p_post_id,
        p_comment_id,
        p_desired_reaction
      )::text,
      'UTF8'
    )),
    'hex'
  );

  -- Unknown request identities fail before any target lookup. The non-locking
  -- read avoids taking a child FK row before the canonical comment parent;
  -- the request advisory lock excludes causal writers and the row is locked
  -- and revalidated after the parent/source lock set below.
  SELECT operation_row.*
  INTO v_operation
  FROM public.comment_reaction_intent_operations AS operation_row
  WHERE operation_row.actor_id = p_actor_id
    AND operation_row.request_id = p_request_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unknown_ticket');
  END IF;

  IF v_operation.post_id IS DISTINCT FROM p_post_id
     OR v_operation.comment_id IS DISTINCT FROM p_comment_id
     OR v_operation.intent_sequence IS DISTINCT FROM p_intent_sequence
     OR v_operation.desired_reaction IS DISTINCT FROM p_desired_reaction
     OR v_operation.intent_fingerprint IS DISTINCT FROM v_fingerprint
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'comment-reaction-intent-head:' || p_actor_id::text || ':' || p_comment_id::text,
      0
    )
  );

  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    p_comment_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT target_post.group_id
  INTO v_group_id
  FROM public.posts AS target_post
  WHERE target_post.id = p_post_id
    AND target_post.deleted_at IS NULL
    AND target_post.status = 'active'::public.post_status
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_group_id IS NOT NULL THEN
    PERFORM 1
    FROM public.groups AS interaction_group
    WHERE interaction_group.id = v_group_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  PERFORM 1
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id
    AND target_comment.post_id = p_post_id
    AND target_comment.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM 1
  FROM public.comment_likes AS reaction
  WHERE reaction.comment_id = p_comment_id
    AND reaction.user_id = p_actor_id
  FOR UPDATE;

  SELECT head_row.*
  INTO v_head
  FROM public.comment_reaction_intent_heads AS head_row
  WHERE head_row.actor_id = p_actor_id
    AND head_row.comment_id = p_comment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unknown_ticket');
  END IF;

  SELECT operation_row.*
  INTO v_operation
  FROM public.comment_reaction_intent_operations AS operation_row
  WHERE operation_row.actor_id = p_actor_id
    AND operation_row.request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unknown_ticket');
  END IF;

  IF v_operation.post_id IS DISTINCT FROM p_post_id
     OR v_operation.comment_id IS DISTINCT FROM p_comment_id
     OR v_operation.intent_sequence IS DISTINCT FROM p_intent_sequence
     OR v_operation.desired_reaction IS DISTINCT FROM p_desired_reaction
     OR v_operation.intent_fingerprint IS DISTINCT FROM v_fingerprint
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;

  IF v_operation.state = 'applied' THEN
    IF v_operation.intent_sequence <> v_head.latest_issued_sequence THEN
      RETURN pg_catalog.jsonb_build_object('status', 'stale');
    END IF;
    RETURN pg_catalog.jsonb_set(
      v_operation.result,
      '{replayed}',
      'true'::jsonb,
      false
    );
  END IF;

  IF v_operation.state = 'stale' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'stale');
  END IF;

  IF v_operation.state = 'expired' OR v_operation.expires_at <= v_now THEN
    IF v_operation.state = 'issued' THEN
      UPDATE public.comment_reaction_intent_operations AS operation_row
      SET state = 'expired',
          completed_at = v_now
      WHERE operation_row.actor_id = p_actor_id
        AND operation_row.request_id = p_request_id;
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'expired');
  END IF;

  IF p_intent_sequence <> v_head.latest_issued_sequence THEN
    IF v_operation.state = 'issued' THEN
      UPDATE public.comment_reaction_intent_operations AS operation_row
      SET state = 'stale',
          completed_at = v_now
      WHERE operation_row.actor_id = p_actor_id
        AND operation_row.request_id = p_request_id;
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'stale');
  END IF;

  v_base_result := public.set_comment_reaction_desired_state_atomic(
    p_actor_id,
    p_post_id,
    p_comment_id,
    p_desired_reaction
  );

  IF pg_catalog.jsonb_typeof(v_base_result) IS DISTINCT FROM 'object'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.jsonb_object_keys(v_base_result)
     ) <> 7
     OR v_base_result ->> 'status' NOT IN (
       'added', 'removed', 'changed', 'unchanged'
     )
     OR v_base_result ->> 'action' IS DISTINCT FROM v_base_result ->> 'status'
     OR v_base_result -> 'reaction' IS DISTINCT FROM (CASE
       WHEN p_desired_reaction IS NULL THEN 'null'::jsonb
       ELSE pg_catalog.to_jsonb(p_desired_reaction)
     END)
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'comment reaction causal authority returned a malformed acknowledgement';
  END IF;

  v_result := v_base_result || pg_catalog.jsonb_build_object(
    'intent_sequence', p_intent_sequence::text,
    'replayed', false
  );

  UPDATE public.comment_reaction_intent_operations AS operation_row
  SET state = 'applied',
      result = v_result,
      completed_at = v_now
  WHERE operation_row.actor_id = p_actor_id
    AND operation_row.request_id = p_request_id;

  UPDATE public.comment_reaction_intent_heads AS head_row
  SET latest_applied_sequence = p_intent_sequence,
      updated_at = v_now
  WHERE head_row.actor_id = p_actor_id
    AND head_row.comment_id = p_comment_id;

  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_comment_reaction_intents_atomic(
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_deleted_operations integer := 0;
  v_deleted_heads integer := 0;
  v_candidate record;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'comment reaction causal-intent migration gate is busy';
  END IF;

  -- Candidate discovery is intentionally lock-free. Each candidate is then
  -- revalidated under account -> causal advisory -> comment -> head order.
  -- This preserves account/comment cascade order and prevents a new causal
  -- ticket from racing the final orphan check.
  FOR v_candidate IN
    SELECT head_row.actor_id, head_row.comment_id
    FROM public.comment_reaction_intent_heads AS head_row
    WHERE head_row.updated_at < v_now - interval '30 days'
      AND NOT EXISTS (
        SELECT 1
        FROM public.comment_reaction_intent_operations AS operation_row
        WHERE operation_row.actor_id = head_row.actor_id
          AND operation_row.comment_id = head_row.comment_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.comment_likes AS reaction
        WHERE reaction.user_id = head_row.actor_id
          AND reaction.comment_id = head_row.comment_id
      )
    ORDER BY head_row.updated_at, head_row.actor_id, head_row.comment_id
    LIMIT p_limit
  LOOP
    PERFORM 1
    FROM auth.users AS actor_account
    WHERE actor_account.id = v_candidate.actor_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'comment-reaction-intent-head:' ||
          v_candidate.actor_id::text || ':' || v_candidate.comment_id::text,
        0
      )
    );

    PERFORM 1
    FROM public.comments AS target_comment
    WHERE target_comment.id = v_candidate.comment_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM 1
    FROM public.comment_reaction_intent_heads AS head_row
    WHERE head_row.actor_id = v_candidate.actor_id
      AND head_row.comment_id = v_candidate.comment_id
      AND head_row.updated_at < v_now - interval '30 days'
      AND NOT EXISTS (
        SELECT 1
        FROM public.comment_reaction_intent_operations AS operation_row
        WHERE operation_row.actor_id = head_row.actor_id
          AND operation_row.comment_id = head_row.comment_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.comment_likes AS reaction
        WHERE reaction.user_id = head_row.actor_id
          AND reaction.comment_id = head_row.comment_id
      )
    FOR UPDATE;

    IF FOUND THEN
      DELETE FROM public.comment_reaction_intent_heads AS head_row
      WHERE head_row.actor_id = v_candidate.actor_id
        AND head_row.comment_id = v_candidate.comment_id;
      v_deleted_heads := v_deleted_heads + 1;
    END IF;
  END LOOP;

  -- Delete operation rows only after the head-clean pass. The reverse order
  -- could hold an operation row while waiting for a comment that an apply
  -- session already holds while waiting for that same operation row.
  WITH expired_operation AS (
    SELECT operation_row.actor_id, operation_row.request_id
    FROM public.comment_reaction_intent_operations AS operation_row
    WHERE operation_row.retain_until < v_now
    ORDER BY operation_row.retain_until,
      operation_row.actor_id,
      operation_row.request_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  DELETE FROM public.comment_reaction_intent_operations AS operation_row
  USING expired_operation
  WHERE operation_row.actor_id = expired_operation.actor_id
    AND operation_row.request_id = expired_operation.request_id;
  GET DIAGNOSTICS v_deleted_operations = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'operations_deleted', v_deleted_operations,
    'heads_deleted', v_deleted_heads
  );
END
$function$;

ALTER FUNCTION public.reserve_comment_reaction_intent_atomic(
  uuid, uuid, uuid, text, text
) OWNER TO postgres;
ALTER FUNCTION public.set_comment_reaction_desired_state_causal_atomic(
  uuid, uuid, uuid, text, bigint, text
) OWNER TO postgres;
ALTER FUNCTION public.cleanup_comment_reaction_intents_atomic(integer)
  OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure,
    'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure,
    'public.cleanup_comment_reaction_intents_atomic(integer)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_function
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee <> 0 AND v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION 'causal-intent function ACL references missing role oid %',
          v_grantee.grantee;
      END IF;
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %s CASCADE',
        v_function,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;

  GRANT EXECUTE ON FUNCTION
    public.reserve_comment_reaction_intent_atomic(uuid, uuid, uuid, text, text)
    TO service_role;
  GRANT EXECUTE ON FUNCTION
    public.set_comment_reaction_desired_state_causal_atomic(
      uuid, uuid, uuid, text, bigint, text
    ) TO service_role;
  GRANT EXECUTE ON FUNCTION
    public.cleanup_comment_reaction_intents_atomic(integer)
    TO service_role;
END
$converge_function_acl$;

DO $seal_causal_functions$
DECLARE
  v_expected record;
  v_source text;
BEGIN
  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
          'comment-reaction-causal-intent:reserve-v1:'
        ),
        (
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
          'comment-reaction-causal-intent:apply-v1:'
        ),
        (
          'public.cleanup_comment_reaction_intents_atomic(integer)',
          'comment-reaction-causal-intent:cleanup-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      pg_catalog.to_regprocedure(v_expected.signature);
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_expected.signature,
      v_expected.comment_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$seal_causal_functions$;

COMMENT ON TABLE public.comment_reaction_intent_heads IS
  'Bounded actor/comment reservation-order head. Sequence order is server reservation order, not physical click time.';
COMMENT ON TABLE public.comment_reaction_intent_operations IS
  'Private replay and causal-ticket ledger with bounded retention and account/comment cascade.';

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_relation regclass;
  v_function regprocedure;
  v_base regprocedure :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  v_source text;
  v_comment text;
  v_function_name text;
  v_expected_prefix text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND (
          relation.relkind <> 'r'
          OR relation.relpersistence <> 'p'
          OR relation.relispartition
          OR relation.relowner <> v_postgres
          OR NOT relation.relrowsecurity
          OR NOT relation.relforcerowsecurity
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> relation.relowner
    ) THEN
      RAISE EXCEPTION 'comment reaction causal-intent table boundary drifted: %',
        v_relation;
    END IF;
  END LOOP;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_base
    AND function_row.proowner = v_postgres
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];
  IF v_comment IS DISTINCT FROM
       'comment-reaction-desired-state:v1:' || pg_catalog.md5(v_source)
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
         AND function_row.proname =
           'set_comment_reaction_desired_state_atomic'
         AND function_row.oid <> v_base
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_base
         AND acl_entry.grantee NOT IN (function_row.proowner, v_service)
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_base
         AND acl_entry.grantee = v_service
         AND acl_entry.privilege_type = 'EXECUTE'
         AND NOT acl_entry.is_grantable
     )
  THEN
    RAISE EXCEPTION
      '1070 desired-state composed authority changed during causal publication';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure,
    'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure,
    'public.cleanup_comment_reaction_intents_atomic(integer)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proname,
           function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_function_name, v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;
    v_expected_prefix := CASE v_function_name
      WHEN 'reserve_comment_reaction_intent_atomic' THEN
        'comment-reaction-causal-intent:reserve-v1:'
      WHEN 'set_comment_reaction_desired_state_causal_atomic' THEN
        'comment-reaction-causal-intent:apply-v1:'
      WHEN 'cleanup_comment_reaction_intents_atomic' THEN
        'comment-reaction-causal-intent:cleanup-v1:'
    END;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND (
          function_row.prokind <> 'f'
          OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
          OR function_row.proretset
          OR function_row.proowner <> v_postgres
          OR NOT function_row.prosecdef
          OR function_row.provolatile <> 'v'
          OR function_row.prolang <> v_plpgsql
          OR function_row.proisstrict
          OR function_row.proparallel <> 'u'
          OR function_row.proleakproof
          OR pg_catalog.cardinality(function_row.proconfig) <> 4
          OR NOT function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'row_security=off',
            'lock_timeout=5s',
            'statement_timeout=15s'
          ]::text[]
        )
    ) OR v_comment IS DISTINCT FROM
      v_expected_prefix || pg_catalog.md5(v_source)
       OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee = v_service
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.grantee NOT IN (function_row.proowner, v_service)
       )
    THEN
      RAISE EXCEPTION 'comment reaction causal-intent function ACL drifted: %',
        v_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'expand migration unexpectedly closed the legacy authority';
  END IF;
END
$postflight$;

COMMIT;
