-- Make a verified SIWE wallet a single canonical identity at the database
-- boundary. Ambiguous historical ownership is cleared, never guessed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $required_objects$
DECLARE
  v_role text;
  v_profile pg_catalog.regclass := pg_catalog.to_regclass(
    'public.user_profiles'
  );
  v_index pg_catalog.regclass;
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
      RAISE EXCEPTION 'required wallet-authority role is missing: %', v_role;
    END IF;
  END LOOP;

  IF v_profile IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_profile
      AND relation.relkind IN ('r', 'p')
      AND relation.relowner = (
        SELECT role_row.oid
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = 'postgres'
      )
  ) THEN
    RAISE EXCEPTION 'public.user_profiles must be an ordinary postgres-owned table';
  END IF;

  FOREACH v_index IN ARRAY ARRAY[
    pg_catalog.to_regclass('public.idx_user_profiles_wallet_address'),
    pg_catalog.to_regclass(
      'public.user_profiles_wallet_address_lower_unique'
    )
  ]::pg_catalog.regclass[]
  LOOP
    IF v_index IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indexrelid = v_index
        AND index_row.indrelid = v_profile
    ) THEN
      RAISE EXCEPTION 'wallet index name belongs to another relation: %',
        v_index;
    END IF;
  END LOOP;
END
$required_objects$;

LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_index pg_catalog.regclass;
  v_index_name text;
  v_expected_key text;
  v_shape_constraint record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype),
        ('wallet_address', 'text'::pg_catalog.regtype)
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
  ) THEN
    RAISE EXCEPTION 'public.user_profiles wallet columns are incompatible';
  END IF;

  -- A familiar object name is not authority to destroy an unfamiliar
  -- definition. Only the two exact historical/canonical wallet indexes may
  -- be replaced; same-table name collisions fail before any DDL or data
  -- repair.
  FOR v_index_name, v_expected_key IN
    SELECT candidate.index_name, candidate.expected_key
    FROM (
      VALUES
        ('idx_user_profiles_wallet_address', 'wallet_address'),
        (
          'user_profiles_wallet_address_lower_unique',
          'lower(wallet_address)'
        )
    ) AS candidate(index_name, expected_key)
  LOOP
    v_index := pg_catalog.to_regclass('public.' || v_index_name);
    IF v_index IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indexrelid = v_index
        AND index_row.indrelid =
          'public.user_profiles'::pg_catalog.regclass
        AND access_method.amname = 'btree'
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indislive
        AND index_row.indimmediate
        AND NOT index_row.indisclustered
        AND NOT index_row.indisreplident
        AND index_row.indnkeyatts = 1
        AND index_row.indnatts = 1
        AND pg_catalog.pg_get_indexdef(
          index_row.indexrelid,
          1,
          true
        ) = v_expected_key
        AND pg_catalog.pg_get_expr(
          index_row.indpred,
          index_row.indrelid
        ) = '(wallet_address IS NOT NULL)'
    ) THEN
      RAISE EXCEPTION
        'wallet index definition is incompatible and was preserved: %',
        v_index_name;
    END IF;
  END LOOP;

  SELECT
    constraint_row.contype,
    constraint_row.convalidated,
    constraint_row.connoinherit,
    pg_catalog.pg_get_expr(
      constraint_row.conbin,
      constraint_row.conrelid
    ) AS expression
  INTO v_shape_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'public.user_profiles'::pg_catalog.regclass
    AND constraint_row.conname =
      'user_profiles_wallet_address_shape_check';

  IF FOUND AND NOT (
    v_shape_constraint.contype = 'c'
    AND v_shape_constraint.convalidated
    AND NOT v_shape_constraint.connoinherit
    AND v_shape_constraint.expression =
      '((wallet_address IS NULL) OR ((wallet_address = lower(wallet_address)) AND (wallet_address ~ ''^0x[0-9a-f]{40}$''::text)))'
  ) THEN
    RAISE EXCEPTION
      'wallet shape constraint is incompatible and was preserved';
  END IF;
END
$preflight$;

-- Remove replayed or legacy enforcement before repairing historical rows.
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_wallet_address_shape_check;

DO $drop_wallet_indexes$
DECLARE
  v_index_name text;
  v_index pg_catalog.regclass;
  v_constraint record;
BEGIN
  FOREACH v_index_name IN ARRAY ARRAY[
    'idx_user_profiles_wallet_address',
    'user_profiles_wallet_address_lower_unique'
  ]::text[]
  LOOP
    v_index := pg_catalog.to_regclass('public.' || v_index_name);
    IF v_index IS NULL THEN
      CONTINUE;
    END IF;

    SELECT constraint_row.conname
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_profiles'::pg_catalog.regclass
      AND constraint_row.conindid = v_index;

    IF FOUND THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.user_profiles DROP CONSTRAINT %I',
        v_constraint.conname
      );
    ELSE
      EXECUTE pg_catalog.format('DROP INDEX public.%I', v_index_name);
    END IF;
  END LOOP;
END
$drop_wallet_indexes$;

DROP TABLE IF EXISTS pg_temp.user_profile_wallet_conflicts;
CREATE TEMPORARY TABLE pg_temp.user_profile_wallet_conflicts (
  canonical_wallet text PRIMARY KEY
) ON COMMIT DROP;

-- Existing checksum-case variants are valid inputs, but multiple rows with
-- the same lowercase address have ambiguous ownership. Clear every row in an
-- ambiguous group so a future signed SIWE proof, not migration ordering,
-- decides ownership.
INSERT INTO pg_temp.user_profile_wallet_conflicts (canonical_wallet)
SELECT pg_catalog.lower(profile.wallet_address)
FROM public.user_profiles AS profile
WHERE profile.wallet_address IS NOT NULL
  AND profile.wallet_address ~ '^0x[0-9A-Fa-f]{40}$'
GROUP BY pg_catalog.lower(profile.wallet_address)
HAVING pg_catalog.count(*) > 1;

DO $repair_wallet_addresses$
DECLARE
  v_unlinked bigint;
  v_canonicalized bigint;
BEGIN
  UPDATE public.user_profiles AS profile
  SET wallet_address = NULL
  WHERE profile.wallet_address IS NOT NULL
    AND (
      profile.wallet_address !~ '^0x[0-9A-Fa-f]{40}$'
      OR EXISTS (
        SELECT 1
        FROM pg_temp.user_profile_wallet_conflicts AS conflict
        WHERE conflict.canonical_wallet =
          pg_catalog.lower(profile.wallet_address)
      )
    );
  GET DIAGNOSTICS v_unlinked = ROW_COUNT;

  UPDATE public.user_profiles AS profile
  SET wallet_address = pg_catalog.lower(profile.wallet_address)
  WHERE profile.wallet_address IS NOT NULL
    AND profile.wallet_address IS DISTINCT FROM
      pg_catalog.lower(profile.wallet_address);
  GET DIAGNOSTICS v_canonicalized = ROW_COUNT;

  RAISE NOTICE
    'wallet authority repair: % ambiguous/invalid rows unlinked, % singleton rows canonicalized',
    v_unlinked,
    v_canonicalized;
END
$repair_wallet_addresses$;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_wallet_address_shape_check
  CHECK (
    wallet_address IS NULL
    OR (
      wallet_address = pg_catalog.lower(wallet_address)
      AND wallet_address ~ '^0x[0-9a-f]{40}$'
    )
  ) NOT VALID;
ALTER TABLE public.user_profiles
  VALIDATE CONSTRAINT user_profiles_wallet_address_shape_check;

CREATE UNIQUE INDEX user_profiles_wallet_address_lower_unique
  ON public.user_profiles (pg_catalog.lower(wallet_address))
  WHERE wallet_address IS NOT NULL;

-- Browser JWTs cannot bind identity columns directly. Revoking table-level
-- privileges is necessary because they override column revokes; the safe
-- profile UPDATE columns granted by the profile-authority migration remain.
REVOKE INSERT, UPDATE ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (wallet_address), UPDATE (wallet_address)
  ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;

-- REVOKE UPDATE ON TABLE also clears authenticated's explicit column grants.
-- Restore the exact self-service surface established by 178000; wallet and
-- every other identity/authority column remain server-owned.
GRANT UPDATE (
  handle,
  bio,
  avatar_url,
  cover_url,
  market_pairs,
  notify_follow,
  notify_like,
  notify_comment,
  notify_mention,
  notify_message,
  notify_trader_events,
  show_followers,
  show_following,
  dm_permission,
  email_digest,
  settings_version,
  show_pro_badge,
  last_seen_at,
  is_online,
  interests,
  onboarding_completed,
  search_history
) ON TABLE public.user_profiles TO authenticated;

GRANT SELECT (wallet_address), UPDATE (wallet_address)
  ON TABLE public.user_profiles
  TO service_role;

DO $postflight$
DECLARE
  v_anon oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_index pg_catalog.regclass :=
    'public.user_profiles_wallet_address_lower_unique'::pg_catalog.regclass;
  v_safe_column text;
  v_safe_columns constant text[] := ARRAY[
    'handle',
    'bio',
    'avatar_url',
    'cover_url',
    'market_pairs',
    'notify_follow',
    'notify_like',
    'notify_comment',
    'notify_mention',
    'notify_message',
    'notify_trader_events',
    'show_followers',
    'show_following',
    'dm_permission',
    'email_digest',
    'settings_version',
    'show_pro_badge',
    'last_seen_at',
    'is_online',
    'interests',
    'onboarding_completed',
    'search_history'
  ]::text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.wallet_address IS NOT NULL
      AND (
        profile.wallet_address <> pg_catalog.lower(profile.wallet_address)
        OR profile.wallet_address !~ '^0x[0-9a-f]{40}$'
      )
  ) OR EXISTS (
    SELECT pg_catalog.lower(profile.wallet_address)
    FROM public.user_profiles AS profile
    WHERE profile.wallet_address IS NOT NULL
    GROUP BY pg_catalog.lower(profile.wallet_address)
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'persisted wallet identities violate the canonical contract';
  END IF;

  IF pg_catalog.to_regclass('public.idx_user_profiles_wallet_address')
    IS NOT NULL
  THEN
    RAISE EXCEPTION 'legacy case-sensitive wallet index remains';
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
      AND pg_catalog.pg_get_expr(
        index_row.indexprs,
        index_row.indrelid
      ) = 'lower(wallet_address)'
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) = '(wallet_address IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'case-insensitive wallet identity index is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_profiles'::pg_catalog.regclass
      AND constraint_row.conname =
        'user_profiles_wallet_address_shape_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_row.oid),
        'lower(wallet_address)'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_row.oid),
        '^0x[0-9a-f]{40}$'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'wallet identity shape constraint is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (
          SELECT relation.relacl
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
        ),
        pg_catalog.acldefault(
          'r',
          (
            SELECT relation.relowner
            FROM pg_catalog.pg_class AS relation
            WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
          )
        )
      )
    ) AS privilege
    WHERE privilege.grantee IN (0, v_anon, v_authenticated)
      AND privilege.privilege_type IN ('INSERT', 'UPDATE')
  ) OR pg_catalog.has_column_privilege(
    'anon', 'public.user_profiles', 'wallet_address', 'INSERT,UPDATE'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'wallet_address',
    'INSERT,UPDATE'
  ) THEN
    RAISE EXCEPTION 'browser role retains wallet mutation authority';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
    'service_role',
    'public.user_profiles',
    'wallet_address',
    'SELECT,UPDATE'
  ) THEN
    RAISE EXCEPTION 'service wallet authority is unavailable';
  END IF;

  FOREACH v_safe_column IN ARRAY v_safe_columns
  LOOP
    IF NOT pg_catalog.has_column_privilege(
      'authenticated',
      'public.user_profiles',
      v_safe_column,
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'safe profile update column was not preserved: %',
        v_safe_column;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
