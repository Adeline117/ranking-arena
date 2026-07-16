-- Keep collection discovery readable while making every collection mutation
-- server-owned.  The API already authenticates the actor and uses the service
-- client; browser JWTs must not be able to bypass those checks with PostgREST.

BEGIN;

DO $required_relations$
BEGIN
  IF pg_catalog.to_regclass('public.user_collections') IS NULL
    OR pg_catalog.to_regclass('public.collection_items') IS NULL
  THEN
    RAISE EXCEPTION 'collection tables must exist before installing their boundary';
  END IF;
END
$required_relations$;

ALTER TABLE public.user_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;

DO $replace_collection_policies$
DECLARE
  relation_name text;
  policy_row record;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'user_collections',
    'collection_items'
  ]::text[]
  LOOP
    FOR policy_row IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = pg_catalog.to_regclass('public.' || relation_name)
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        policy_row.polname,
        relation_name
      );
    END LOOP;
  END LOOP;
END
$replace_collection_policies$;

DO $revoke_collection_client_writes$
DECLARE
  relation_name text;
  column_list text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'user_collections',
    'collection_items'
  ]::text[]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON public.%I FROM PUBLIC, anon, authenticated',
      relation_name
    );

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass('public.' || relation_name)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF column_list IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON public.%2$I FROM PUBLIC, anon, authenticated',
        column_list,
        relation_name
      );
    END IF;
  END LOOP;
END
$revoke_collection_client_writes$;

GRANT SELECT ON public.user_collections TO anon, authenticated;
GRANT SELECT ON public.collection_items TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_collections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_items TO service_role;

CREATE POLICY user_collections_public_or_owner_read
  ON public.user_collections
  FOR SELECT
  TO anon, authenticated
  USING (
    COALESCE(is_public, false)
    OR user_id = (SELECT auth.uid())
  );

CREATE POLICY collection_items_public_or_owner_read
  ON public.collection_items
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_collections AS collection
      WHERE collection.id = collection_items.collection_id
        AND (
          COALESCE(collection.is_public, false)
          OR collection.user_id = (SELECT auth.uid())
        )
    )
  );

CREATE POLICY server_role_mutation
  ON public.user_collections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY server_role_mutation
  ON public.collection_items
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
DECLARE
  relation_name text;
  unsafe_role_oids oid[] := ARRAY[
    0::oid,
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
  ];
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'user_collections',
    'collection_items'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'anon',
      'public.' || relation_name,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.' || relation_name,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_any_column_privilege(
      'anon',
      'public.' || relation_name,
      'INSERT,UPDATE,REFERENCES'
    ) OR pg_catalog.has_any_column_privilege(
      'authenticated',
      'public.' || relation_name,
      'INSERT,UPDATE,REFERENCES'
    ) THEN
      RAISE EXCEPTION 'collection JWT write privilege remains on public.%', relation_name;
    END IF;

    IF NOT pg_catalog.has_table_privilege(
      'anon',
      'public.' || relation_name,
      'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      'public.' || relation_name,
      'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      'service_role',
      'public.' || relation_name,
      'SELECT,INSERT,UPDATE,DELETE'
    ) THEN
      RAISE EXCEPTION 'collection table ACL is incomplete on public.%', relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = pg_catalog.to_regclass('public.' || relation_name)
        AND policy.polcmd IN ('*', 'a', 'w', 'd')
        AND policy.polroles && unsafe_role_oids
    ) THEN
      RAISE EXCEPTION 'collection JWT mutation policy remains on public.%', relation_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_collections'::regclass
      AND policy.polname = 'user_collections_public_or_owner_read'
      AND policy.polcmd = 'r'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.collection_items'::regclass
      AND policy.polname = 'collection_items_public_or_owner_read'
      AND policy.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'collection read boundary is incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
