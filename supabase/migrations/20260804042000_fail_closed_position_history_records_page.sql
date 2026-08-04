-- Migration: 20260804042000_fail_closed_position_history_records_page.sql
-- Description: Retire the public RPC projection of legacy/@1 typed position
-- history. Until a parser-conservation receipt is bound to a new projection,
-- direct callers receive an explicit empty/unknown result. Other record kinds
-- retain their byte-identical implementation and the callable keeps its OID.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260804-fail-closed-position-history-records-page', 0)
);

CREATE TEMP TABLE records_page_quarantine_snapshot
ON COMMIT DROP
AS
SELECT
  function_row.oid AS function_oid,
  function_row.prosrc AS function_body,
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  ) AS function_body_hash
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid = pg_catalog.to_regprocedure(
  'public.arena_records_page(text,text,text,integer,text,integer)'
);

DO $preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_records_page(text,text,text,integer,text,integer)'
  );
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_language text;
  v_body_hash text;
  v_named_count integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'position-history records-page quarantine requires PostgreSQL 14 or newer';
  END IF;

  IF v_function IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'position-history records-page callable substrate is incomplete';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_temp.records_page_quarantine_snapshot) <> 1 THEN
    RAISE EXCEPTION 'position-history records-page snapshot is incomplete';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_named_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND function_row.proname = 'arena_records_page';
  IF v_named_count <> 1 THEN
    RAISE EXCEPTION 'arena_records_page overload set drifted';
  END IF;

  SELECT function_row.*
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  SELECT language_row.lanname
  INTO STRICT v_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_function_row.prolang;

  v_body_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')),
    'hex'
  );

  IF v_function_row.prokind <> 'f'
     OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_function_row.prosecdef
     OR v_function_row.provolatile <> 's'
     OR v_function_row.proparallel <> 'u'
     OR v_function_row.proretset
     OR v_function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_function_row.proisstrict
     OR v_function_row.proleakproof
     OR v_language <> 'plpgsql'
     OR v_function_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader','p_kind','p_tf','p_cursor','p_limit']::pg_catalog.text[]
     OR v_function_row.pronargdefaults <> 3
     OR v_function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_body_hash NOT IN (
          '85ab861ceef850c6d19154c3c519d44326780cccfc6773002a108a75941388b3',
          'ccac40558ee03e98967fe74dd8380484d124fac06ccc18c0ddee14fef3730e7d'
        ) THEN
    RAISE EXCEPTION 'arena_records_page callable contract drifted: %', v_body_hash;
  END IF;

  IF EXISTS (
       SELECT actual.grantor, actual.grantee, actual.privilege_type, actual.is_grantable
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_function_row.proacl,
           pg_catalog.acldefault('f', v_function_row.proowner)
         )
       ) AS actual
       EXCEPT
       SELECT expected.grantor, expected.grantee,
              expected.privilege_type, expected.is_grantable
       FROM (
         VALUES
           (v_function_row.proowner, v_function_row.proowner, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'anon'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'authenticated'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'service_role'::pg_catalog.regrole::oid, 'EXECUTE'::text, false)
       ) AS expected(grantor, grantee, privilege_type, is_grantable)
     )
     OR EXISTS (
       SELECT expected.grantor, expected.grantee,
              expected.privilege_type, expected.is_grantable
       FROM (
         VALUES
           (v_function_row.proowner, v_function_row.proowner, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'anon'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'authenticated'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'service_role'::pg_catalog.regrole::oid, 'EXECUTE'::text, false)
       ) AS expected(grantor, grantee, privilege_type, is_grantable)
       EXCEPT
       SELECT actual.grantor, actual.grantee, actual.privilege_type, actual.is_grantable
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_function_row.proacl,
           pg_catalog.acldefault('f', v_function_row.proowner)
         )
       ) AS actual
     ) THEN
    RAISE EXCEPTION 'arena_records_page ACL drifted before quarantine';
  END IF;
END
$preflight$;

DO $cutover$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_records_page(text,text,text,integer,text,integer)'
  );
  v_body text;
  v_body_hash text;
  v_anchor constant text := $anchor$  IF v_trader_id IS NULL THEN
    RETURN NULL;
  END IF;
$anchor$;
  v_guard constant text := $guard$
  IF p_kind = 'position_history' THEN
    RETURN pg_catalog.jsonb_build_object(
      'rows', '[]'::pg_catalog.jsonb,
      'nextCursor', NULL::pg_catalog.text,
      'asOf', NULL::pg_catalog.timestamptz,
      'sourceAsOf', NULL::pg_catalog.timestamptz,
      'observedAt', NULL::pg_catalog.timestamptz,
      'publishedAt', NULL::pg_catalog.timestamptz,
      'currency', v_currency,
      'completeness', pg_catalog.jsonb_build_object(
        'state', 'unknown',
        'reason', 'history_evidence_not_bound'
      )
    );
  END IF;
$guard$;
  v_history_marker constant text := $history$  ELSIF p_kind = 'position_history' THEN
$history$;
  v_orders_marker constant text := $orders$  ELSIF p_kind = 'orders' THEN
$orders$;
  v_history_start integer;
  v_orders_start integer;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_body
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_body_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')),
    'hex'
  );
  IF v_body_hash =
       'ccac40558ee03e98967fe74dd8380484d124fac06ccc18c0ddee14fef3730e7d' THEN
    RETURN;
  END IF;
  IF v_body_hash <>
       '85ab861ceef850c6d19154c3c519d44326780cccfc6773002a108a75941388b3' THEN
    RAISE EXCEPTION 'arena_records_page body changed during quarantine: %', v_body_hash;
  END IF;

  IF (
       pg_catalog.length(v_body)
       - pg_catalog.length(pg_catalog.replace(v_body, v_anchor, ''))
     ) / pg_catalog.length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'arena_records_page trader-resolution anchor drifted';
  END IF;

  v_body := pg_catalog.replace(v_body, v_anchor, v_anchor || v_guard);
  v_history_start := pg_catalog.strpos(v_body, v_history_marker);
  v_orders_start := pg_catalog.strpos(v_body, v_orders_marker);
  IF v_history_start = 0 OR v_orders_start <= v_history_start THEN
    RAISE EXCEPTION 'arena_records_page history branch boundary drifted';
  END IF;
  v_body :=
    pg_catalog.substr(v_body, 1, v_history_start - 1)
    || pg_catalog.substr(v_body, v_orders_start);

  v_body_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')),
    'hex'
  );
  IF v_body_hash <>
       'ccac40558ee03e98967fe74dd8380484d124fac06ccc18c0ddee14fef3730e7d'
     OR pg_catalog.strpos(v_body, 'arena.position_history') <> 0 THEN
    RAISE EXCEPTION 'arena_records_page quarantine transform drifted: %', v_body_hash;
  END IF;

  EXECUTE pg_catalog.format(
    $definition$
CREATE OR REPLACE FUNCTION public.arena_records_page(
  p_source text,
  p_trader text,
  p_kind text,
  p_tf int DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS %L;
$definition$,
    v_body
  );
END
$cutover$;

ALTER FUNCTION public.arena_records_page(text, text, text, int, text, int)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_records_page(text, text, text, int, text, int)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_records_page(text, text, text, int, text, int)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_records_page(text, text, text, int, text, int) IS
  'Record page reader with legacy position history fail-closed as empty/unknown. Reopening requires a parser-conservation receipt-bound projection.';

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_records_page(text,text,text,integer,text,integer)'
  );
  v_original_oid oid;
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_language text;
  v_body_hash text;
  v_named_count integer;
BEGIN
  SELECT snapshot.function_oid
  INTO STRICT v_original_oid
  FROM pg_temp.records_page_quarantine_snapshot AS snapshot;

  SELECT function_row.*
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  SELECT language_row.lanname
  INTO STRICT v_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_function_row.prolang;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_named_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND function_row.proname = 'arena_records_page';

  v_body_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')),
    'hex'
  );

  IF v_named_count <> 1
     OR v_function IS DISTINCT FROM v_original_oid
     OR v_function_row.prokind <> 'f'
     OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_function_row.prosecdef
     OR v_function_row.provolatile <> 's'
     OR v_function_row.proparallel <> 'u'
     OR v_function_row.proretset
     OR v_function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_function_row.proisstrict
     OR v_function_row.proleakproof
     OR v_language <> 'plpgsql'
     OR v_function_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader','p_kind','p_tf','p_cursor','p_limit']::pg_catalog.text[]
     OR v_function_row.pronargdefaults <> 3
     OR v_function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_body_hash <>
          'ccac40558ee03e98967fe74dd8380484d124fac06ccc18c0ddee14fef3730e7d'
     OR pg_catalog.strpos(v_function_row.prosrc, 'arena.position_history') <> 0
     OR pg_catalog.strpos(
          v_function_row.prosrc,
          'history_evidence_not_bound'
        ) = 0
     OR pg_catalog.strpos(
          v_function_row.prosrc,
          'IF p_kind = ''position_history'' THEN'
        ) = 0
     OR pg_catalog.strpos(
          v_function_row.prosrc,
          'IF p_cursor IS NOT NULL AND p_cursor <> '''' THEN'
        ) <= pg_catalog.strpos(
          v_function_row.prosrc,
          'IF p_kind = ''position_history'' THEN'
        ) THEN
    RAISE EXCEPTION 'arena_records_page quarantine postflight failed: %', v_body_hash;
  END IF;

  IF EXISTS (
       SELECT actual.grantor, actual.grantee, actual.privilege_type, actual.is_grantable
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_function_row.proacl,
           pg_catalog.acldefault('f', v_function_row.proowner)
         )
       ) AS actual
       EXCEPT
       SELECT expected.grantor, expected.grantee,
              expected.privilege_type, expected.is_grantable
       FROM (
         VALUES
           (v_function_row.proowner, v_function_row.proowner, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'anon'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'authenticated'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'service_role'::pg_catalog.regrole::oid, 'EXECUTE'::text, false)
       ) AS expected(grantor, grantee, privilege_type, is_grantable)
     )
     OR EXISTS (
       SELECT expected.grantor, expected.grantee,
              expected.privilege_type, expected.is_grantable
       FROM (
         VALUES
           (v_function_row.proowner, v_function_row.proowner, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'anon'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'authenticated'::pg_catalog.regrole::oid, 'EXECUTE'::text, false),
           (v_function_row.proowner, 'service_role'::pg_catalog.regrole::oid, 'EXECUTE'::text, false)
       ) AS expected(grantor, grantee, privilege_type, is_grantable)
       EXCEPT
       SELECT actual.grantor, actual.grantee, actual.privilege_type, actual.is_grantable
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_function_row.proacl,
           pg_catalog.acldefault('f', v_function_row.proowner)
         )
       ) AS actual
     ) THEN
    RAISE EXCEPTION 'arena_records_page ACL drifted after quarantine';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
