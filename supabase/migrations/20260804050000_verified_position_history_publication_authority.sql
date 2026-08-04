-- Verified, immutable publication authority for Tier-B position history.
--
-- FORWARD REOPEN DEPLOY ORDER: the preceding retirement/quarantine migrations
-- have already made the legacy @1 writer, typed rows, direct table reads, and
-- public history projection fail closed. This migration installs the reviewed
-- parser-conservation @2 authority as the only path that can reopen public
-- position history. Legacy rows remain quarantined and are never promoted.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804050000-verified-position-history-authority-v1',
    0
  )
);

DO $preflight$
DECLARE
  v_expected_sources constant jsonb :=
    '[
      {"slug":"binance_futures","adapter":"binance","currency":"USDT"},
      {"slug":"bitget_futures","adapter":"bitget","currency":"USDT"},
      {"slug":"okx_futures","adapter":"okx","currency":"USDT"}
    ]'::jsonb;
  v_source jsonb;
  v_expected record;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.record_surface_publications') IS NULL
     OR pg_catalog.to_regclass(
       'arena.position_history_raw_admissions'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.position_history') IS NULL
     OR pg_catalog.to_regclass('arena.positions_current') IS NULL
     OR pg_catalog.to_regclass('arena.order_records') IS NULL
     OR pg_catalog.to_regclass('arena.transfer_history') IS NULL
     OR pg_catalog.to_regclass('arena.mv_source_capabilities') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_records_page(text,text,text,integer,text,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure('public.arena_source_capabilities()') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL
     OR pg_catalog.to_regprocedure('extensions.hmac(bytea,bytea,text)') IS NULL
     OR pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
     OR pg_catalog.to_regprocedure('arena.jnum(text)') IS NULL
     OR pg_catalog.to_regprocedure('arena.jmargin_mode(jsonb)') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_is_eligible(text,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_meta_sha256(jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_snapshot_sha256(bigint,smallint,text,bigint,smallint,timestamp with time zone,text,integer,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.admit_position_history_raw()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.require_position_history_raw_admission_context()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_position_history_raw_evidence()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_position_history_raw_truncate()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_position_history_raw_admission_mutation()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_position_history_registry_identity()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.get_position_history_publication_checkpoint(smallint,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_verified_position_history_row()'
     ) IS NULL THEN
    RAISE EXCEPTION
      'verified position-history authority requires PG17, the Arena serving/RAW foundations, and all API roles';
  END IF;

  IF pg_catalog.to_regclass('arena.position_history_source_contracts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_publish_guards') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_acquisitions') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_publications') IS NOT NULL
     OR pg_catalog.to_regclass('arena.verified_position_history_facts') IS NOT NULL
     OR pg_catalog.to_regclass(
       'arena.position_history_publication_bindings'
     ) IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_states') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_state_memberships') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_publication_memberships') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.publish_verified_position_history(bigint,text,bigint,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'verified position-history authority is already or partially installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace IN (
      'public'::pg_catalog.regnamespace,
      'arena'::pg_catalog.regnamespace
    )
      AND function_row.proname IN (
        'arena_records_page',
        'arena_source_capabilities',
        'publish_verified_position_history'
      )
      AND function_row.oid NOT IN (
        'public.arena_records_page(text,text,text,integer,text,integer)'::pg_catalog.regprocedure,
        'public.arena_source_capabilities()'::pg_catalog.regprocedure,
        'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'record, capability, or publisher overload drift prevents cutover';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'public.arena_records_page(text,text,text,integer,text,integer)'::pg_catalog.regprocedure
      AND function_row.prosecdef
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND pg_catalog.strpos(
        function_row.prosrc,
        'history_evidence_not_bound'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'arena.position_history'
      ) = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'public.arena_source_capabilities()'::pg_catalog.regprocedure
      AND function_row.prosecdef
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'record or capability RPC owner/security contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'arena.position_history'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND table_row.relrowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'arena.position_history'::pg_catalog.regclass
      AND policy_row.polname = 'Public read position_history'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'arena.position_history', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'arena.position_history', 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = 'arena.position_history'::pg_catalog.regclass
      AND attribute_row.attname = 'verified_publication_id'
      AND attribute_row.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      AND NOT attribute_row.attnotnull
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargdefaults = 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'legacy position-history publisher is retired; parser-conservation receipt required'
      ) > 0
      AND pg_catalog.strpos(function_row.prosrc, 'arena.raw_objects') = 0
      AND pg_catalog.strpos(function_row.prosrc, 'arena.position_history') = 0
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
    'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.position_history'::pg_catalog.regclass
      AND trigger_row.tgname = 'protect_verified_position_history_before_write'
      AND trigger_row.tgfoid =
        'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 31
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.position_history'::pg_catalog.regclass
      AND trigger_row.tgname = 'protect_verified_position_history_before_truncate'
      AND trigger_row.tgfoid =
        'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 34
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'retired position-history writer/read/typed-row quarantine drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.sources'::pg_catalog.regclass
      AND attname = 'adapter_slug'
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'source registry adapter contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND table_row.relrowsecurity
      AND table_row.relforcerowsecurity
  ) OR pg_catalog.has_table_privilege(
       'anon', 'arena.position_history_raw_admissions', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history_raw_admissions', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history_raw_admissions', 'SELECT'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid =
         'arena.position_history_raw_admissions'::pg_catalog.regclass
     ) <> 3 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid =
           'arena.position_history_raw_admissions'::pg_catalog.regclass
         AND policy_row.polname =
           'owner_position_history_raw_admission_read'
         AND policy_row.polcmd = 'r'
         AND policy_row.polpermissive
         AND policy_row.polroles =
           ARRAY['postgres'::pg_catalog.regrole]::oid[]
         AND pg_catalog.pg_get_expr(
           policy_row.polqual, policy_row.polrelid, true
         ) = 'true'
         AND policy_row.polwithcheck IS NULL
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid =
           'arena.position_history_raw_admissions'::pg_catalog.regclass
         AND policy_row.polname =
           'owner_position_history_raw_admission_insert'
         AND policy_row.polcmd = 'a'
         AND policy_row.polpermissive
         AND policy_row.polroles =
           ARRAY['postgres'::pg_catalog.regrole]::oid[]
         AND policy_row.polqual IS NULL
         AND pg_catalog.pg_get_expr(
           policy_row.polwithcheck, policy_row.polrelid, true
         ) = 'true'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid =
           'arena.position_history_raw_admissions'::pg_catalog.regclass
         AND policy_row.polname =
           'owner_position_history_raw_admission_lock'
         AND policy_row.polcmd = 'w'
         AND policy_row.polpermissive
         AND policy_row.polroles =
           ARRAY['postgres'::pg_catalog.regrole]::oid[]
         AND pg_catalog.pg_get_expr(
           policy_row.polqual, policy_row.polrelid, true
         ) = 'true'
         AND pg_catalog.pg_get_expr(
           policy_row.polwithcheck, policy_row.polrelid, true
         ) = 'false'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'A'
         AND (
           trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
           AND trigger_row.tgname IN (
             'admit_position_history_raw_after_insert',
             'protect_position_history_raw_evidence_before_write',
             'reject_position_history_raw_truncate'
           )
           OR trigger_row.tgrelid =
             'arena.position_history_raw_admissions'::pg_catalog.regclass
           AND trigger_row.tgname IN (
             'require_position_history_raw_admission_context',
             'reject_position_history_raw_admission_row_mutation',
             'reject_position_history_raw_admission_truncate'
           )
           OR trigger_row.tgrelid = 'arena.sources'::pg_catalog.regclass
           AND trigger_row.tgname IN (
             'protect_position_history_source_identity',
             'reject_position_history_source_truncate'
           )
           OR trigger_row.tgrelid = 'arena.traders'::pg_catalog.regclass
           AND trigger_row.tgname IN (
             'protect_position_history_trader_identity',
             'reject_position_history_trader_truncate'
           )
         )
     ) <> 10 THEN
    RAISE EXCEPTION
      'verified position-history RAW admission prerequisites are absent or drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
      ('arena.raw_objects'::regclass, 'admit_position_history_raw_after_insert',
       'arena.admit_position_history_raw()'::regprocedure, 5::smallint),
      ('arena.raw_objects'::regclass,
       'protect_position_history_raw_evidence_before_write',
       'arena.protect_position_history_raw_evidence()'::regprocedure, 27::smallint),
      ('arena.raw_objects'::regclass, 'reject_position_history_raw_truncate',
       'arena.reject_position_history_raw_truncate()'::regprocedure, 34::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'require_position_history_raw_admission_context',
       'arena.require_position_history_raw_admission_context()'::regprocedure,
       7::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'reject_position_history_raw_admission_row_mutation',
       'arena.reject_position_history_raw_admission_mutation()'::regprocedure,
       27::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'reject_position_history_raw_admission_truncate',
       'arena.reject_position_history_raw_admission_mutation()'::regprocedure,
       34::smallint),
      ('arena.sources'::regclass, 'protect_position_history_source_identity',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       27::smallint),
      ('arena.sources'::regclass, 'reject_position_history_source_truncate',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       34::smallint),
      ('arena.traders'::regclass, 'protect_position_history_trader_identity',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       27::smallint),
      ('arena.traders'::regclass, 'reject_position_history_trader_truncate',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       34::smallint)
    ) AS expected(table_oid, trigger_name, function_oid, trigger_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_expected.table_oid
        AND trigger_row.tgname = v_expected.trigger_name
        AND trigger_row.tgfoid = v_expected.function_oid
        AND trigger_row.tgtype = v_expected.trigger_type
        AND trigger_row.tgenabled = 'A'
        AND NOT trigger_row.tgisinternal
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgattr::text = ''
        AND trigger_row.tgconstraint = 0
    ) THEN
      RAISE EXCEPTION 'position-history prerequisite trigger drifted: %.%',
        v_expected.table_oid, v_expected.trigger_name;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT role_name
    FROM (VALUES ('anon'::text), ('authenticated'::text),
                 ('service_role'::text)) AS api_role(role_name)
  LOOP
    IF pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'INSERT'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'UPDATE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'DELETE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'TRUNCATE'
       ) THEN
      RAISE EXCEPTION
        'position-history prerequisite admission write ACL drifted for %',
        v_expected.role_name;
    END IF;
  END LOOP;

  FOR v_source IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_expected_sources)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM arena.sources AS source_row
      WHERE source_row.slug = v_source->>'slug'
        AND source_row.adapter_slug = v_source->>'adapter'
        AND source_row.currency = v_source->>'currency'
    ) THEN
      RAISE EXCEPTION 'reviewed source/adapter contract is absent or drifted: %', v_source;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM arena.position_history_raw_admissions AS admission
    LEFT JOIN arena.sources AS source_row
      ON source_row.id = admission.source_id
    LEFT JOIN arena.traders AS trader_row
      ON trader_row.id = admission.trader_id
    WHERE source_row.id IS NULL
       OR trader_row.id IS NULL
       OR trader_row.source_id IS DISTINCT FROM admission.source_id
       OR trader_row.exchange_trader_id
            IS DISTINCT FROM admission.exchange_trader_id
       OR source_row.slug IS DISTINCT FROM admission.source_slug
       OR (source_row.slug, source_row.adapter_slug, source_row.currency)
            NOT IN (
              ('binance_futures', 'binance', 'USDT'),
              ('bitget_futures', 'bitget', 'USDT'),
              ('okx_futures', 'okx', 'USDT')
            )
  ) THEN
    RAISE EXCEPTION
      'verified position-history RAW admission registry identity drifted';
  END IF;

END
$preflight$;

CREATE FUNCTION arena.position_history_text_sha256(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')),
    'hex'
  )
$function$;

CREATE FUNCTION arena.position_history_json_has_duplicate_keys(p_value json)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_type text := pg_catalog.json_typeof(p_value);
BEGIN
  IF v_type = 'object' THEN
    IF EXISTS (
      SELECT object_field.key
      FROM pg_catalog.json_each(p_value) AS object_field(key, value)
      GROUP BY object_field.key
      HAVING pg_catalog.count(*) > 1
    ) THEN
      RETURN true;
    END IF;
    RETURN EXISTS (
      SELECT 1
      FROM pg_catalog.json_each(p_value) AS object_field(key, value)
      WHERE arena.position_history_json_has_duplicate_keys(object_field.value)
    );
  ELSIF v_type = 'array' THEN
    RETURN EXISTS (
      SELECT 1
      FROM pg_catalog.json_array_elements(p_value) AS array_item(value)
      WHERE arena.position_history_json_has_duplicate_keys(array_item.value)
    );
  END IF;
  RETURN false;
END
$function$;
CREATE FUNCTION arena.position_history_exact_jsonb_keys(
  p_value jsonb,
  p_expected text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'object'
    AND ARRAY(
      SELECT object_key
      FROM pg_catalog.jsonb_object_keys(p_value) AS object_key
      ORDER BY object_key COLLATE "C"
    ) IS NOT DISTINCT FROM p_expected
$function$;

-- ECMAScript String.prototype.trim uses a fixed WhiteSpace/LineTerminator
-- set, not a database locale. Keep all TS/SQL text boundaries on that exact
-- set (including NBSP, the U+2000 block, and BOM).
CREATE FUNCTION arena.position_history_ecmascript_trim(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.btrim(
    p_value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  )
$function$;

CREATE FUNCTION arena.position_history_text_is_canonical(
  p_value text,
  p_minimum integer,
  p_maximum integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_value IS NULL
     OR p_minimum < 0
     OR p_maximum < p_minimum
     OR pg_catalog.octet_length(p_value) > p_maximum * 4
     OR p_value IS DISTINCT FROM arena.position_history_ecmascript_trim(p_value) THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.char_length(p_value) BETWEEN p_minimum AND p_maximum;
END
$function$;

CREATE FUNCTION arena.position_history_source_identity(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_type text;
  v_numeric numeric;
  v_text text;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  v_type := pg_catalog.jsonb_typeof(p_value);
  IF v_type = 'string' THEN
    v_text := p_value #>> '{}';
    RETURN CASE
      WHEN arena.position_history_text_is_canonical(v_text, 1, 1024)
        THEN v_text
      ELSE NULL
    END;
  ELSIF v_type <> 'number' THEN
    RETURN NULL;
  END IF;
  v_numeric := (p_value #>> '{}')::numeric;
  IF v_numeric <> pg_catalog.trunc(v_numeric)
     OR v_numeric NOT BETWEEN 0 AND 9007199254740991 THEN
    RETURN NULL;
  END IF;
  RETURN v_numeric::bigint::text;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$function$;

CREATE FUNCTION arena.position_history_canonical_timestamp(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_timestamp timestamptz;
BEGIN
  IF p_value !~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RETURN false;
  END IF;
  v_timestamp := p_value::timestamptz;
  RETURN pg_catalog.isfinite(v_timestamp)
    AND pg_catalog.to_char(
      v_timestamp AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) = p_value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

-- Convert only the bounded decimal/exponent subset accepted by the reviewed
-- publication gate.  Source parsers may understand more of JavaScript's
-- Number(value) grammar, but radix-prefixed strings, edge whitespace,
-- negative zero, and non-zero underflow are deliberately not publication
-- values.  Keeping this authority in one helper prevents a publisher from
-- substituting an economically different value while retaining an
-- allowlisted field path.
CREATE FUNCTION arena.position_history_js_number(p_value jsonb)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_type text;
  v_text text;
  v_number double precision;
  v_significand text;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  v_type := pg_catalog.jsonb_typeof(p_value);
  IF v_type NOT IN ('number', 'string') THEN
    RETURN NULL;
  END IF;
  v_text := p_value #>> '{}';
  IF v_type = 'string' THEN
    IF pg_catalog.char_length(v_text) > 128
       OR v_text = ''
       OR v_text IS DISTINCT FROM
          arena.position_history_ecmascript_trim(v_text)
       OR v_text !~
         '^[+-]?((([0-9]+)(\.[0-9]*)?)|(\.[0-9]+))([eE][+-]?[0-9]+)?$' THEN
      RETURN NULL;
    END IF;
  END IF;

  BEGIN
    v_number := v_text::double precision;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF v_number IN (
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ) THEN
    RETURN NULL;
  END IF;
  IF v_type = 'string' AND v_number = 0 THEN
    v_significand := pg_catalog.regexp_replace(
      pg_catalog.split_part(
        pg_catalog.regexp_replace(pg_catalog.lower(v_text), '^[+-]', ''),
        'e',
        1
      ),
      '\.',
      '',
      'g'
    );
    IF v_text ~ '^-' OR v_significand !~ '^0+$' THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN v_number;
END
$function$;

-- Reconstruct the exact binary64 rational, then apply ECMAScript
-- Number::toString's minimum-significand/closest-real/even-tie rules.  PG17's
-- own shortest float output can choose a different spelling from ECMAScript
-- (not merely a different fixed/scientific layout), so it is not an authority
-- for canonical fact bytes.
CREATE FUNCTION arena.position_history_ecmascript_number_text(
  p_value double precision
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_bytes bytea;
  v_sign text := '';
  v_magnitude double precision;
  v_exponent_bits integer;
  v_fraction_bits numeric := 0;
  v_mantissa numeric;
  v_binary_exponent integer;
  v_decimal_scale integer;
  v_exact_integer_digits text;
  v_exact_text text;
  v_exact numeric;
  v_scaled_exact numeric;
  v_floor_significand numeric;
  v_candidate_significand numeric;
  v_candidate_text text;
  v_candidate_number double precision;
  v_candidate_exact numeric;
  v_candidate_distance numeric;
  v_best_significand numeric;
  v_best_distance numeric;
  v_digits text;
  v_n integer;
  v_candidate_n integer;
  v_best_n integer;
  v_k integer;
  v_index integer;
  v_byte_index integer;
  v_decimal_exponent integer;
  v_scientific_exponent integer;
  v_result text;
BEGIN
  IF p_value IN (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     ) THEN
    RETURN NULL;
  END IF;
  IF p_value = 0 THEN
    RETURN '0';
  END IF;

  IF p_value < 0 THEN
    v_sign := '-';
  END IF;
  v_magnitude := pg_catalog.abs(p_value);
  v_bytes := pg_catalog.float8send(v_magnitude);
  v_exponent_bits :=
    (pg_catalog.get_byte(v_bytes, 0) % 128) * 16 +
    pg_catalog.get_byte(v_bytes, 1) / 16;
  v_fraction_bits := pg_catalog.get_byte(v_bytes, 1) % 16;
  FOR v_byte_index IN 2..7 LOOP
    v_fraction_bits :=
      v_fraction_bits * 256 + pg_catalog.get_byte(v_bytes, v_byte_index);
  END LOOP;

  IF v_exponent_bits = 0 THEN
    v_mantissa := v_fraction_bits;
    v_binary_exponent := -1074;
  ELSE
    v_mantissa := 4503599627370496::numeric + v_fraction_bits;
    v_binary_exponent := v_exponent_bits - 1023 - 52;
  END IF;

  -- A binary fraction m * 2^-q is the terminating decimal
  -- (m * 5^q) * 10^-q.  Construct its text before casting to numeric so no
  -- division result scale can round away exact low-order digits.
  IF v_binary_exponent >= 0 THEN
    v_exact_integer_digits := pg_catalog.regexp_replace(
      (
        v_mantissa * pg_catalog.power(
          2::numeric,
          v_binary_exponent::numeric
        )
      )::text,
      '[.]0+$',
      ''
    );
    v_exact_text := v_exact_integer_digits;
    v_n := pg_catalog.char_length(v_exact_integer_digits);
  ELSE
    v_decimal_scale := -v_binary_exponent;
    v_exact_integer_digits := pg_catalog.regexp_replace(
      (
        v_mantissa * pg_catalog.power(
          5::numeric,
          v_decimal_scale::numeric
        )
      )::text,
      '[.]0+$',
      ''
    );
    v_n := pg_catalog.char_length(v_exact_integer_digits) - v_decimal_scale;
    IF pg_catalog.char_length(v_exact_integer_digits) > v_decimal_scale THEN
      v_exact_text :=
        pg_catalog.left(v_exact_integer_digits, v_n) || '.' ||
        pg_catalog.substring(v_exact_integer_digits, v_n + 1);
    ELSE
      v_exact_text := '0.' || pg_catalog.repeat(
        '0', v_decimal_scale - pg_catalog.char_length(v_exact_integer_digits)
      ) || v_exact_integer_digits;
    END IF;
  END IF;
  v_exact := v_exact_text::numeric;

  -- Binary64 always has a round-trip decimal with at most 17 significant
  -- digits.  At each precision the closest grid points are floor(y)/ceil(y);
  -- because the binary64 rounding interval contains x, no farther grid point
  -- can be the closest admissible candidate.  Check the adjacent decimal
  -- decades as well: a float immediately below a power of ten can canonically
  -- stringify to that power (for example Number(1e-7)).
  FOR v_k IN 1..17 LOOP
    v_best_significand := NULL;
    v_best_n := NULL;
    v_best_distance := NULL;

    FOR v_candidate_n IN (v_n - 1)..(v_n + 1) LOOP
      v_scaled_exact := v_exact * (
        '1e' || (v_k - v_candidate_n)::text
      )::numeric;
      v_floor_significand := pg_catalog.floor(v_scaled_exact);

      FOR v_index IN 0..1 LOOP
        v_candidate_significand := v_floor_significand + v_index;
        IF v_candidate_significand < pg_catalog.power(
             10::numeric,
             (v_k - 1)::numeric
           )
           OR v_candidate_significand >= pg_catalog.power(
             10::numeric,
             v_k::numeric
           ) THEN
          CONTINUE;
        END IF;

        v_decimal_exponent := v_candidate_n - v_k;
        v_candidate_text :=
          v_candidate_significand::text || 'e' || v_decimal_exponent::text;
        BEGIN
          v_candidate_number := v_candidate_text::double precision;
        EXCEPTION WHEN OTHERS THEN
          v_candidate_number := NULL;
        END;
        IF v_candidate_number IS DISTINCT FROM v_magnitude THEN
          CONTINUE;
        END IF;

        v_candidate_exact := v_candidate_text::numeric;
        v_candidate_distance := pg_catalog.abs(v_candidate_exact - v_exact);
        IF v_best_significand IS NULL
           OR v_candidate_distance < v_best_distance
           OR (
             v_candidate_distance = v_best_distance
             AND pg_catalog.mod(v_candidate_significand, 2) = 0
             AND pg_catalog.mod(v_best_significand, 2) <> 0
           ) THEN
          v_best_significand := v_candidate_significand;
          v_best_n := v_candidate_n;
          v_best_distance := v_candidate_distance;
        END IF;
      END LOOP;
    END LOOP;

    EXIT WHEN v_best_significand IS NOT NULL;
  END LOOP;

  IF v_best_significand IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := v_best_significand::text;
  v_k := pg_catalog.char_length(v_digits);
  v_n := v_best_n;

  IF v_n BETWEEN -5 AND 21 THEN
    IF v_n >= v_k THEN
      v_result := v_digits || pg_catalog.repeat('0', v_n - v_k);
    ELSIF v_n > 0 THEN
      v_result := pg_catalog.left(v_digits, v_n) || '.' ||
        pg_catalog.substring(v_digits, v_n + 1);
    ELSE
      v_result := '0.' || pg_catalog.repeat('0', -v_n) || v_digits;
    END IF;
  ELSE
    v_scientific_exponent := v_n - 1;
    v_result := pg_catalog.left(v_digits, 1) ||
      CASE WHEN v_k = 1 THEN ''
        ELSE '.' || pg_catalog.substring(v_digits, 2)
      END || 'e' ||
      CASE WHEN v_scientific_exponent >= 0 THEN '+' ELSE '-' END ||
      pg_catalog.abs(v_scientific_exponent)::text;
  END IF;
  RETURN v_sign || v_result;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$function$;

-- Distinguish an unparseable source value (which a reviewed parser represents
-- as NULL) from a finite JavaScript spelling that the publication contract
-- explicitly forbids.  This closes the fact=NULL bypass for radix strings,
-- negative zero, non-zero decimal underflow, and overlong strings.
CREATE FUNCTION arena.position_history_numeric_scalar_is_publishable(
  p_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_text text;
  v_trimmed text;
  v_significand text;
  v_exponent text;
BEGIN
  IF p_value IS NULL
     OR p_value = 'null'::jsonb
     OR pg_catalog.jsonb_typeof(p_value) <> 'string' THEN
    RETURN true;
  END IF;
  v_text := p_value #>> '{}';
  IF pg_catalog.char_length(v_text) > 128 THEN
    RETURN false;
  END IF;
  v_trimmed := arena.position_history_ecmascript_trim(v_text);
  IF v_trimmed = '' THEN
    RETURN true;
  END IF;
  IF v_text IS DISTINCT FROM v_trimmed THEN
    RETURN false;
  END IF;
  IF v_text ~ '^0[xX][0-9a-fA-F]+$'
     OR v_text ~ '^0[oO][0-7]+$'
     OR v_text ~ '^0[bB][01]+$' THEN
    RETURN false;
  END IF;
  IF v_text !~
    '^[+-]?((([0-9]+)(\.[0-9]*)?)|(\.[0-9]+))([eE][+-]?[0-9]+)?$' THEN
    RETURN true;
  END IF;

  v_significand := pg_catalog.regexp_replace(
    pg_catalog.split_part(
      pg_catalog.regexp_replace(pg_catalog.lower(v_text), '^[+-]', ''),
      'e',
      1
    ),
    '\.',
    '',
    'g'
  );
  IF v_text ~ '^-' AND v_significand ~ '^0+$' THEN
    RETURN false;
  END IF;
  IF arena.position_history_js_number(p_value) IS NOT NULL THEN
    RETURN true;
  END IF;

  v_exponent := pg_catalog.substring(
    pg_catalog.lower(v_text),
    'e([+-]?[0-9]+)$'
  );
  RETURN NOT (
    v_significand !~ '^0+$'
    AND v_exponent IS NOT NULL
    AND v_exponent ~ '^-'
  );
END
$function$;

CREATE FUNCTION arena.position_history_scaled_return_is_finite(
  p_value jsonb,
  p_scale numeric
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_return double precision;
  v_scaled double precision;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN
    RETURN true;
  END IF;
  IF pg_catalog.jsonb_typeof(p_value) <> 'number' OR p_scale <= 0 THEN
    RETURN false;
  END IF;
  v_return := (p_value #>> '{}')::double precision;
  v_scaled := v_return * p_scale::double precision;
  RETURN v_return NOT IN (
      'NaN'::double precision,
      'Infinity'::double precision,
      '-Infinity'::double precision
    )
    AND v_scaled NOT IN (
      'NaN'::double precision,
      'Infinity'::double precision,
      '-Infinity'::double precision
    );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

-- Recompute every material economic field from the bound RAW row using the
-- exact source parser mapping.  This is deliberately stricter than trusting
-- field_sources: an allowlisted path proves lineage, not value equality.
CREATE FUNCTION arena.position_history_fact_matches_raw(
  p_source_slug text,
  p_source_currency text,
  p_exchange_trader_id text,
  p_page_fetched_at timestamptz,
  p_fact jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_raw jsonb := p_fact->'raw';
  v_raw_value jsonb;
  v_expected_symbol text;
  v_expected_side text;
  v_expected_marker text;
  v_opened_number double precision;
  v_closed_number double precision;
  v_raw_id_number double precision;
  v_expected_number double precision;
  v_fact_number double precision;
  v_fact_field text;
  v_raw_field text;
  v_fact_fields text[];
  v_raw_fields text[];
  v_numeric_values jsonb[];
  v_page_fetched_number double precision;
  v_index integer;
BEGIN
  IF pg_catalog.jsonb_typeof(v_raw) <> 'object'
     OR NOT pg_catalog.isfinite(p_page_fetched_at) THEN
    RETURN false;
  END IF;
  v_page_fetched_number :=
    (EXTRACT(epoch FROM p_page_fetched_at) * 1000)::double precision;

  IF p_source_slug = 'binance_futures' THEN
    IF pg_catalog.jsonb_typeof(v_raw->'id') <> 'number'
       OR pg_catalog.jsonb_typeof(v_raw->'opened') <> 'number'
       OR pg_catalog.jsonb_typeof(v_raw->'closed') <> 'number'
       OR pg_catalog.jsonb_typeof(v_raw->'type') <> 'string'
       OR v_raw->>'type' IS DISTINCT FROM 'UM'
       OR pg_catalog.jsonb_typeof(v_raw->'symbol') <> 'string'
       OR pg_catalog.char_length(v_raw->>'symbol') <=
          pg_catalog.char_length(p_source_currency)
       OR pg_catalog.right(
            v_raw->>'symbol',
            pg_catalog.char_length(p_source_currency)
          ) IS DISTINCT FROM p_source_currency
       OR pg_catalog.jsonb_typeof(v_raw->'side') <> 'string'
       OR v_raw->>'side' = ''
       OR v_raw->>'status' IS DISTINCT FROM 'All Closed' THEN
      RETURN false;
    END IF;
    v_expected_symbol := v_raw->>'symbol';
    v_expected_side := CASE v_raw->>'side'
      WHEN 'Long' THEN 'long'
      WHEN 'Short' THEN 'short'
      ELSE NULL
    END;
    IF v_expected_side IS NULL THEN
      RETURN false;
    END IF;
    v_expected_marker := 'All Closed';
    v_opened_number := arena.position_history_js_number(v_raw->'opened');
    v_closed_number := arena.position_history_js_number(v_raw->'closed');
    v_raw_id_number := arena.position_history_js_number(v_raw->'id');
    IF v_raw_id_number IS NULL
       OR v_raw_id_number <= 0
       OR v_raw_id_number > 8640000000000000::double precision
       OR v_raw_id_number <> pg_catalog.trunc(v_raw_id_number)
       OR v_raw_id_number IS DISTINCT FROM v_opened_number
       OR arena.position_history_source_identity(v_raw->'id')
            IS DISTINCT FROM pg_catalog.trunc(v_raw_id_number)::bigint::text THEN
      RETURN false;
    END IF;
    v_fact_fields := ARRAY[
      'leverage', 'size', 'entry_price', 'exit_price',
      'realized_pnl', 'source_return'
    ];
    v_raw_fields := ARRAY[
      'leverage', 'closedVolume', 'avgCost', 'avgClosePrice',
      'closingPnl', 'roi'
    ];
    v_numeric_values := ARRAY[
      v_raw->'id', v_raw->'opened', v_raw->'closed', v_raw->'leverage',
      v_raw->'closedVolume', v_raw->'avgCost', v_raw->'avgClosePrice',
      v_raw->'closingPnl', v_raw->'roi'
    ];
  ELSIF p_source_slug = 'bitget_futures' THEN
    IF pg_catalog.jsonb_typeof(v_raw->'tokenId') <> 'string'
       OR v_raw->>'tokenId' IS DISTINCT FROM p_source_currency
       OR arena.position_history_source_identity(v_raw->'orderNo') IS NULL THEN
      RETURN false;
    END IF;
    v_raw_value := CASE
      WHEN v_raw ? 'symbolDisplayName'
        AND v_raw->'symbolDisplayName' <> 'null'::jsonb
        THEN v_raw->'symbolDisplayName'
      WHEN v_raw ? 'productCode' AND v_raw->'productCode' <> 'null'::jsonb
        THEN v_raw->'productCode'
      ELSE v_raw->'symbolId'
    END;
    IF pg_catalog.jsonb_typeof(v_raw_value) <> 'string'
       OR v_raw_value #>> '{}' = '' THEN
      RETURN false;
    END IF;
    v_expected_symbol := v_raw_value #>> '{}';
    v_raw_value := CASE
      WHEN v_raw ? 'position' AND v_raw->'position' <> 'null'::jsonb
        THEN v_raw->'position'
      ELSE v_raw->'holdSide'
    END;
    v_expected_number := arena.position_history_js_number(v_raw_value);
    v_expected_side := CASE v_expected_number
      WHEN 1 THEN 'long'
      WHEN 2 THEN 'short'
      ELSE NULL
    END;
    v_opened_number := arena.position_history_js_number(v_raw->'openTime');
    v_closed_number := arena.position_history_js_number(v_raw->'closeTime');
    IF v_closed_number IS NOT NULL AND v_closed_number > 0 THEN
      v_expected_marker := arena.position_history_ecmascript_trim(
        v_raw->>'closeTime'
      );
    END IF;
    v_fact_fields := ARRAY[
      'leverage', 'size', 'entry_price', 'exit_price',
      'realized_pnl', 'source_return'
    ];
    v_raw_fields := ARRAY[
      'openLevel', CASE
        WHEN v_raw ? 'closeDealCount'
          AND v_raw->'closeDealCount' <> 'null'::jsonb
          THEN 'closeDealCount' ELSE 'openDealCount' END,
      'openAvgPrice', 'closeAvgPrice', 'netProfit', 'returnRate'
    ];
    v_numeric_values := ARRAY[
      v_raw->'openTime', v_raw->'closeTime', v_raw_value,
      v_raw->'openLevel', v_raw->(v_raw_fields[2]),
      v_raw->'openAvgPrice', v_raw->'closeAvgPrice',
      v_raw->'netProfit', v_raw->'returnRate'
    ];
  ELSIF p_source_slug = 'okx_futures' THEN
    IF pg_catalog.jsonb_typeof(v_raw->'uniqueCode') <> 'string'
       OR v_raw->>'uniqueCode' IS DISTINCT FROM p_exchange_trader_id
       OR pg_catalog.jsonb_typeof(v_raw->'instType') <> 'string'
       OR v_raw->>'instType' IS DISTINCT FROM 'SWAP'
       OR pg_catalog.jsonb_typeof(v_raw->'ccy') <> 'string'
       OR v_raw->>'ccy' IS DISTINCT FROM p_source_currency THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_raw->'instId') <> 'string'
       OR NOT arena.position_history_text_is_canonical(
         v_raw->>'instId', 1, 128
       )
       OR pg_catalog.char_length(v_raw->>'instId') <=
          pg_catalog.char_length('-' || p_source_currency || '-SWAP')
       OR pg_catalog.right(
            v_raw->>'instId',
            pg_catalog.char_length('-' || p_source_currency || '-SWAP')
          ) IS DISTINCT FROM '-' || p_source_currency || '-SWAP'
       OR NOT arena.position_history_text_is_canonical(
         arena.position_history_source_identity(v_raw->'subPosId'),
         1,
         512
       )
       OR pg_catalog.strpos(
            arena.position_history_source_identity(v_raw->'subPosId'), '|'
          ) > 0
       OR pg_catalog.jsonb_typeof(v_raw->'posSide') <> 'string'
       OR v_raw->>'posSide' NOT IN ('long', 'short') THEN
      RETURN false;
    END IF;
    v_expected_symbol := v_raw->>'instId';
    v_expected_side := CASE
      WHEN pg_catalog.jsonb_typeof(v_raw->'posSide') = 'string'
        AND v_raw->>'posSide' IN ('long', 'short') THEN v_raw->>'posSide'
      ELSE NULL
    END;
    v_opened_number := arena.position_history_js_number(v_raw->'openTime');
    v_closed_number := arena.position_history_js_number(v_raw->'closeTime');
    IF v_closed_number IS NOT NULL AND v_closed_number > 0 THEN
      v_expected_marker := arena.position_history_ecmascript_trim(
        v_raw->>'closeTime'
      );
    END IF;
    v_fact_fields := ARRAY[
      'leverage', 'size', 'entry_price', 'exit_price',
      'realized_pnl', 'source_return'
    ];
    v_raw_fields := ARRAY[
      'lever', 'subPos', 'openAvgPx', 'closeAvgPx', 'pnl', 'pnlRatio'
    ];
    v_numeric_values := ARRAY[
      v_raw->'openTime', v_raw->'closeTime', v_raw->'lever',
      v_raw->'subPos', v_raw->'openAvgPx', v_raw->'closeAvgPx',
      v_raw->'pnl', v_raw->'pnlRatio'
    ];
  ELSE
    RETURN false;
  END IF;

  FOREACH v_raw_value IN ARRAY v_numeric_values LOOP
    IF NOT arena.position_history_numeric_scalar_is_publishable(v_raw_value) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF p_source_slug = 'bitget_futures'
     AND (
       v_opened_number IS NULL
       OR v_opened_number <= 0
       OR v_opened_number > 8640000000000000::double precision
       OR v_opened_number <> pg_catalog.trunc(v_opened_number)
     ) THEN
    v_opened_number := NULL;
  END IF;

  IF v_closed_number IS NULL
     OR v_closed_number <= 0
     OR v_closed_number > 8640000000000000::double precision
     OR v_closed_number <> pg_catalog.trunc(v_closed_number) THEN
    RETURN false;
  END IF;

  IF p_source_slug <> 'bitget_futures' AND (
    v_opened_number IS NULL
    OR v_opened_number <= 0
    OR v_opened_number > 8640000000000000::double precision
    OR v_opened_number <> pg_catalog.trunc(v_opened_number)
  ) THEN
    RETURN false;
  END IF;

  IF v_closed_number > v_page_fetched_number
     OR v_opened_number > v_page_fetched_number
     OR (
       v_opened_number IS NOT NULL
       AND v_closed_number < v_opened_number
     ) THEN
    RETURN false;
  END IF;

  IF p_fact->>'symbol' IS DISTINCT FROM v_expected_symbol
     OR (CASE WHEN p_fact->'side' = 'null'::jsonb THEN NULL
          ELSE p_fact->>'side' END) IS DISTINCT FROM v_expected_side
     OR p_fact->>'source_lifecycle_marker' IS DISTINCT FROM v_expected_marker THEN
    RETURN false;
  END IF;

  IF v_opened_number IS NOT NULL THEN
    v_opened_number := pg_catalog.trunc(v_opened_number);
  END IF;
  v_closed_number := pg_catalog.trunc(v_closed_number);
  IF (p_fact->'opened_at' = 'null'::jsonb) IS DISTINCT FROM
       (v_opened_number IS NULL)
     OR (p_fact->'closed_at' = 'null'::jsonb) IS DISTINCT FROM
       (v_closed_number IS NULL) THEN
    RETURN false;
  END IF;
  IF v_opened_number IS NOT NULL AND
       (EXTRACT(epoch FROM (p_fact->>'opened_at')::timestamptz) * 1000)::double precision
         IS DISTINCT FROM v_opened_number THEN
    RETURN false;
  END IF;
  IF v_closed_number IS NOT NULL AND
       (EXTRACT(epoch FROM (p_fact->>'closed_at')::timestamptz) * 1000)::double precision
         IS DISTINCT FROM v_closed_number THEN
    RETURN false;
  END IF;

  FOR v_index IN 1..pg_catalog.array_length(v_fact_fields, 1) LOOP
    v_fact_field := v_fact_fields[v_index];
    v_raw_field := v_raw_fields[v_index];
    v_expected_number := arena.position_history_js_number(v_raw->v_raw_field);
    IF v_expected_number IS NULL THEN
      IF p_fact->v_fact_field <> 'null'::jsonb THEN
        RETURN false;
      END IF;
    ELSE
      IF pg_catalog.jsonb_typeof(p_fact->v_fact_field) <> 'number' THEN
        RETURN false;
      END IF;
      v_fact_number := (p_fact->>v_fact_field)::double precision;
      IF v_fact_number IN (
           'NaN'::double precision,
           'Infinity'::double precision,
           '-Infinity'::double precision
         )
         OR v_fact_number IS DISTINCT FROM v_expected_number THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

-- Independently classify the only source row that may be retained without a
-- materialized fact. This mirrors the frozen OKX @2 lifecycle domain instead
-- of trusting a caller-provided manifest classification.
CREATE FUNCTION arena.position_history_okx_partial_row_matches_raw(
  p_exchange_trader_id text,
  p_source_currency text,
  p_page_fetched_at timestamptz,
  p_raw jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_sub_position_id text;
  v_opened_number double precision;
  v_page_fetched_number double precision;
  v_suffix text := '-' || p_source_currency || '-SWAP';
BEGIN
  IF pg_catalog.jsonb_typeof(p_raw) <> 'object'
     OR NOT pg_catalog.isfinite(p_page_fetched_at)
     OR pg_catalog.jsonb_typeof(p_raw->'uniqueCode') <> 'string'
     OR p_raw->>'uniqueCode' IS DISTINCT FROM p_exchange_trader_id
     OR pg_catalog.strpos(p_exchange_trader_id, '|') > 0
     OR pg_catalog.jsonb_typeof(p_raw->'instType') <> 'string'
     OR p_raw->>'instType' IS DISTINCT FROM 'SWAP'
     OR pg_catalog.jsonb_typeof(p_raw->'ccy') <> 'string'
     OR p_raw->>'ccy' IS DISTINCT FROM p_source_currency
     OR p_source_currency IS DISTINCT FROM 'USDT'
     OR pg_catalog.jsonb_typeof(p_raw->'posSide') <> 'string'
     OR p_raw->>'posSide' NOT IN ('long', 'short')
     OR pg_catalog.jsonb_typeof(p_raw->'instId') <> 'string'
     OR NOT arena.position_history_text_is_canonical(
       p_raw->>'instId', 1, 128
     )
     OR pg_catalog.char_length(p_raw->>'instId') <=
        pg_catalog.char_length(v_suffix)
     OR pg_catalog.right(
          p_raw->>'instId', pg_catalog.char_length(v_suffix)
        ) IS DISTINCT FROM v_suffix
     OR pg_catalog.jsonb_typeof(p_raw->'closeTime') <> 'string'
     OR p_raw->>'closeTime' IS DISTINCT FROM '' THEN
    RETURN false;
  END IF;

  v_sub_position_id := arena.position_history_source_identity(
    p_raw->'subPosId'
  );
  v_opened_number := arena.position_history_js_number(p_raw->'openTime');
  v_page_fetched_number :=
    (EXTRACT(epoch FROM p_page_fetched_at) * 1000)::double precision;

  RETURN arena.position_history_text_is_canonical(
      v_sub_position_id, 1, 512
    )
    AND pg_catalog.strpos(v_sub_position_id, '|') = 0
    AND arena.position_history_numeric_scalar_is_publishable(
      p_raw->'openTime'
    )
    AND v_opened_number IS NOT NULL
    AND v_opened_number > 0
    AND v_opened_number <= 8640000000000000::double precision
    AND v_opened_number = pg_catalog.trunc(v_opened_number)
    AND v_opened_number <= v_page_fetched_number;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE FUNCTION arena.position_history_serving_margin_mode(
  p_source_slug text,
  p_raw jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE p_source_slug
    WHEN 'binance_futures' THEN CASE p_raw->>'isolated'
      WHEN 'Cross' THEN 'cross'
      WHEN 'Isolated' THEN 'isolated'
      ELSE NULL
    END
    WHEN 'okx_futures' THEN CASE p_raw->>'mgnMode'
      WHEN 'cross' THEN 'cross'
      WHEN 'isolated' THEN 'isolated'
      ELSE NULL
    END
    ELSE NULL
  END
$function$;

CREATE FUNCTION arena.position_history_recomputed_dedupe(
  p_source_slug text,
  p_exchange_trader_id text,
  p_fact jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_identity jsonb;
  v_basis text;
  v_raw_identity text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_fact->'source_fact_id') <> 'string' THEN
    RETURN NULL;
  END IF;
  IF p_source_slug = 'binance_futures' THEN
    v_raw_identity := arena.position_history_source_identity(
      p_fact->'raw'->'id'
    );
    IF v_raw_identity IS NULL THEN
      RETURN NULL;
    END IF;
    BEGIN
      v_identity := (p_fact->>'source_fact_id')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
    IF pg_catalog.jsonb_typeof(v_identity) <> 'array'
       OR pg_catalog.jsonb_array_length(v_identity) <> 4
       OR v_identity->>0 IS DISTINCT FROM p_exchange_trader_id
       OR v_identity->>1 IS DISTINCT FROM v_raw_identity
       OR v_identity->>2 IS DISTINCT FROM p_fact->>'symbol'
       OR v_identity->>3 IS DISTINCT FROM p_fact->'raw'->>'side'
       OR pg_catalog.strpos(v_identity->>0, '|') > 0
       OR pg_catalog.strpos(v_identity->>1, '|') > 0
       OR pg_catalog.strpos(v_identity->>2, '|') > 0
       OR pg_catalog.strpos(v_identity->>3, '|') > 0 THEN
      RETURN NULL;
    END IF;
    v_basis := 'binance_ph|' || (v_identity->>0) || '|' || (v_identity->>1) ||
      '|' || (v_identity->>2) || '|' || (v_identity->>3);
  ELSIF p_source_slug = 'bitget_futures' THEN
    v_raw_identity := arena.position_history_source_identity(
      p_fact->'raw'->'orderNo'
    );
    IF v_raw_identity IS NULL
       OR p_fact->>'source_fact_id' IS DISTINCT FROM v_raw_identity THEN
      RETURN NULL;
    END IF;
    v_basis := 'bitget_ph|' || (p_fact->>'source_fact_id');
  ELSIF p_source_slug = 'okx_futures' THEN
    v_raw_identity := arena.position_history_source_identity(
      p_fact->'raw'->'subPosId'
    );
    IF v_raw_identity IS NULL THEN
      RETURN NULL;
    END IF;
    BEGIN
      v_identity := (p_fact->>'source_fact_id')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
    IF pg_catalog.jsonb_typeof(v_identity) <> 'array'
       OR pg_catalog.jsonb_array_length(v_identity) <> 2
       OR v_identity->>0 IS DISTINCT FROM p_exchange_trader_id
       OR v_identity->>1 IS DISTINCT FROM v_raw_identity
       OR NOT arena.position_history_text_is_canonical(v_raw_identity, 1, 512)
       OR pg_catalog.strpos(v_identity->>0, '|') > 0
       OR pg_catalog.strpos(v_identity->>1, '|') > 0 THEN
      RETURN NULL;
    END IF;
    v_basis := 'okx_ph|' || (v_identity->>0) || '|' || (v_identity->>1);
  ELSE
    RETURN NULL;
  END IF;
  RETURN pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_basis, 'UTF8'), 'sha1'),
    'hex'
  );
END
$function$;

CREATE TABLE arena.position_history_source_contracts (
  source_id smallint PRIMARY KEY,
  source_slug text NOT NULL UNIQUE,
  adapter_slug text NOT NULL,
  source_contract text NOT NULL UNIQUE,
  parser_contract text NOT NULL UNIQUE,
  terminal_verifier_contract text NOT NULL UNIQUE,
  source_currency text NOT NULL CHECK (source_currency = 'USDT'),
  page_size smallint NOT NULL CHECK (page_size IN (20, 50, 100)),
  -- Presentation-only normalization. Immutable facts retain the exact source
  -- return; the 2C records surface displays percent values.
  serving_return_scale numeric NOT NULL CHECK (
    serving_return_scale IN (1, 100)
  ),
  allowed_field_paths jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(allowed_field_paths) = 'object'
  ),
  contract_version integer NOT NULL CHECK (contract_version = 1)
);

INSERT INTO arena.position_history_source_contracts (
  source_id,
  source_slug,
  adapter_slug,
  source_contract,
  parser_contract,
  terminal_verifier_contract,
  source_currency,
  page_size,
  serving_return_scale,
  allowed_field_paths,
  contract_version
)
SELECT
  source_row.id,
  source_row.slug,
  source_row.adapter_slug,
  contract_row.source_contract,
  contract_row.parser_contract,
  contract_row.verifier_contract,
  source_row.currency,
  contract_row.page_size,
  contract_row.return_scale,
  contract_row.allowed_paths,
  1
FROM arena.sources AS source_row
JOIN (
  VALUES
  (
    'binance_futures',
    'arena.ingest.position-history-source.binance_futures@1',
    'arena.ingest.position-history-parser.binance@1',
    'arena.ingest.history-terminal-verifier.binance.position_history@2',
    50::smallint,
    100::numeric,
    '{
      "openedAt":[["response.data.list[].opened"]],
      "closedAt":[["response.data.list[].closed"]],
      "symbol":[["response.data.list[].symbol"]],
      "side":[["response.data.list[].side"]],
      "leverage":[["response.data.list[].leverage"]],
      "size":[["response.data.list[].closedVolume"]],
      "entryPrice":[["response.data.list[].avgCost"]],
      "exitPrice":[["response.data.list[].avgClosePrice"]],
      "realizedPnl":[["response.data.list[].closingPnl"]],
      "sourceFactId":[["portfolioId","response.data.list[].id","response.data.list[].symbol","response.data.list[].side"]],
      "sourceLifecycleMarker":[["response.data.list[].status"]],
      "sourceReturn":[["response.data.list[].roi"]]
    }'::jsonb
  ),
  (
    'bitget_futures',
    'arena.ingest.position-history-source.bitget_futures@1',
    'arena.ingest.position-history-parser.bitget@1',
    'arena.ingest.history-terminal-verifier.bitget.position_history@2',
    20::smallint,
    1::numeric,
    '{
      "openedAt":[["data.rows[].openTime"]],
      "closedAt":[["data.rows[].closeTime"]],
      "symbol":[["data.rows[].symbolDisplayName"],["data.rows[].productCode"],["data.rows[].symbolId"]],
      "side":[["data.rows[].position"],["data.rows[].holdSide"]],
      "leverage":[["data.rows[].openLevel"]],
      "size":[["data.rows[].closeDealCount"],["data.rows[].openDealCount"]],
      "entryPrice":[["data.rows[].openAvgPrice"]],
      "exitPrice":[["data.rows[].closeAvgPrice"]],
      "realizedPnl":[["data.rows[].netProfit"]],
      "sourceFactId":[["data.rows[].orderNo"]],
      "sourceLifecycleMarker":[["data.rows[].closeTime"]],
      "sourceReturn":[["data.rows[].returnRate"]]
    }'::jsonb
  ),
  (
    'okx_futures',
    'arena.ingest.position-history-source.okx_futures@1',
    'arena.ingest.position-history-parser.okx@1',
    'arena.ingest.history-terminal-verifier.okx.position_history@2',
    100::smallint,
    100::numeric,
    '{
      "openedAt":[["data[].openTime"]],
      "closedAt":[["data[].closeTime"]],
      "symbol":[["data[].instId"]],
      "side":[["data[].posSide"]],
      "leverage":[["data[].lever"]],
      "size":[["data[].subPos"]],
      "entryPrice":[["data[].openAvgPx"]],
      "exitPrice":[["data[].closeAvgPx"]],
      "realizedPnl":[["data[].pnl"]],
      "sourceFactId":[["historyTraderIdentity","data[].subPosId"]],
      "sourceLifecycleMarker":[["data[].closeTime"]],
      "sourceReturn":[["data[].pnlRatio"]]
    }'::jsonb
  )
) AS contract_row(
  source_slug,
  source_contract,
  parser_contract,
  verifier_contract,
  page_size,
  return_scale,
  allowed_paths
) ON contract_row.source_slug = source_row.slug;

CREATE TABLE arena.position_history_publish_guards (
  transaction_id xid8 PRIMARY KEY,
  backend_pid integer NOT NULL,
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE arena.position_history_acquisitions (
  acquisition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_run_id text NOT NULL UNIQUE CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  -- Deliberately no FK to raw_objects: the immutable evidence copy below
  -- survives the normal RAW object/pointer retention and GC lifecycle.
  raw_object_id bigint NOT NULL UNIQUE CHECK (raw_object_id > 0),
  source_id smallint NOT NULL,
  trader_id bigint NOT NULL,
  source_slug text NOT NULL,
  adapter_slug text NOT NULL,
  exchange_trader_id text NOT NULL,
  raw_storage_path text NOT NULL,
  raw_content_hash text NOT NULL CHECK (raw_content_hash = source_run_id),
  raw_bytes integer NOT NULL CHECK (raw_bytes > 0),
  raw_fetched_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(raw_fetched_at)),
  attempt_started_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(attempt_started_at)
  ),
  observed_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(observed_at)
    AND attempt_started_at <= observed_at
  ),
  starting_cursor timestamptz CHECK (
    starting_cursor IS NULL OR pg_catalog.isfinite(starting_cursor)
  ),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 100000),
  page_manifest jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(page_manifest) = 'array'
  ),
  source_contract text NOT NULL,
  parser_contract text NOT NULL,
  verifier_contract text NOT NULL,
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN ('exhausted', 'cursor_overlap')
  ),
  termination jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(termination) = 'object'
  ),
  raw_meta jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_meta) = 'object'),
  acquired_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(acquired_at)),
  CONSTRAINT position_history_acquisition_source_contract_fkey
    FOREIGN KEY (source_id)
    REFERENCES arena.position_history_source_contracts(source_id)
    ON DELETE RESTRICT,
  UNIQUE (acquisition_id, source_run_id, source_id, trader_id)
);

CREATE TABLE arena.position_history_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acquisition_id bigint NOT NULL UNIQUE,
  source_run_id text NOT NULL UNIQUE,
  source_id smallint NOT NULL,
  trader_id bigint NOT NULL,
  previous_publication_id bigint,
  cursor_before timestamptz CHECK (
    cursor_before IS NULL OR pg_catalog.isfinite(cursor_before)
  ),
  cursor_after timestamptz CHECK (
    cursor_after IS NULL OR pg_catalog.isfinite(cursor_after)
  ),
  observed_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(observed_at)),
  published_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(published_at)),
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN ('exhausted', 'cursor_overlap')
  ),
  parsed_row_count integer NOT NULL CHECK (
    parsed_row_count BETWEEN 0 AND 100000
  ),
  binding_count integer NOT NULL CHECK (
    binding_count BETWEEN parsed_row_count AND 100000
  ),
  partial_row_count integer NOT NULL CHECK (
    partial_row_count BETWEEN 0 AND binding_count
  ),
  unique_fact_count integer NOT NULL CHECK (
    unique_fact_count BETWEEN 0 AND parsed_row_count
  ),
  new_fact_count integer NOT NULL CHECK (
    new_fact_count BETWEEN 0 AND unique_fact_count
  ),
  binding_set_sha256 text NOT NULL CHECK (
    binding_set_sha256 ~ '^[0-9a-f]{64}$'
  ),
  publication_sha256 text NOT NULL UNIQUE CHECK (
    publication_sha256 ~ '^[0-9a-f]{64}$'
  ),
  publication_payload text NOT NULL,
  cursor_secret bytea NOT NULL CHECK (
    pg_catalog.octet_length(cursor_secret) = 32
  ),
  publication_contract text NOT NULL CHECK (
    publication_contract = 'arena.ingest.verified-position-history-rpc-payload@2'
  ),
  serialization_contract text NOT NULL CHECK (
    serialization_contract = 'arena.strict-canonical-json@1'
  ),
  CONSTRAINT position_history_publication_acquisition_fkey
    FOREIGN KEY (acquisition_id, source_run_id, source_id, trader_id)
    REFERENCES arena.position_history_acquisitions(
      acquisition_id, source_run_id, source_id, trader_id
    ) ON DELETE RESTRICT,
  CONSTRAINT position_history_publication_previous_not_self
    CHECK (
      previous_publication_id IS NULL
      OR previous_publication_id <> publication_id
    ),
  CONSTRAINT position_history_publication_binding_accounting
    CHECK (binding_count = parsed_row_count + partial_row_count),
  UNIQUE (publication_id, source_id, trader_id),
  UNIQUE (publication_id, source_run_id, source_id, trader_id),
  CONSTRAINT position_history_publication_previous_identity_fkey
    FOREIGN KEY (previous_publication_id, source_id, trader_id)
    REFERENCES arena.position_history_publications(
      publication_id, source_id, trader_id
    ) ON DELETE RESTRICT,
  -- A linear publication chain is a stored invariant, not merely a property
  -- of the advisory-lock/CAS implementation. NULLS NOT DISTINCT permits one
  -- root per identity and one child for every predecessor.
  CONSTRAINT position_history_publication_linear_chain
    UNIQUE NULLS NOT DISTINCT (
      source_id, trader_id, previous_publication_id
    )
);

CREATE INDEX idx_position_history_acquisition_trader_identity
  ON arena.position_history_acquisitions (trader_id, acquisition_id);

CREATE INDEX idx_position_history_publication_latest
  ON arena.position_history_publications (
    source_id, trader_id, publication_id DESC
  );

CREATE INDEX idx_position_history_publication_trader_latest
  ON arena.position_history_publications (trader_id, publication_id DESC);

CREATE TABLE arena.verified_position_history_facts (
  fact_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_publication_id bigint NOT NULL,
  source_run_id text NOT NULL,
  source_id smallint NOT NULL,
  trader_id bigint NOT NULL,
  opened_at timestamptz,
  closed_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(closed_at)),
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  source_fact_id text NOT NULL,
  source_lifecycle_marker text NOT NULL,
  source_return numeric,
  limitations jsonb CHECK (
    limitations IS NULL OR pg_catalog.jsonb_typeof(limitations) = 'array'
  ),
  dedupe_hash text NOT NULL CHECK (dedupe_hash ~ '^[0-9a-f]{40}$'),
  raw_canonical_json text NOT NULL,
  fact_canonical_json text NOT NULL,
  raw jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw) = 'object'),
  field_sources jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(field_sources) = 'object'
  ),
  fact_payload jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(fact_payload) = 'object'),
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at)),
  CONSTRAINT verified_position_history_first_publication_fkey
    FOREIGN KEY (first_publication_id, source_id, trader_id)
    REFERENCES arena.position_history_publications(
      publication_id, source_id, trader_id
    ) ON DELETE RESTRICT,
  UNIQUE (source_id, trader_id, dedupe_hash),
  UNIQUE (source_id, trader_id, source_fact_id),
  UNIQUE (fact_id, source_id, trader_id)
);

CREATE INDEX idx_verified_position_history_fact_page
  ON arena.verified_position_history_facts (
    source_id, trader_id, closed_at DESC, dedupe_hash DESC,
    first_publication_id
  );

-- One binding per non-verifier source row, not a copy of every cumulative
-- state. Partial OKX source rows retain RAW evidence without pretending that a
-- closed fact exists. Storage is O(total observations); public history is
-- facts whose first publication precedes the cursor's immutable anchor.
-- Storage is O(total observations); public history is facts whose first
-- publication precedes the cursor's immutable publication anchor.
CREATE TABLE arena.position_history_publication_bindings (
  publication_id bigint NOT NULL,
  binding_ordinal integer NOT NULL CHECK (binding_ordinal > 0),
  classification text NOT NULL CHECK (
    classification IN ('canonical_materialized', 'source_partial_omitted')
  ),
  fact_ordinal integer CHECK (fact_ordinal > 0),
  fact_id bigint,
  source_run_id text NOT NULL,
  source_id smallint NOT NULL,
  trader_id bigint NOT NULL,
  page_ordinal integer NOT NULL CHECK (page_ordinal > 0),
  page_stored_index integer NOT NULL CHECK (page_stored_index > 0),
  source_row_ordinal integer NOT NULL CHECK (source_row_ordinal > 0),
  page_payload_sha256 text NOT NULL CHECK (
    page_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  page_fetched_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(page_fetched_at)),
  raw_row_sha256 text NOT NULL CHECK (
    raw_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_row_canonical_json text NOT NULL,
  fact_sha256 text CHECK (
    fact_sha256 IS NULL OR fact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  fact_canonical_json text,
  CONSTRAINT position_history_publication_binding_fact_shape CHECK (
    (
      classification = 'canonical_materialized'
      AND fact_ordinal IS NOT NULL
      AND fact_id IS NOT NULL
      AND fact_sha256 IS NOT NULL
      AND fact_canonical_json IS NOT NULL
    ) OR (
      classification = 'source_partial_omitted'
      AND fact_ordinal IS NULL
      AND fact_id IS NULL
      AND fact_sha256 IS NULL
      AND fact_canonical_json IS NULL
    )
  ),
  PRIMARY KEY (publication_id, binding_ordinal),
  UNIQUE (publication_id, fact_ordinal),
  UNIQUE (publication_id, fact_id),
  CONSTRAINT position_history_publication_binding_publication_fkey
    FOREIGN KEY (publication_id, source_run_id, source_id, trader_id)
    REFERENCES arena.position_history_publications(
      publication_id, source_run_id, source_id, trader_id
    ) ON DELETE RESTRICT,
  CONSTRAINT position_history_publication_binding_fact_fkey
    FOREIGN KEY (fact_id, source_id, trader_id)
    REFERENCES arena.verified_position_history_facts(
      fact_id, source_id, trader_id
    ) ON DELETE RESTRICT
);

CREATE INDEX idx_position_history_publication_binding_fact
  ON arena.position_history_publication_bindings (fact_id, publication_id)
  WHERE fact_id IS NOT NULL;

CREATE FUNCTION arena.position_history_publish_guard_active(p_source_run_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT current_user = 'postgres'
    AND p_source_run_id ~ '^[0-9a-f]{64}$'
    AND EXISTS (
      SELECT 1
      FROM arena.position_history_publish_guards AS guard_row
      WHERE guard_row.transaction_id = pg_catalog.pg_current_xact_id()
        AND guard_row.backend_pid = pg_catalog.pg_backend_pid()
        AND guard_row.source_run_id = p_source_run_id
    )
$function$;

CREATE FUNCTION arena.reject_verified_position_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'verified position-history authority is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.require_verified_position_history_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_run_id text;
BEGIN
  v_source_run_id := pg_catalog.to_jsonb(NEW)->>'source_run_id';
  IF NOT arena.position_history_publish_guard_active(v_source_run_id) THEN
    RAISE EXCEPTION
      'verified position-history inserts require the owner publication boundary'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DO $configure_private_authority$
DECLARE
  v_table regclass;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.position_history_acquisitions'::pg_catalog.regclass,
    'arena.position_history_publications'::pg_catalog.regclass,
    'arena.verified_position_history_facts'::pg_catalog.regclass,
    'arena.position_history_publication_bindings'::pg_catalog.regclass
  ]
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO postgres', v_table);
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_verified_history_read ON %s FOR SELECT TO postgres USING (true)',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_verified_history_insert ON %s FOR INSERT TO postgres WITH CHECK (arena.position_history_publish_guard_active(source_run_id))',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_verified_history_update ON %s FOR UPDATE TO postgres USING (true) WITH CHECK (false)',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_verified_history_delete ON %s FOR DELETE TO postgres USING (true)',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER require_verified_history_insert_guard BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION arena.require_verified_position_history_insert_guard()',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER reject_verified_history_update_delete BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION arena.reject_verified_position_history_mutation()',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER reject_verified_history_update_delete_statement BEFORE UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_verified_position_history_mutation()',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER reject_verified_history_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_verified_position_history_mutation()',
      v_table
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER require_verified_history_insert_guard',
      v_table
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_update_delete',
      v_table
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_update_delete_statement',
      v_table
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_truncate',
      v_table
    );
  END LOOP;
END
$configure_private_authority$;

ALTER TABLE arena.position_history_source_contracts OWNER TO postgres;
ALTER TABLE arena.position_history_source_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.position_history_source_contracts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.position_history_source_contracts
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY owner_verified_history_contract_read
  ON arena.position_history_source_contracts
  FOR SELECT TO postgres USING (true);
CREATE POLICY owner_verified_history_contract_update
  ON arena.position_history_source_contracts
  FOR UPDATE TO postgres USING (true) WITH CHECK (false);
CREATE POLICY owner_verified_history_contract_delete
  ON arena.position_history_source_contracts
  FOR DELETE TO postgres USING (true);
CREATE TRIGGER reject_verified_history_contract_insert
BEFORE INSERT ON arena.position_history_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_verified_position_history_mutation();
CREATE TRIGGER reject_verified_history_contract_update_delete
BEFORE UPDATE OR DELETE ON arena.position_history_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_verified_position_history_mutation();
CREATE TRIGGER reject_verified_history_contract_update_delete_statement
BEFORE UPDATE OR DELETE ON arena.position_history_source_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_verified_position_history_mutation();
CREATE TRIGGER reject_verified_history_contract_truncate
BEFORE TRUNCATE ON arena.position_history_source_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_verified_position_history_mutation();
ALTER TABLE arena.position_history_source_contracts
  ENABLE ALWAYS TRIGGER reject_verified_history_contract_insert;
ALTER TABLE arena.position_history_source_contracts
  ENABLE ALWAYS TRIGGER reject_verified_history_contract_update_delete;
ALTER TABLE arena.position_history_source_contracts
  ENABLE ALWAYS TRIGGER reject_verified_history_contract_update_delete_statement;
ALTER TABLE arena.position_history_source_contracts
  ENABLE ALWAYS TRIGGER reject_verified_history_contract_truncate;

ALTER TABLE arena.position_history_publish_guards OWNER TO postgres;
REVOKE ALL ON TABLE arena.position_history_publish_guards
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_private_sequences$
DECLARE
  v_sequence regclass;
BEGIN
  FOR v_sequence IN
    SELECT sequence_row.seqrelid::pg_catalog.regclass
    FROM pg_catalog.pg_sequence AS sequence_row
    WHERE sequence_row.seqrelid IN (
      pg_catalog.pg_get_serial_sequence(
        'arena.position_history_acquisitions', 'acquisition_id'
      )::pg_catalog.regclass,
      pg_catalog.pg_get_serial_sequence(
        'arena.position_history_publications', 'publication_id'
      )::pg_catalog.regclass,
      pg_catalog.pg_get_serial_sequence(
        'arena.verified_position_history_facts', 'fact_id'
      )::pg_catalog.regclass
    )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
      v_sequence
    );
  END LOOP;
END
$revoke_private_sequences$;

REVOKE ALL ON FUNCTION arena.position_history_text_sha256(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_json_has_duplicate_keys(json)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_exact_jsonb_keys(jsonb,text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_ecmascript_trim(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_text_is_canonical(text,integer,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_source_identity(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_canonical_timestamp(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_js_number(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_ecmascript_number_text(
  double precision
)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_numeric_scalar_is_publishable(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_scaled_return_is_finite(jsonb,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_fact_matches_raw(
  text,text,text,timestamptz,jsonb
)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_okx_partial_row_matches_raw(
  text,text,timestamptz,jsonb
)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_serving_margin_mode(text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_recomputed_dedupe(text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_publish_guard_active(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_verified_position_history_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.require_verified_position_history_insert_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- Once the immutable acquisition/publication graph exists, the normal RAW GC
-- path may delete only the exact pointer which that graph copied. Before a
-- publication exists, an admitted run remains undeletable. A pre-admission @2
-- orphan can still be explicitly quarantined and recollected.
CREATE OR REPLACE FUNCTION arena.protect_position_history_raw_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_admission arena.position_history_raw_admissions%ROWTYPE;
  v_has_admission boolean;
  v_new_eligible boolean;
  v_old_eligible boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT arena.position_history_raw_is_eligible(OLD.job_type, OLD.meta) THEN
      RETURN OLD;
    END IF;

    SELECT admission.*
    INTO v_admission
    FROM arena.position_history_raw_admissions AS admission
    WHERE admission.raw_object_id = OLD.id;
    v_has_admission := FOUND;

    IF v_has_admission AND (
      v_admission.source_id IS DISTINCT FROM OLD.source_id
      OR v_admission.job_type IS DISTINCT FROM OLD.job_type
      OR v_admission.trader_id IS DISTINCT FROM OLD.trader_id
      OR v_admission.timeframe IS DISTINCT FROM OLD.timeframe
      OR v_admission.fetched_at IS DISTINCT FROM OLD.fetched_at
      OR v_admission.storage_path IS DISTINCT FROM OLD.storage_path
      OR v_admission.bytes IS DISTINCT FROM OLD.bytes
      OR v_admission.content_hash IS DISTINCT FROM OLD.content_hash
      OR v_admission.source_run_id
           IS DISTINCT FROM OLD.meta->>'source_run_id'
      OR v_admission.source_slug IS DISTINCT FROM OLD.meta->>'source_slug'
      OR v_admission.exchange_trader_id
           IS DISTINCT FROM OLD.meta->>'exchange_trader_id'
      OR v_admission.raw_meta_sha256 IS DISTINCT FROM
        arena.position_history_raw_meta_sha256(OLD.meta)
      OR v_admission.raw_snapshot_sha256 IS DISTINCT FROM
        arena.position_history_raw_snapshot_sha256(
          OLD.id,
          OLD.source_id,
          OLD.job_type,
          OLD.trader_id,
          OLD.timeframe,
          OLD.fetched_at,
          OLD.storage_path,
          OLD.bytes,
          OLD.content_hash,
          arena.position_history_raw_meta_sha256(OLD.meta)
        )
    ) THEN
      RAISE EXCEPTION 'position-history RAW admission authority drifted'
        USING ERRCODE = '55000';
    END IF;

    IF NOT v_has_admission THEN
      IF OLD.quarantined THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'unadmitted position-history RAW must be quarantined before deletion'
        USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM arena.position_history_acquisitions AS acquisition
      JOIN arena.position_history_publications AS publication
        ON publication.acquisition_id = acquisition.acquisition_id
       AND publication.source_run_id = acquisition.source_run_id
       AND publication.source_id = acquisition.source_id
       AND publication.trader_id = acquisition.trader_id
      WHERE acquisition.raw_object_id = OLD.id
        AND acquisition.source_run_id = v_admission.source_run_id
        AND acquisition.source_id = v_admission.source_id
        AND acquisition.trader_id = v_admission.trader_id
        AND acquisition.source_slug = v_admission.source_slug
        AND acquisition.exchange_trader_id =
          v_admission.exchange_trader_id
        AND acquisition.raw_storage_path = v_admission.storage_path
        AND acquisition.raw_content_hash = v_admission.content_hash
        AND acquisition.raw_bytes = v_admission.bytes
        AND acquisition.raw_fetched_at = v_admission.fetched_at
        AND acquisition.raw_meta = OLD.meta
    ) THEN
      RAISE EXCEPTION
        'unpublished position-history RAW evidence cannot be deleted'
        USING ERRCODE = '42501';
    END IF;

    RETURN OLD;
  END IF;

  v_old_eligible := arena.position_history_raw_is_eligible(
    OLD.job_type,
    OLD.meta
  );
  v_new_eligible := arena.position_history_raw_is_eligible(
    NEW.job_type,
    NEW.meta
  );

  IF v_old_eligible OR v_new_eligible THEN
    IF NOT v_old_eligible
       OR NOT v_new_eligible
       OR OLD.quarantined
       OR NOT NEW.quarantined
       OR (pg_catalog.to_jsonb(NEW) - 'quarantined')
            IS DISTINCT FROM
          (pg_catalog.to_jsonb(OLD) - 'quarantined') THEN
      RAISE EXCEPTION 'position-history RAW evidence cannot be mutated'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION arena.protect_position_history_raw_evidence()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.protect_position_history_raw_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION arena.publish_verified_position_history(
  p_raw_object_id bigint,
  p_source_run_id text,
  p_previous_publication_id bigint,
  p_publication_text text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_publication_json json;
  v_publication jsonb;
  v_rows_json json;
  v_rows jsonb;
  v_publication_sha256 text;
  v_raw arena.raw_objects%ROWTYPE;
  v_admission arena.position_history_raw_admissions%ROWTYPE;
  v_meta jsonb;
  v_contract record;
  v_existing record;
  v_latest record;
  v_page record;
  v_page_row record;
  v_observation record;
  v_row_element record;
  v_existing_fact_row record;
  v_fact jsonb;
  v_raw_row jsonb;
  v_fact_json json;
  v_raw_row_json json;
  v_field_sources jsonb;
  v_fact_canonical_json text;
  v_raw_row_canonical_json text;
  v_attempt_started_at timestamptz;
  v_observed_at timestamptz;
  v_starting_cursor timestamptz;
  v_page_fetched_at timestamptz;
  v_previous_page_fetched_at timestamptz;
  v_previous_completed_closed_at timestamptz;
  v_terminal_min_closed_at timestamptz;
  v_opened_at timestamptz;
  v_closed_at timestamptz;
  v_cursor_after timestamptz;
  v_terminal_cursor timestamptz;
  v_overlap_at timestamptz;
  v_page_count integer;
  v_row_count integer;
  v_binding_count integer;
  v_partial_row_count integer;
  v_distinct_dedupe_count bigint;
  v_distinct_source_fact_count bigint;
  v_binding_mismatch_count bigint;
  v_manifest_row_count integer := 0;
  v_manifest_fact_count integer := 0;
  v_manifest_partial_count integer := 0;
  v_verifier_row_count integer := 0;
  v_unique_fact_count integer := 0;
  v_new_fact_count integer := 0;
  v_page_ordinal integer;
  v_row_ordinal integer;
  v_observation_count integer;
  v_previous_observation_ordinal integer := 0;
  v_closing_terminal_ordinal integer;
  v_segment_local_index integer := 0;
  v_matching_fact_count integer;
  v_page_source_row_count integer;
  v_fact_id bigint;
  v_acquisition_id bigint;
  v_publication_id bigint;
  v_terminal_state text;
  v_segment text;
  v_classification text;
  v_previous_segment text;
  v_reason text;
  v_page_terminal_reason text;
  v_dedupe_hash text;
  v_recomputed_dedupe text;
  v_source_fact_id text;
  v_numeric_field text;
  v_claim_field text;
  v_fact_field text;
  v_constraint_name text;
  v_fact_number double precision;
  v_expected_claim boolean;
  v_okx_materialized_rows_started boolean := false;
  v_prior_page_overlaps boolean := false;
BEGIN
  IF session_user IS DISTINCT FROM 'postgres'
     OR current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'verified position-history publication is postgres-owner-only'
      USING ERRCODE = '42501';
  END IF;

  IF p_raw_object_id IS NULL OR p_raw_object_id <= 0
     OR p_source_run_id IS NULL
     OR p_source_run_id !~ '^[0-9a-f]{64}$'
     OR p_source_run_id = pg_catalog.repeat('0', 64)
     OR p_previous_publication_id IS NOT NULL
        AND p_previous_publication_id <= 0
     OR p_publication_text IS NULL
     OR pg_catalog.octet_length(p_publication_text) > 67108864 THEN
    RAISE EXCEPTION 'invalid verified position-history publication arguments'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_publication_json := p_publication_text::json;
    IF arena.position_history_json_has_duplicate_keys(v_publication_json) THEN
      RAISE EXCEPTION 'verified position-history RPC payload repeats an object key';
    END IF;
    v_publication := v_publication_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'verified position-history RPC payload is not exact duplicate-free JSON'
      USING ERRCODE = '22023';
  END;

  IF NOT arena.position_history_exact_jsonb_keys(
       v_publication,
       ARRAY[
         'adapter_slug',
         'binding_set_sha256',
         'bindings_canonical_json',
         'contract',
         'exchange_trader_id',
         'history_kind',
         'observed_at',
         'page_count',
         'parser_contract',
         'previous_publication_id',
         'raw_object_id',
         'serialization_contract',
         'source_contract',
         'source_id',
         'source_run_id',
         'source_slug',
         'starting_cursor',
         'trader_id'
       ]::text[]
     )
     OR v_publication->>'contract' IS DISTINCT FROM
        'arena.ingest.verified-position-history-rpc-payload@2'
     OR v_publication->>'serialization_contract' IS DISTINCT FROM
        'arena.strict-canonical-json@1'
     OR v_publication->>'history_kind' IS DISTINCT FROM 'position_history'
     OR v_publication->>'source_run_id' IS DISTINCT FROM p_source_run_id
     OR v_publication->>'binding_set_sha256' !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(
       v_publication->'bindings_canonical_json'
     ) <> 'string'
     OR pg_catalog.jsonb_typeof(v_publication->'raw_object_id') <> 'number'
     OR (v_publication->>'raw_object_id')::numeric <>
        pg_catalog.trunc((v_publication->>'raw_object_id')::numeric)
     OR (v_publication->>'raw_object_id')::numeric
        IS DISTINCT FROM p_raw_object_id::numeric THEN
    RAISE EXCEPTION 'invalid verified position-history RPC payload'
      USING ERRCODE = '22023';
  END IF;

  IF p_previous_publication_id IS NULL THEN
    IF v_publication->'previous_publication_id' <> 'null'::jsonb THEN
      RAISE EXCEPTION 'payload previous publication identity is not exact'
        USING ERRCODE = '22023';
    END IF;
  ELSIF pg_catalog.jsonb_typeof(
          v_publication->'previous_publication_id'
        ) <> 'number'
     OR (v_publication->>'previous_publication_id')::numeric <>
        pg_catalog.trunc((v_publication->>'previous_publication_id')::numeric)
     OR (v_publication->>'previous_publication_id')::numeric
        IS DISTINCT FROM p_previous_publication_id::numeric THEN
    RAISE EXCEPTION 'payload previous publication identity is not exact'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_rows_json := (v_publication->>'bindings_canonical_json')::json;
    IF arena.position_history_json_has_duplicate_keys(v_rows_json) THEN
      RAISE EXCEPTION 'bindings_canonical_json repeats an object key';
    END IF;
    v_rows := v_rows_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'bindings_canonical_json is not exact duplicate-free JSON'
      USING ERRCODE = '22023';
  END;
  IF pg_catalog.jsonb_typeof(v_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(v_rows) > 100000
     OR arena.position_history_text_sha256(
          v_publication->>'bindings_canonical_json'
        ) IS DISTINCT FROM v_publication->>'binding_set_sha256' THEN
    RAISE EXCEPTION
      'bindings_canonical_json or binding_set_sha256 is not exact'
      USING ERRCODE = '22023';
  END IF;
  v_binding_count := pg_catalog.jsonb_array_length(v_rows);
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE binding.value->>'classification' = 'canonical_materialized'
    ),
    pg_catalog.count(*) FILTER (
      WHERE binding.value->>'classification' = 'source_partial_omitted'
    )
  INTO v_row_count, v_partial_row_count
  FROM pg_catalog.jsonb_array_elements(v_rows) AS binding(value);
  IF v_binding_count <> v_row_count + v_partial_row_count THEN
    RAISE EXCEPTION 'publication binding classifications are not exact'
      USING ERRCODE = '22023';
  END IF;
  -- Detect duplicate parser identities set-wise. The previous JSONB map
  -- concatenation copied an ever-growing object for every row (O(n^2) at the
  -- 100k contract bound). Malformed embedded facts also fail closed here and
  -- are diagnosed more precisely by the per-row validator below.
  BEGIN
    SELECT
      pg_catalog.count(DISTINCT parsed.fact->>'dedupe_hash'),
      pg_catalog.count(DISTINCT parsed.fact->>'source_fact_id')
    INTO v_distinct_dedupe_count, v_distinct_source_fact_count
    FROM pg_catalog.jsonb_array_elements(v_rows) AS binding(value)
    CROSS JOIN LATERAL (
      SELECT (binding.value->>'fact_canonical_json')::jsonb AS fact
    ) AS parsed
    WHERE binding.value->>'classification' = 'canonical_materialized';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'publication facts are not parseable identity envelopes'
      USING ERRCODE = '22023';
  END;
  IF v_distinct_dedupe_count IS DISTINCT FROM v_row_count::bigint
     OR v_distinct_source_fact_count IS DISTINCT FROM v_row_count::bigint THEN
    RAISE EXCEPTION 'publication repeats a parser dedupe or source fact identity'
      USING ERRCODE = '23505';
  END IF;
  v_publication_sha256 := arena.position_history_text_sha256(
    p_publication_text
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.position-history-source-run:' || p_source_run_id,
      0
    )
  );

  SELECT
    publication.publication_id,
    publication.previous_publication_id,
    publication.parsed_row_count,
    publication.binding_count,
    publication.partial_row_count,
    publication.binding_set_sha256,
    publication.publication_sha256,
    publication.publication_payload,
    publication.cursor_after,
    publication.observed_at,
    acquisition.raw_object_id
  INTO v_existing
  FROM arena.position_history_publications AS publication
  JOIN arena.position_history_acquisitions AS acquisition
    ON acquisition.acquisition_id = publication.acquisition_id
  WHERE publication.source_run_id = p_source_run_id;

  IF FOUND THEN
    IF v_existing.raw_object_id IS DISTINCT FROM p_raw_object_id
       OR v_existing.previous_publication_id
            IS DISTINCT FROM p_previous_publication_id
       OR v_existing.parsed_row_count IS DISTINCT FROM v_row_count
       OR v_existing.binding_count IS DISTINCT FROM v_binding_count
       OR v_existing.partial_row_count IS DISTINCT FROM v_partial_row_count
       OR v_existing.binding_set_sha256
            IS DISTINCT FROM v_publication->>'binding_set_sha256'
       OR v_existing.publication_sha256
            IS DISTINCT FROM v_publication_sha256
       OR v_existing.publication_payload
            IS DISTINCT FROM p_publication_text THEN
      RAISE EXCEPTION
        'source_run replay conflicts with its immutable publication'
        USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'cursorAfter', v_existing.cursor_after,
      'factsAdded', 0,
      'factsReused', v_existing.parsed_row_count,
      'observedAt', v_existing.observed_at,
      'publicationId', v_existing.publication_id,
      'publicationSha256', v_existing.publication_sha256,
      'rawObjectId', v_existing.raw_object_id,
      'replayed', true,
      'sourceRunId', p_source_run_id,
      'stateId', v_existing.publication_id
    );
  END IF;

  SELECT raw_row.*
  INTO STRICT v_raw
  FROM arena.raw_objects AS raw_row
  WHERE raw_row.id = p_raw_object_id
  FOR UPDATE;

  SELECT admission.*
  INTO v_admission
  FROM arena.position_history_raw_admissions AS admission
  WHERE admission.raw_object_id = p_raw_object_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'position-history RAW did not cross the immutable admission boundary'
      USING ERRCODE = '22023';
  END IF;

  v_meta := v_raw.meta;
  IF NOT arena.position_history_exact_jsonb_keys(
    v_meta,
    ARRAY[
      'attempt_started_at',
      'capture_config',
      'data_contract',
      'exchange_trader_id',
      'history_evidence_contract',
      'history_kind',
      'observed_at',
      'page_count',
      'page_manifest',
      'parser_contract',
      'raw_integrity',
      'source_contract',
      'source_run_id',
      'source_slug',
      'starting_cursor',
      'termination',
      'verifier_contract'
    ]::text[]
  ) THEN
    RAISE EXCEPTION
      'event_history RAW metadata requires the exact reviewed 17-key contract'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    contract_row.source_id,
    contract_row.source_slug,
    contract_row.adapter_slug,
    contract_row.source_contract,
    contract_row.parser_contract,
    contract_row.terminal_verifier_contract,
    contract_row.page_size,
    contract_row.serving_return_scale,
    contract_row.allowed_field_paths,
    contract_row.source_currency,
    trader_row.exchange_trader_id AS registered_exchange_trader_id
  INTO v_contract
  FROM arena.position_history_source_contracts AS contract_row
  JOIN arena.sources AS source_row
    ON source_row.id = contract_row.source_id
   AND source_row.slug = contract_row.source_slug
   AND source_row.adapter_slug = contract_row.adapter_slug
   AND source_row.currency = contract_row.source_currency
  JOIN arena.traders AS trader_row
    ON trader_row.id = v_raw.trader_id
   AND trader_row.source_id = source_row.id
  WHERE contract_row.source_id = v_raw.source_id
  FOR SHARE OF source_row, trader_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAW source/trader does not have a reviewed source contract'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.position_history_raw_is_eligible(v_raw.job_type, v_meta)
     OR v_raw.job_type IS DISTINCT FROM 'history:position_history'
     OR v_raw.trader_id IS NULL
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.quarantined
     OR v_raw.bytes <= 0
     OR v_admission.source_run_id IS DISTINCT FROM p_source_run_id
     OR v_admission.raw_object_id IS DISTINCT FROM v_raw.id
     OR v_admission.source_id IS DISTINCT FROM v_raw.source_id
     OR v_admission.job_type IS DISTINCT FROM v_raw.job_type
     OR v_admission.trader_id IS DISTINCT FROM v_raw.trader_id
     OR v_admission.timeframe IS DISTINCT FROM v_raw.timeframe
     OR v_admission.fetched_at IS DISTINCT FROM v_raw.fetched_at
     OR v_admission.storage_path IS DISTINCT FROM v_raw.storage_path
     OR v_admission.bytes IS DISTINCT FROM v_raw.bytes
     OR v_admission.content_hash IS DISTINCT FROM v_raw.content_hash
     OR v_admission.source_slug IS DISTINCT FROM v_meta->>'source_slug'
     OR v_admission.exchange_trader_id
          IS DISTINCT FROM v_meta->>'exchange_trader_id'
     OR v_admission.raw_meta_sha256 IS DISTINCT FROM
       arena.position_history_raw_meta_sha256(v_meta)
     OR v_admission.raw_snapshot_sha256 IS DISTINCT FROM
       arena.position_history_raw_snapshot_sha256(
         v_raw.id,
         v_raw.source_id,
         v_raw.job_type,
         v_raw.trader_id,
         v_raw.timeframe,
         v_raw.fetched_at,
         v_raw.storage_path,
         v_raw.bytes,
         v_raw.content_hash,
         arena.position_history_raw_meta_sha256(v_meta)
       )
     OR NOT arena.position_history_text_is_canonical(
       v_contract.registered_exchange_trader_id, 1, 512
     )
     OR (
       v_contract.source_slug IN ('binance_futures', 'okx_futures')
       AND pg_catalog.strpos(
         v_contract.registered_exchange_trader_id, '|'
       ) > 0
     )
     OR v_raw.content_hash IS DISTINCT FROM p_source_run_id
     OR v_raw.storage_path IS DISTINCT FROM
       v_contract.source_slug || '/history_trust/position_history/' ||
       p_source_run_id || '/event_history_' || p_source_run_id || '.json.gz'
     OR v_meta->>'source_run_id' IS DISTINCT FROM p_source_run_id
     OR v_meta->>'source_slug' IS DISTINCT FROM v_contract.source_slug
     OR v_meta->>'exchange_trader_id'
          IS DISTINCT FROM v_contract.registered_exchange_trader_id
     OR v_meta->>'history_kind' IS DISTINCT FROM 'position_history'
     OR v_meta->>'data_contract' IS DISTINCT FROM
        'arena.ingest.history-acquisition-artifact@1'
     OR v_meta->>'history_evidence_contract' IS DISTINCT FROM
        'arena.position-history-publication-evidence@2'
     OR v_meta->>'source_contract' IS DISTINCT FROM v_contract.source_contract
     OR v_meta->>'parser_contract' IS DISTINCT FROM v_contract.parser_contract
     OR v_meta->>'verifier_contract'
          IS DISTINCT FROM v_contract.terminal_verifier_contract
     OR v_publication->>'source_contract'
          IS DISTINCT FROM v_contract.source_contract
     OR v_publication->>'parser_contract'
          IS DISTINCT FROM v_contract.parser_contract
     OR v_publication->>'adapter_slug'
          IS DISTINCT FROM v_contract.adapter_slug
     OR v_publication->>'source_slug'
          IS DISTINCT FROM v_contract.source_slug
     OR v_publication->>'exchange_trader_id'
          IS DISTINCT FROM v_contract.registered_exchange_trader_id
     OR pg_catalog.jsonb_typeof(v_publication->'source_id') <> 'number'
     OR (v_publication->>'source_id')::numeric
          IS DISTINCT FROM v_raw.source_id::numeric
     OR pg_catalog.jsonb_typeof(v_publication->'trader_id') <> 'number'
     OR (v_publication->>'trader_id')::numeric
          IS DISTINCT FROM v_raw.trader_id::numeric THEN
    RAISE EXCEPTION
      'RAW pointer, source, trader, parser, or verifier contract is not exact'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.position_history_exact_jsonb_keys(
       v_meta->'capture_config', ARRAY['caller_page_cap']::text[]
     )
     OR NOT (
       v_meta->'capture_config'->'caller_page_cap' = 'null'::jsonb
       OR (
         pg_catalog.jsonb_typeof(
           v_meta->'capture_config'->'caller_page_cap'
         ) = 'number'
         AND (v_meta->'capture_config'->>'caller_page_cap')::numeric =
           pg_catalog.trunc(
             (v_meta->'capture_config'->>'caller_page_cap')::numeric
           )
         AND (v_meta->'capture_config'->>'caller_page_cap')::numeric
           BETWEEN 1 AND 100000
       )
     ) THEN
    RAISE EXCEPTION 'event_history capture_config is not exact'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.position_history_exact_jsonb_keys(
    v_meta->'raw_integrity',
    ARRAY[
      'compressed_bytes',
      'compression',
      'content_type',
      'encoding',
      'hash_algorithm',
      'hash_scope',
      'serialization_contract',
      'uncompressed_bytes',
      'version'
    ]::text[]
  )
     OR pg_catalog.jsonb_typeof(
       v_meta->'raw_integrity'->'version'
     ) <> 'number'
     OR (v_meta->'raw_integrity'->>'version')::numeric <> 1
     OR v_meta->'raw_integrity'->>'content_type'
          IS DISTINCT FROM 'application/json'
     OR v_meta->'raw_integrity'->>'encoding' IS DISTINCT FROM 'utf-8'
     OR v_meta->'raw_integrity'->>'compression' IS DISTINCT FROM 'gzip'
     OR v_meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
     OR v_meta->'raw_integrity'->>'serialization_contract'
          IS DISTINCT FROM 'arena.strict-canonical-json@1'
     OR pg_catalog.jsonb_typeof(
       v_meta->'raw_integrity'->'compressed_bytes'
     ) <> 'number'
     OR (v_meta->'raw_integrity'->>'compressed_bytes')::numeric <= 0
     OR (v_meta->'raw_integrity'->>'compressed_bytes')::numeric <>
       pg_catalog.trunc(
         (v_meta->'raw_integrity'->>'compressed_bytes')::numeric
       )
     OR (v_meta->'raw_integrity'->>'compressed_bytes')::numeric
          IS DISTINCT FROM v_raw.bytes::numeric
     OR pg_catalog.jsonb_typeof(
       v_meta->'raw_integrity'->'uncompressed_bytes'
     ) <> 'number'
     OR (v_meta->'raw_integrity'->>'uncompressed_bytes')::numeric <= 0
     OR (v_meta->'raw_integrity'->>'uncompressed_bytes')::numeric <>
       pg_catalog.trunc(
         (v_meta->'raw_integrity'->>'uncompressed_bytes')::numeric
       ) THEN
    RAISE EXCEPTION 'event_history RAW integrity metadata is not exact'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(v_meta->'page_count') <> 'number'
     OR (v_meta->>'page_count')::numeric < 1
     OR (v_meta->>'page_count')::numeric > 100000
     OR (v_meta->>'page_count')::numeric <>
        pg_catalog.trunc((v_meta->>'page_count')::numeric)
     OR pg_catalog.jsonb_typeof(v_meta->'page_manifest') <> 'array'
     OR NOT arena.position_history_canonical_timestamp(
       v_meta->>'attempt_started_at'
     )
     OR NOT arena.position_history_canonical_timestamp(v_meta->>'observed_at')
     OR NOT (
       v_meta->'starting_cursor' = 'null'::jsonb
       OR arena.position_history_canonical_timestamp(
         v_meta->>'starting_cursor'
       )
     ) THEN
    RAISE EXCEPTION 'event_history count or clock contract is not canonical'
      USING ERRCODE = '22023';
  END IF;

  v_page_count := (v_meta->>'page_count')::integer;
  v_attempt_started_at := (v_meta->>'attempt_started_at')::timestamptz;
  v_observed_at := (v_meta->>'observed_at')::timestamptz;
  v_starting_cursor := CASE
    WHEN v_meta->'starting_cursor' = 'null'::jsonb THEN NULL
    ELSE (v_meta->>'starting_cursor')::timestamptz
  END;

  IF pg_catalog.jsonb_array_length(v_meta->'page_manifest') <> v_page_count
     OR v_raw.fetched_at IS DISTINCT FROM v_observed_at
     OR v_attempt_started_at > v_observed_at
     OR v_starting_cursor > v_observed_at
     OR v_publication->>'observed_at' IS DISTINCT FROM v_meta->>'observed_at'
     OR pg_catalog.jsonb_typeof(v_publication->'page_count') <> 'number'
     OR (v_publication->>'page_count')::numeric
          IS DISTINCT FROM v_page_count::numeric THEN
    RAISE EXCEPTION
      'event_history acquisition clocks or publication count are inconsistent'
      USING ERRCODE = '22023';
  END IF;
  IF v_starting_cursor IS NULL THEN
    IF v_publication->'starting_cursor' <> 'null'::jsonb THEN
      RAISE EXCEPTION 'publication starting cursor is not exact'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_publication->>'starting_cursor'
          IS DISTINCT FROM v_meta->>'starting_cursor' THEN
    RAISE EXCEPTION 'publication starting cursor is not exact'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.position_history_exact_jsonb_keys(
       v_meta->'termination',
       ARRAY[
         'blocker_reasons',
         'claim_observations',
         'evidence_state',
         'overlap_event_at',
         'scan_terminal_state',
         'terminal_cursor_value',
         'verifier_contract'
       ]::text[]
     )
     OR v_meta->'termination'->>'evidence_state' IS DISTINCT FROM 'verified'
     OR v_meta->'termination'->>'verifier_contract'
          IS DISTINCT FROM v_contract.terminal_verifier_contract
     OR v_meta->'termination'->'blocker_reasons' IS DISTINCT FROM '[]'::jsonb
     OR pg_catalog.jsonb_typeof(
       v_meta->'termination'->'claim_observations'
     ) <> 'array'
     OR pg_catalog.jsonb_array_length(
       v_meta->'termination'->'claim_observations'
     ) NOT BETWEEN 1 AND 8
     OR v_meta->'termination'->>'scan_terminal_state'
          NOT IN ('exhausted', 'cursor_overlap') THEN
    RAISE EXCEPTION 'verified terminal evidence envelope is not exact'
      USING ERRCODE = '22023';
  END IF;

  v_terminal_state := v_meta->'termination'->>'scan_terminal_state';
  v_observation_count := pg_catalog.jsonb_array_length(
    v_meta->'termination'->'claim_observations'
  );
  FOR v_observation IN
    SELECT observation.value, observation.ordinality
    FROM pg_catalog.jsonb_array_elements(
      v_meta->'termination'->'claim_observations'
    ) WITH ORDINALITY AS observation(value, ordinality)
    ORDER BY observation.ordinality
  LOOP
    IF NOT arena.position_history_exact_jsonb_keys(
         v_observation.value,
         ARRAY['page_ordinal', 'reason', 'segment_id']::text[]
       )
       OR pg_catalog.jsonb_typeof(v_observation.value->'page_ordinal') <> 'number'
       OR (v_observation.value->>'page_ordinal')::numeric <>
          pg_catalog.trunc((v_observation.value->>'page_ordinal')::numeric)
       OR (v_observation.value->>'page_ordinal')::integer
          NOT BETWEEN 1 AND v_page_count
       OR (v_observation.value->>'page_ordinal')::integer
          <= v_previous_observation_ordinal
       OR v_observation.value->>'reason' NOT IN (
         'empty_page', 'short_page', 'reported_end',
         'cursor_overlap', 'snapshot_complete'
       )
       OR v_observation.value->>'segment_id'
          !~ '^[a-z0-9][a-z0-9_]{0,63}$' THEN
      RAISE EXCEPTION 'verified history terminal observation is not exact'
        USING ERRCODE = '22023';
    END IF;
    v_previous_observation_ordinal :=
      (v_observation.value->>'page_ordinal')::integer;
  END LOOP;

  IF v_contract.source_slug = 'binance_futures' THEN
    IF v_starting_cursor IS NULL THEN
      IF v_observation_count <> 2
         OR v_meta->'termination'->'claim_observations'->0->>'segment_id'
              IS DISTINCT FROM 'closing'
         OR v_meta->'termination'->'claim_observations'->1->>'segment_id'
              IS DISTINCT FROM 'opening'
         OR v_meta->'termination'->'claim_observations'->0->>'reason'
              NOT IN ('reported_end', 'empty_page')
         OR v_meta->'termination'->'claim_observations'->1->>'reason'
              NOT IN ('reported_end', 'empty_page')
         OR (v_meta->'termination'->'claim_observations'->1->>'page_ordinal')::integer
              <> v_page_count
         OR v_terminal_state <> 'exhausted' THEN
        RAISE EXCEPTION 'Binance initial terminal segment contract is not exact'
          USING ERRCODE = '22023';
      END IF;
      v_closing_terminal_ordinal :=
        (v_meta->'termination'->'claim_observations'->0->>'page_ordinal')::integer;
    ELSE
      IF v_observation_count <> 1
         OR v_meta->'termination'->'claim_observations'->0->>'segment_id'
              IS DISTINCT FROM 'closing'
         OR v_meta->'termination'->'claim_observations'->0->>'reason'
              NOT IN ('reported_end', 'empty_page', 'cursor_overlap')
         OR (v_meta->'termination'->'claim_observations'->0->>'page_ordinal')::integer
              <> v_page_count THEN
        RAISE EXCEPTION 'Binance continuation terminal segment contract is not exact'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  ELSE
    IF v_observation_count <> 1
       OR v_meta->'termination'->'claim_observations'->0->>'segment_id'
            IS DISTINCT FROM 'default'
       OR (v_meta->'termination'->'claim_observations'->0->>'page_ordinal')::integer
            <> v_page_count
       OR (
         v_contract.source_slug = 'bitget_futures'
         AND v_meta->'termination'->'claim_observations'->0->>'reason'
             NOT IN ('reported_end', 'short_page', 'empty_page', 'cursor_overlap')
       )
       OR (
         v_contract.source_slug = 'okx_futures'
         AND v_meta->'termination'->'claim_observations'->0->>'reason'
             NOT IN ('empty_page', 'cursor_overlap')
       ) THEN
      RAISE EXCEPTION 'source terminal segment contract is not exact'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_reason := v_meta->'termination'->'claim_observations'->
    (v_observation_count - 1)->>'reason';
  IF (v_reason = 'cursor_overlap') <> (v_terminal_state = 'cursor_overlap') THEN
    RAISE EXCEPTION 'terminal reason and scan state disagree'
      USING ERRCODE = '22023';
  END IF;
  IF v_terminal_state = 'cursor_overlap' THEN
    IF v_starting_cursor IS NULL
       OR NOT arena.position_history_canonical_timestamp(
         v_meta->'termination'->>'terminal_cursor_value'
       )
       OR NOT arena.position_history_canonical_timestamp(
         v_meta->'termination'->>'overlap_event_at'
       )
       OR v_meta->'termination'->>'terminal_cursor_value'
            IS DISTINCT FROM v_meta->>'starting_cursor' THEN
      RAISE EXCEPTION 'cursor-overlap terminal clocks are not exact'
        USING ERRCODE = '22023';
    END IF;
    v_terminal_cursor :=
      (v_meta->'termination'->>'terminal_cursor_value')::timestamptz;
    v_overlap_at := (v_meta->'termination'->>'overlap_event_at')::timestamptz;
    IF v_terminal_cursor IS DISTINCT FROM v_starting_cursor
       OR v_overlap_at > v_terminal_cursor
       OR v_overlap_at > v_observed_at THEN
      RAISE EXCEPTION 'cursor-overlap evidence is outside the verified clocks'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_meta->'termination'->'terminal_cursor_value' <> 'null'::jsonb
     OR v_meta->'termination'->'overlap_event_at' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'exhausted evidence cannot carry cursor-overlap clocks'
      USING ERRCODE = '22023';
  END IF;

  v_previous_page_fetched_at := v_attempt_started_at;
  FOR v_page IN
    SELECT page_element.value, page_element.ordinality
    FROM pg_catalog.jsonb_array_elements(v_meta->'page_manifest')
      WITH ORDINALITY AS page_element(value, ordinality)
    ORDER BY page_element.ordinality
  LOOP
    IF NOT arena.position_history_exact_jsonb_keys(
         v_page.value,
         ARRAY[
           'classification',
           'fetched_at',
           'ordinal',
           'payload_sha256',
           'segment_id',
           'source_rows',
           'stored_page_index'
         ]::text[]
       )
       OR pg_catalog.jsonb_typeof(v_page.value->'ordinal') <> 'number'
       OR (v_page.value->>'ordinal')::numeric
          IS DISTINCT FROM v_page.ordinality::numeric
       OR NOT arena.position_history_canonical_timestamp(
         v_page.value->>'fetched_at'
       )
       OR v_page.value->>'payload_sha256' !~ '^[0-9a-f]{64}$'
       OR v_page.value->>'payload_sha256' = pg_catalog.repeat('0', 64)
       OR pg_catalog.jsonb_typeof(v_page.value->'stored_page_index') <> 'number'
       OR (v_page.value->>'stored_page_index')::numeric <>
          pg_catalog.trunc((v_page.value->>'stored_page_index')::numeric)
       OR pg_catalog.jsonb_typeof(v_page.value->'source_rows') <> 'array' THEN
      RAISE EXCEPTION 'page_manifest entry is not exact at ordinal %',
        v_page.ordinality USING ERRCODE = '22023';
    END IF;

    v_page_ordinal := v_page.ordinality::integer;
    v_page_fetched_at := (v_page.value->>'fetched_at')::timestamptz;
    IF v_contract.source_slug = 'binance_futures' THEN
      IF v_starting_cursor IS NULL
         AND v_page_ordinal > v_closing_terminal_ordinal THEN
        v_segment := 'opening';
        v_classification := 'verifier_only';
      ELSE
        v_segment := 'closing';
        v_classification := 'canonical_materialized';
      END IF;
    ELSE
      v_segment := 'default';
      v_classification := 'canonical_materialized';
    END IF;
    IF v_page.value->>'segment_id' IS DISTINCT FROM v_segment
       OR v_page.value->>'classification' IS DISTINCT FROM v_classification THEN
      RAISE EXCEPTION 'page_manifest segment or classification is not reviewed'
        USING ERRCODE = '22023';
    END IF;

    IF v_previous_segment IS DISTINCT FROM v_segment THEN
      v_segment_local_index := 1;
      v_previous_segment := v_segment;
    ELSE
      v_segment_local_index := v_segment_local_index + 1;
    END IF;
    IF (v_page.value->>'stored_page_index')::integer <> v_segment_local_index THEN
      RAISE EXCEPTION
        'page_manifest stored page index is not segment-local and contiguous'
        USING ERRCODE = '22023';
    END IF;
    IF v_page_fetched_at < v_previous_page_fetched_at
       OR v_page_fetched_at > v_observed_at THEN
      RAISE EXCEPTION 'page_manifest has an inconsistent fetched_at'
        USING ERRCODE = '22023';
    END IF;
    v_previous_page_fetched_at := v_page_fetched_at;

    v_page_source_row_count :=
      pg_catalog.jsonb_array_length(v_page.value->'source_rows');
    IF v_page_source_row_count > v_contract.page_size THEN
      RAISE EXCEPTION 'page_manifest exceeds the reviewed source page size'
        USING ERRCODE = '22023';
    END IF;

    SELECT observation.value->>'reason'
    INTO v_page_terminal_reason
    FROM pg_catalog.jsonb_array_elements(
      v_meta->'termination'->'claim_observations'
    ) AS observation(value)
    WHERE (observation.value->>'page_ordinal')::integer = v_page_ordinal
      AND observation.value->>'segment_id' = v_segment;

    -- Re-prove every terminal cardinality that is visible in the immutable
    -- manifest. Envelope-only facts such as Bitget nextFlag and Binance total
    -- remain in the reviewed TypeScript verifier TCB.
    IF v_page_terminal_reason = 'empty_page'
       AND v_page_source_row_count <> 0 THEN
      RAISE EXCEPTION 'empty-page terminal evidence contains source rows'
        USING ERRCODE = '22023';
    ELSIF v_page_terminal_reason = 'short_page'
       AND (
         v_contract.source_slug IS DISTINCT FROM 'bitget_futures'
         OR v_page_source_row_count NOT BETWEEN 1 AND
           (v_contract.page_size - 1)
       ) THEN
      RAISE EXCEPTION 'short-page terminal cardinality is not exact'
        USING ERRCODE = '22023';
    ELSIF v_page_terminal_reason = 'cursor_overlap'
       AND (
         v_page_source_row_count = 0
         OR (
           v_contract.source_slug = 'bitget_futures'
           AND v_page_source_row_count <> v_contract.page_size
         )
       ) THEN
      RAISE EXCEPTION 'cursor-overlap terminal cardinality is not exact'
        USING ERRCODE = '22023';
    ELSIF v_page_terminal_reason IS NULL
       AND (
         (
           v_contract.source_slug = 'bitget_futures'
           AND v_page_source_row_count <> v_contract.page_size
         ) OR (
           v_contract.source_slug IN ('binance_futures', 'okx_futures')
           AND v_page_source_row_count = 0
         )
       ) THEN
      RAISE EXCEPTION 'nonterminal reviewed page cardinality is not exact'
        USING ERRCODE = '22023';
    END IF;

    FOR v_page_row IN
      SELECT source_row.value, source_row.ordinality
      FROM pg_catalog.jsonb_array_elements(v_page.value->'source_rows')
        WITH ORDINALITY AS source_row(value, ordinality)
      ORDER BY source_row.ordinality
    LOOP
      IF NOT arena.position_history_exact_jsonb_keys(
           v_page_row.value,
           ARRAY[
             'classification',
             'source_row_ordinal',
             'source_row_sha256'
           ]::text[]
         )
         OR pg_catalog.jsonb_typeof(
           v_page_row.value->'source_row_ordinal'
         ) <> 'number'
         OR (v_page_row.value->>'source_row_ordinal')::numeric
            IS DISTINCT FROM v_page_row.ordinality::numeric
         OR v_page_row.value->>'source_row_sha256' !~ '^[0-9a-f]{64}$'
         OR v_page_row.value->>'source_row_sha256' =
            pg_catalog.repeat('0', 64) THEN
        RAISE EXCEPTION 'page_manifest source-row binding is not exact'
          USING ERRCODE = '22023';
      END IF;

      IF v_classification = 'verifier_only' THEN
        IF v_page_row.value->>'classification'
             IS DISTINCT FROM 'verifier_only' THEN
          RAISE EXCEPTION
            'verifier-only page carries a publishable source-row classification'
            USING ERRCODE = '22023';
        END IF;
        v_verifier_row_count := v_verifier_row_count + 1;
      ELSIF v_contract.source_slug = 'okx_futures' THEN
        IF v_page_row.value->>'classification' = 'canonical_materialized' THEN
          v_manifest_row_count := v_manifest_row_count + 1;
          v_manifest_fact_count := v_manifest_fact_count + 1;
        ELSIF v_page_row.value->>'classification' = 'source_partial_omitted' THEN
          v_manifest_row_count := v_manifest_row_count + 1;
          v_manifest_partial_count := v_manifest_partial_count + 1;
        ELSE
          RAISE EXCEPTION
            'OKX source-row classification is outside the reviewed lifecycle domain'
            USING ERRCODE = '22023';
        END IF;
      ELSE
        IF v_page_row.value->>'classification'
             IS DISTINCT FROM 'canonical_materialized' THEN
          RAISE EXCEPTION
            'materialized page carries an unreviewed source-row classification'
            USING ERRCODE = '22023';
        END IF;
        v_manifest_row_count := v_manifest_row_count + 1;
        v_manifest_fact_count := v_manifest_fact_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  IF v_manifest_row_count <> v_binding_count
     OR v_manifest_fact_count <> v_row_count
     OR v_manifest_partial_count <> v_partial_row_count THEN
    RAISE EXCEPTION
      'publication binding/fact/partial counts do not equal the manifest'
      USING ERRCODE = '22023';
  END IF;
  IF v_manifest_partial_count > 0 AND v_terminal_state <> 'exhausted' THEN
    RAISE EXCEPTION 'source partial omissions require an exhausted acquisition'
      USING ERRCODE = '22023';
  END IF;
  IF v_previous_page_fetched_at IS DISTINCT FROM v_observed_at THEN
    RAISE EXCEPTION 'observed_at must equal the final reviewed page clock'
      USING ERRCODE = '22023';
  END IF;
  IF v_contract.source_slug = 'binance_futures'
     AND v_starting_cursor IS NULL
     AND v_verifier_row_count <> v_manifest_fact_count THEN
    RAISE EXCEPTION
      'Binance opening verifier row population does not match closing'
      USING ERRCODE = '22023';
  END IF;
  -- This count check deliberately does not claim opening/closing identity-set
  -- equality. Opening rows are verifier_only commitments: their RAW identity
  -- derivation is not carried by the @2 RPC, so exact dual-sort set equality
  -- remains a reviewed TypeScript verifier boundary. A database-independent
  -- proof requires a future protocol revision that binds each derived source
  -- identity (or the full verifier-only RAW row) into the publication RPC.
  IF v_terminal_state = 'cursor_overlap'
     AND v_contract.source_slug = 'binance_futures'
     AND v_starting_cursor >
       (v_meta->'page_manifest'->0->>'fetched_at')::timestamptz THEN
    RAISE EXCEPTION
      'Binance cursor cannot follow the first reviewed page clock'
      USING ERRCODE = '22023';
  END IF;

  -- Bind rows to the flattened manifest in one relational pass. This avoids
  -- six repeatedly-copied PL/pgSQL arrays at the 100k row upper bound.
  WITH manifest_rows AS (
    SELECT
      pg_catalog.row_number() OVER (
        ORDER BY manifest_page.ordinality, manifest_row.ordinality
      ) AS binding_ordinal,
      manifest_row.value->>'classification' AS classification,
      manifest_page.value->>'ordinal' AS page_ordinal,
      manifest_page.value->>'stored_page_index' AS page_stored_index,
      manifest_row.value->>'source_row_ordinal' AS source_row_ordinal,
      manifest_page.value->>'payload_sha256' AS page_payload_sha256,
      manifest_page.value->>'fetched_at' AS page_fetched_at,
      manifest_row.value->>'source_row_sha256' AS raw_row_sha256
    FROM pg_catalog.jsonb_array_elements(v_meta->'page_manifest')
      WITH ORDINALITY AS manifest_page(value, ordinality)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      manifest_page.value->'source_rows'
    ) WITH ORDINALITY AS manifest_row(value, ordinality)
    WHERE manifest_row.value->>'classification' <> 'verifier_only'
  ), binding_rows AS (
    SELECT binding.value, binding.ordinality AS binding_ordinal
    FROM pg_catalog.jsonb_array_elements(v_rows)
      WITH ORDINALITY AS binding(value, ordinality)
  )
  SELECT pg_catalog.count(*)
  INTO v_binding_mismatch_count
  FROM manifest_rows AS manifest
  FULL JOIN binding_rows AS binding USING (binding_ordinal)
  WHERE manifest.binding_ordinal IS NULL
     OR binding.binding_ordinal IS NULL
     OR binding.value->>'binding_ordinal'
          IS DISTINCT FROM binding.binding_ordinal::text
     OR binding.value->>'classification'
          IS DISTINCT FROM manifest.classification
     OR binding.value->>'page_ordinal'
          IS DISTINCT FROM manifest.page_ordinal
     OR binding.value->>'page_stored_index'
          IS DISTINCT FROM manifest.page_stored_index
     OR binding.value->>'source_row_ordinal'
          IS DISTINCT FROM manifest.source_row_ordinal
     OR binding.value->>'page_payload_sha256'
          IS DISTINCT FROM manifest.page_payload_sha256
     OR binding.value->>'page_fetched_at'
          IS DISTINCT FROM manifest.page_fetched_at
     OR binding.value->>'raw_row_sha256'
          IS DISTINCT FROM manifest.raw_row_sha256;
  IF v_binding_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'publication rows do not exactly bind the reviewed manifest'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.position-history-identity:' ||
      v_raw.source_id::text || ':' || v_raw.trader_id::text,
      0
    )
  );

  SELECT
    publication.publication_id,
    publication.cursor_after,
    publication.observed_at
  INTO v_latest
  FROM arena.position_history_publications AS publication
  WHERE publication.source_id = v_raw.source_id
    AND publication.trader_id = v_raw.trader_id
  ORDER BY publication.publication_id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF p_previous_publication_id IS NOT NULL OR v_starting_cursor IS NOT NULL THEN
      RAISE EXCEPTION
        'an initial verified publication cannot inherit an unverified cursor'
        USING ERRCODE = '22023';
    END IF;
    v_cursor_after := NULL;
  ELSE
    IF v_latest.publication_id IS DISTINCT FROM p_previous_publication_id
       OR v_latest.cursor_after IS DISTINCT FROM v_starting_cursor THEN
      RAISE EXCEPTION
        'continuation must bind the exact latest verified publication and cursor'
        USING ERRCODE = '40001';
    END IF;
    IF v_observed_at < v_latest.observed_at THEN
      RAISE EXCEPTION 'continuation observed_at cannot move backward'
        USING ERRCODE = '22023';
    END IF;
    v_cursor_after := v_latest.cursor_after;
  END IF;

  FOR v_row_element IN
    SELECT publication_row.value, publication_row.ordinality
    FROM pg_catalog.jsonb_array_elements(v_rows)
      WITH ORDINALITY AS publication_row(value, ordinality)
    ORDER BY publication_row.ordinality
  LOOP
    v_row_ordinal := v_row_element.ordinality::integer;
    v_classification := v_row_element.value->>'classification';
    IF NOT arena.position_history_exact_jsonb_keys(
         v_row_element.value,
         ARRAY[
           'binding_ordinal',
           'classification',
           'fact_canonical_json',
           'fact_ordinal',
           'fact_sha256',
           'page_fetched_at',
           'page_ordinal',
           'page_payload_sha256',
           'page_stored_index',
           'raw_row_canonical_json',
           'raw_row_sha256',
           'source_row_ordinal'
         ]::text[]
       )
       OR pg_catalog.jsonb_typeof(
         v_row_element.value->'raw_row_canonical_json'
       ) <> 'string'
       OR pg_catalog.jsonb_typeof(
         v_row_element.value->'binding_ordinal'
       ) <> 'number'
       OR (v_row_element.value->>'binding_ordinal')::numeric
          IS DISTINCT FROM v_row_ordinal::numeric
       OR pg_catalog.jsonb_typeof(
         v_row_element.value->'classification'
       ) <> 'string'
       OR NOT (
         (
           v_classification = 'canonical_materialized'
           AND pg_catalog.jsonb_typeof(
             v_row_element.value->'fact_canonical_json'
           ) = 'string'
           AND pg_catalog.jsonb_typeof(
             v_row_element.value->'fact_ordinal'
           ) = 'number'
           AND (v_row_element.value->>'fact_ordinal')::numeric =
             pg_catalog.trunc(
               (v_row_element.value->>'fact_ordinal')::numeric
             )
           AND (v_row_element.value->>'fact_ordinal')::numeric
             IS NOT DISTINCT FROM (v_unique_fact_count + 1)::numeric
           AND v_row_element.value->>'fact_sha256' ~ '^[0-9a-f]{64}$'
         ) OR (
           v_classification = 'source_partial_omitted'
           AND v_row_element.value->'fact_canonical_json' = 'null'::jsonb
           AND v_row_element.value->'fact_ordinal' = 'null'::jsonb
           AND v_row_element.value->'fact_sha256' = 'null'::jsonb
         )
       )
       OR pg_catalog.jsonb_typeof(v_row_element.value->'page_ordinal') <> 'number'
       OR (v_row_element.value->>'page_ordinal')::numeric <= 0
       OR (v_row_element.value->>'page_ordinal')::numeric <>
          pg_catalog.trunc((v_row_element.value->>'page_ordinal')::numeric)
       OR pg_catalog.jsonb_typeof(
         v_row_element.value->'page_stored_index'
       ) <> 'number'
       OR (v_row_element.value->>'page_stored_index')::numeric <= 0
       OR (v_row_element.value->>'page_stored_index')::numeric <>
          pg_catalog.trunc(
            (v_row_element.value->>'page_stored_index')::numeric
          )
       OR pg_catalog.jsonb_typeof(
         v_row_element.value->'source_row_ordinal'
       ) <> 'number'
       OR (v_row_element.value->>'source_row_ordinal')::numeric <= 0
       OR (v_row_element.value->>'source_row_ordinal')::numeric <>
          pg_catalog.trunc(
            (v_row_element.value->>'source_row_ordinal')::numeric
          )
       OR v_row_element.value->>'page_payload_sha256' !~ '^[0-9a-f]{64}$'
       OR v_row_element.value->>'raw_row_sha256' !~ '^[0-9a-f]{64}$'
       OR NOT arena.position_history_canonical_timestamp(
         v_row_element.value->>'page_fetched_at'
       ) THEN
      RAISE EXCEPTION 'publication row binding is not exact at ordinal %',
        v_row_ordinal USING ERRCODE = '22023';
    END IF;

    v_raw_row_canonical_json :=
      v_row_element.value->>'raw_row_canonical_json';
    IF arena.position_history_text_sha256(v_raw_row_canonical_json)
         IS DISTINCT FROM v_row_element.value->>'raw_row_sha256' THEN
      RAISE EXCEPTION 'RAW row canonical byte digest is not exact'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_raw_row_json := v_raw_row_canonical_json::json;
      IF arena.position_history_json_has_duplicate_keys(v_raw_row_json) THEN
        RAISE EXCEPTION 'RAW row repeats an object key';
      END IF;
      v_raw_row := v_raw_row_json::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'RAW row canonical text is not exact duplicate-free JSON'
        USING ERRCODE = '22023';
    END;

    v_page_fetched_at :=
      (v_row_element.value->>'page_fetched_at')::timestamptz;
    IF v_classification = 'source_partial_omitted' THEN
      IF v_contract.source_slug IS DISTINCT FROM 'okx_futures'
         OR v_terminal_state IS DISTINCT FROM 'exhausted'
         OR v_okx_materialized_rows_started
         OR NOT arena.position_history_okx_partial_row_matches_raw(
           v_contract.registered_exchange_trader_id,
           v_contract.source_currency,
           v_page_fetched_at,
           v_raw_row
         ) THEN
        RAISE EXCEPTION
          'source partial binding is outside exact reviewed OKX omission evidence'
          USING ERRCODE = '22023';
      END IF;
      CONTINUE;
    END IF;

    IF v_contract.source_slug = 'okx_futures' THEN
      v_okx_materialized_rows_started := true;
    END IF;

    v_fact_canonical_json := v_row_element.value->>'fact_canonical_json';
    IF arena.position_history_text_sha256(v_fact_canonical_json)
         IS DISTINCT FROM v_row_element.value->>'fact_sha256' THEN
      RAISE EXCEPTION 'fact canonical byte digest is not exact'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_fact_json := v_fact_canonical_json::json;
      IF arena.position_history_json_has_duplicate_keys(v_fact_json) THEN
        RAISE EXCEPTION 'fact repeats an object key';
      END IF;
      v_fact := v_fact_json::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'fact canonical text is not exact duplicate-free JSON'
        USING ERRCODE = '22023';
    END;

    v_field_sources := v_fact->'field_sources';
    IF NOT arena.position_history_exact_jsonb_keys(
         v_fact,
         ARRAY[
           'closed_at',
           'dedupe_hash',
           'entry_price',
           'exit_price',
           'field_sources',
           'leverage',
           'limitations',
           'opened_at',
           'raw',
           'realized_pnl',
           'side',
           'size',
           'source_fact_id',
           'source_lifecycle_marker',
           'source_return',
           'symbol'
         ]::text[]
       )
       OR pg_catalog.jsonb_typeof(v_raw_row) <> 'object'
       OR v_fact->'raw' IS DISTINCT FROM v_raw_row
       OR pg_catalog.jsonb_typeof(v_field_sources) <> 'object' THEN
      RAISE EXCEPTION 'canonical fact, RAW, or field-source envelope is not exact'
        USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.jsonb_typeof(v_fact->'symbol') <> 'string'
       OR NOT arena.position_history_text_is_canonical(
         v_fact->>'symbol', 1, 128
       )
       OR NOT (
         v_fact->'side' = 'null'::jsonb
         OR (
           pg_catalog.jsonb_typeof(v_fact->'side') = 'string'
           AND arena.position_history_text_is_canonical(
             v_fact->>'side', 1, 64
           )
         )
       )
       OR pg_catalog.jsonb_typeof(v_fact->'source_fact_id') <> 'string'
       OR NOT arena.position_history_text_is_canonical(
         v_fact->>'source_fact_id', 1, 1024
       )
       OR pg_catalog.jsonb_typeof(v_fact->'source_lifecycle_marker') <> 'string'
       OR NOT arena.position_history_text_is_canonical(
         v_fact->>'source_lifecycle_marker', 1, 256
       )
       OR pg_catalog.jsonb_typeof(v_fact->'limitations') <> 'array'
       OR v_fact->>'dedupe_hash' !~ '^[0-9a-f]{40}$' THEN
      RAISE EXCEPTION 'canonical fact value types are not exact or closed-only'
        USING ERRCODE = '22023';
    END IF;

    IF NOT arena.position_history_canonical_timestamp(v_fact->>'closed_at')
       OR NOT (
         v_fact->'opened_at' = 'null'::jsonb
         OR arena.position_history_canonical_timestamp(v_fact->>'opened_at')
       ) THEN
      RAISE EXCEPTION 'canonical fact timestamps are not exact'
        USING ERRCODE = '22023';
    END IF;
    v_opened_at := CASE
      WHEN v_fact->'opened_at' = 'null'::jsonb THEN NULL
      ELSE (v_fact->>'opened_at')::timestamptz
    END;
    v_closed_at := (v_fact->>'closed_at')::timestamptz;
    v_page_fetched_at := (v_row_element.value->>'page_fetched_at')::timestamptz;
    IF v_opened_at > v_closed_at
       OR v_closed_at > v_page_fetched_at
       OR v_closed_at > v_observed_at THEN
      RAISE EXCEPTION
        'canonical chronology requires opened_at <= closed_at <= page/observed clocks'
        USING ERRCODE = '22023';
    END IF;
    IF v_previous_completed_closed_at IS NOT NULL
       AND v_closed_at > v_previous_completed_closed_at THEN
      RAISE EXCEPTION
        'reviewed completed lifecycle rows must be globally non-increasing'
        USING ERRCODE = '22023';
    END IF;
    v_previous_completed_closed_at := v_closed_at;

    IF v_terminal_state = 'cursor_overlap' THEN
      IF (v_row_element.value->>'page_ordinal')::integer = v_page_count THEN
        IF v_terminal_min_closed_at IS NULL
           OR v_closed_at < v_terminal_min_closed_at THEN
          v_terminal_min_closed_at := v_closed_at;
        END IF;
      ELSIF v_closed_at <= v_starting_cursor THEN
        v_prior_page_overlaps := true;
      END IF;
    END IF;

    FOREACH v_numeric_field IN ARRAY ARRAY[
      'entry_price',
      'exit_price',
      'leverage',
      'realized_pnl',
      'size',
      'source_return'
    ]::text[]
    LOOP
      IF NOT (
        v_fact->v_numeric_field = 'null'::jsonb
        OR pg_catalog.jsonb_typeof(v_fact->v_numeric_field) = 'number'
      ) THEN
        RAISE EXCEPTION 'canonical numeric field % is not a JSON number',
          v_numeric_field USING ERRCODE = '22023';
      END IF;
      IF v_fact->v_numeric_field <> 'null'::jsonb THEN
        v_fact_number := arena.position_history_js_number(
          v_fact->v_numeric_field
        );
        IF v_fact_number IS NULL
           OR (v_fact_json->v_numeric_field)::text IS DISTINCT FROM
             arena.position_history_ecmascript_number_text(v_fact_number) THEN
          RAISE EXCEPTION
            'canonical numeric field % is not the exact ECMAScript Number spelling',
            v_numeric_field USING ERRCODE = '22023';
        END IF;
      END IF;
    END LOOP;

    FOR v_claim_field, v_fact_field IN
      SELECT claim_map.claim_field, claim_map.fact_field
      FROM (VALUES
        ('sourceFactId', 'source_fact_id'),
        ('sourceLifecycleMarker', 'source_lifecycle_marker'),
        ('sourceReturn', 'source_return'),
        ('openedAt', 'opened_at'),
        ('closedAt', 'closed_at'),
        ('symbol', 'symbol'),
        ('side', 'side'),
        ('leverage', 'leverage'),
        ('size', 'size'),
        ('entryPrice', 'entry_price'),
        ('exitPrice', 'exit_price'),
        ('realizedPnl', 'realized_pnl')
      ) AS claim_map(claim_field, fact_field)
    LOOP
      v_expected_claim := v_fact->v_fact_field <> 'null'::jsonb;
      IF (v_field_sources ? v_claim_field) <> v_expected_claim THEN
        RAISE EXCEPTION
          'field source presence disagrees with canonical field %',
          v_claim_field USING ERRCODE = '22023';
      END IF;
      IF v_expected_claim AND (
        NOT arena.position_history_exact_jsonb_keys(
          v_field_sources->v_claim_field, ARRAY['fieldPaths']::text[]
        )
        OR pg_catalog.jsonb_typeof(
          v_field_sources->v_claim_field->'fieldPaths'
        ) <> 'array'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            v_contract.allowed_field_paths->v_claim_field
          ) AS allowed_path(value)
          WHERE allowed_path.value =
            v_field_sources->v_claim_field->'fieldPaths'
        )
      ) THEN
        RAISE EXCEPTION
          'field source % is outside the exact parser allowlist',
          v_claim_field USING ERRCODE = '22023';
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(v_field_sources)
        AS actual_field(field)
      WHERE actual_field.field <> ALL (ARRAY[
        'sourceFactId', 'sourceLifecycleMarker', 'sourceReturn',
        'openedAt', 'closedAt', 'symbol', 'side', 'leverage', 'size',
        'entryPrice', 'exitPrice', 'realizedPnl'
      ]::text[])
    ) THEN
      RAISE EXCEPTION 'field source contains an unreviewed claim'
        USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_fact->'limitations')
        AS limitation_value(value)
      WHERE pg_catalog.jsonb_typeof(limitation_value.value) <> 'string'
         OR limitation_value.value #>> '{}' NOT IN (
           'source_realized_pnl_missing',
           'source_return_missing'
         )
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements_text(v_fact->'limitations')
        AS item(value)
    ) <> (
      SELECT pg_catalog.count(DISTINCT item.value)
      FROM pg_catalog.jsonb_array_elements_text(v_fact->'limitations')
        AS item(value)
    ) OR (
      (v_fact->'realized_pnl' = 'null'::jsonb) <>
      (v_fact->'limitations' @> '["source_realized_pnl_missing"]'::jsonb)
    ) OR (
      (v_fact->'source_return' = 'null'::jsonb) <>
      (v_fact->'limitations' @> '["source_return_missing"]'::jsonb)
    ) THEN
      RAISE EXCEPTION
        'fact limitations are not exact or contain partial lifecycle claims'
        USING ERRCODE = '22023';
    END IF;

    IF NOT arena.position_history_fact_matches_raw(
      v_contract.source_slug,
      v_contract.source_currency,
      v_contract.registered_exchange_trader_id,
      v_page_fetched_at,
      v_fact
    ) OR NOT arena.position_history_scaled_return_is_finite(
      v_fact->'source_return', v_contract.serving_return_scale
    ) THEN
      RAISE EXCEPTION
        'canonical fact economic fields do not match the reviewed RAW parser'
        USING ERRCODE = '22023';
    END IF;

    v_dedupe_hash := v_fact->>'dedupe_hash';
    v_source_fact_id := v_fact->>'source_fact_id';
    v_recomputed_dedupe := arena.position_history_recomputed_dedupe(
      v_contract.source_slug,
      v_contract.registered_exchange_trader_id,
      v_fact
    );
    IF v_dedupe_hash IS DISTINCT FROM v_recomputed_dedupe THEN
      RAISE EXCEPTION
        'dedupe_hash does not match the reviewed adapter formula'
        USING ERRCODE = '22023';
    END IF;

    v_unique_fact_count := v_unique_fact_count + 1;
    v_matching_fact_count := 0;
    FOR v_existing_fact_row IN
      SELECT
        canonical_fact.fact_id,
        canonical_fact.dedupe_hash,
        canonical_fact.source_fact_id,
        canonical_fact.fact_canonical_json,
        canonical_fact.raw_canonical_json
      FROM arena.verified_position_history_facts AS canonical_fact
      WHERE canonical_fact.source_id = v_raw.source_id
        AND canonical_fact.trader_id = v_raw.trader_id
        AND (
          canonical_fact.dedupe_hash = v_dedupe_hash
          OR canonical_fact.source_fact_id = v_source_fact_id
        )
    LOOP
      v_matching_fact_count := v_matching_fact_count + 1;
      IF v_existing_fact_row.dedupe_hash IS DISTINCT FROM v_dedupe_hash
         OR v_existing_fact_row.source_fact_id
              IS DISTINCT FROM v_source_fact_id
         OR v_existing_fact_row.fact_canonical_json
              IS DISTINCT FROM v_fact_canonical_json
         OR v_existing_fact_row.raw_canonical_json
              IS DISTINCT FROM v_raw_row_canonical_json THEN
        RAISE EXCEPTION
          'parser dedupe or source fact identity conflicts with exact bytes'
          USING ERRCODE = '23505';
      END IF;
    END LOOP;
    IF v_matching_fact_count = 0 THEN
      v_new_fact_count := v_new_fact_count + 1;
    ELSIF v_matching_fact_count <> 1 THEN
      RAISE EXCEPTION 'fact identity authority is internally inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF v_cursor_after IS NULL OR v_closed_at > v_cursor_after THEN
      v_cursor_after := v_closed_at;
    END IF;
  END LOOP;

  IF v_unique_fact_count <> v_row_count THEN
    RAISE EXCEPTION
      'publication facts are not one-to-one with canonical source rows'
      USING ERRCODE = '22023';
  END IF;

  IF v_terminal_state = 'cursor_overlap' AND (
       v_terminal_min_closed_at IS NULL
       OR v_terminal_min_closed_at > v_starting_cursor
       OR v_overlap_at IS DISTINCT FROM v_terminal_min_closed_at
       OR v_prior_page_overlaps
     ) THEN
    RAISE EXCEPTION
      'cursor-overlap evidence does not match the exact terminal fact boundary'
      USING ERRCODE = '22023';
  END IF;

  IF v_contract.source_slug = 'okx_futures'
     AND v_partial_row_count > 0 THEN
    IF EXISTS (
      WITH binding_identities AS (
        SELECT arena.position_history_source_identity(
          ((binding.value->>'raw_row_canonical_json')::jsonb)->'subPosId'
        ) AS sub_position_id
        FROM pg_catalog.jsonb_array_elements(v_rows) AS binding(value)
      )
      SELECT 1
      FROM binding_identities
      GROUP BY sub_position_id
      HAVING pg_catalog.count(*) <> 1
    ) THEN
      RAISE EXCEPTION
        'OKX publication repeats a partial/materialized source identity'
        USING ERRCODE = '23505';
    END IF;

    IF EXISTS (
      WITH partial_identities AS (
        SELECT arena.position_history_source_identity(
          ((binding.value->>'raw_row_canonical_json')::jsonb)->'subPosId'
        ) AS sub_position_id
        FROM pg_catalog.jsonb_array_elements(v_rows) AS binding(value)
        WHERE binding.value->>'classification' = 'source_partial_omitted'
      )
      SELECT 1
      FROM partial_identities AS partial
      JOIN arena.verified_position_history_facts AS fact
        ON fact.source_id = v_raw.source_id
       AND fact.trader_id = v_raw.trader_id
       AND arena.position_history_source_identity(fact.raw->'subPosId') =
           partial.sub_position_id
    ) THEN
      RAISE EXCEPTION
        'OKX closed fact cannot regress to a source partial omission'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO arena.position_history_publish_guards (
    transaction_id, backend_pid, source_run_id, created_at
  ) VALUES (
    pg_catalog.pg_current_xact_id(),
    pg_catalog.pg_backend_pid(),
    p_source_run_id,
    v_now
  );

  INSERT INTO arena.position_history_acquisitions (
    source_run_id,
    raw_object_id,
    source_id,
    trader_id,
    source_slug,
    adapter_slug,
    exchange_trader_id,
    raw_storage_path,
    raw_content_hash,
    raw_bytes,
    raw_fetched_at,
    attempt_started_at,
    observed_at,
    starting_cursor,
    page_count,
    page_manifest,
    source_contract,
    parser_contract,
    verifier_contract,
    scan_terminal_state,
    termination,
    raw_meta,
    acquired_at
  ) VALUES (
    p_source_run_id,
    p_raw_object_id,
    v_raw.source_id,
    v_raw.trader_id,
    v_contract.source_slug,
    v_contract.adapter_slug,
    v_contract.registered_exchange_trader_id,
    v_raw.storage_path,
    v_raw.content_hash,
    v_raw.bytes,
    v_raw.fetched_at,
    v_attempt_started_at,
    v_observed_at,
    v_starting_cursor,
    v_page_count,
    v_meta->'page_manifest',
    v_contract.source_contract,
    v_contract.parser_contract,
    v_contract.terminal_verifier_contract,
    v_terminal_state,
    v_meta->'termination',
    v_meta,
    v_now
  ) RETURNING acquisition_id INTO v_acquisition_id;

  BEGIN
    INSERT INTO arena.position_history_publications (
      acquisition_id,
      source_run_id,
      source_id,
      trader_id,
      previous_publication_id,
      cursor_before,
      cursor_after,
      observed_at,
      published_at,
      scan_terminal_state,
      parsed_row_count,
      binding_count,
      partial_row_count,
      unique_fact_count,
      new_fact_count,
      binding_set_sha256,
      publication_sha256,
      publication_payload,
      cursor_secret,
      publication_contract,
      serialization_contract
    ) VALUES (
      v_acquisition_id,
      p_source_run_id,
      v_raw.source_id,
      v_raw.trader_id,
      p_previous_publication_id,
      v_starting_cursor,
      v_cursor_after,
      v_observed_at,
      v_now,
      v_terminal_state,
      v_row_count,
      v_binding_count,
      v_partial_row_count,
      v_unique_fact_count,
      v_new_fact_count,
      v_publication->>'binding_set_sha256',
      v_publication_sha256,
      p_publication_text,
      extensions.gen_random_bytes(32),
      'arena.ingest.verified-position-history-rpc-payload@2',
      'arena.strict-canonical-json@1'
    ) RETURNING publication_id INTO v_publication_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'position_history_publication_linear_chain' THEN
      RAISE EXCEPTION
        'continuation lost the verified publication compare-and-swap race'
        USING ERRCODE = '40001';
    END IF;
    RAISE;
  END;

  FOR v_row_element IN
    SELECT publication_row.value, publication_row.ordinality
    FROM pg_catalog.jsonb_array_elements(v_rows)
      WITH ORDINALITY AS publication_row(value, ordinality)
    ORDER BY publication_row.ordinality
  LOOP
    v_row_ordinal := v_row_element.ordinality::integer;
    v_classification := v_row_element.value->>'classification';
    v_raw_row_canonical_json :=
      v_row_element.value->>'raw_row_canonical_json';
    v_fact_id := NULL;
    v_fact_canonical_json := NULL;

    IF v_classification = 'canonical_materialized' THEN
      v_fact_canonical_json := v_row_element.value->>'fact_canonical_json';
      v_fact := v_fact_canonical_json::jsonb;
      v_field_sources := v_fact->'field_sources';
      v_dedupe_hash := v_fact->>'dedupe_hash';
      v_source_fact_id := v_fact->>'source_fact_id';

      SELECT canonical_fact.fact_id
      INTO v_fact_id
      FROM arena.verified_position_history_facts AS canonical_fact
      WHERE canonical_fact.source_id = v_raw.source_id
        AND canonical_fact.trader_id = v_raw.trader_id
        AND canonical_fact.dedupe_hash = v_dedupe_hash
        AND canonical_fact.source_fact_id = v_source_fact_id;

      IF NOT FOUND THEN
        INSERT INTO arena.verified_position_history_facts (
          first_publication_id,
          source_run_id,
          source_id,
          trader_id,
          opened_at,
          closed_at,
          symbol,
          side,
          leverage,
          size,
          entry_price,
          exit_price,
          realized_pnl,
          currency,
          source_fact_id,
          source_lifecycle_marker,
          source_return,
          limitations,
          dedupe_hash,
          raw_canonical_json,
          fact_canonical_json,
          raw,
          field_sources,
          fact_payload,
          created_at
        ) VALUES (
          v_publication_id,
          p_source_run_id,
          v_raw.source_id,
          v_raw.trader_id,
          CASE WHEN v_fact->'opened_at' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'opened_at')::timestamptz END,
          (v_fact->>'closed_at')::timestamptz,
          v_fact->>'symbol',
          CASE WHEN v_fact->'side' = 'null'::jsonb
            THEN NULL ELSE v_fact->>'side' END,
          CASE WHEN v_fact->'leverage' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'leverage')::numeric END,
          CASE WHEN v_fact->'size' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'size')::numeric END,
          CASE WHEN v_fact->'entry_price' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'entry_price')::numeric END,
          CASE WHEN v_fact->'exit_price' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'exit_price')::numeric END,
          CASE WHEN v_fact->'realized_pnl' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'realized_pnl')::numeric END,
          v_contract.source_currency,
          v_source_fact_id,
          v_fact->>'source_lifecycle_marker',
          CASE WHEN v_fact->'source_return' = 'null'::jsonb
            THEN NULL ELSE (v_fact->>'source_return')::numeric END,
          v_fact->'limitations',
          v_dedupe_hash,
          v_raw_row_canonical_json,
          v_fact_canonical_json,
          v_fact->'raw',
          v_field_sources,
          v_fact,
          v_now
        ) RETURNING fact_id INTO v_fact_id;
      END IF;
    END IF;

    INSERT INTO arena.position_history_publication_bindings (
      publication_id,
      binding_ordinal,
      classification,
      fact_ordinal,
      fact_id,
      source_run_id,
      source_id,
      trader_id,
      page_ordinal,
      page_stored_index,
      source_row_ordinal,
      page_payload_sha256,
      page_fetched_at,
      raw_row_sha256,
      raw_row_canonical_json,
      fact_sha256,
      fact_canonical_json
    ) VALUES (
      v_publication_id,
      v_row_ordinal,
      v_classification,
      (v_row_element.value->>'fact_ordinal')::integer,
      v_fact_id,
      p_source_run_id,
      v_raw.source_id,
      v_raw.trader_id,
      (v_row_element.value->>'page_ordinal')::integer,
      (v_row_element.value->>'page_stored_index')::integer,
      (v_row_element.value->>'source_row_ordinal')::integer,
      v_row_element.value->>'page_payload_sha256',
      (v_row_element.value->>'page_fetched_at')::timestamptz,
      v_row_element.value->>'raw_row_sha256',
      v_raw_row_canonical_json,
      v_row_element.value->>'fact_sha256',
      v_fact_canonical_json
    );
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.position_history_publication_bindings AS published_binding
    WHERE published_binding.publication_id = v_publication_id
  ) IS DISTINCT FROM v_binding_count::bigint
     OR (
       SELECT pg_catalog.count(DISTINCT published_binding.fact_id)
       FROM arena.position_history_publication_bindings AS published_binding
       WHERE published_binding.publication_id = v_publication_id
     ) IS DISTINCT FROM v_unique_fact_count::bigint
     OR (
       SELECT pg_catalog.count(*)
       FROM arena.position_history_publication_bindings AS published_binding
       WHERE published_binding.publication_id = v_publication_id
         AND published_binding.classification = 'source_partial_omitted'
     ) IS DISTINCT FROM v_partial_row_count::bigint THEN
    RAISE EXCEPTION 'publication graph postcondition failed'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM arena.position_history_publish_guards AS guard_row
  WHERE guard_row.transaction_id = pg_catalog.pg_current_xact_id()
    AND guard_row.backend_pid = pg_catalog.pg_backend_pid()
    AND guard_row.source_run_id = p_source_run_id;

  RETURN pg_catalog.jsonb_build_object(
    'cursorAfter', v_cursor_after,
    'factsAdded', v_new_fact_count,
    'factsReused', v_row_count - v_new_fact_count,
    'observedAt', v_observed_at,
    'publicationId', v_publication_id,
    'publicationSha256', v_publication_sha256,
    'rawObjectId', p_raw_object_id,
    'replayed', false,
    'sourceRunId', p_source_run_id,
    'stateId', v_publication_id
  );
END
$function$;
ALTER FUNCTION arena.publish_verified_position_history(bigint,text,bigint,text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.publish_verified_position_history(
  bigint,text,bigint,text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION arena.position_history_timestamp_text(p_value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.to_char(
    p_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$function$;

ALTER FUNCTION arena.position_history_timestamp_text(timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.position_history_timestamp_text(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION arena.position_history_base64url_encode(p_value bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.rtrim(
    pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(pg_catalog.encode(p_value, 'base64'), E'\n', ''),
        '+', '-'
      ),
      '/', '_'
    ),
    '='
  )
$function$;

ALTER FUNCTION arena.position_history_base64url_encode(bytea)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.position_history_base64url_encode(bytea)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.arena_records_page(
  p_source text,
  p_trader text,
  p_kind text,
  p_tf integer DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_trader_id bigint;
  v_source_id smallint;
  v_contract_source_id smallint;
  v_currency text;
  v_serving_return_scale numeric := 1;
  v_limit integer := LEAST(
    GREATEST(COALESCE(p_limit, 50), 1),
    100
  );
  v_cursor_ts timestamptz;
  v_cursor_hash text;
  v_cursor_epoch_ms bigint;
  v_anchor_publication_id bigint;
  v_anchor_source_run_id text;
  v_anchor_observed_at timestamptz;
  v_anchor_published_at timestamptz;
  v_anchor_terminal_state text;
  v_anchor_cursor_secret bytea;
  v_anchor_identity_valid boolean := false;
  v_cursor_payload text;
  v_cursor_payload_encoded text;
  v_cursor_mac_encoded text;
  v_expected_mac_encoded text;
  v_rows jsonb;
  v_has_more boolean := false;
  v_last_ts timestamptz;
  v_last_hash text;
  v_source_as_of timestamptz;
  v_observed_at timestamptz;
  v_next_cursor text;
BEGIN
  IF p_source IS NULL
     OR pg_catalog.octet_length(p_source) NOT BETWEEN 1 AND 128
     OR p_source !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'record source is not bounded lower_snake_case'
      USING ERRCODE = '22023';
  END IF;
  IF NOT arena.position_history_text_is_canonical(p_trader, 1, 512)
     OR (
       p_kind = 'position_history'
       AND p_source IN ('binance_futures', 'okx_futures')
       AND pg_catalog.strpos(p_trader, '|') > 0
     ) THEN
    RAISE EXCEPTION 'record trader identity is not bounded canonical text'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'copiers' THEN
    RAISE EXCEPTION
      'copier records are aggregate-only; use arena_copier_aggregate';
  END IF;
  IF p_kind IS NULL
     OR p_kind NOT IN ('positions', 'position_history', 'orders', 'transfers') THEN
    RAISE EXCEPTION 'unknown record kind: %', p_kind;
  END IF;
  IF p_cursor IS NOT NULL AND pg_catalog.octet_length(p_cursor) > 200 THEN
    RAISE EXCEPTION 'record cursor exceeds the 200-byte bound'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    trader_row.id,
    source_row.id,
    source_row.currency,
    COALESCE(contract_row.serving_return_scale, 1),
    contract_row.source_id
  INTO
    v_trader_id,
    v_source_id,
    v_currency,
    v_serving_return_scale,
    v_contract_source_id
  FROM arena.traders AS trader_row
  JOIN arena.sources AS source_row ON source_row.id = trader_row.source_id
  LEFT JOIN arena.position_history_source_contracts AS contract_row
    ON contract_row.source_id = source_row.id
   AND contract_row.source_slug = source_row.slug
   AND contract_row.adapter_slug = source_row.adapter_slug
   AND contract_row.source_currency = source_row.currency
  WHERE source_row.slug = p_source
    AND trader_row.exchange_trader_id = p_trader;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_kind = 'position_history'
     AND p_source IN ('binance_futures', 'bitget_futures', 'okx_futures')
     AND v_contract_source_id IS NULL THEN
    RAISE EXCEPTION
      'reviewed position-history source registry no longer matches its immutable contract'
      USING ERRCODE = '55000';
  END IF;

  IF p_kind = 'position_history' THEN
    -- Resolve whether this identity has crossed over before interpreting its
    -- cursor. Before the first verified publication the retired typed surface
    -- remains quarantined: the only safe 2C response is empty/unknown.
    SELECT
      publication.publication_id,
      publication.source_run_id,
      publication.observed_at,
      publication.published_at,
      publication.scan_terminal_state,
      publication.cursor_secret,
      COALESCE(
        publication.source_id = v_source_id
        AND acquisition.acquisition_id = publication.acquisition_id
        AND acquisition.source_run_id = publication.source_run_id
        AND acquisition.source_id = publication.source_id
        AND acquisition.trader_id = publication.trader_id
        AND acquisition.source_slug = p_source
        AND acquisition.exchange_trader_id = p_trader
        AND contract_row.source_id = v_contract_source_id
        AND contract_row.source_slug = acquisition.source_slug
        AND contract_row.adapter_slug = acquisition.adapter_slug
        AND contract_row.source_currency = v_currency
        AND contract_row.source_contract = acquisition.source_contract
        AND contract_row.parser_contract = acquisition.parser_contract
        AND contract_row.terminal_verifier_contract =
            acquisition.verifier_contract,
        false
      )
    INTO
      v_anchor_publication_id,
      v_anchor_source_run_id,
      v_anchor_observed_at,
      v_anchor_published_at,
      v_anchor_terminal_state,
      v_anchor_cursor_secret,
      v_anchor_identity_valid
    FROM arena.position_history_publications AS publication
    LEFT JOIN arena.position_history_acquisitions AS acquisition
      ON acquisition.acquisition_id = publication.acquisition_id
    LEFT JOIN arena.position_history_source_contracts AS contract_row
      ON contract_row.source_id = publication.source_id
    WHERE publication.trader_id = v_trader_id
    ORDER BY publication.publication_id DESC
    LIMIT 1;

    IF v_anchor_publication_id IS NULL THEN
      IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
        RAISE EXCEPTION
          'position-history authority changed; reset pagination without a cursor'
          USING ERRCODE = '40001';
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'asOf', NULL,
        'completeness', pg_catalog.jsonb_build_object(
          'blockerReasons',
            pg_catalog.jsonb_build_array('history_evidence_not_bound'),
          'contract', 'arena.position-history-completeness@2',
          'evidenceState', 'unknown',
          'publicationId', NULL,
          'reason', 'history_evidence_not_bound',
          'scanTerminalState', NULL,
          'state', 'unknown'
        ),
        'currency', v_currency,
        'nextCursor', NULL,
        'observedAt', NULL,
        'publicationId', NULL,
        'publishedAt', NULL,
        'rows', '[]'::pg_catalog.jsonb,
        'sourceAsOf', NULL,
        'sourceRunId', NULL,
        'stateId', NULL
      );
    END IF;

    IF NOT v_anchor_identity_valid THEN
      RAISE EXCEPTION
        'verified position-history identity no longer matches its immutable acquisition'
        USING ERRCODE = '55000';
    END IF;

    IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
      IF p_cursor ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z[|][0-9a-f]{40}$' THEN
        RAISE EXCEPTION
          'position-history authority changed; reset pagination without a cursor'
          USING ERRCODE = '40001';
      END IF;
      IF p_cursor !~ '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'invalid verified position-history cursor'
          USING ERRCODE = '22023';
      END IF;
      v_cursor_payload_encoded := pg_catalog.split_part(p_cursor, '.', 1);
      v_cursor_mac_encoded := pg_catalog.split_part(p_cursor, '.', 2);
      BEGIN
        v_cursor_payload := pg_catalog.convert_from(
          pg_catalog.decode(
            pg_catalog.translate(v_cursor_payload_encoded, '-_', '+/') ||
              pg_catalog.repeat(
                '=',
                (4 - pg_catalog.length(v_cursor_payload_encoded) % 4) % 4
              ),
            'base64'
          ),
          'UTF8'
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid verified position-history cursor'
          USING ERRCODE = '22023';
      END;
      IF arena.position_history_base64url_encode(
           pg_catalog.convert_to(v_cursor_payload, 'UTF8')
         ) IS DISTINCT FROM v_cursor_payload_encoded THEN
        RAISE EXCEPTION 'invalid verified position-history cursor'
          USING ERRCODE = '22023';
      END IF;
      IF v_cursor_payload !~
        '^vph3[|][1-9][0-9]{0,18}[|][0-9]{1,19}[|][0-9a-f]{40}$' THEN
        RAISE EXCEPTION 'invalid verified position-history cursor'
          USING ERRCODE = '22023';
      END IF;

      BEGIN
        v_anchor_publication_id :=
          pg_catalog.split_part(v_cursor_payload, '|', 2)::bigint;
        v_cursor_epoch_ms :=
          pg_catalog.split_part(v_cursor_payload, '|', 3)::bigint;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION 'invalid verified position-history cursor'
          USING ERRCODE = '22023';
      END;
      v_cursor_hash := pg_catalog.split_part(v_cursor_payload, '|', 4);

      SELECT
        publication.source_run_id,
        publication.observed_at,
        publication.published_at,
        publication.scan_terminal_state,
        publication.cursor_secret
      INTO
        v_anchor_source_run_id,
        v_anchor_observed_at,
        v_anchor_published_at,
        v_anchor_terminal_state,
        v_anchor_cursor_secret
      FROM arena.position_history_publications AS publication
      JOIN arena.position_history_acquisitions AS acquisition
        ON acquisition.acquisition_id = publication.acquisition_id
       AND acquisition.source_run_id = publication.source_run_id
       AND acquisition.source_id = publication.source_id
       AND acquisition.trader_id = publication.trader_id
       AND acquisition.source_slug = p_source
       AND acquisition.exchange_trader_id = p_trader
      JOIN arena.position_history_source_contracts AS contract_row
        ON contract_row.source_id = publication.source_id
       AND contract_row.source_id = v_contract_source_id
       AND contract_row.source_slug = acquisition.source_slug
       AND contract_row.adapter_slug = acquisition.adapter_slug
       AND contract_row.source_currency = v_currency
       AND contract_row.source_contract = acquisition.source_contract
       AND contract_row.parser_contract = acquisition.parser_contract
       AND contract_row.terminal_verifier_contract =
           acquisition.verifier_contract
      WHERE publication.publication_id = v_anchor_publication_id
        AND publication.source_id = v_source_id
        AND publication.trader_id = v_trader_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'verified position-history cursor state does not match this identity'
          USING ERRCODE = '22023';
      END IF;

      v_expected_mac_encoded := arena.position_history_base64url_encode(
        extensions.hmac(
          pg_catalog.convert_to(v_cursor_payload, 'UTF8'),
          v_anchor_cursor_secret,
          'sha256'
        )
      );
      IF v_cursor_mac_encoded IS DISTINCT FROM v_expected_mac_encoded THEN
        RAISE EXCEPTION 'invalid verified position-history cursor authentication'
          USING ERRCODE = '22023';
      END IF;

      BEGIN
        v_cursor_ts := pg_catalog.to_timestamp(
          v_cursor_epoch_ms::double precision / 1000.0
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid verified position-history cursor timestamp'
          USING ERRCODE = '22023';
      END;
      IF NOT pg_catalog.isfinite(v_cursor_ts)
         OR pg_catalog.floor(
           EXTRACT(epoch FROM v_cursor_ts) * 1000
         )::bigint IS DISTINCT FROM v_cursor_epoch_ms THEN
        RAISE EXCEPTION 'invalid verified position-history cursor timestamp'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      v_cursor_ts := NULL;
      v_cursor_hash := NULL;
    END IF;

    WITH candidates AS (
      SELECT
        fact.*,
        pg_catalog.row_number() OVER (
          ORDER BY fact.closed_at DESC, fact.dedupe_hash DESC
        ) AS result_ordinal
      FROM arena.verified_position_history_facts AS fact
      WHERE fact.source_id = v_source_id
        AND fact.trader_id = v_trader_id
        AND fact.first_publication_id <= v_anchor_publication_id
        AND (
          v_cursor_ts IS NULL
          OR (fact.closed_at, fact.dedupe_hash) <
             (v_cursor_ts, v_cursor_hash)
        )
      ORDER BY fact.closed_at DESC, fact.dedupe_hash DESC
      LIMIT v_limit + 1
    )
    SELECT
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'closed_at',
              arena.position_history_timestamp_text(candidate.closed_at),
            'closing_value', COALESCE(
              arena.jnum(candidate.raw->>'closingValue'),
              arena.jnum(candidate.raw->>'closeValue')
            ),
            'currency', candidate.currency,
            'entry_price', candidate.entry_price,
            'exit_price', candidate.exit_price,
            'leverage', candidate.leverage,
            'margin_mode', arena.position_history_serving_margin_mode(
              p_source, candidate.raw
            ),
            'max_open_interest', COALESCE(
              arena.jnum(candidate.raw->>'maxOpenInterest'),
              arena.jnum(candidate.raw->>'max_open_interest')
            ),
            'opened_at', CASE WHEN candidate.opened_at IS NULL THEN NULL
              ELSE arena.position_history_timestamp_text(candidate.opened_at)
              END,
            'realized_pnl', candidate.realized_pnl,
            'roi', candidate.source_return * v_serving_return_scale,
            'side', candidate.side,
            'size', candidate.size,
            'source_return', candidate.source_return,
            'symbol', candidate.symbol
          ) ORDER BY candidate.closed_at DESC, candidate.dedupe_hash DESC
        ) FILTER (WHERE candidate.result_ordinal <= v_limit),
        '[]'::jsonb
      ),
      COALESCE(
        pg_catalog.bool_or(candidate.result_ordinal > v_limit),
        false
      ),
      pg_catalog.max(candidate.closed_at)
        FILTER (WHERE candidate.result_ordinal = v_limit),
      pg_catalog.max(candidate.dedupe_hash)
        FILTER (WHERE candidate.result_ordinal = v_limit)
    INTO v_rows, v_has_more, v_last_ts, v_last_hash
    FROM candidates AS candidate;

    IF v_has_more THEN
      v_cursor_payload :=
        'vph3|' || v_anchor_publication_id::text || '|' ||
        pg_catalog.floor(
          EXTRACT(epoch FROM v_last_ts) * 1000
        )::bigint::text || '|' || v_last_hash;
      v_next_cursor :=
        arena.position_history_base64url_encode(
          pg_catalog.convert_to(v_cursor_payload, 'UTF8')
        ) || '.' ||
        arena.position_history_base64url_encode(
          extensions.hmac(
            pg_catalog.convert_to(v_cursor_payload, 'UTF8'),
            v_anchor_cursor_secret,
            'sha256'
          )
        );
    ELSE
      v_next_cursor := NULL;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'asOf', NULL,
      'completeness', pg_catalog.jsonb_build_object(
        'blockerReasons', '[]'::jsonb,
        'contract', 'arena.position-history-completeness@2',
        'evidenceState', 'verified',
        'publicationId', v_anchor_publication_id,
        'reason', 'verified_terminal_history',
        'scanTerminalState', v_anchor_terminal_state,
        'state', 'complete'
      ),
      'currency', v_currency,
      'nextCursor', v_next_cursor,
      'observedAt',
        arena.position_history_timestamp_text(v_anchor_observed_at),
      'publicationId', v_anchor_publication_id,
      'publishedAt',
        arena.position_history_timestamp_text(v_anchor_published_at),
      'rows', v_rows,
      'sourceAsOf', NULL,
      'sourceRunId', v_anchor_source_run_id,
      'stateId', v_anchor_publication_id
    );
  END IF;

  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    IF p_kind = 'positions'
       OR p_cursor !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z[|][0-9a-f]{40}$'
       OR NOT arena.position_history_canonical_timestamp(
         pg_catalog.split_part(p_cursor, '|', 1)
       ) THEN
      RAISE EXCEPTION 'invalid legacy record cursor'
        USING ERRCODE = '22023';
    END IF;
    v_cursor_ts := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_hash := pg_catalog.split_part(p_cursor, '|', 2);
  END IF;

  IF p_kind = 'positions' THEN
    SELECT
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'as_of',
              arena.position_history_timestamp_text(position_row.as_of),
            'currency', position_row.currency,
            'entry_price', position_row.entry_price,
            'leverage', position_row.leverage,
            'margin', COALESCE(
              arena.jnum(position_row.raw->>'collateral'),
              arena.jnum(position_row.raw->>'isolatedWallet'),
              arena.jnum(position_row.raw->>'marginBalance'),
              arena.jnum(position_row.raw->>'margin')
            ),
            'margin_mode', arena.jmargin_mode(position_row.raw),
            'mark_price', position_row.mark_price,
            'notional', COALESCE(
              arena.jnum(position_row.raw->>'notionalValue'),
              arena.jnum(position_row.raw->>'notional')
            ),
            'roe', CASE WHEN COALESCE(
              arena.jnum(position_row.raw->>'collateral'),
              arena.jnum(position_row.raw->>'isolatedWallet'),
              arena.jnum(position_row.raw->>'marginBalance')
            ) > 0 THEN pg_catalog.round(
              position_row.unrealized_pnl / COALESCE(
                arena.jnum(position_row.raw->>'collateral'),
                arena.jnum(position_row.raw->>'isolatedWallet'),
                arena.jnum(position_row.raw->>'marginBalance')
              ) * 100,
              2
            ) END,
            'side', position_row.side,
            'size', position_row.size,
            'symbol', position_row.symbol,
            'unrealized_pnl', position_row.unrealized_pnl
          ) ORDER BY
            pg_catalog.abs(COALESCE(position_row.unrealized_pnl, 0)) DESC
        ),
        '[]'::jsonb
      ),
      pg_catalog.max(position_row.as_of),
      pg_catalog.max(position_row.snapshot_at)
    INTO v_rows, v_source_as_of, v_observed_at
    FROM (
      SELECT *
      FROM arena.positions_current AS position_source
      WHERE position_source.trader_id = v_trader_id
      ORDER BY
        pg_catalog.abs(COALESCE(position_source.unrealized_pnl, 0)) DESC
      LIMIT v_limit
    ) AS position_row;

    RETURN pg_catalog.jsonb_build_object(
      'asOf', CASE WHEN v_source_as_of IS NULL THEN NULL
        ELSE arena.position_history_timestamp_text(v_source_as_of) END,
      'completeness', pg_catalog.jsonb_build_object(
        'blockerReasons',
          pg_catalog.jsonb_build_array('legacy_unverified_surface'),
        'evidenceState', 'unknown',
        'reason', 'legacy_unverified_surface',
        'state', 'unknown'
      ),
      'currency', v_currency,
      'nextCursor', NULL,
      'observedAt', CASE WHEN v_observed_at IS NULL THEN NULL
        ELSE arena.position_history_timestamp_text(v_observed_at) END,
      'publishedAt', NULL,
      'rows', v_rows,
      'sourceAsOf', CASE WHEN v_source_as_of IS NULL THEN NULL
        ELSE arena.position_history_timestamp_text(v_source_as_of) END
    );
  ELSIF p_kind = 'orders' THEN
    WITH candidates AS (
      SELECT
        order_source.*,
        pg_catalog.row_number() OVER (
          ORDER BY order_source.ts DESC, order_source.dedupe_hash DESC
        ) AS result_ordinal
      FROM arena.order_records AS order_source
      WHERE order_source.trader_id = v_trader_id
        AND (
          v_cursor_ts IS NULL
          OR (order_source.ts, order_source.dedupe_hash) <
             (v_cursor_ts, v_cursor_hash)
        )
      ORDER BY order_source.ts DESC, order_source.dedupe_hash DESC
      LIMIT v_limit + 1
    )
    SELECT
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'currency', candidate.currency,
            'kind', candidate.kind,
            'notional', COALESCE(
              arena.jnum(candidate.raw->>'totalAmount'),
              arena.jnum(candidate.raw->>'notionalValue'),
              arena.jnum(candidate.raw->>'indexValue')
            ),
            'price', candidate.price,
            'qty', candidate.qty,
            'realized_pnl', COALESCE(
              arena.jnum(candidate.raw->>'totalPnl'),
              arena.jnum(candidate.raw->>'realizedPnl'),
              arena.jnum(candidate.raw->>'pnl'),
              arena.jnum(candidate.raw->>'pnl_net')
            ),
            'side', candidate.side,
            'symbol', candidate.symbol,
            'ts', arena.position_history_timestamp_text(candidate.ts)
          ) ORDER BY candidate.ts DESC, candidate.dedupe_hash DESC
        ) FILTER (WHERE candidate.result_ordinal <= v_limit),
        '[]'::jsonb
      ),
      COALESCE(
        pg_catalog.bool_or(candidate.result_ordinal > v_limit),
        false
      ),
      pg_catalog.max(candidate.ts)
        FILTER (WHERE candidate.result_ordinal = v_limit),
      pg_catalog.max(candidate.dedupe_hash)
        FILTER (WHERE candidate.result_ordinal = v_limit)
    INTO v_rows, v_has_more, v_last_ts, v_last_hash
    FROM candidates AS candidate;
  ELSE
    WITH candidates AS (
      SELECT
        transfer_source.*,
        pg_catalog.row_number() OVER (
          ORDER BY transfer_source.ts DESC, transfer_source.dedupe_hash DESC
        ) AS result_ordinal
      FROM arena.transfer_history AS transfer_source
      WHERE transfer_source.trader_id = v_trader_id
        AND (
          v_cursor_ts IS NULL
          OR (transfer_source.ts, transfer_source.dedupe_hash) <
             (v_cursor_ts, v_cursor_hash)
        )
      ORDER BY transfer_source.ts DESC, transfer_source.dedupe_hash DESC
      LIMIT v_limit + 1
    )
    SELECT
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'amount', candidate.amount,
            'asset', candidate.asset,
            'currency', candidate.currency,
            'direction', candidate.direction,
            'ts', arena.position_history_timestamp_text(candidate.ts)
          ) ORDER BY candidate.ts DESC, candidate.dedupe_hash DESC
        ) FILTER (WHERE candidate.result_ordinal <= v_limit),
        '[]'::jsonb
      ),
      COALESCE(
        pg_catalog.bool_or(candidate.result_ordinal > v_limit),
        false
      ),
      pg_catalog.max(candidate.ts)
        FILTER (WHERE candidate.result_ordinal = v_limit),
      pg_catalog.max(candidate.dedupe_hash)
        FILTER (WHERE candidate.result_ordinal = v_limit)
    INTO v_rows, v_has_more, v_last_ts, v_last_hash
    FROM candidates AS candidate;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'asOf', NULL,
    'completeness', pg_catalog.jsonb_build_object(
      'blockerReasons',
        pg_catalog.jsonb_build_array('legacy_unverified_surface'),
      'evidenceState', 'unknown',
      'reason', 'legacy_unverified_surface',
      'state', 'unknown'
    ),
    'currency', v_currency,
    'nextCursor', CASE WHEN v_has_more THEN
      arena.position_history_timestamp_text(v_last_ts) || '|' || v_last_hash
      ELSE NULL END,
    'observedAt', NULL,
    'publishedAt', NULL,
    'rows', v_rows,
    'sourceAsOf', NULL
  );
END
$function$;
ALTER FUNCTION public.arena_records_page(text,text,text,integer,text,integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_records_page(
  text,text,text,integer,text,integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_records_page(
  text,text,text,integer,text,integer
) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(
      capability.slug,
      CASE WHEN EXISTS (
        SELECT 1
        FROM arena.position_history_source_contracts AS contract
        JOIN arena.sources AS source_row
          ON source_row.id = contract.source_id
         AND source_row.slug = contract.source_slug
         AND source_row.adapter_slug = contract.adapter_slug
         AND source_row.currency = contract.source_currency
        JOIN arena.position_history_publications AS publication
          ON publication.source_id = contract.source_id
        JOIN arena.position_history_acquisitions AS acquisition
          ON acquisition.acquisition_id = publication.acquisition_id
         AND acquisition.source_run_id = publication.source_run_id
         AND acquisition.source_id = publication.source_id
         AND acquisition.trader_id = publication.trader_id
         AND acquisition.source_slug = contract.source_slug
         AND acquisition.adapter_slug = contract.adapter_slug
         AND acquisition.source_contract = contract.source_contract
         AND acquisition.parser_contract = contract.parser_contract
         AND acquisition.verifier_contract = contract.terminal_verifier_contract
        JOIN arena.traders AS trader_row
          ON trader_row.id = acquisition.trader_id
         AND trader_row.source_id = acquisition.source_id
         AND trader_row.exchange_trader_id = acquisition.exchange_trader_id
        WHERE contract.source_slug = capability.slug
      ) THEN pg_catalog.jsonb_set(
        capability.cap,
        '{surfaces,position_history}'::text[],
        'true'::jsonb,
        true
      ) ELSE capability.cap END
    ),
    '{}'::jsonb
  )
  FROM arena.mv_source_capabilities AS capability
$function$;
ALTER FUNCTION public.arena_source_capabilities() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_source_capabilities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION arena.protect_position_history_registry_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_has_bound_identity boolean := false;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION
      'position-history source/trader registries cannot be truncated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sources'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.slug IS NOT DISTINCT FROM OLD.slug
     AND NEW.adapter_slug IS NOT DISTINCT FROM OLD.adapter_slug
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'traders'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.exchange_trader_id IS NOT DISTINCT FROM OLD.exchange_trader_id THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'traders' THEN
    v_has_bound_identity := EXISTS (
      SELECT 1
      FROM arena.position_history_raw_admissions AS admission
      WHERE admission.trader_id = OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM arena.position_history_acquisitions AS acquisition
      JOIN arena.position_history_publications AS publication
        ON publication.acquisition_id = acquisition.acquisition_id
      WHERE acquisition.trader_id = OLD.id
    );

    IF v_has_bound_identity AND (
      EXISTS (
        SELECT 1
        FROM arena.position_history_raw_admissions AS admission
        WHERE admission.trader_id = OLD.id
          AND (
            admission.source_id IS DISTINCT FROM OLD.source_id
            OR admission.exchange_trader_id
                 IS DISTINCT FROM OLD.exchange_trader_id
          )
      ) OR EXISTS (
        SELECT 1
        FROM arena.position_history_acquisitions AS acquisition
        JOIN arena.position_history_publications AS publication
          ON publication.acquisition_id = acquisition.acquisition_id
        WHERE acquisition.trader_id = OLD.id
          AND (
            acquisition.source_id IS DISTINCT FROM OLD.source_id
            OR acquisition.exchange_trader_id
                 IS DISTINCT FROM OLD.exchange_trader_id
          )
      )
    ) THEN
      RAISE EXCEPTION
        'position-history trader registry authority drifted'
        USING ERRCODE = '55000';
    END IF;

    IF v_has_bound_identity THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'verified position-history trader identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.source_id IS DISTINCT FROM OLD.source_id
         OR NEW.exchange_trader_id IS DISTINCT FROM OLD.exchange_trader_id THEN
        RAISE EXCEPTION
          'verified position-history trader identity is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'sources' THEN
    v_has_bound_identity := EXISTS (
      SELECT 1
      FROM arena.position_history_raw_admissions AS admission
      WHERE admission.source_id = OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM arena.position_history_source_contracts AS contract_row
      WHERE contract_row.source_id = OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM arena.position_history_publications AS publication
      WHERE publication.source_id = OLD.id
    );

    IF v_has_bound_identity AND (
      EXISTS (
        SELECT 1
        FROM arena.position_history_raw_admissions AS admission
        WHERE admission.source_id = OLD.id
          AND admission.source_slug IS DISTINCT FROM OLD.slug
      ) OR EXISTS (
        SELECT 1
        FROM arena.position_history_source_contracts AS contract_row
        WHERE contract_row.source_id = OLD.id
          AND (
            contract_row.source_slug IS DISTINCT FROM OLD.slug
            OR contract_row.adapter_slug IS DISTINCT FROM OLD.adapter_slug
            OR contract_row.source_currency IS DISTINCT FROM OLD.currency
          )
      ) OR EXISTS (
        SELECT 1
        FROM arena.position_history_acquisitions AS acquisition
        JOIN arena.position_history_publications AS publication
          ON publication.acquisition_id = acquisition.acquisition_id
        WHERE acquisition.source_id = OLD.id
          AND (
            acquisition.source_slug IS DISTINCT FROM OLD.slug
            OR acquisition.adapter_slug IS DISTINCT FROM OLD.adapter_slug
          )
      )
    ) THEN
      RAISE EXCEPTION
        'position-history source registry authority drifted'
        USING ERRCODE = '55000';
    END IF;

    IF v_has_bound_identity THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'verified position-history source identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.adapter_slug IS DISTINCT FROM OLD.adapter_slug
         OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION
          'verified position-history source identity is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION arena.protect_position_history_registry_identity()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  arena.protect_position_history_registry_identity()
  FROM PUBLIC, anon, authenticated, service_role;

-- Acquire existing registry locks at the end in the same child-to-parent
-- order established by the prerequisite migration. This prevents a writer
-- that already owns a trader lock and then checks its source from deadlocking
-- with the FK installation.
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $locked_registry_recheck$
BEGIN
  -- Under REPEATABLE READ these row locks also turn any identity update that
  -- committed after the migration snapshot into a serialization failure,
  -- rather than allowing the following checks to read an obsolete version.
  PERFORM 1
  FROM arena.sources AS source_row
  WHERE source_row.slug IN (
    'binance_futures', 'bitget_futures', 'okx_futures'
  )
  FOR SHARE OF source_row;

  PERFORM 1
  FROM arena.traders AS trader_row
  WHERE EXISTS (
    SELECT 1
    FROM arena.position_history_raw_admissions AS admission
    WHERE admission.trader_id = trader_row.id
  )
  FOR SHARE OF trader_row;

  IF EXISTS (
    SELECT 1
    FROM arena.position_history_source_contracts AS contract_row
    LEFT JOIN arena.sources AS source_row
      ON source_row.id = contract_row.source_id
    WHERE source_row.id IS NULL
       OR source_row.slug IS DISTINCT FROM contract_row.source_slug
       OR source_row.adapter_slug IS DISTINCT FROM contract_row.adapter_slug
       OR source_row.currency IS DISTINCT FROM contract_row.source_currency
  ) OR EXISTS (
    SELECT 1
    FROM arena.position_history_raw_admissions AS admission
    LEFT JOIN arena.sources AS source_row
      ON source_row.id = admission.source_id
    LEFT JOIN arena.traders AS trader_row
      ON trader_row.id = admission.trader_id
    WHERE source_row.id IS NULL
       OR trader_row.id IS NULL
       OR source_row.slug IS DISTINCT FROM admission.source_slug
       OR trader_row.source_id IS DISTINCT FROM admission.source_id
       OR trader_row.exchange_trader_id
            IS DISTINCT FROM admission.exchange_trader_id
  ) THEN
    RAISE EXCEPTION
      'locked position-history registry identity recheck failed'
      USING ERRCODE = '55000';
  END IF;
END
$locked_registry_recheck$;

-- These ordinary primary-key FKs validate three contract rows and the new
-- immutable authority graph; no index is added to the production RAW table.
ALTER TABLE arena.position_history_source_contracts
  ADD CONSTRAINT position_history_source_contract_registry_fkey
  FOREIGN KEY (source_id)
  REFERENCES arena.sources(id)
  ON DELETE RESTRICT;

ALTER TABLE arena.position_history_acquisitions
  ADD CONSTRAINT position_history_acquisition_trader_fkey
  FOREIGN KEY (trader_id)
  REFERENCES arena.traders(id)
  ON DELETE RESTRICT;

ALTER TABLE arena.verified_position_history_facts
  ADD CONSTRAINT verified_position_history_trader_fkey
  FOREIGN KEY (trader_id)
  REFERENCES arena.traders(id)
  ON DELETE RESTRICT;

DO $postflight$
DECLARE
  v_table regclass;
  v_expected record;
  v_expected_contracts jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'adapter', contract.adapter_slug,
      'currency', contract.source_currency,
      'fieldPaths', contract.allowed_field_paths,
      'pageSize', contract.page_size,
      'parser', contract.parser_contract,
      'returnScale', contract.serving_return_scale,
      'slug', contract.source_slug,
      'source', contract.source_contract,
      'verifier', contract.terminal_verifier_contract
    ) ORDER BY contract.source_slug
  )
  INTO v_expected_contracts
  FROM arena.position_history_source_contracts AS contract;

  IF v_expected_contracts IS DISTINCT FROM
    '[
      {
        "adapter":"binance",
        "currency":"USDT",
        "fieldPaths":{
          "openedAt":[["response.data.list[].opened"]],
          "closedAt":[["response.data.list[].closed"]],
          "symbol":[["response.data.list[].symbol"]],
          "side":[["response.data.list[].side"]],
          "leverage":[["response.data.list[].leverage"]],
          "size":[["response.data.list[].closedVolume"]],
          "entryPrice":[["response.data.list[].avgCost"]],
          "exitPrice":[["response.data.list[].avgClosePrice"]],
          "realizedPnl":[["response.data.list[].closingPnl"]],
          "sourceFactId":[["portfolioId","response.data.list[].id","response.data.list[].symbol","response.data.list[].side"]],
          "sourceLifecycleMarker":[["response.data.list[].status"]],
          "sourceReturn":[["response.data.list[].roi"]]
        },
        "pageSize":50,
        "parser":"arena.ingest.position-history-parser.binance@1",
        "returnScale":100,
        "slug":"binance_futures",
        "source":"arena.ingest.position-history-source.binance_futures@1",
        "verifier":"arena.ingest.history-terminal-verifier.binance.position_history@2"
      },
      {
        "adapter":"bitget",
        "currency":"USDT",
        "fieldPaths":{
          "openedAt":[["data.rows[].openTime"]],
          "closedAt":[["data.rows[].closeTime"]],
          "symbol":[["data.rows[].symbolDisplayName"],["data.rows[].productCode"],["data.rows[].symbolId"]],
          "side":[["data.rows[].position"],["data.rows[].holdSide"]],
          "leverage":[["data.rows[].openLevel"]],
          "size":[["data.rows[].closeDealCount"],["data.rows[].openDealCount"]],
          "entryPrice":[["data.rows[].openAvgPrice"]],
          "exitPrice":[["data.rows[].closeAvgPrice"]],
          "realizedPnl":[["data.rows[].netProfit"]],
          "sourceFactId":[["data.rows[].orderNo"]],
          "sourceLifecycleMarker":[["data.rows[].closeTime"]],
          "sourceReturn":[["data.rows[].returnRate"]]
        },
        "pageSize":20,
        "parser":"arena.ingest.position-history-parser.bitget@1",
        "returnScale":1,
        "slug":"bitget_futures",
        "source":"arena.ingest.position-history-source.bitget_futures@1",
        "verifier":"arena.ingest.history-terminal-verifier.bitget.position_history@2"
      },
      {
        "adapter":"okx",
        "currency":"USDT",
        "fieldPaths":{
          "openedAt":[["data[].openTime"]],
          "closedAt":[["data[].closeTime"]],
          "symbol":[["data[].instId"]],
          "side":[["data[].posSide"]],
          "leverage":[["data[].lever"]],
          "size":[["data[].subPos"]],
          "entryPrice":[["data[].openAvgPx"]],
          "exitPrice":[["data[].closeAvgPx"]],
          "realizedPnl":[["data[].pnl"]],
          "sourceFactId":[["historyTraderIdentity","data[].subPosId"]],
          "sourceLifecycleMarker":[["data[].closeTime"]],
          "sourceReturn":[["data[].pnlRatio"]]
        },
        "pageSize":100,
        "parser":"arena.ingest.position-history-parser.okx@1",
        "returnScale":100,
        "slug":"okx_futures",
        "source":"arena.ingest.position-history-source.okx_futures@1",
        "verifier":"arena.ingest.history-terminal-verifier.okx.position_history@2"
      }
    ]'::jsonb THEN
    RAISE EXCEPTION 'postflight: exact reviewed source contract allowlist drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'anon',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'anon', 'public.arena_source_capabilities()', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', 'public.arena_source_capabilities()', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_source_capabilities()', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.publish_verified_position_history(bigint,text,bigint,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'postgres',
       'arena.publish_verified_position_history(bigint,text,bigint,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'postflight: public read or owner-only publish topology drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'public.arena_records_page(text,text,text,integer,text,integer)'::pg_catalog.regprocedure,
      'public.arena_source_capabilities()'::pg_catalog.regprocedure,
      'arena.publish_verified_position_history(bigint,text,bigint,text)'::pg_catalog.regprocedure
    )
      AND (
        NOT function_row.prosecdef
        OR function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR function_row.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'postflight: RPC definer, owner, or search_path drifted';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'arena.position_history_raw_admissions'::pg_catalog.regclass,
    'arena.position_history_source_contracts'::pg_catalog.regclass,
    'arena.position_history_acquisitions'::pg_catalog.regclass,
    'arena.position_history_publications'::pg_catalog.regclass,
    'arena.verified_position_history_facts'::pg_catalog.regclass,
    'arena.position_history_publication_bindings'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS table_row
      WHERE table_row.oid = v_table
        AND table_row.relowner = 'postgres'::pg_catalog.regrole
        AND table_row.relrowsecurity
        AND table_row.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'postflight: private authority table topology drifted: %',
        v_table;
    END IF;

    FOR v_expected IN
      SELECT role_name
      FROM (VALUES ('anon'::text), ('authenticated'::text),
                   ('service_role'::text)) AS api_role(role_name)
    LOOP
      IF pg_catalog.has_table_privilege(
           v_expected.role_name, v_table, 'SELECT'
         ) OR pg_catalog.has_table_privilege(
           v_expected.role_name, v_table, 'INSERT'
         ) OR pg_catalog.has_table_privilege(
           v_expected.role_name, v_table, 'UPDATE'
         ) OR pg_catalog.has_table_privilege(
           v_expected.role_name, v_table, 'DELETE'
         ) OR pg_catalog.has_table_privilege(
           v_expected.role_name, v_table, 'TRUNCATE'
         ) THEN
        RAISE EXCEPTION 'postflight: private authority ACL drifted: % %',
          v_table, v_expected.role_name;
      END IF;
    END LOOP;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'arena.position_history_raw_admissions'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_read'
      AND policy_row.polcmd = 'r'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid, true
      ) = 'true'
      AND policy_row.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_insert'
      AND policy_row.polcmd = 'a'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND policy_row.polqual IS NULL
      AND pg_catalog.pg_get_expr(
        policy_row.polwithcheck, policy_row.polrelid, true
      ) = 'true'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_lock'
      AND policy_row.polcmd = 'w'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid, true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy_row.polwithcheck, policy_row.polrelid, true
      ) = 'false'
  ) THEN
    RAISE EXCEPTION 'postflight: RAW admission policy set drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid =
        'arena.position_history_publish_guards'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'postflight: publication guard ownership drifted';
  END IF;
  FOR v_expected IN
    SELECT role_name
    FROM (VALUES ('anon'::text), ('authenticated'::text),
                 ('service_role'::text)) AS api_role(role_name)
  LOOP
    IF pg_catalog.has_table_privilege(
         v_expected.role_name, 'arena.position_history_publish_guards', 'SELECT'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name, 'arena.position_history_publish_guards', 'INSERT'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name, 'arena.position_history_publish_guards', 'UPDATE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name, 'arena.position_history_publish_guards', 'DELETE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name, 'arena.position_history_publish_guards', 'TRUNCATE'
       ) THEN
      RAISE EXCEPTION 'postflight: publication guard ACL drifted for %',
        v_expected.role_name;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (
      SELECT
        authority_table.table_oid,
        trigger_spec.trigger_name,
        trigger_spec.function_oid,
        trigger_spec.trigger_type
      FROM (VALUES
        ('arena.position_history_acquisitions'::regclass),
        ('arena.position_history_publications'::regclass),
        ('arena.verified_position_history_facts'::regclass),
        ('arena.position_history_publication_bindings'::regclass)
      ) AS authority_table(table_oid)
      CROSS JOIN (VALUES
        ('require_verified_history_insert_guard'::text,
         'arena.require_verified_position_history_insert_guard()'::regprocedure,
         7::smallint),
        ('reject_verified_history_update_delete'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         27::smallint),
        ('reject_verified_history_update_delete_statement'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         26::smallint),
        ('reject_verified_history_truncate'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         34::smallint)
      ) AS trigger_spec(trigger_name, function_oid, trigger_type)
      UNION ALL
      SELECT * FROM (VALUES
        ('arena.position_history_source_contracts'::regclass,
         'reject_verified_history_contract_insert'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         7::smallint),
        ('arena.position_history_source_contracts'::regclass,
         'reject_verified_history_contract_update_delete'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         27::smallint),
        ('arena.position_history_source_contracts'::regclass,
         'reject_verified_history_contract_update_delete_statement'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         26::smallint),
        ('arena.position_history_source_contracts'::regclass,
         'reject_verified_history_contract_truncate'::text,
         'arena.reject_verified_position_history_mutation()'::regprocedure,
         34::smallint)
      ) AS contract_trigger(table_oid, trigger_name, function_oid, trigger_type)
    ) AS expected
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_expected.table_oid
        AND trigger_row.tgname = v_expected.trigger_name
        AND trigger_row.tgfoid = v_expected.function_oid
        AND trigger_row.tgtype = v_expected.trigger_type
        AND trigger_row.tgenabled = 'A'
        AND NOT trigger_row.tgisinternal
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgattr::text = ''
        AND trigger_row.tgconstraint = 0
    ) THEN
      RAISE EXCEPTION 'postflight: private authority trigger drifted: %.%',
        v_expected.table_oid, v_expected.trigger_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgrelid IN (
        'arena.position_history_source_contracts'::regclass,
        'arena.position_history_acquisitions'::regclass,
        'arena.position_history_publications'::regclass,
        'arena.verified_position_history_facts'::regclass,
        'arena.position_history_publication_bindings'::regclass
      )
  ) <> 20 THEN
    RAISE EXCEPTION 'postflight: private authority trigger set drifted';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'arena.position_history_acquisitions'::regclass,
    'arena.position_history_publications'::regclass,
    'arena.verified_position_history_facts'::regclass,
    'arena.position_history_publication_bindings'::regclass
  ]
  LOOP
    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
    ) <> 4 OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
        AND policy_row.polname = 'owner_verified_history_read'
        AND policy_row.polcmd = 'r'
        AND policy_row.polpermissive
        AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
        AND pg_catalog.pg_get_expr(
          policy_row.polqual, policy_row.polrelid, true
        ) = 'true'
        AND policy_row.polwithcheck IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
        AND policy_row.polname = 'owner_verified_history_insert'
        AND policy_row.polcmd = 'a'
        AND policy_row.polpermissive
        AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
        AND policy_row.polqual IS NULL
        AND pg_catalog.pg_get_expr(
          policy_row.polwithcheck, policy_row.polrelid, true
        ) = 'arena.position_history_publish_guard_active(source_run_id)'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
        AND policy_row.polname = 'owner_verified_history_update'
        AND policy_row.polcmd = 'w'
        AND policy_row.polpermissive
        AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
        AND pg_catalog.pg_get_expr(
          policy_row.polqual, policy_row.polrelid, true
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy_row.polwithcheck, policy_row.polrelid, true
        ) = 'false'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
        AND policy_row.polname = 'owner_verified_history_delete'
        AND policy_row.polcmd = 'd'
        AND policy_row.polpermissive
        AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
        AND pg_catalog.pg_get_expr(
          policy_row.polqual, policy_row.polrelid, true
        ) = 'true'
        AND policy_row.polwithcheck IS NULL
    ) THEN
      RAISE EXCEPTION 'postflight: private authority policy set drifted: %',
        v_table;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'arena.position_history_source_contracts'::regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_source_contracts'::regclass
      AND policy_row.polname = 'owner_verified_history_contract_read'
      AND policy_row.polcmd = 'r'
      AND policy_row.polpermissive
      AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid, true
      ) = 'true'
      AND policy_row.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_source_contracts'::regclass
      AND policy_row.polname = 'owner_verified_history_contract_update'
      AND policy_row.polcmd = 'w'
      AND policy_row.polpermissive
      AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid, true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy_row.polwithcheck, policy_row.polrelid, true
      ) = 'false'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_source_contracts'::regclass
      AND policy_row.polname = 'owner_verified_history_contract_delete'
      AND policy_row.polcmd = 'd'
      AND policy_row.polpermissive
      AND policy_row.polroles = ARRAY['postgres'::regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid, true
      ) = 'true'
      AND policy_row.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'postflight: source contract policy set drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      (
        'arena.idx_position_history_acquisition_trader_identity'::regclass,
        'arena.position_history_acquisitions'::regclass,
        'CREATE INDEX idx_position_history_acquisition_trader_identity ON arena.position_history_acquisitions USING btree (trader_id, acquisition_id)'::text
      ),
      (
        'arena.idx_position_history_publication_trader_latest'::regclass,
        'arena.position_history_publications'::regclass,
        'CREATE INDEX idx_position_history_publication_trader_latest ON arena.position_history_publications USING btree (trader_id, publication_id DESC)'::text
      )
    ) AS expected(index_oid, table_oid, index_definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_class.relam
      WHERE index_row.indexrelid = v_expected.index_oid
        AND index_row.indrelid = v_expected.table_oid
        AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
          v_expected.index_definition
        AND index_class.relowner = 'postgres'::regrole
        AND index_class.relkind = 'i'
        AND index_class.relpersistence = 'p'
        AND access_method.amname = 'btree'
        AND index_row.indnatts = 2
        AND index_row.indnkeyatts = 2
        AND NOT index_row.indisunique
        AND NOT index_row.indisprimary
        AND NOT index_row.indisexclusion
        AND index_row.indimmediate
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indislive
        AND index_row.indexprs IS NULL
        AND index_row.indpred IS NULL
    ) THEN
      RAISE EXCEPTION 'postflight: hot identity index drifted: %',
        v_expected.index_oid;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND trigger_row.tgname = 'admit_position_history_raw_after_insert'
      AND trigger_row.tgfoid =
        'arena.admit_position_history_raw()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 5
      AND trigger_row.tgenabled = 'A'
      AND NOT trigger_row.tgisinternal
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgconstraint = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND trigger_row.tgname =
        'protect_position_history_raw_evidence_before_write'
      AND trigger_row.tgfoid =
        'arena.protect_position_history_raw_evidence()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
      AND trigger_row.tgenabled = 'A'
      AND NOT trigger_row.tgisinternal
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgconstraint = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND trigger_row.tgname = 'reject_position_history_raw_truncate'
      AND trigger_row.tgfoid =
        'arena.reject_position_history_raw_truncate()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 34
      AND trigger_row.tgenabled = 'A'
      AND NOT trigger_row.tgisinternal
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgconstraint = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'arena.admit_position_history_raw()'::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'arena.protect_position_history_raw_evidence()'::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR pg_catalog.has_function_privilege(
       'anon', 'arena.admit_position_history_raw()', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', 'arena.admit_position_history_raw()', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'service_role', 'arena.admit_position_history_raw()', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', 'arena.protect_position_history_raw_evidence()', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.protect_position_history_raw_evidence()',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.protect_position_history_raw_evidence()',
       'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'postflight: position-history RAW admission guard drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('arena.raw_objects'::regclass, 'admit_position_history_raw_after_insert',
       'arena.admit_position_history_raw()'::regprocedure, 5::smallint),
      ('arena.raw_objects'::regclass,
       'protect_position_history_raw_evidence_before_write',
       'arena.protect_position_history_raw_evidence()'::regprocedure, 27::smallint),
      ('arena.raw_objects'::regclass, 'reject_position_history_raw_truncate',
       'arena.reject_position_history_raw_truncate()'::regprocedure, 34::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'require_position_history_raw_admission_context',
       'arena.require_position_history_raw_admission_context()'::regprocedure,
       7::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'reject_position_history_raw_admission_row_mutation',
       'arena.reject_position_history_raw_admission_mutation()'::regprocedure,
       27::smallint),
      ('arena.position_history_raw_admissions'::regclass,
       'reject_position_history_raw_admission_truncate',
       'arena.reject_position_history_raw_admission_mutation()'::regprocedure,
       34::smallint),
      ('arena.sources'::regclass, 'protect_position_history_source_identity',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       27::smallint),
      ('arena.sources'::regclass, 'reject_position_history_source_truncate',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       34::smallint),
      ('arena.traders'::regclass, 'protect_position_history_trader_identity',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       27::smallint),
      ('arena.traders'::regclass, 'reject_position_history_trader_truncate',
       'arena.protect_position_history_registry_identity()'::regprocedure,
       34::smallint)
    ) AS expected(table_oid, trigger_name, function_oid, trigger_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_expected.table_oid
        AND trigger_row.tgname = v_expected.trigger_name
        AND trigger_row.tgfoid = v_expected.function_oid
        AND trigger_row.tgtype = v_expected.trigger_type
        AND trigger_row.tgenabled = 'A'
        AND NOT trigger_row.tgisinternal
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgattr::text = ''
        AND trigger_row.tgconstraint = 0
    ) THEN
      RAISE EXCEPTION 'postflight: prerequisite trigger drifted: %.%',
        v_expected.table_oid, v_expected.trigger_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_acquisitions'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'arena.raw_objects'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'postflight: verified evidence would block RAW retention/GC';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_source_contracts'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_source_contract_registry_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'arena.sources'::pg_catalog.regclass
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE RESTRICT'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_acquisitions'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_acquisition_trader_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'arena.traders'::pg_catalog.regclass
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'FOREIGN KEY (trader_id) REFERENCES arena.traders(id) ON DELETE RESTRICT'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.verified_position_history_facts'::pg_catalog.regclass
      AND constraint_row.conname = 'verified_position_history_trader_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'arena.traders'::pg_catalog.regclass
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'FOREIGN KEY (trader_id) REFERENCES arena.traders(id) ON DELETE RESTRICT'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.sources'::pg_catalog.regclass
      AND trigger_row.tgname =
        'protect_position_history_source_identity'
      AND trigger_row.tgfoid =
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
      AND trigger_row.tgenabled = 'A'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.traders'::pg_catalog.regclass
      AND trigger_row.tgname =
        'protect_position_history_trader_identity'
      AND trigger_row.tgfoid =
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
      AND trigger_row.tgenabled = 'A'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'postflight: source/trader immutable identity drifted';
  END IF;

  IF pg_catalog.to_regclass('arena.position_history_states') IS NOT NULL
     OR pg_catalog.to_regclass('arena.position_history_state_memberships') IS NOT NULL
     OR pg_catalog.to_regclass(
       'arena.position_history_publication_memberships'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'postflight: quadratic cumulative state storage returned';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.position_history', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = 'arena.position_history'::pg_catalog.regclass
         AND policy_row.polname = 'Public read position_history'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
           'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prosecdef
         AND pg_catalog.strpos(
           function_row.prosrc,
           'legacy position-history publisher is retired; parser-conservation receipt required'
         ) > 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.raw_objects') = 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.position_history') = 0
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
           'public.arena_records_page(text,text,text,integer,text,integer)'::pg_catalog.regprocedure
         AND pg_catalog.strpos(
           function_row.prosrc,
           'arena.position-history-completeness@2'
         ) > 0
         AND pg_catalog.strpos(
           function_row.prosrc,
           'FROM arena.verified_position_history_facts AS fact'
         ) > 0
         AND pg_catalog.strpos(
           function_row.prosrc,
           'FROM arena.position_history AS legacy'
         ) = 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'arena.position_history'::pg_catalog.regclass
         AND trigger_row.tgname =
           'protect_verified_position_history_before_write'
         AND trigger_row.tgfoid =
           'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
         AND trigger_row.tgtype = 31
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'arena.position_history'::pg_catalog.regclass
         AND trigger_row.tgname =
           'protect_verified_position_history_before_truncate'
         AND trigger_row.tgfoid =
           'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
         AND trigger_row.tgtype = 34
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
     ) THEN
    RAISE EXCEPTION 'postflight: retired history quarantine drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace IN (
      'public'::pg_catalog.regnamespace,
      'arena'::pg_catalog.regnamespace
    )
      AND function_row.proname IN (
        'arena_records_page',
        'arena_source_capabilities',
        'publish_verified_position_history'
      )
      AND function_row.oid NOT IN (
        'public.arena_records_page(text,text,text,integer,text,integer)'::pg_catalog.regprocedure,
        'public.arena_source_capabilities()'::pg_catalog.regprocedure,
        'arena.publish_verified_position_history(bigint,text,bigint,text)'::pg_catalog.regprocedure,
        'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'postflight: RPC overload appeared during cutover';
  END IF;
END
$postflight$;

COMMIT;
