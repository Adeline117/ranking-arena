-- V1 does not publish trader-alert evaluation, ranking-change delivery, or
-- personalized digest delivery. Preserve legacy owner inventory, deletion,
-- and service-owned export access, but remove every direct browser/PostgREST
-- mutation path that could create, alter, or re-enable that dormant state.
--
-- This is deliberately ACL/RLS-only: it neither deletes historical alerts nor
-- rewrites existing preference values. A future publication must introduce a
-- separately reviewed migration rather than relying on a client-side flag.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public:v1-trader-alert-browser-mutation-quarantine',
    0
  )
);

-- Do not install a partial or misleading boundary on a drifted relation. In
-- particular, a browser role that can assume a relation owner bypasses both
-- ordinary table ACLs and RLS.
DO $required_objects$
DECLARE
  v_relation record;
  v_role name;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_owner name;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['postgres', 'anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'V1 trader-alert browser quarantine roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL OR (
    SELECT routine.prorettype
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = 'auth.uid()'::pg_catalog.regprocedure
  ) <> 'uuid'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'auth.uid() must exist and return uuid';
  END IF;

  FOR v_relation IN
    SELECT
      required_relation.identity,
      pg_catalog.to_regclass(required_relation.identity) AS relation_oid
    FROM (
      VALUES
        ('public.trader_alerts'),
        ('public.alert_history'),
        ('public.user_preferences'),
        ('public.user_profiles')
    ) AS required_relation(identity)
  LOOP
    IF v_relation.relation_oid IS NULL THEN
      RAISE EXCEPTION
        'required V1 trader-alert browser quarantine relation is missing: %',
        v_relation.identity;
    END IF;

    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation.relation_oid;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation.relation_oid
        AND relation.relkind = 'r'
        AND relation.relowner = (
          SELECT role_row.oid
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.rolname = 'postgres'
        )
    ) THEN
      RAISE EXCEPTION
        '% must be an ordinary postgres-owned table before V1 trader-alert browser quarantine',
        v_relation.relation_oid;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      IF pg_catalog.pg_has_role(v_role, v_owner, 'USAGE')
        OR pg_catalog.pg_has_role(v_role, v_owner, 'SET') THEN
        RAISE EXCEPTION
          'browser role % can assume owner % for %, so ACL/RLS would not be authoritative',
          v_role,
          v_owner,
          v_relation.relation_oid;
      END IF;

      IF pg_catalog.pg_has_role(v_role, 'service_role', 'USAGE')
        OR pg_catalog.pg_has_role(v_role, 'service_role', 'SET') THEN
        RAISE EXCEPTION
          'browser role % can assume service_role, so V1 server-gated mutation authority would be bypassed',
          v_role;
      END IF;
    END LOOP;
  END LOOP;

  SELECT pg_catalog.array_agg(
    pg_catalog.format('%s.%I (expected %s)',
      required_column.relation_oid,
      required_column.column_name,
      required_column.type_oid::text
    )
    ORDER BY required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'public.trader_alerts'::pg_catalog.regclass, 'id'::name, 'uuid'::pg_catalog.regtype),
      (2, 'public.trader_alerts'::pg_catalog.regclass, 'user_id'::name, 'uuid'::pg_catalog.regtype),
      (3, 'public.trader_alerts'::pg_catalog.regclass, 'enabled'::name, 'boolean'::pg_catalog.regtype),
      (4, 'public.alert_history'::pg_catalog.regclass, 'id'::name, 'uuid'::pg_catalog.regtype),
      (5, 'public.alert_history'::pg_catalog.regclass, 'alert_id'::name, 'uuid'::pg_catalog.regtype),
      (6, 'public.alert_history'::pg_catalog.regclass, 'user_id'::name, 'uuid'::pg_catalog.regtype),
      (7, 'public.user_preferences'::pg_catalog.regclass, 'user_id'::name, 'uuid'::pg_catalog.regtype),
      (8, 'public.user_preferences'::pg_catalog.regclass, 'watched_traders'::name, 'jsonb'::pg_catalog.regtype),
      (9, 'public.user_preferences'::pg_catalog.regclass, 'email_notifications'::name, 'boolean'::pg_catalog.regtype),
      (10, 'public.user_preferences'::pg_catalog.regclass, 'push_notifications'::name, 'boolean'::pg_catalog.regtype),
      (11, 'public.user_preferences'::pg_catalog.regclass, 'ranking_change_threshold'::name, 'integer'::pg_catalog.regtype),
      (12, 'public.user_profiles'::pg_catalog.regclass, 'id'::name, 'uuid'::pg_catalog.regtype),
      (13, 'public.user_profiles'::pg_catalog.regclass, 'notify_trader_events'::name, 'boolean'::pg_catalog.regtype),
      (14, 'public.user_profiles'::pg_catalog.regclass, 'email_digest'::name, 'text'::pg_catalog.regtype)
  ) AS required_column(ordinality, relation_oid, column_name, type_oid)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = required_column.relation_oid
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid;

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'V1 trader-alert browser quarantine requires compatible columns: %',
      v_invalid_columns;
  END IF;
END
$required_objects$;

LOCK TABLE
  public.trader_alerts,
  public.alert_history,
  public.user_preferences,
  public.user_profiles
IN ACCESS EXCLUSIVE MODE;

-- RLS must be present even where table grants happen to be stricter today:
-- grants and policies are additive over time, and either layer alone is easy
-- to accidentally broaden in a later migration.
ALTER TABLE public.trader_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- Drop every historical policy on the three fully retired browser-write
-- tables. Replaying this migration intentionally converges unknown old policy
-- names instead of leaving an additive FOR ALL/INSERT policy behind.
DO $replace_retired_notification_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polrelid::pg_catalog.regclass AS relation_oid, policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = ANY (
      ARRAY[
        'public.trader_alerts'::pg_catalog.regclass,
        'public.alert_history'::pg_catalog.regclass,
        'public.user_preferences'::pg_catalog.regclass
      ]
    )
    ORDER BY policy.polrelid, policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON %s',
      v_policy.polname,
      v_policy.relation_oid
    );
  END LOOP;
END
$replace_retired_notification_policies$;

-- Revoke both table-level and column-level grants. A table-level UPDATE or
-- INSERT grant overrides a narrow column revoke, while an old column grant can
-- survive a table-level REVOKE; both forms must be removed for browser roles.
DO $revoke_browser_notification_table_and_column_grants$
DECLARE
  v_relation pg_catalog.regclass;
  v_columns text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_alerts'::pg_catalog.regclass,
    'public.alert_history'::pg_catalog.regclass,
    'public.user_preferences'::pg_catalog.regclass
  ]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC, anon, authenticated',
      v_relation
    );
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE %2$s FROM PUBLIC, anon, authenticated',
      v_columns,
      v_relation
    );
  END LOOP;
END
$revoke_browser_notification_table_and_column_grants$;

-- Keep ordinary profile editing available, but remove every direct browser
-- INSERT/UPDATE grant on the two notification columns. The authenticated API
-- route uses its checked service client, so opt-out writes remain server-gated
-- rather than being available as raw PostgREST column mutations.
REVOKE INSERT, UPDATE ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (notify_trader_events, email_digest),
  UPDATE (notify_trader_events, email_digest),
  REFERENCES (notify_trader_events, email_digest)
  ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;

-- PostgreSQL's table-level UPDATE revoke also clears overlapping per-column
-- grants. Restore the established non-notification self-service surface
-- explicitly, intentionally omitting notify_trader_events and email_digest.
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
  show_followers,
  show_following,
  dm_permission,
  settings_version,
  show_pro_badge,
  last_seen_at,
  is_online,
  interests,
  onboarding_completed,
  search_history
) ON TABLE public.user_profiles TO authenticated;

-- Explicit service grants make the retained owner-scoped cleanup/export and
-- server-gated preference path independent of historical default grants.
GRANT SELECT, DELETE ON TABLE public.trader_alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trader_alerts TO service_role;

GRANT SELECT ON TABLE public.alert_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.alert_history TO service_role;

GRANT SELECT ON TABLE public.user_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_preferences TO service_role;

GRANT INSERT (notify_trader_events, email_digest),
  UPDATE (notify_trader_events, email_digest)
  ON TABLE public.user_profiles
  TO service_role;

CREATE POLICY trader_alerts_v1_legacy_owner_select
  ON public.trader_alerts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY trader_alerts_v1_legacy_owner_delete
  ON public.trader_alerts
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY trader_alerts_v1_service_mutation
  ON public.trader_alerts
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY alert_history_v1_legacy_owner_select
  ON public.alert_history
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY alert_history_v1_service_mutation
  ON public.alert_history
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- The exact user_preferences schema has no independent ranking subscription
-- table: watched_traders, delivery channels, and ranking threshold comprise
-- the legacy subscription state. It is therefore browser read-only as one
-- unit during V1 verification.
CREATE POLICY user_preferences_v1_legacy_owner_select
  ON public.user_preferences
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY user_preferences_v1_service_mutation
  ON public.user_preferences
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
DECLARE
  v_relation pg_catalog.regclass;
  v_role name;
  v_column name;
  v_privilege text;
  v_unexpected_policies name[];
  v_expected_policy_count integer;
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_alerts'::pg_catalog.regclass,
    'public.alert_history'::pg_catalog.regclass,
    'public.user_preferences'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS is disabled after V1 browser quarantine on %', v_relation;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES']::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_relation,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              'browser role % retains % column authority on %.%',
              v_role,
              v_privilege,
              v_relation,
              v_column;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'SELECT, INSERT, UPDATE, DELETE'
    ) THEN
      RAISE EXCEPTION 'service role lost retained V1 legacy authority on %', v_relation;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.trader_alerts',
    'SELECT, DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.trader_alerts',
    'INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER'
  ) THEN
    RAISE EXCEPTION 'trader_alerts browser ACL did not converge to legacy read/delete only';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.alert_history'::pg_catalog.regclass,
    'public.user_preferences'::pg_catalog.regclass
  ]
  LOOP
    IF NOT pg_catalog.has_table_privilege('authenticated', v_relation, 'SELECT')
      OR pg_catalog.has_table_privilege(
        'authenticated',
        v_relation,
        'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      ) THEN
      RAISE EXCEPTION 'browser ACL did not converge to legacy read-only on %', v_relation;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_alerts'::pg_catalog.regclass,
    'public.alert_history'::pg_catalog.regclass,
    'public.user_preferences'::pg_catalog.regclass
  ]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege('anon', v_relation, v_privilege) THEN
        RAISE EXCEPTION 'anon retains % authority on %', v_privilege, v_relation;
      END IF;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_profiles',
    'INSERT, UPDATE'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'notify_trader_events',
    'INSERT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'notify_trader_events',
    'UPDATE'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'email_digest',
    'INSERT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'email_digest',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'browser role retains V1 trader notification profile mutation authority';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
    'service_role',
    'public.user_profiles',
    'notify_trader_events',
    'UPDATE'
  ) OR NOT pg_catalog.has_column_privilege(
    'service_role',
    'public.user_profiles',
    'email_digest',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'service role lost server-gated notification preference authority';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
    'authenticated',
    'public.user_profiles',
    'handle',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'safe profile update authority was not preserved';
  END IF;

  SELECT pg_catalog.array_agg(policy.polname ORDER BY policy.polname)
  INTO v_unexpected_policies
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.trader_alerts'::pg_catalog.regclass
    AND policy.polname <> ALL (
      ARRAY[
        'trader_alerts_v1_legacy_owner_select',
        'trader_alerts_v1_legacy_owner_delete',
        'trader_alerts_v1_service_mutation'
      ]::name[]
    );
  IF v_unexpected_policies IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected trader_alerts policies remain after V1 quarantine: %', v_unexpected_policies;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_expected_policy_count
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.trader_alerts'::pg_catalog.regclass
    AND (
      (policy.polname = 'trader_alerts_v1_legacy_owner_select'
        AND policy.polcmd = 'r'
        AND policy.polroles = ARRAY[v_authenticated_oid])
      OR (policy.polname = 'trader_alerts_v1_legacy_owner_delete'
        AND policy.polcmd = 'd'
        AND policy.polroles = ARRAY[v_authenticated_oid])
      OR (policy.polname = 'trader_alerts_v1_service_mutation'
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid])
    );
  IF v_expected_policy_count <> 3 THEN
    RAISE EXCEPTION 'trader_alerts V1 policy set did not converge';
  END IF;

  SELECT pg_catalog.array_agg(policy.polname ORDER BY policy.polname)
  INTO v_unexpected_policies
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.alert_history'::pg_catalog.regclass
    AND policy.polname <> ALL (
      ARRAY[
        'alert_history_v1_legacy_owner_select',
        'alert_history_v1_service_mutation'
      ]::name[]
    );
  IF v_unexpected_policies IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected alert_history policies remain after V1 quarantine: %', v_unexpected_policies;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_expected_policy_count
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.alert_history'::pg_catalog.regclass
    AND (
      (policy.polname = 'alert_history_v1_legacy_owner_select'
        AND policy.polcmd = 'r'
        AND policy.polroles = ARRAY[v_authenticated_oid])
      OR (policy.polname = 'alert_history_v1_service_mutation'
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid])
    );
  IF v_expected_policy_count <> 2 THEN
    RAISE EXCEPTION 'alert_history V1 policy set did not converge';
  END IF;

  SELECT pg_catalog.array_agg(policy.polname ORDER BY policy.polname)
  INTO v_unexpected_policies
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.user_preferences'::pg_catalog.regclass
    AND policy.polname <> ALL (
      ARRAY[
        'user_preferences_v1_legacy_owner_select',
        'user_preferences_v1_service_mutation'
      ]::name[]
    );
  IF v_unexpected_policies IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected user_preferences policies remain after V1 quarantine: %', v_unexpected_policies;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_expected_policy_count
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.user_preferences'::pg_catalog.regclass
    AND (
      (policy.polname = 'user_preferences_v1_legacy_owner_select'
        AND policy.polcmd = 'r'
        AND policy.polroles = ARRAY[v_authenticated_oid])
      OR (policy.polname = 'user_preferences_v1_service_mutation'
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid])
    );
  IF v_expected_policy_count <> 2 THEN
    RAISE EXCEPTION 'user_preferences V1 policy set did not converge';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
