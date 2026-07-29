-- A GoTrue ban or global sign-out cannot retract an already issued access JWT
-- from PostgREST.  Make the application-account tombstone authoritative at the
-- database write boundary, including writes hidden inside SECURITY DEFINER
-- functions, until that JWT expires.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('inactive-auth-subject-mutation-barrier', 0)
);

DO $preflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'inactive-subject barrier role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('id', 'uuid'::pg_catalog.regtype),
          ('deleted_at', 'timestamptz'::pg_catalog.regtype),
          ('banned_at', 'timestamptz'::pg_catalog.regtype),
          ('is_banned', 'boolean'::pg_catalog.regtype),
          ('ban_expires_at', 'timestamptz'::pg_catalog.regtype)
      ) AS required_column(column_name, type_oid)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
          AND attribute.attname = required_column.column_name
          AND attribute.atttypid = required_column.type_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
    )
  THEN
    RAISE EXCEPTION 'inactive-subject barrier prerequisites are missing';
  END IF;
END
$preflight$;

-- Statement-level execution is deliberate: account activity does not depend on
-- a row's shape, and checking once avoids adding a per-row cost to bulk service
-- writes.  BEFORE STATEMENT also runs before every row trigger, so a rejected
-- stale JWT cannot reach a row-level side effect first.
CREATE OR REPLACE FUNCTION public.guard_active_authenticated_subject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_claims_text text := NULLIF(
    pg_catalog.current_setting('request.jwt.claims', true),
    ''
  );
  v_claims jsonb;
  v_json_role text;
  v_json_subject text;
  v_legacy_role text := NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
  v_legacy_subject text := NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  );
  v_database_role text := NULLIF(
    pg_catalog.current_setting('role', true),
    'none'
  );
  v_claim_role text;
  v_claim_subject text;
  v_subject_id uuid;
  v_auth_uid uuid;
  v_profile record;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'STATEMENT'
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    OR TG_TABLE_SCHEMA NOT IN ('public', 'storage')
  THEN
    RAISE EXCEPTION 'inactive-subject guard is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF v_claims_text IS NOT NULL THEN
    BEGIN
      v_claims := v_claims_text::jsonb;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'authenticated mutation JWT claims are malformed'
          USING ERRCODE = '42501';
    END;
    IF pg_catalog.jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'authenticated mutation JWT claims must be an object'
        USING ERRCODE = '42501';
    END IF;
    v_json_role := NULLIF(v_claims ->> 'role', '');
    v_json_subject := NULLIF(v_claims ->> 'sub', '');
  END IF;

  IF v_json_role IS NOT NULL
    AND v_legacy_role IS NOT NULL
    AND v_json_role IS DISTINCT FROM v_legacy_role
  THEN
    RAISE EXCEPTION 'authenticated mutation JWT role claims conflict'
      USING ERRCODE = '42501';
  END IF;
  IF v_json_subject IS NOT NULL
    AND v_legacy_subject IS NOT NULL
    AND v_json_subject IS DISTINCT FROM v_legacy_subject
  THEN
    RAISE EXCEPTION 'authenticated mutation JWT subject claims conflict'
      USING ERRCODE = '42501';
  END IF;

  v_claim_role := COALESCE(v_json_role, v_legacy_role);
  v_claim_subject := COALESCE(v_json_subject, v_legacy_subject);

  -- current_user changes to this function's owner inside SECURITY DEFINER.
  -- request claims do not. current_setting('role') is used only to recognize an
  -- authenticated database session whose claims are missing or contradictory.
  IF v_claim_role IS DISTINCT FROM 'authenticated'
    AND v_database_role IS DISTINCT FROM 'authenticated'
  THEN
    RETURN NULL;
  END IF;

  IF v_claim_role IS DISTINCT FROM 'authenticated'
    OR v_claim_subject IS NULL
    OR v_database_role IS NOT NULL
      AND v_database_role IS DISTINCT FROM 'authenticated'
  THEN
    RAISE EXCEPTION 'authenticated mutation JWT identity is unavailable'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_subject_id := v_claim_subject::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'authenticated mutation JWT subject is malformed'
        USING ERRCODE = '42501';
  END;
  IF v_claim_subject IS DISTINCT FROM v_subject_id::text THEN
    RAISE EXCEPTION 'authenticated mutation JWT subject is not canonical'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_auth_uid := (SELECT auth.uid());
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'authenticated mutation JWT subject cannot be verified'
        USING ERRCODE = '42501';
  END;
  IF v_auth_uid IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'authenticated mutation JWT subject verification failed'
      USING ERRCODE = '42501';
  END IF;

  -- This is the same user-scoped key used by deletion preparation, recovery,
  -- and hard-delete admission.  The transaction that wins this lock determines
  -- whether the write linearizes before or after the lifecycle transition.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_subject_id::text,
      0
    )
  );

  SELECT
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned,
    profile.ban_expires_at
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = v_subject_id;

  IF NOT FOUND
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RAISE EXCEPTION 'authenticated account is not active'
      USING ERRCODE = '42501';
  END IF;

  -- No authenticated principal may truncate a shared relation, even while its
  -- own profile is active. Direct privilege is also revoked by the installer.
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'authenticated relation truncation is forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN NULL;
END
$function$;

ALTER FUNCTION public.guard_active_authenticated_subject_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_active_authenticated_subject_mutation()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

-- All writers of the profile lifecycle columns, including service-role admin
-- moderation and legacy helpers, acquire the same key as the statement guard.
-- This prevents a status transition from committing between the guard's check
-- and the protected mutation without taking row locks in arbitrary domain order.
CREATE OR REPLACE FUNCTION public.lock_account_lifecycle_subject_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_subject_id uuid;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'user_profiles'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION 'account lifecycle lock is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_subject_id := OLD.id;
  ELSE
    v_subject_id := NEW.id;
  END IF;
  IF v_subject_id IS NULL
    OR TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id
  THEN
    RAISE EXCEPTION 'account lifecycle subject identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_subject_id::text,
      0
    )
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.lock_account_lifecycle_subject_transition()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_account_lifecycle_subject_transition()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

-- Kept private: future migrations call this while running as postgres, followed
-- by the assertion below. It covers partition parents and leaves separately,
-- because PostgreSQL statement triggers on a partitioned parent do not fire
-- when a caller names a leaf directly.
CREATE OR REPLACE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_relation record;
  v_installed integer := 0;
  v_guard_name constant text :=
    '000_active_authenticated_subject_statement_guard';
  v_profile_insert_delete_name constant text :=
    '000_account_lifecycle_subject_insert_delete_lock';
  v_profile_status_name constant text :=
    '000_account_lifecycle_subject_status_lock';
BEGIN
  FOR v_relation IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      relation.oid AS relation_id
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
    ORDER BY namespace.nspname, relation.relname
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation.relation_id
        AND trigger_row.tgname = v_guard_name
        AND NOT trigger_row.tgisinternal
        AND (
          trigger_row.tgfoid IS DISTINCT FROM
            'public.guard_active_authenticated_subject_mutation()'::regprocedure
          OR trigger_row.tgtype IS DISTINCT FROM 62
          OR trigger_row.tgenabled NOT IN ('O', 'A')
        )
    ) THEN
      EXECUTE pg_catalog.format(
        'DROP TRIGGER %I ON %I.%I',
        v_guard_name,
        v_relation.schema_name,
        v_relation.relation_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation.relation_id
        AND trigger_row.tgname = v_guard_name
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgfoid =
          'public.guard_active_authenticated_subject_mutation()'::regprocedure
        AND trigger_row.tgtype = 62
        AND trigger_row.tgenabled IN ('O', 'A')
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE '
          || 'ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION '
          || 'public.guard_active_authenticated_subject_mutation()',
        v_guard_name,
        v_relation.schema_name,
        v_relation.relation_name
      );
      v_installed := v_installed + 1;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE TRIGGER, TRUNCATE ON TABLE %I.%I FROM PUBLIC, authenticated',
      v_relation.schema_name,
      v_relation.relation_name
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname = v_profile_insert_delete_name
      AND NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgfoid IS DISTINCT FROM
          'public.lock_account_lifecycle_subject_transition()'::regprocedure
        OR trigger_row.tgtype IS DISTINCT FROM 15
        OR trigger_row.tgenabled NOT IN ('O', 'A')
      )
  ) THEN
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON public.user_profiles',
      v_profile_insert_delete_name
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname = v_profile_insert_delete_name
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.lock_account_lifecycle_subject_transition()'::regprocedure
      AND trigger_row.tgtype = 15
      AND trigger_row.tgenabled IN ('O', 'A')
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I BEFORE INSERT OR DELETE ON public.user_profiles '
        || 'FOR EACH ROW EXECUTE FUNCTION '
        || 'public.lock_account_lifecycle_subject_transition()',
      v_profile_insert_delete_name
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname = v_profile_status_name
      AND NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgfoid IS DISTINCT FROM
          'public.lock_account_lifecycle_subject_transition()'::regprocedure
        OR trigger_row.tgtype IS DISTINCT FROM 19
        OR trigger_row.tgenabled NOT IN ('O', 'A')
      )
  ) THEN
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON public.user_profiles',
      v_profile_status_name
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname = v_profile_status_name
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.lock_account_lifecycle_subject_transition()'::regprocedure
      AND trigger_row.tgtype = 19
      AND trigger_row.tgenabled IN ('O', 'A')
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I BEFORE UPDATE OF '
        || 'deleted_at, banned_at, is_banned, ban_expires_at '
        || 'ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION '
        || 'public.lock_account_lifecycle_subject_transition()',
      v_profile_status_name
    );
  END IF;

  RETURN v_installed;
END
$function$;

ALTER FUNCTION public.install_active_authenticated_subject_mutation_barriers()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.install_active_authenticated_subject_mutation_barriers()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_guard_name constant text :=
    '000_active_authenticated_subject_statement_guard';
  v_relation_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = relation.oid
          AND trigger_row.tgname = v_guard_name
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid =
            'public.guard_active_authenticated_subject_mutation()'::regprocedure
          AND trigger_row.tgtype = 62
          AND trigger_row.tgenabled IN ('O', 'A')
      )
  ) THEN
    RAISE EXCEPTION 'inactive-subject statement trigger coverage drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_trigger AS earlier_trigger
      ON earlier_trigger.tgrelid = relation.oid
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
      AND NOT earlier_trigger.tgisinternal
      AND earlier_trigger.tgenabled IN ('O', 'A')
      AND (earlier_trigger.tgtype & 1) = 0
      AND (earlier_trigger.tgtype & 2) = 2
      AND (earlier_trigger.tgtype & 60) <> 0
      AND earlier_trigger.tgname < v_guard_name COLLATE "C"
  ) THEN
    RAISE EXCEPTION 'inactive-subject guard is not the first BEFORE STATEMENT trigger';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
      AND (
        pg_catalog.has_table_privilege(
          'authenticated',
          relation.oid,
          'TRIGGER'
        )
        OR pg_catalog.has_table_privilege(
          'authenticated',
          relation.oid,
          'TRUNCATE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'authenticated trigger or truncate privilege drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname =
        '000_account_lifecycle_subject_insert_delete_lock'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.lock_account_lifecycle_subject_transition()'::regprocedure
      AND trigger_row.tgtype = 15
      AND trigger_row.tgenabled IN ('O', 'A')
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
      AND trigger_row.tgname = '000_account_lifecycle_subject_status_lock'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.lock_account_lifecycle_subject_transition()'::regprocedure
      AND trigger_row.tgtype = 19
      AND trigger_row.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'account lifecycle advisory-lock trigger coverage drifted';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_relation_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('public', 'storage')
    AND relation.relkind IN ('r', 'p');

  RETURN v_relation_count;
END
$function$;

ALTER FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
  TO service_role;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

COMMENT ON FUNCTION public.guard_active_authenticated_subject_mutation() IS
  'Rejects every public/storage mutation made by a missing, deleted, or actively banned authenticated JWT, including SECURITY DEFINER writes.';
COMMENT ON FUNCTION public.lock_account_lifecycle_subject_transition() IS
  'Serializes profile insertion, deletion, and suspension transitions with authenticated mutation admission.';
COMMENT ON FUNCTION public.install_active_authenticated_subject_mutation_barriers() IS
  'Private migration helper that installs the statement guard on every public/storage table and partition.';
COMMENT ON FUNCTION public.assert_active_authenticated_subject_mutation_barriers() IS
  'Service-readable coverage assertion for the inactive authenticated-subject mutation barrier.';

COMMIT;
