-- Forward-port the canonical profile handle contract without importing the
-- old monolithic Hum migration.  Existing dotted/reserved handles remain
-- readable when unchanged, while every new or renamed handle is URL-segment
-- safe, normalized, non-reserved and unique case-insensitively.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $required_objects$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = v_role
    ) THEN
      RAISE EXCEPTION 'required handle-contract role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('auth.users') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'auth.users'::pg_catalog.regclass
      AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'auth.users must be an ordinary table';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
      AND relation.relkind IN ('r', 'p')
      AND relation.relowner = (
        SELECT role_row.oid
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = 'postgres'
      )
  ) THEN
    RAISE EXCEPTION 'public.user_profiles must be an ordinary postgres-owned table';
  END IF;
END
$required_objects$;

-- Match the auth insertion order.  Locking auth.users before user_profiles
-- prevents a signup trigger from holding the parent write while waiting on the
-- profile table in the opposite order.
LOCK TABLE auth.users, public.user_profiles IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_index_relation pg_catalog.regclass;
  v_provisioner pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.handle_new_user()'
  );
  v_validator pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.enforce_user_profile_handle_contract()'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('auth', 'users', 'email', 'text'::pg_catalog.regtype),
        ('auth', 'users', 'raw_user_meta_data', 'jsonb'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'email', 'text'::pg_catalog.regtype),
        ('public', 'user_profiles', 'handle', 'text'::pg_catalog.regtype),
        ('public', 'user_profiles', 'created_at', 'timestamptz'::pg_catalog.regtype)
    ) AS required_column(schema_name, relation_name, column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          required_column.schema_name || '.' || required_column.relation_name
        )
        AND attribute.attname = required_column.column_name
        AND (
          attribute.atttypid = required_column.type_oid
          OR (
            required_column.schema_name = 'auth'
            AND required_column.relation_name = 'users'
            AND required_column.column_name = 'email'
            AND attribute.atttypid = 'varchar'::pg_catalog.regtype
          )
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'profile handle-contract columns are incompatible';
  END IF;

  IF v_provisioner IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_provisioner
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prokind = 'f'
  ) THEN
    RAISE EXCEPTION 'canonical auth profile provisioner is missing or incompatible';
  END IF;

  IF v_validator IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_validator
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prokind = 'f'
  ) THEN
    RAISE EXCEPTION 'profile handle validator is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'handle_new_user',
        'enforce_user_profile_handle_contract'
      )
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'unexpected profile handle function overload exists';
  END IF;

  v_index_relation := pg_catalog.to_regclass(
    'public.user_profiles_handle_lower_unique'
  );
  IF v_index_relation IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid = v_index_relation
      AND index_row.indrelid = 'public.user_profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'profile handle index name belongs to another relation';
  END IF;
END
$preflight$;

-- A replay may already have a drifted validator/constraint/index.  Remove the
-- enforcement pieces transactionally before repairing either missing profiles
-- or existing rows, then rebuild their exact definitions after convergence.
DROP TRIGGER IF EXISTS trg_user_profiles_05_handle_contract
  ON public.user_profiles;
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_handle_shape_check;
DROP INDEX IF EXISTS public.user_profiles_handle_lower_unique;

-- Repair auth identities that predate or raced historical provisioning.  A
-- deterministic UUID-derived candidate avoids trusting stale auth metadata;
-- lower(handle) is checked under the table lock even before the canonical
-- case-insensitive index exists.
DO $backfill_missing_profiles$
DECLARE
  v_auth_user record;
  v_candidate text;
  v_attempt integer;
BEGIN
  FOR v_auth_user IN
    SELECT auth_user.id, auth_user.email
    FROM auth.users AS auth_user
    LEFT JOIN public.user_profiles AS profile ON profile.id = auth_user.id
    WHERE profile.id IS NULL
    ORDER BY auth_user.id
  LOOP
    v_attempt := 0;
    LOOP
      IF v_attempt = 0 THEN
        v_candidate := 'user_' || pg_catalog.left(
          pg_catalog.replace(v_auth_user.id::text, '-', ''),
          25
        );
      ELSE
        v_candidate := 'user_' || pg_catalog.left(
          pg_catalog.md5(v_auth_user.id::text || ':' || v_attempt::text),
          25
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.user_profiles AS existing_profile
        WHERE pg_catalog.lower(existing_profile.handle) =
          pg_catalog.lower(v_candidate)
      ) THEN
        BEGIN
          INSERT INTO public.user_profiles (id, email, handle)
          VALUES (v_auth_user.id, v_auth_user.email, v_candidate);
          EXIT;
        EXCEPTION
          WHEN unique_violation THEN
            IF EXISTS (
              SELECT 1
              FROM public.user_profiles AS existing_profile
              WHERE existing_profile.id = v_auth_user.id
            ) THEN
              EXIT;
            END IF;
        END;
      END IF;

      v_attempt := v_attempt + 1;
      IF v_attempt > 128 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'unable to allocate deterministic backfill handle';
      END IF;
    END LOOP;
  END LOOP;
END
$backfill_missing_profiles$;

DROP TABLE IF EXISTS pg_temp.user_profile_handle_plan;
CREATE TEMPORARY TABLE pg_temp.user_profile_handle_plan (
  id uuid PRIMARY KEY,
  original_handle text,
  created_at timestamptz,
  base_handle text NOT NULL,
  final_handle text,
  placeholder_handle text
) ON COMMIT DROP;

WITH normalized AS (
  SELECT
    profile.id,
    profile.handle AS original_handle,
    profile.created_at,
    normalize(
      pg_catalog.btrim(COALESCE(profile.handle, '')),
      NFC
    ) AS normalized_handle
  FROM public.user_profiles AS profile
), sanitized AS (
  SELECT
    normalized.id,
    normalized.original_handle,
    normalized.created_at,
    pg_catalog.left(
      pg_catalog.regexp_replace(
        normalized.normalized_handle,
        '[^A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]',
        '_',
        'g'
      ),
      30
    ) AS legacy_candidate
  FROM normalized
), classified AS (
  SELECT
    sanitized.id,
    sanitized.original_handle,
    sanitized.created_at,
    CASE
      WHEN sanitized.legacy_candidate ~
        '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
      THEN sanitized.legacy_candidate
      ELSE 'user_' || pg_catalog.left(
        pg_catalog.replace(sanitized.id::text, '-', ''),
        25
      )
    END AS candidate,
    sanitized.legacy_candidate ~
      '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
      AND sanitized.original_handle IS NOT DISTINCT FROM
        sanitized.legacy_candidate AS preserve_legacy
  FROM sanitized
), new_safe AS (
  SELECT
    classified.id,
    classified.original_handle,
    classified.created_at,
    classified.preserve_legacy,
    CASE
      WHEN classified.preserve_legacy THEN classified.candidate
      ELSE pg_catalog.replace(classified.candidate, '.', '_')
    END AS candidate
  FROM classified
), reserved_safe AS (
  SELECT
    new_safe.id,
    new_safe.original_handle,
    new_safe.created_at,
    CASE
      WHEN NOT new_safe.preserve_legacy
        AND pg_catalog.lower(new_safe.candidate) = ANY (
          ARRAY[
            'admin', 'administrator', 'arena', 'moderator',
            'official', 'root', 'support', 'system'
          ]::text[]
        )
      THEN pg_catalog.left(new_safe.candidate, 21)
        || '_'
        || pg_catalog.left(
          pg_catalog.replace(new_safe.id::text, '-', ''),
          8
        )
      ELSE new_safe.candidate
    END AS base_handle
  FROM new_safe
)
INSERT INTO pg_temp.user_profile_handle_plan (
  id,
  original_handle,
  created_at,
  base_handle
)
SELECT
  reserved_safe.id,
  reserved_safe.original_handle,
  reserved_safe.created_at,
  reserved_safe.base_handle
FROM reserved_safe;

-- Reserve every canonical base first.  Duplicate/collision rows receive a
-- deterministic strict-alphabet suffix that cannot steal another base.
WITH ranked AS (
  SELECT
    plan.id,
    pg_catalog.row_number() OVER (
      PARTITION BY pg_catalog.lower(plan.base_handle)
      ORDER BY plan.created_at NULLS LAST, plan.id
    ) AS collision_rank
  FROM pg_temp.user_profile_handle_plan AS plan
)
UPDATE pg_temp.user_profile_handle_plan AS plan
SET final_handle = plan.base_handle
FROM ranked
WHERE ranked.id = plan.id
  AND ranked.collision_rank = 1;

DO $allocate_collision_handles$
DECLARE
  v_row record;
  v_candidate text;
  v_attempt integer;
BEGIN
  FOR v_row IN
    SELECT plan.id, plan.base_handle
    FROM pg_temp.user_profile_handle_plan AS plan
    WHERE plan.final_handle IS NULL
    ORDER BY plan.created_at NULLS LAST, plan.id
  LOOP
    v_attempt := 0;
    LOOP
      v_candidate := pg_catalog.left(v_row.base_handle, 19)
        || '_'
        || pg_catalog.left(
          pg_catalog.md5(v_row.id::text || ':' || v_attempt::text),
          10
        );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_temp.user_profile_handle_plan AS allocated
        WHERE pg_catalog.lower(allocated.final_handle) =
          pg_catalog.lower(v_candidate)
      ) THEN
        UPDATE pg_temp.user_profile_handle_plan AS target
        SET final_handle = v_candidate
        WHERE target.id = v_row.id;
        EXIT;
      END IF;

      v_attempt := v_attempt + 1;
      IF v_attempt > 128 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'unable to allocate collision-free profile handle';
      END IF;
    END LOOP;
  END LOOP;
END
$allocate_collision_handles$;

CREATE UNIQUE INDEX user_profile_handle_plan_lower_unique
  ON pg_temp.user_profile_handle_plan (pg_catalog.lower(final_handle));

DO $validate_handle_plan$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.user_profile_handle_plan AS plan
    WHERE plan.final_handle IS NULL
      OR pg_catalog.char_length(plan.final_handle) NOT BETWEEN 1 AND 30
      OR plan.final_handle IS NOT NFC NORMALIZED
      OR plan.final_handle !~ '^[A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]+$'
      OR plan.final_handle !~ '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
      OR (
        plan.original_handle IS DISTINCT FROM plan.final_handle
        AND (
          plan.final_handle !~ '^[A-Za-z0-9_一-龯ぁ-ゟ゠-ヿ가-힣]+$'
          OR pg_catalog.lower(plan.final_handle) = ANY (
            ARRAY[
              'admin', 'administrator', 'arena', 'moderator',
              'official', 'root', 'support', 'system'
            ]::text[]
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'profile handle repair plan violates the canonical contract';
  END IF;

  UPDATE pg_temp.user_profile_handle_plan AS plan
  SET placeholder_handle = '~arena~'
    || plan.id::text
    || '~'
    || pg_catalog.pg_current_xact_id()::text
  WHERE plan.original_handle IS DISTINCT FROM plan.final_handle;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.user_profile_handle_plan AS changing
    JOIN pg_temp.user_profile_handle_plan AS existing
      ON existing.original_handle = changing.placeholder_handle
    WHERE changing.placeholder_handle IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'profile handle repair placeholder collision';
  END IF;
END
$validate_handle_plan$;

-- Stage changed rows through transaction-unique placeholders so exact UNIQUE
-- constraints cannot fail on swaps such as "foo!" -> "foo_" while another
-- row currently owns "foo_".  Both writes are invisible outside this atomic
-- transaction; existing author-cache triggers finish on the final value.
UPDATE public.user_profiles AS profile
SET handle = plan.placeholder_handle
FROM pg_temp.user_profile_handle_plan AS plan
WHERE plan.id = profile.id
  AND plan.placeholder_handle IS NOT NULL;

UPDATE public.user_profiles AS profile
SET handle = plan.final_handle
FROM pg_temp.user_profile_handle_plan AS plan
WHERE plan.id = profile.id
  AND profile.handle IS DISTINCT FROM plan.final_handle;

ALTER TABLE public.user_profiles
  ALTER COLUMN handle SET NOT NULL;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_handle_shape_check
  CHECK (
    handle = pg_catalog.btrim(handle)
    AND pg_catalog.char_length(handle) BETWEEN 1 AND 30
    AND handle IS NFC NORMALIZED
    AND handle ~ '^[A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]+$'
    AND handle ~ '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
  ) NOT VALID;
ALTER TABLE public.user_profiles
  VALIDATE CONSTRAINT user_profiles_handle_shape_check;

CREATE UNIQUE INDEX user_profiles_handle_lower_unique
  ON public.user_profiles (pg_catalog.lower(handle));

CREATE OR REPLACE FUNCTION public.enforce_user_profile_handle_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_handle_changed boolean;
BEGIN
  v_handle_changed := TG_OP = 'INSERT'
    OR NEW.handle IS DISTINCT FROM OLD.handle;

  IF NEW.handle IS NULL
    OR NEW.handle <> pg_catalog.btrim(NEW.handle)
    OR pg_catalog.char_length(NEW.handle) NOT BETWEEN 1 AND 30
    OR NEW.handle IS NOT NFC NORMALIZED
    OR NEW.handle !~ '^[A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]+$'
    OR NEW.handle !~ '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid profile handle';
  END IF;

  IF v_handle_changed
    AND NEW.handle !~ '^[A-Za-z0-9_一-龯ぁ-ゟ゠-ヿ가-힣]+$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid profile handle';
  END IF;

  IF v_handle_changed
    AND pg_catalog.lower(NEW.handle) = ANY (
      ARRAY[
        'admin', 'administrator', 'arena', 'moderator',
        'official', 'root', 'support', 'system'
      ]::text[]
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'reserved profile handle';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_user_profile_handle_contract()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_user_profile_handle_contract()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_user_profiles_05_handle_contract
BEFORE INSERT OR UPDATE OF handle
ON public.user_profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_profile_handle_contract();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_requested text;
  v_base text;
  v_candidate text;
  v_attempt integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  v_requested := COALESCE(
    NULLIF(NEW.raw_user_meta_data ->> 'handle', ''),
    NULLIF(pg_catalog.split_part(COALESCE(NEW.email, ''), '@', 1), ''),
    'user'
  );
  v_base := pg_catalog.left(
    pg_catalog.regexp_replace(
      normalize(pg_catalog.btrim(v_requested), NFC),
      '[^A-Za-z0-9_一-龯ぁ-ゟ゠-ヿ가-힣]',
      '_',
      'g'
    ),
    30
  );
  IF v_base = ''
    OR v_base !~ '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
  THEN
    v_base := 'user';
  END IF;

  IF pg_catalog.lower(v_base) = ANY (
    ARRAY[
      'admin', 'administrator', 'arena', 'moderator',
      'official', 'root', 'support', 'system'
    ]::text[]
  ) THEN
    v_base := pg_catalog.left(v_base, 19)
      || '_'
      || pg_catalog.left(
        pg_catalog.replace(NEW.id::text, '-', ''),
        10
      );
  END IF;
  v_candidate := v_base;

  LOOP
    BEGIN
      INSERT INTO public.user_profiles (id, email, handle)
      VALUES (NEW.id, NEW.email, v_candidate);
      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        IF EXISTS (
          SELECT 1
          FROM public.user_profiles AS profile
          WHERE profile.id = NEW.id
        ) THEN
          RETURN NEW;
        END IF;

        v_attempt := v_attempt + 1;
        IF v_attempt > 128 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23505',
            MESSAGE = 'unable to allocate unique profile handle';
        END IF;
        v_candidate := pg_catalog.left(v_base, 19)
          || '_'
          || pg_catalog.left(
            pg_catalog.md5(NEW.id::text || ':' || v_attempt::text),
            10
          );
    END;
  END LOOP;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated, service_role;

-- Retire every historical trigger name that still invokes this provisioner;
-- otherwise one auth INSERT could execute the same side effect twice.
DO $replace_auth_profile_triggers$
DECLARE
  v_trigger record;
BEGIN
  FOR v_trigger IN
    SELECT trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.handle_new_user()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  LOOP
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON auth.users',
      v_trigger.tgname
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgname = 'on_auth_user_created'
      AND NOT trigger_row.tgisinternal
  ) THEN
    EXECUTE 'DROP TRIGGER on_auth_user_created ON auth.users';
  END IF;
END
$replace_auth_profile_triggers$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT
ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_handle_attnum smallint;
  v_index pg_catalog.regclass :=
    'public.user_profiles_handle_lower_unique'::pg_catalog.regclass;
  v_signature pg_catalog.regprocedure;
  v_source text;
BEGIN
  SELECT attribute.attnum
  INTO STRICT v_handle_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
    AND attribute.attname = 'handle'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attnotnull;

  IF EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    LEFT JOIN public.user_profiles AS profile ON profile.id = auth_user.id
    WHERE profile.id IS NULL
  ) THEN
    RAISE EXCEPTION 'auth identity is missing its canonical profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.handle IS NULL
      OR profile.handle <> pg_catalog.btrim(profile.handle)
      OR pg_catalog.char_length(profile.handle) NOT BETWEEN 1 AND 30
      OR profile.handle IS NOT NFC NORMALIZED
      OR profile.handle !~ '^[A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]+$'
      OR profile.handle !~ '[A-Za-z0-9一-龯ぁ-ゟ゠-ヿ가-힣]'
  ) OR EXISTS (
    SELECT pg_catalog.lower(profile.handle)
    FROM public.user_profiles AS profile
    GROUP BY pg_catalog.lower(profile.handle)
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'persisted profile handles violate the canonical contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid = v_index
      AND index_row.indrelid = 'public.user_profiles'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indpred IS NULL
      AND pg_catalog.pg_get_expr(
        index_row.indexprs,
        index_row.indrelid
      ) = 'lower(handle)'
  ) THEN
    RAISE EXCEPTION 'case-insensitive profile handle index is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_profiles'::pg_catalog.regclass
      AND constraint_row.conname = 'user_profiles_handle_shape_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_row.oid),
        'IS NFC NORMALIZED'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_row.oid),
        'char_length(handle)'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'profile handle shape constraint is incompatible';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.enforce_user_profile_handle_contract()'::pg_catalog.regprocedure,
    'public.handle_new_user()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prokind = 'f'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[];

    IF pg_catalog.has_function_privilege(
      'anon', v_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role', v_signature, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'profile handle function remains executable: %',
        v_signature;
    END IF;

    IF v_signature =
      'public.enforce_user_profile_handle_contract()'::pg_catalog.regprocedure
      AND (
        pg_catalog.strpos(v_source, 'v_handle_changed') = 0
        OR pg_catalog.strpos(v_source, 'reserved profile handle') = 0
        OR pg_catalog.strpos(v_source, 'IS NOT NFC NORMALIZED') = 0
      )
    THEN
      RAISE EXCEPTION 'profile handle validator source drifted';
    ELSIF v_signature =
      'public.handle_new_user()'::pg_catalog.regprocedure
      AND (
        pg_catalog.strpos(v_source, 'NEW.raw_user_meta_data') = 0
        OR pg_catalog.strpos(v_source, 'unique_violation') = 0
        OR pg_catalog.strpos(v_source, 'public.user_profiles') = 0
      )
    THEN
      RAISE EXCEPTION 'auth profile provisioner source drifted';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_user_profiles_05_handle_contract'
      AND trigger_row.tgfoid =
        'public.enforce_user_profile_handle_contract()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND trigger_row.tgattr::text = v_handle_attnum::text
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_user_profiles_05_handle_contract'
      AND NOT trigger_row.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'profile handle trigger is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgname = 'on_auth_user_created'
      AND trigger_row.tgfoid =
        'public.handle_new_user()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 5
      AND trigger_row.tgattr = ''::pg_catalog.int2vector
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.handle_new_user()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'auth profile provisioning trigger is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'handle_new_user',
        'enforce_user_profile_handle_contract'
      )
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'unexpected profile handle function overload remains';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
