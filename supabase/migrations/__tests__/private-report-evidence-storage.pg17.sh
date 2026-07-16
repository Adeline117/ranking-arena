#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for private report evidence storage, browser
# denial, object ownership/existence checks, duplicate stability, and replay.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716113800_private_report_evidence_storage.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/private-report-evidence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55489
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE legacy_app NOLOGIN;

CREATE SCHEMA auth;
CREATE SCHEMA storage;

CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  banned_at timestamptz,
  deleted_at timestamptz
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id),
  user_id uuid NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY,
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL
);
CREATE TABLE public.content_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reporter_id uuid NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  reason text NOT NULL,
  description text,
  images text[] DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT pg_catalog.now(),
  CONSTRAINT content_reports_content_type_check
    CHECK (content_type IN ('post', 'comment', 'message', 'user')),
  CONSTRAINT content_reports_reason_check
    CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other')),
  CONSTRAINT content_reports_status_check
    CHECK (status IN ('pending', 'resolved', 'dismissed'))
);
CREATE UNIQUE INDEX uniq_content_reports_pending_reporter_content
  ON public.content_reports(reporter_id, content_type, content_id)
  WHERE status = 'pending';

CREATE TABLE public.allowed_post_actors (
  actor_id uuid NOT NULL,
  post_id uuid NOT NULL,
  PRIMARY KEY (actor_id, post_id)
);
CREATE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.allowed_post_actors AS access_row
    WHERE access_row.actor_id = p_actor_id
      AND access_row.post_id = p_post_id
  )
$$;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, legacy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects
  TO anon, authenticated, service_role;
GRANT SELECT ON storage.objects TO legacy_app;
CREATE POLICY "Legacy broad storage access"
  ON storage.objects
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.posts(id, author_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.allowed_post_actors(actor_id, post_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');

-- Initial drift proves the migration refuses to reinterpret or delete data.
INSERT INTO storage.objects(bucket_id, name) VALUES
  ('reports', '11111111-1111-4111-8111-111111111111/legacy.png');
INSERT INTO public.content_reports(
  reporter_id, content_type, content_id, reason, description, images
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'post',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'spam',
  'legacy evidence must not be rewritten',
  ARRAY['https://legacy.example/evidence.png']
);
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/missing-dependency.log" 2>&1; then
  echo "private evidence migration unexpectedly skipped the 112300 dependency" >&2
  exit 1
fi
if ! grep -q 'apply 20260716112300_atomic_content_report_submission.sql first' \
  "$TMP_ROOT/missing-dependency.log"; then
  cat "$TMP_ROOT/missing-dependency.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $dependency_rollback_proof$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'reports')
     OR pg_catalog.to_regclass('public.report_evidence_uploads') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.content_report_evidence_refs_valid(uuid,text[])'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'missing 112300 dependency changed private evidence state';
  END IF;
END
$dependency_rollback_proof$;

-- Canonical semantic boundary installed by 112300.
ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.content_reports
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.content_reports TO service_role;
CREATE POLICY "Service role manages content reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
SQL

# The 113800 preflight must prove the full 112300 schema contract, not merely
# its ACL/index headline. Exercise both defaults, every enum CHECK, and one of
# the required id lookup keys before any private-evidence object can be created.
psql_cmd -c "ALTER TABLE public.content_reports ALTER COLUMN status SET DEFAULT 'resolved'"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/status-default-drift.log" 2>&1; then
  echo "private evidence migration accepted a noncanonical status default" >&2
  exit 1
fi
grep -q 'status/images defaults' "$TMP_ROOT/status-default-drift.log"
psql_cmd -c "ALTER TABLE public.content_reports ALTER COLUMN status SET DEFAULT 'pending'"

psql_cmd -c "ALTER TABLE public.content_reports ALTER COLUMN images DROP DEFAULT"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/images-default-drift.log" 2>&1; then
  echo "private evidence migration accepted a missing 112300 images default" >&2
  exit 1
fi
grep -q 'status/images defaults' "$TMP_ROOT/images-default-drift.log"
psql_cmd -c "ALTER TABLE public.content_reports ALTER COLUMN images SET DEFAULT ARRAY[]::text[]"

for check_name in content_type reason status; do
  constraint_name="content_reports_${check_name}_check"
  psql_cmd -c "ALTER TABLE public.content_reports DROP CONSTRAINT ${constraint_name}; ALTER TABLE public.content_reports ADD CONSTRAINT ${constraint_name} CHECK (true)"
  if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/${check_name}-check-drift.log" 2>&1; then
    echo "private evidence migration accepted CHECK(true) for ${check_name}" >&2
    exit 1
  fi
  grep -q 'missing the canonical 112300 check' \
    "$TMP_ROOT/${check_name}-check-drift.log"

  psql_cmd -c "ALTER TABLE public.content_reports DROP CONSTRAINT ${constraint_name}"
  case "$check_name" in
    content_type)
      psql_cmd -c "ALTER TABLE public.content_reports ADD CONSTRAINT ${constraint_name} CHECK (content_type IN ('post', 'comment', 'message', 'user'))"
      ;;
    reason)
      psql_cmd -c "ALTER TABLE public.content_reports ADD CONSTRAINT ${constraint_name} CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other'))"
      ;;
    status)
      psql_cmd -c "ALTER TABLE public.content_reports ADD CONSTRAINT ${constraint_name} CHECK (status IN ('pending', 'resolved', 'dismissed'))"
      ;;
  esac
done

psql_cmd -c "ALTER TABLE public.conversations DROP CONSTRAINT conversations_pkey"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/id-key-drift.log" 2>&1; then
  echo "private evidence migration accepted a missing dependency id key" >&2
  exit 1
fi
grep -q 'canonical 112300 unique (id) key' "$TMP_ROOT/id-key-drift.log"
psql_cmd -c "ALTER TABLE public.conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (id)"

psql_cmd -c "ALTER TABLE public.conversations DROP CONSTRAINT conversations_pkey; ALTER TABLE public.conversations ADD CONSTRAINT conversations_pkey UNIQUE (id) DEFERRABLE INITIALLY IMMEDIATE"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/deferred-id-key-drift.log" 2>&1; then
  echo "private evidence migration accepted a deferred dependency id key" >&2
  exit 1
fi
grep -q 'canonical 112300 unique (id) key' \
  "$TMP_ROOT/deferred-id-key-drift.log"
psql_cmd -c "ALTER TABLE public.conversations DROP CONSTRAINT conversations_pkey; ALTER TABLE public.conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (id)"

psql_cmd <<'SQL'
DO $dependency_schema_rollback_proof$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'reports')
     OR pg_catalog.to_regclass('public.report_evidence_uploads') IS NOT NULL
  THEN
    RAISE EXCEPTION '112300 schema drift checks partially mutated evidence state';
  END IF;
END
$dependency_schema_rollback_proof$;
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/nonempty.log" 2>&1; then
  echo "private evidence migration unexpectedly accepted first-install data" >&2
  exit 1
fi
if ! grep -q 'first install requires empty state' "$TMP_ROOT/nonempty.log"; then
  cat "$TMP_ROOT/nonempty.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.content_reports) <> 1
     OR (SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'reports') <> 1
     OR EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'reports')
  THEN
    RAISE EXCEPTION 'non-empty preflight changed evidence or bucket state';
  END IF;
END
$rollback_proof$;
DELETE FROM public.content_reports;
DELETE FROM storage.objects WHERE bucket_id = 'reports';
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# An empty, same-named registry can still be operationally unusable when a
# nullable lifecycle column is tightened or the table is made crash-ephemeral.
# Replays must reject both catalog drifts before replacing any function/policy.
psql_cmd -c "ALTER TABLE public.report_evidence_uploads ALTER COLUMN report_id SET NOT NULL"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/registry-nullability-drift.log" 2>&1; then
  echo "private evidence replay accepted wrong registry nullability" >&2
  exit 1
fi
grep -q 'registry constraint contract drift' \
  "$TMP_ROOT/registry-nullability-drift.log"
psql_cmd -c "ALTER TABLE public.report_evidence_uploads ALTER COLUMN report_id DROP NOT NULL"

psql_cmd -c "ALTER TABLE public.report_evidence_uploads SET UNLOGGED"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/registry-persistence-drift.log" 2>&1; then
  echo "private evidence replay accepted an unlogged registry" >&2
  exit 1
fi
grep -q 'registry constraint contract drift' \
  "$TMP_ROOT/registry-persistence-drift.log"
psql_cmd -c "ALTER TABLE public.report_evidence_uploads SET LOGGED"

psql_cmd <<'SQL'
CREATE FUNCTION public.assert_sqlstate(
  p_sql text,
  p_state text,
  p_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN RETURN; END IF;
    RAISE EXCEPTION '% raised %, expected %', p_label, SQLSTATE, p_state;
  END;
  RAISE EXCEPTION '% unexpectedly succeeded', p_label;
END
$function$;
GRANT EXECUTE ON FUNCTION public.assert_sqlstate(text, text, text)
  TO anon, authenticated, service_role;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
BEGIN;
SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'png', 'image/png'
)
FROM pg_catalog.generate_series(1, 8);
SELECT public.assert_sqlstate(
  $$SELECT public.reserve_report_evidence_upload(
    '33333333-3333-4333-8333-333333333333', 'png', 'image/png'
  )$$,
  '54000',
  'ninth unclaimed upload reservation'
);
ROLLBACK;
DO $reservation_cap_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.report_evidence_uploads
    WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'reservation cap proof did not roll back cleanly';
  END IF;
END
$reservation_cap_rollback_proof$;

SELECT public.reserve_report_evidence_upload(
  '11111111-1111-4111-8111-111111111111', 'png', 'image/png'
);
SELECT public.reserve_report_evidence_upload(
  '22222222-2222-4222-8222-222222222222', 'webp', 'image/webp'
);
INSERT INTO storage.objects(bucket_id, name)
SELECT 'reports', upload_row.object_name
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.reporter_id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);
SELECT public.finalize_report_evidence_upload(
  upload_row.reporter_id,
  upload_row.evidence_ref
)
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.status = 'reserved';
RESET ROLE;
RESET request.jwt.claim.role;

INSERT INTO storage.objects(bucket_id, name) VALUES
  ('avatars', 'public-avatar.png');

SET ROLE authenticated;
SELECT public.assert_sqlstate(
  $$INSERT INTO storage.objects(bucket_id, name)
    VALUES ('reports', '11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaa.png')$$,
  '42501',
  'browser report upload'
);
DO $browser_read_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'reports') <> 0
     OR (SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'avatars') <> 1
  THEN
    RAISE EXCEPTION 'browser restrictive report policy is invalid';
  END IF;
END
$browser_read_proof$;
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-4111-8111-111111111111',
    'post',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'spam',
    'browser cannot call this report function',
    ARRAY['reports/11111111-1111-4111-8111-111111111111/0123456789abcdef.png']
  )$$,
  '42501',
  'browser submit RPC'
);
RESET ROLE;

SET ROLE legacy_app;
DO $arbitrary_role_read_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'reports') <> 0 THEN
    RAISE EXCEPTION 'an arbitrary non-service role can read private report objects';
  END IF;
END
$arbitrary_role_read_proof$;
RESET ROLE;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $service_storage_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'reports') <> 2 THEN
    RAISE EXCEPTION 'service role cannot read private report objects';
  END IF;
END
$service_storage_proof$;

DO $rpc_proof$
DECLARE
  v_created jsonb;
  v_duplicate jsonb;
  v_cleanup jsonb;
  v_evidence_ref text;
BEGIN
  SELECT upload_row.evidence_ref
  INTO v_evidence_ref
  FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.reporter_id = '11111111-1111-4111-8111-111111111111'
    AND upload_row.status = 'uploaded';

  v_created := public.submit_content_report(
    '11111111-1111-4111-8111-111111111111',
    'post',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'spam',
    'documented private report evidence',
    ARRAY[v_evidence_ref]
  );
  v_duplicate := public.submit_content_report(
    '11111111-1111-4111-8111-111111111111',
    'post',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'spam',
    'documented private report evidence',
    ARRAY[v_evidence_ref]
  );
  v_cleanup := public.lease_report_evidence_cleanup(
    '11111111-1111-4111-8111-111111111111',
    v_evidence_ref
  );

  IF (v_created ->> 'created')::boolean IS NOT true
     OR (v_duplicate ->> 'created')::boolean IS NOT false
     OR v_duplicate ->> 'reason' <> 'DUPLICATE_PENDING'
     OR v_created ->> 'reason' <> 'spam'
     OR v_cleanup ->> 'reason' <> 'CLAIMED'
     OR EXISTS (
       SELECT 1
       FROM public.report_evidence_uploads AS upload_row
       WHERE upload_row.evidence_ref = v_evidence_ref
         AND (
           upload_row.status <> 'claimed'
           OR upload_row.report_id::text <> (v_created ->> 'report_id')
         )
     )
  THEN
    RAISE EXCEPTION 'report create/duplicate result is unstable: % %', v_created, v_duplicate;
  END IF;
END
$rpc_proof$;

SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-4111-8111-111111111111',
    'user',
    '22222222-2222-4222-8222-222222222222',
    'spam',
    'cross reporter evidence is forbidden',
    ARRAY[(
      SELECT upload_row.evidence_ref
      FROM public.report_evidence_uploads AS upload_row
      WHERE upload_row.reporter_id = '22222222-2222-4222-8222-222222222222'
    )]
  )$$,
  '22023',
  'cross reporter evidence'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-4111-8111-111111111111',
    'user',
    '22222222-2222-4222-8222-222222222222',
    'spam',
    'missing report evidence is forbidden',
    ARRAY['reports/11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaa.png']
  )$$,
  '22023',
  'missing report evidence'
);

-- An uploaded registry row is still rejected if the underlying object has
-- disappeared. The direct object delete is test-fixture simulation only; the
-- migration and application worker never delete storage.objects directly.
DO $missing_object_proof$
DECLARE
  v_reservation jsonb;
  v_ref text;
  v_object_name text;
BEGIN
  v_reservation := public.reserve_report_evidence_upload(
    '33333333-3333-4333-8333-333333333333', 'png', 'image/png'
  );
  v_ref := v_reservation ->> 'evidence_ref';
  v_object_name := v_reservation ->> 'object_name';
  INSERT INTO storage.objects(bucket_id, name) VALUES ('reports', v_object_name);
  PERFORM public.finalize_report_evidence_upload(
    '33333333-3333-4333-8333-333333333333', v_ref
  );
  DELETE FROM storage.objects
  WHERE bucket_id = 'reports' AND name = v_object_name;

  BEGIN
    PERFORM public.submit_content_report(
      '33333333-3333-4333-8333-333333333333',
      'user',
      '22222222-2222-4222-8222-222222222222',
      'fraud',
      'uploaded registry evidence object is missing',
      ARRAY[v_ref]
    );
    RAISE EXCEPTION 'missing Storage object unexpectedly submitted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END
$missing_object_proof$;

SELECT public.lease_report_evidence_cleanup(
  upload_row.reporter_id,
  upload_row.evidence_ref
)
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.reporter_id = '22222222-2222-4222-8222-222222222222';
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '22222222-2222-4222-8222-222222222222',
    'user',
    '11111111-1111-4111-8111-111111111111',
    'harassment',
    'cleanup won the report evidence row lock',
    ARRAY[(
      SELECT upload_row.evidence_ref
      FROM public.report_evidence_uploads AS upload_row
      WHERE upload_row.reporter_id = '22222222-2222-4222-8222-222222222222'
    )]
  )$$,
  '22023',
  'cleanup before submit'
);

-- Prove stale leasing is transactional, leases can be released after a worker
-- failure, and a later worker receives a fresh token before acknowledgement.
SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'webp', 'image/webp'
);
UPDATE public.report_evidence_uploads
SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
  AND status = 'reserved';
BEGIN;
DO $stale_lease_transaction_proof$
DECLARE
  v_batch jsonb;
BEGIN
  v_batch := public.lease_stale_report_evidence_cleanup(50);
  IF pg_catalog.jsonb_array_length(v_batch) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.report_evidence_uploads
    WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
      AND status = 'cleanup'
      AND lease_token IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'stale cleanup lease was not acquired transactionally';
  END IF;
END
$stale_lease_transaction_proof$;
ROLLBACK;
DO $stale_lease_rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.report_evidence_uploads
    WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
      AND status = 'reserved'
      AND lease_token IS NULL
  ) THEN
    RAISE EXCEPTION 'rolled-back stale cleanup lease changed registry state';
  END IF;
END
$stale_lease_rollback_proof$;
DO $stale_lease_retry_proof$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_ref text;
  v_first_token uuid;
  v_second_token uuid;
BEGIN
  v_first := public.lease_stale_report_evidence_cleanup(50) -> 0;
  v_ref := v_first ->> 'evidence_ref';
  v_first_token := (v_first ->> 'lease_token')::uuid;
  IF NOT public.release_report_evidence_cleanup(
    '33333333-3333-4333-8333-333333333333', v_ref, v_first_token
  ) THEN
    RAISE EXCEPTION 'worker failure did not release cleanup lease';
  END IF;

  v_second := public.lease_stale_report_evidence_cleanup(50) -> 0;
  v_second_token := (v_second ->> 'lease_token')::uuid;
  IF v_second_token = v_first_token OR NOT public.ack_report_evidence_cleanup(
    '33333333-3333-4333-8333-333333333333', v_ref, v_second_token
  ) THEN
    RAISE EXCEPTION 'cleanup retry token/ack contract failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.report_evidence_uploads WHERE evidence_ref = v_ref
  ) THEN
    RAISE EXCEPTION 'cleanup acknowledgement left registry row behind';
  END IF;
END
$stale_lease_retry_proof$;

SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'gif', 'image/gif'
);
SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'avif', 'image/avif'
);
UPDATE public.report_evidence_uploads
SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
  AND status = 'reserved';
RESET ROLE;
RESET request.jwt.claim.role;
SQL

# Force both opposite-order submissions to retain their first logical step long
# enough to overlap. A storage-row blocker pauses the [A,B] caller after it has
# locked registry A. With caller-order locking, [B,A] then holds registry B and
# the two RPCs deadlock; canonical evidence_ref locking lets only A be first.
psql_cmd <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'jpg', 'image/jpeg'
);
SELECT public.reserve_report_evidence_upload(
  '33333333-3333-4333-8333-333333333333', 'png', 'image/png'
);
INSERT INTO storage.objects(bucket_id, name)
SELECT 'reports', upload_row.object_name
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.reporter_id = '33333333-3333-4333-8333-333333333333'
  AND upload_row.status = 'reserved'
  AND upload_row.expires_at > pg_catalog.clock_timestamp();
SELECT public.finalize_report_evidence_upload(
  upload_row.reporter_id,
  upload_row.evidence_ref
)
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.reporter_id = '33333333-3333-4333-8333-333333333333'
  AND upload_row.status = 'reserved'
  AND upload_row.expires_at > pg_catalog.clock_timestamp();
RESET ROLE;
RESET request.jwt.claim.role;
SQL

EVIDENCE_A="$(psql_cmd -Atc "
  SELECT upload_row.evidence_ref
  FROM public.report_evidence_uploads AS upload_row
  JOIN storage.objects AS object_row
    ON object_row.bucket_id = 'reports'
   AND object_row.name = upload_row.object_name
  WHERE upload_row.reporter_id = '33333333-3333-4333-8333-333333333333'
    AND upload_row.status = 'uploaded'
  ORDER BY upload_row.evidence_ref
  LIMIT 1
")"
EVIDENCE_B="$(psql_cmd -Atc "
  SELECT upload_row.evidence_ref
  FROM public.report_evidence_uploads AS upload_row
  JOIN storage.objects AS object_row
    ON object_row.bucket_id = 'reports'
   AND object_row.name = upload_row.object_name
  WHERE upload_row.reporter_id = '33333333-3333-4333-8333-333333333333'
    AND upload_row.status = 'uploaded'
  ORDER BY upload_row.evidence_ref DESC
  LIMIT 1
")"

if [[ -z "$EVIDENCE_A" || -z "$EVIDENCE_B" || "$EVIDENCE_A" == "$EVIDENCE_B" ]]; then
  echo "could not seed two distinct evidence rows for lock-order proof" >&2
  exit 1
fi

(
  psql_cmd -v evidence_ref="$EVIDENCE_A" <<SQL
BEGIN;
SELECT object_row.id
FROM storage.objects AS object_row
WHERE object_row.bucket_id = 'reports'
  AND object_row.name = pg_catalog.substr(:'evidence_ref', 9)
FOR UPDATE;
\! touch "$TMP_ROOT/evidence-object-lock.ready"
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
) >"$TMP_ROOT/evidence-object-lock.log" 2>&1 &
OBJECT_LOCK_PID=$!

object_lock_ready=false
for _attempt in {1..100}; do
  if [[ -f "$TMP_ROOT/evidence-object-lock.ready" ]]; then
    object_lock_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$object_lock_ready" != true ]]; then
  cat "$TMP_ROOT/evidence-object-lock.log" >&2 || true
  echo "timed out waiting for evidence object lock" >&2
  exit 1
fi

(
  psql_cmd -v evidence_a="$EVIDENCE_A" -v evidence_b="$EVIDENCE_B" <<'SQL'
BEGIN;
SET LOCAL application_name = 'report-evidence-order-ab';
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.submit_content_report(
  '33333333-3333-4333-8333-333333333333',
  'user',
  '11111111-1111-4111-8111-111111111111',
  'fraud',
  'canonical evidence lock order caller AB',
  ARRAY[:'evidence_a', :'evidence_b']::text[]
);
COMMIT;
SQL
) >"$TMP_ROOT/evidence-order-ab.log" 2>&1 &
ORDER_AB_PID=$!

(
  psql_cmd -v evidence_a="$EVIDENCE_A" -v evidence_b="$EVIDENCE_B" <<'SQL'
BEGIN;
SET LOCAL application_name = 'report-evidence-order-ba';
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.submit_content_report(
  '33333333-3333-4333-8333-333333333333',
  'user',
  '22222222-2222-4222-8222-222222222222',
  'fraud',
  'canonical evidence lock order caller BA',
  ARRAY[:'evidence_b', :'evidence_a']::text[]
);
COMMIT;
SQL
) >"$TMP_ROOT/evidence-order-ba.log" 2>&1 &
ORDER_BA_PID=$!

both_waiting=false
for _attempt in {1..100}; do
  if [[ "$(psql_cmd -Atc "
    SELECT pg_catalog.count(*) = 2
    FROM pg_catalog.pg_stat_activity
    WHERE application_name IN (
      'report-evidence-order-ab',
      'report-evidence-order-ba'
    )
      AND wait_event_type = 'Lock'
  ")" == "t" ]]; then
    both_waiting=true
    break
  fi
  sleep 0.02
done
if [[ "$both_waiting" != true ]]; then
  cat "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log" >&2 || true
  echo "opposite-order submissions did not reach the lock-order probe" >&2
  exit 1
fi

wait "$OBJECT_LOCK_PID"
set +e
wait "$ORDER_AB_PID"
ORDER_AB_STATUS=$?
wait "$ORDER_BA_PID"
ORDER_BA_STATUS=$?
set -e

if grep -q 'deadlock detected' \
  "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log"; then
  cat "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log" >&2
  echo "opposite-order evidence arrays deadlocked" >&2
  exit 1
fi
if [[ "$ORDER_AB_STATUS" -eq 0 && "$ORDER_BA_STATUS" -eq 0 ]] \
   || [[ "$ORDER_AB_STATUS" -ne 0 && "$ORDER_BA_STATUS" -ne 0 ]]; then
  cat "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log" >&2
  echo "opposite-order submissions did not produce exactly one winner" >&2
  exit 1
fi
if ! grep -q 'report evidence upload is unavailable' \
  "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log"; then
  cat "$TMP_ROOT/evidence-order-ab.log" "$TMP_ROOT/evidence-order-ba.log" >&2
  echo "losing opposite-order submission did not observe the claimed registry row" >&2
  exit 1
fi

psql_cmd -v evidence_a="$EVIDENCE_A" -v evidence_b="$EVIDENCE_B" <<'SQL'
SELECT pg_catalog.set_config('test.evidence_a', :'evidence_a', false);
SELECT pg_catalog.set_config('test.evidence_b', :'evidence_b', false);

DO $canonical_evidence_lock_order_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.content_reports AS report_row
    WHERE report_row.reporter_id = '33333333-3333-4333-8333-333333333333'
      AND report_row.content_type = 'user'
      AND report_row.content_id IN (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222'
      )
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.evidence_ref IN (
      pg_catalog.current_setting('test.evidence_a'),
      pg_catalog.current_setting('test.evidence_b')
    )
      AND (
        upload_row.status <> 'claimed'
        OR upload_row.report_id IS NULL
      )
  ) OR (
    SELECT pg_catalog.count(DISTINCT upload_row.report_id)
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.evidence_ref IN (
      pg_catalog.current_setting('test.evidence_a'),
      pg_catalog.current_setting('test.evidence_b')
    )
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical evidence lock order left inconsistent claims';
  END IF;
END
$canonical_evidence_lock_order_proof$;

DO $canonical_evidence_lock_order_cleanup$
DECLARE
  v_report_id uuid;
BEGIN
  SELECT upload_row.report_id
  INTO v_report_id
  FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.evidence_ref = pg_catalog.current_setting('test.evidence_a');

  DELETE FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.evidence_ref IN (
    pg_catalog.current_setting('test.evidence_a'),
    pg_catalog.current_setting('test.evidence_b')
  );

  DELETE FROM public.content_reports AS report_row
  WHERE report_row.id = v_report_id;

  DELETE FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'reports'
    AND object_row.name IN (
      pg_catalog.substr(pg_catalog.current_setting('test.evidence_a'), 9),
      pg_catalog.substr(pg_catalog.current_setting('test.evidence_b'), 9)
    );

  IF EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.evidence_ref IN (
      pg_catalog.current_setting('test.evidence_a'),
      pg_catalog.current_setting('test.evidence_b')
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    WHERE report_row.id = v_report_id
  ) OR EXISTS (
    SELECT 1
    FROM storage.objects AS object_row
    WHERE object_row.bucket_id = 'reports'
      AND object_row.name IN (
        pg_catalog.substr(pg_catalog.current_setting('test.evidence_a'), 9),
        pg_catalog.substr(pg_catalog.current_setting('test.evidence_b'), 9)
      )
  ) THEN
    RAISE EXCEPTION 'canonical evidence lock order fixture cleanup failed';
  END IF;
END
$canonical_evidence_lock_order_cleanup$;
SQL

# Hold one stale row in a separate transaction. The worker must lease the
# other row immediately via FOR UPDATE SKIP LOCKED, never block or duplicate.
LOCKED_EVIDENCE_REF="$(psql_cmd -Atc "
  SELECT evidence_ref
  FROM public.report_evidence_uploads
  WHERE reporter_id = '33333333-3333-4333-8333-333333333333'
    AND status = 'reserved'
  ORDER BY evidence_ref
  LIMIT 1
")"

(
  psql_cmd <<SQL
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
BEGIN;
SELECT evidence_ref
FROM public.report_evidence_uploads
WHERE evidence_ref = '$LOCKED_EVIDENCE_REF'
FOR UPDATE;
\! touch "$TMP_ROOT/lease-lock.ready"
SELECT pg_catalog.pg_sleep(2);
ROLLBACK;
SQL
) >"$TMP_ROOT/lease-lock.log" 2>&1 &
LOCK_PID=$!

lock_ready=false
for _attempt in {1..100}; do
  if [[ -f "$TMP_ROOT/lease-lock.ready" ]]; then
    lock_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$lock_ready" != true ]]; then
  cat "$TMP_ROOT/lease-lock.log" >&2 || true
  echo "timed out waiting for cleanup concurrency row lock" >&2
  exit 1
fi

psql_cmd -v locked_ref="$LOCKED_EVIDENCE_REF" <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT pg_catalog.set_config('test.locked_evidence_ref', :'locked_ref', false);
DO $skip_locked_concurrency_proof$
DECLARE
  v_batch jsonb;
  v_item jsonb;
BEGIN
  v_batch := public.lease_stale_report_evidence_cleanup(50);
  IF pg_catalog.jsonb_array_length(v_batch) <> 1
     OR v_batch @> pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object(
         'evidence_ref', pg_catalog.current_setting('test.locked_evidence_ref')
       )
     )
  THEN
    RAISE EXCEPTION 'cleanup worker did not skip the concurrently locked row: %', v_batch;
  END IF;
  v_item := v_batch -> 0;
  IF NOT public.ack_report_evidence_cleanup(
    (v_item ->> 'reporter_id')::uuid,
    v_item ->> 'evidence_ref',
    (v_item ->> 'lease_token')::uuid
  ) THEN
    RAISE EXCEPTION 'cleanup worker could not acknowledge unlocked row';
  END IF;
END
$skip_locked_concurrency_proof$;
RESET ROLE;
RESET request.jwt.claim.role;
SQL

wait "$LOCK_PID"

psql_cmd <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $previously_locked_retry_proof$
DECLARE
  v_batch jsonb;
  v_item jsonb;
BEGIN
  v_batch := public.lease_stale_report_evidence_cleanup(50);
  IF pg_catalog.jsonb_array_length(v_batch) <> 1 THEN
    RAISE EXCEPTION 'previously locked cleanup row was not retried: %', v_batch;
  END IF;
  v_item := v_batch -> 0;
  IF NOT public.ack_report_evidence_cleanup(
    (v_item ->> 'reporter_id')::uuid,
    v_item ->> 'evidence_ref',
    (v_item ->> 'lease_token')::uuid
  ) THEN
    RAISE EXCEPTION 'previously locked cleanup row could not be acknowledged';
  END IF;
END
$previously_locked_retry_proof$;
RESET ROLE;
RESET request.jwt.claim.role;
SQL

# A canonical replay must not leave a Storage object outside the registry/TTL
# lifecycle. The migration fails closed after taking its table locks and leaves
# the object untouched for explicit registration or operator cleanup.
psql_cmd <<'SQL'
INSERT INTO storage.objects(bucket_id, name) VALUES (
  'reports',
  '33333333-3333-4333-8333-333333333333/ffffffffffffffff.png'
);
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/unregistered-object-replay.log" 2>&1; then
  echo "private evidence replay accepted an unregistered reports object" >&2
  exit 1
fi
grep -q 'unregistered object' "$TMP_ROOT/unregistered-object-replay.log"
psql_cmd <<'SQL'
DO $unregistered_object_rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.objects AS object_row
    WHERE object_row.bucket_id = 'reports'
      AND object_row.name =
        '33333333-3333-4333-8333-333333333333/ffffffffffffffff.png'
  ) OR EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.object_name =
      '33333333-3333-4333-8333-333333333333/ffffffffffffffff.png'
  ) THEN
    RAISE EXCEPTION 'unregistered object replay did not fail before mutation';
  END IF;
END
$unregistered_object_rollback_proof$;
DELETE FROM storage.objects
WHERE bucket_id = 'reports'
  AND name = '33333333-3333-4333-8333-333333333333/ffffffffffffffff.png';
SQL

# Same-name constraints are not a contract. CHECK(true), a different UNIQUE
# key, and a foreign key to the wrong table must each stop replay preflight.
psql_cmd <<'SQL'
ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_status_check;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_status_check CHECK (true);
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/registry-check-drift.log" 2>&1; then
  echo "private evidence replay accepted registry CHECK(true)" >&2
  exit 1
fi
grep -q 'registry constraint contract drift' "$TMP_ROOT/registry-check-drift.log"
psql_cmd <<'SQL'
ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_status_check;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_status_check
  CHECK (status IN ('reserved', 'uploaded', 'cleanup', 'claimed'));

ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_object_name_key;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_object_name_key
  UNIQUE (evidence_ref, object_name);
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/registry-unique-drift.log" 2>&1; then
  echo "private evidence replay accepted a wrong same-name registry UNIQUE" >&2
  exit 1
fi
grep -q 'registry constraint contract drift' "$TMP_ROOT/registry-unique-drift.log"
psql_cmd <<'SQL'
ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_object_name_key;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_object_name_key UNIQUE (object_name);

CREATE TABLE public.wrong_report_targets (id uuid PRIMARY KEY);
INSERT INTO public.wrong_report_targets(id)
SELECT DISTINCT upload_row.report_id
FROM public.report_evidence_uploads AS upload_row
WHERE upload_row.report_id IS NOT NULL;
ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_report_id_fkey;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_report_id_fkey
  FOREIGN KEY (report_id)
  REFERENCES public.wrong_report_targets(id)
  ON DELETE RESTRICT;
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/registry-fkey-drift.log" 2>&1; then
  echo "private evidence replay accepted a wrong same-name registry FK" >&2
  exit 1
fi
grep -q 'registry constraint contract drift' "$TMP_ROOT/registry-fkey-drift.log"
psql_cmd <<'SQL'
ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT report_evidence_uploads_report_id_fkey;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_report_id_fkey
  FOREIGN KEY (report_id)
  REFERENCES public.content_reports(id)
  ON DELETE RESTRICT;
DROP TABLE public.wrong_report_targets;
SQL

psql_cmd <<'SQL'

-- Inject replay drift. Canonical data must survive while catalogs converge.
UPDATE storage.buckets
SET public = true,
    file_size_limit = 9999999,
    allowed_mime_types = ARRAY['text/plain']
WHERE id = 'reports';
DROP POLICY "Non-service roles cannot access report evidence" ON storage.objects;
CREATE POLICY "Non-service roles cannot access report evidence"
  ON storage.objects AS PERMISSIVE FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE FUNCTION public.submit_content_report(p_reporter_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $$ SELECT '{}'::jsonb $$;
GRANT EXECUTE ON FUNCTION public.submit_content_report(uuid)
  TO PUBLIC, anon, authenticated, legacy_app;
CREATE FUNCTION public.content_report_evidence_refs_valid(p_images text[])
RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$ SELECT true $$;
GRANT EXECUTE ON FUNCTION public.content_report_evidence_refs_valid(text[])
  TO PUBLIC, authenticated, legacy_app;
GRANT ALL PRIVILEGES ON TABLE public.report_evidence_uploads TO legacy_app;
GRANT SELECT (mime_type), UPDATE (status)
  ON TABLE public.report_evidence_uploads TO PUBLIC, authenticated, legacy_app;
CREATE POLICY "Registry browser drift"
  ON public.report_evidence_uploads FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE FUNCTION public.reserve_report_evidence_upload(p_reporter_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $$ SELECT '{}'::jsonb $$;
GRANT EXECUTE ON FUNCTION public.reserve_report_evidence_upload(uuid)
  TO PUBLIC, authenticated, legacy_app;
GRANT SELECT ON TABLE public.content_reports TO legacy_app;
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/dependency-drift.log" 2>&1; then
  echo "private evidence migration unexpectedly accepted dependency ACL drift" >&2
  exit 1
fi
if ! grep -q 'apply 20260716112300_atomic_content_report_submission.sql first' \
  "$TMP_ROOT/dependency-drift.log"; then
  cat "$TMP_ROOT/dependency-drift.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $dependency_drift_rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'reports' AND public IS true AND file_size_limit = 9999999
  ) OR pg_catalog.to_regprocedure(
    'public.reserve_report_evidence_upload(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'dependency preflight partially mutated replay drift';
  END IF;
END
$dependency_drift_rollback_proof$;
REVOKE SELECT ON TABLE public.content_reports FROM legacy_app;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $catalog_and_replay_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.content_reports) <> 1
     OR pg_catalog.to_regprocedure('public.submit_content_report(uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.content_report_evidence_refs_valid(text[])') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.reserve_report_evidence_upload(uuid)') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM storage.buckets
       WHERE id = 'reports'
         AND name = 'reports'
         AND public IS false
         AND file_size_limit = 2097152
         AND allowed_mime_types = ARRAY[
           'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'
         ]::text[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'storage.objects'::regclass
         AND policy.polname = 'Non-service roles cannot access report evidence'
         AND NOT policy.polpermissive
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.submit_content_report(uuid,text,uuid,text,text,text[])',
       'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'legacy_app', 'public.report_evidence_uploads', 'SELECT'
     )
     OR pg_catalog.has_column_privilege(
       'authenticated', 'public.report_evidence_uploads', 'status', 'UPDATE'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.report_evidence_uploads'::regclass
         AND policy.polname = 'Registry browser drift'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.content_report_evidence_refs_valid(uuid,text[])',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'private report evidence replay/catalog contract failed';
  END IF;
END
$catalog_and_replay_proof$;
SQL

echo "private report evidence PostgreSQL 17 proof passed"
