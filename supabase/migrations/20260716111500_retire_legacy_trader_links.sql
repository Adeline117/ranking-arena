-- `trader_links` is a retired identity source. Keep service-only reads for the
-- short compatibility fallback, but make every write path impossible. The
-- canonical identity boundary is `trader_claims` -> activate_trader_claim ->
-- `user_linked_traders`.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_links') IS NULL THEN
    RAISE EXCEPTION 'public.trader_links must exist before retiring its ACL';
  END IF;
END
$preflight$;

ALTER TABLE public.trader_links ENABLE ROW LEVEL SECURITY;

-- Database history contains three named browser policies, but production
-- drift must not leave an unknown policy behind. Replace the complete policy
-- set so replay converges on one service read contract.
DO $replace_policies$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_links'::regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.trader_links',
      policy_row.polname
    );
  END LOOP;
END
$replace_policies$;

-- Table-level revokes do not necessarily remove independently granted column
-- privileges. Revoke both layers from every API role before restoring the one
-- capability this retired fallback still needs.
REVOKE ALL PRIVILEGES ON TABLE public.trader_links
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_privileges$
DECLARE
  column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.trader_links'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF column_list IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.trader_links FROM PUBLIC, anon, authenticated, service_role',
      column_list
    );
  END IF;
END
$revoke_column_privileges$;

GRANT SELECT ON TABLE public.trader_links TO service_role;

CREATE POLICY legacy_trader_links_service_read
  ON public.trader_links
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

DO $postflight$
DECLARE
  service_oid oid := (
    SELECT role.oid
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'service_role'
  );
BEGIN
  IF pg_catalog.has_table_privilege(
       'anon',
       'public.trader_links',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.trader_links',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       'anon',
       'public.trader_links',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated',
       'public.trader_links',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'browser privilege remains on retired public.trader_links';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.trader_links',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'public.trader_links',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       'service_role',
       'public.trader_links',
       'INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'service read-only ACL is incomplete on public.trader_links';
  END IF;

  IF service_oid IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_links'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_links'::regclass
      AND policy.polname = 'legacy_trader_links_service_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[service_oid]
  ) THEN
    RAISE EXCEPTION 'retired public.trader_links policy boundary is incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
