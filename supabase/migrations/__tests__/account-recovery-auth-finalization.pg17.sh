#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ADMISSION="$ROOT_DIR/supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql"
FINALIZATION="$ROOT_DIR/supabase/migrations/20260729072000_account_recovery_auth_finalization.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo 'PostgreSQL 17 required' >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/account-recovery-auth-finalization-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"; SOCKET_DIR="$TMP_ROOT/socket"; LOG_DIR="$TMP_ROOT/logs"; PORT=55529
mkdir -p "$SOCKET_DIR" "$LOG_DIR"
cleanup() {
  local status=$?
  ((status == 0)) || tail -200 "$LOG_DIR/postgres.log" >&2 || true
  [[ ! -s "$DATA_DIR/postmaster.pid" ]] || "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null
psql_cmd() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"; }

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $f$ SELECT pg_catalog.current_setting('request.jwt.claim.role', true) $f$;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  encrypted_password text
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz,
  original_handle text,
  original_email text,
  stripe_customer_id text,
  api_stripe_subscription_id text,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.account_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE public.posts (id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), author_id uuid NOT NULL, author_handle text);
CREATE TABLE public.comments (id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), user_id uuid NOT NULL, author_handle text);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.account_recovery_tokens OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.comments OWNER TO postgres;
CREATE FUNCTION public.restore_pending_account(p_user_id uuid, p_recovery_token_hash text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_profile public.user_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_profile.deleted_at IS NULL OR v_profile.deletion_scheduled_at <= pg_catalog.clock_timestamp() THEN RETURN NULL; END IF;
  IF p_recovery_token_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.account_recovery_tokens
    WHERE user_id = p_user_id AND token_hash = p_recovery_token_hash
      AND used_at IS NULL AND expires_at > pg_catalog.clock_timestamp()
  ) THEN RETURN NULL; END IF;
  UPDATE public.user_profiles SET deleted_at = NULL, deletion_scheduled_at = NULL WHERE id = p_user_id;
  UPDATE public.account_recovery_tokens SET used_at = pg_catalog.clock_timestamp() WHERE user_id = p_user_id AND used_at IS NULL;
  RETURN p_user_id;
END $f$;
ALTER FUNCTION public.restore_pending_account(uuid,text) OWNER TO postgres;
CREATE FUNCTION public.schedule_account_deletion_with_billing_blocks(
  p_user_id uuid,p_reason text,p_scheduled_at timestamptz,p_recovery_token_hash text,
  p_stripe_customer_id text,p_stripe_subscription_ids text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE v_deleted_at timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  UPDATE public.user_profiles SET deleted_at=v_deleted_at,deletion_scheduled_at=p_scheduled_at WHERE id=p_user_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'not schedulable'; END IF;
  INSERT INTO public.account_recovery_tokens(user_id,token_hash,expires_at)
  VALUES(p_user_id,p_recovery_token_hash,p_scheduled_at);
  RETURN pg_catalog.jsonb_build_object(
    'status','scheduled','user_id',p_user_id,'deleted_at',v_deleted_at,
    'deletion_scheduled_at',p_scheduled_at,'stripe_customer_id',p_stripe_customer_id,
    'stripe_subscription_ids',p_stripe_subscription_ids
  );
END $f$;
ALTER FUNCTION public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamptz,text,text,text[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamptz,text,text,text[]) TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
SQL
psql_cmd -f "$ADMISSION" >/dev/null
psql_cmd -f "$FINALIZATION" >/dev/null

if psql_cmd >/dev/null 2>&1 <<'SQL'; then
SET request.jwt.claim.role='service_role'; SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111', repeat('1',64), gen_random_uuid()
);
SQL
  echo 'legacy unfenced recovery claim remained executable' >&2; exit 1
fi
if psql_cmd >/dev/null 2>&1 <<'SQL'; then
SET request.jwt.claim.role='service_role'; SET ROLE service_role;
SELECT public.finish_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111', gen_random_uuid()
);
SQL
  echo 'legacy unprepared recovery finish remained executable' >&2; exit 1
fi

psql_cmd <<'SQL'
INSERT INTO auth.users(id,email)
SELECT id, id::text || '@test'
FROM pg_catalog.unnest(ARRAY[
 '11111111-1111-4111-8111-111111111111'::uuid,
 '22222222-2222-4222-8222-222222222222'::uuid,
 '33333333-3333-4333-8333-333333333333'::uuid,
 '44444444-4444-4444-8444-444444444444'::uuid,
 '55555555-5555-4555-8555-555555555555'::uuid,
 '66666666-6666-4666-8666-666666666666'::uuid,
 '77777777-7777-4777-8777-777777777777'::uuid,
 '88888888-8888-4888-8888-888888888888'::uuid,
 '99999999-9999-4999-8999-999999999999'::uuid
]) AS ids(id);
INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at,original_handle)
SELECT id, id::text || '@test', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()+interval '30 days', 'user'
FROM pg_catalog.unnest(ARRAY[
 '11111111-1111-4111-8111-111111111111'::uuid,
 '22222222-2222-4222-8222-222222222222'::uuid,
 '33333333-3333-4333-8333-333333333333'::uuid,
 '44444444-4444-4444-8444-444444444444'::uuid,
 '55555555-5555-4555-8555-555555555555'::uuid,
 '66666666-6666-4666-8666-666666666666'::uuid,
 '77777777-7777-4777-8777-777777777777'::uuid,
 '88888888-8888-4888-8888-888888888888'::uuid,
 '99999999-9999-4999-8999-999999999999'::uuid
]) AS ids(id);
INSERT INTO public.account_recovery_tokens(user_id,token_hash,expires_at)
SELECT id, pg_catalog.repeat(substr(id::text,1,1),64), pg_catalog.clock_timestamp()+interval '30 days'
FROM public.user_profiles;
UPDATE auth.users AS auth_user
SET encrypted_password=extensions.crypt('correct-password',extensions.gen_salt('bf',10))
FROM public.user_profiles AS profile
WHERE profile.id=auth_user.id;
SQL

psql_cmd <<'SQL'
SET request.jwt.claim.role='service_role';
DO $two_phase_recovery_and_billing$
DECLARE u uuid:='11111111-1111-4111-8111-111111111111'; o uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; h text:=repeat('a',64); a uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
BEGIN
 IF public.claim_account_recovery_with_deletion_fence_atomic(u,repeat('1',64),o)<>'claimed' THEN RAISE EXCEPTION 'recovery claim'; END IF;
 IF public.prepare_account_recovery_auth_finalization_atomic(u,o,h)<>'prepared' THEN RAISE EXCEPTION 'prepare'; END IF;
 IF EXISTS(SELECT 1 FROM public.user_profiles WHERE id=u AND deleted_at IS NULL) THEN RAISE EXCEPTION 'prepare restored early'; END IF;
 IF public.finish_account_recovery_with_auth_finalization_atomic(u,o,h)<>'finished' THEN RAISE EXCEPTION 'finish'; END IF;
 IF public.claim_account_recovery_auth_finalization_atomic(u,o,h,a)<>'claimed' THEN RAISE EXCEPTION 'Auth claim'; END IF;
 IF public.finalize_account_recovery_auth_atomic(u,o,h,a)<>'finalized' THEN RAISE EXCEPTION 'Auth finalize'; END IF;
 IF public.arm_account_recovery_billing_atomic(u,o,h,a)<>'armed' THEN RAISE EXCEPTION 'billing arm'; END IF;
 IF public.complete_account_recovery_billing_atomic(u,o,h,a,true)<>'completed_resumed' THEN RAISE EXCEPTION 'billing complete'; END IF;
 IF public.claim_account_recovery_auth_finalization_atomic(u,o,h,gen_random_uuid())<>'completed_resumed' THEN RAISE EXCEPTION 'terminal replay'; END IF;
END $two_phase_recovery_and_billing$;

DO $password_bcrypt_contract$
DECLARE u uuid:='22222222-2222-4222-8222-222222222222'; o uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc'; ack text;
BEGIN
 IF public.claim_account_recovery_with_deletion_fence_atomic(u,NULL,o)<>'claimed' THEN RAISE EXCEPTION 'password claim'; END IF;
 IF public.verify_pending_account_password_atomic(u,o,u::text||'@test','correct-password')<>'verified' THEN RAISE EXCEPTION 'correct bcrypt'; END IF;
 IF public.verify_pending_account_password_atomic(u,o,u::text||'@test','wrong')<>'invalid' THEN RAISE EXCEPTION 'wrong bcrypt'; END IF;
 UPDATE auth.users SET encrypted_password='$2b$'||substring(encrypted_password from 5) WHERE id=u;
 IF public.verify_pending_account_password_atomic(u,o,u::text||'@test','correct-password')<>'unavailable' THEN RAISE EXCEPTION 'unsupported bcrypt was not unavailable'; END IF;
 IF (SELECT failure_count FROM public.account_recovery_password_guards WHERE user_id=u)<>1 THEN RAISE EXCEPTION 'unsupported bcrypt counted as failure'; END IF;
 BEGIN
  PERFORM public.verify_pending_account_password_atomic(u,o,u::text||'@test',repeat('x',73));
  RAISE EXCEPTION '73-byte password admitted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END $password_bcrypt_contract$;

DO $deletion_billing_saga_and_worker_lease$
DECLARE u uuid:='88888888-8888-4888-8888-888888888888'; o uuid:='12121212-1212-4212-8212-121212121212'; w uuid:='13131313-1313-4313-8313-131313131313'; h text:=repeat('d',64); ack jsonb;
BEGIN
 UPDATE public.user_profiles SET deleted_at=NULL,deletion_scheduled_at=NULL WHERE id=u;
 IF public.prepare_account_deletion_auth_fence_atomic(u,o,h,'privacy')<>'prepared' THEN RAISE EXCEPTION 'delete prepare'; END IF;
 IF public.claim_account_deletion_auth_fence_atomic(u,o,w,h)<>'billing_pending' THEN RAISE EXCEPTION 'delete claim'; END IF;
 IF public.claim_account_deletion_auth_fence_atomic(u,o,gen_random_uuid(),h)<>'busy' THEN RAISE EXCEPTION 'second worker crossed lease'; END IF;
 IF public.claim_account_recovery_with_deletion_fence_atomic(u,repeat('8',64),gen_random_uuid())<>'busy' THEN RAISE EXCEPTION 'recovery crossed billing saga'; END IF;
 ack:=public.schedule_account_deletion_with_billing_blocks_fenced(u,o,w,h,clock_timestamp()+interval '30 days',h,NULL,ARRAY[]::text[]);
 IF ack->>'status'<>'scheduled' THEN RAISE EXCEPTION 'delete schedule'; END IF;
 IF public.complete_account_deletion_auth_fence_atomic(u,o,w,h)<>'completed' THEN RAISE EXCEPTION 'delete complete'; END IF;
END $deletion_billing_saga_and_worker_lease$;
SQL

psql_cmd <<'SQL'
UPDATE public.user_profiles SET deletion_scheduled_at=clock_timestamp()-interval '1 second'
WHERE id='88888888-8888-4888-8888-888888888888';
SET request.jwt.claim.role='service_role';
DO $hard_delete_expired_claim_revalidates$
DECLARE u uuid:='88888888-8888-4888-8888-888888888888'; w1 uuid:='14141414-1414-4414-8414-141414141414';
BEGIN
 IF public.claim_account_hard_deletion_atomic(u,w1)<>'claimed' THEN RAISE EXCEPTION 'hard claim'; END IF;
END $hard_delete_expired_claim_revalidates$;
UPDATE public.account_hard_deletion_fences SET claimed_at=clock_timestamp()-interval '20 minutes',
  lease_expires_at=clock_timestamp()-interval '1 second'
WHERE user_id='88888888-8888-4888-8888-888888888888';
UPDATE public.user_profiles SET deleted_at=NULL,deletion_scheduled_at=NULL
WHERE id='88888888-8888-4888-8888-888888888888';
SET request.jwt.claim.role='service_role';
DO $hard_delete_takeover_after_restore_blocked$
DECLARE u uuid:='88888888-8888-4888-8888-888888888888'; w2 uuid:='15151515-1515-4515-8515-151515151515';
BEGIN
 IF public.claim_account_hard_deletion_atomic(u,w2)<>'invalid' THEN RAISE EXCEPTION 'expired claim skipped revalidation'; END IF;
 IF (SELECT state FROM public.account_hard_deletion_fences WHERE user_id=u)<>'released' THEN RAISE EXCEPTION 'unsafe hard claim not released'; END IF;
END $hard_delete_takeover_after_restore_blocked$;
SQL

psql_cmd <<'SQL'
SET request.jwt.claim.role='service_role';
DO $completed_recovery_can_be_superseded_by_new_deletion$
DECLARE u uuid:='11111111-1111-4111-8111-111111111111'; o uuid:='16161616-1616-4616-8616-161616161616'; h text:=repeat('e',64);
BEGIN
 IF public.prepare_account_deletion_auth_fence_atomic(u,o,h,'delete again')<>'prepared' THEN RAISE EXCEPTION 're-delete prepare failed'; END IF;
 IF EXISTS (
   SELECT 1 FROM public.account_recovery_admissions WHERE user_id=u AND (
     auth_finalization_state<>'superseded' OR auth_finalization_attempt_id IS NOT NULL
     OR auth_finalization_attempt_expires_at IS NOT NULL OR auth_finalized_at IS NOT NULL
     OR recovery_billing_resumed IS NOT NULL OR recovery_billing_may_have_changed IS NOT NULL
   )
 ) THEN RAISE EXCEPTION 'superseded recovery shape retained terminal fields'; END IF;
END $completed_recovery_can_be_superseded_by_new_deletion$;

DO $expired_recovery_capability_cannot_resume$
DECLARE u uuid:='33333333-3333-4333-8333-333333333333'; o uuid:='17171717-1717-4717-8717-171717171717'; h text:=repeat('f',64); a uuid:='18181818-1818-4818-8818-181818181818';
BEGIN
 IF public.claim_account_recovery_with_deletion_fence_atomic(u,repeat('3',64),o)<>'claimed' THEN RAISE EXCEPTION 'expiry recovery claim'; END IF;
 IF public.prepare_account_recovery_auth_finalization_atomic(u,o,h)<>'prepared' THEN RAISE EXCEPTION 'expiry recovery prepare'; END IF;
 UPDATE public.account_recovery_admissions SET auth_finalization_prepared_at=clock_timestamp()-interval '30 days 1 second' WHERE operation_id=o;
 IF public.finish_account_recovery_with_auth_finalization_atomic(u,o,h)<>'invalid' THEN RAISE EXCEPTION 'expired recovery finish replay admitted'; END IF;
 IF public.claim_account_recovery_auth_finalization_atomic(u,o,h,a)<>'invalid' THEN RAISE EXCEPTION 'expired recovery Auth replay admitted'; END IF;
 IF public.arm_account_recovery_billing_atomic(u,o,h,a)<>'invalid' THEN RAISE EXCEPTION 'expired recovery billing replay admitted'; END IF;
 IF (SELECT auth_finalization_state FROM public.account_recovery_admissions WHERE operation_id=o)<>'expired_manual' THEN RAISE EXCEPTION 'expired recovery not durable manual'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=u AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'expired recovery restored profile'; END IF;
END $expired_recovery_capability_cannot_resume$;

DO $expired_deletion_capability_cannot_schedule$
DECLARE u uuid:='44444444-4444-4444-8444-444444444444'; o uuid:='19191919-1919-4919-8919-191919191919'; w uuid:='20202020-2020-4020-8020-202020202020'; h text:=repeat('a',64);
BEGIN
 UPDATE public.user_profiles SET deleted_at=NULL,deletion_scheduled_at=NULL WHERE id=u;
 IF public.prepare_account_deletion_auth_fence_atomic(u,o,h,'expiry')<>'prepared' THEN RAISE EXCEPTION 'expiry delete prepare'; END IF;
 IF public.claim_account_deletion_auth_fence_atomic(u,o,w,h)<>'billing_pending' THEN RAISE EXCEPTION 'expiry delete claim'; END IF;
 UPDATE public.account_deletion_auth_fences SET prepared_at=clock_timestamp()-interval '31 days 1 second' WHERE user_id=u;
 IF public.claim_account_deletion_auth_fence_atomic(u,o,gen_random_uuid(),h)<>'invalid' THEN RAISE EXCEPTION 'expired deletion replay admitted'; END IF;
 IF public.schedule_account_deletion_with_billing_blocks_fenced(u,o,w,h,clock_timestamp()+interval '30 days',h,NULL,ARRAY[]::text[]) IS NOT NULL THEN RAISE EXCEPTION 'expired deletion scheduled profile'; END IF;
 IF (SELECT state FROM public.account_deletion_auth_fences WHERE user_id=u)<>'expired_manual' THEN RAISE EXCEPTION 'expired deletion not durable manual'; END IF;
 IF EXISTS(SELECT 1 FROM public.user_profiles WHERE id=u AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'expired deletion mutated profile'; END IF;
END $expired_deletion_capability_cannot_schedule$;

DO $cron_terminalizes_unattended_expiry$
DECLARE
  recovery_user uuid:='55555555-5555-4555-8555-555555555555';
  recovery_operation uuid:='21212121-2121-4121-8121-212121212121';
  deletion_user uuid:='66666666-6666-4666-8666-666666666666';
  deletion_operation uuid:='22222222-2222-4222-8222-222222222223';
  worker uuid:='23232323-2323-4323-8323-232323232323';
BEGIN
 IF public.claim_account_recovery_with_deletion_fence_atomic(recovery_user,repeat('5',64),recovery_operation)<>'claimed' THEN RAISE EXCEPTION 'unattended recovery claim'; END IF;
 IF public.prepare_account_recovery_auth_finalization_atomic(recovery_user,recovery_operation,repeat('c',64))<>'prepared' THEN RAISE EXCEPTION 'unattended recovery prepare'; END IF;
 UPDATE public.account_recovery_admissions SET auth_finalization_prepared_at=clock_timestamp()-interval '30 days 1 second' WHERE operation_id=recovery_operation;

 UPDATE public.user_profiles SET deleted_at=NULL,deletion_scheduled_at=NULL WHERE id=deletion_user;
 IF public.prepare_account_deletion_auth_fence_atomic(deletion_user,deletion_operation,repeat('d',64),'unattended')<>'prepared' THEN RAISE EXCEPTION 'unattended deletion prepare'; END IF;
 IF public.claim_account_deletion_auth_fence_atomic(deletion_user,deletion_operation,worker,repeat('d',64))<>'billing_pending' THEN RAISE EXCEPTION 'unattended deletion claim'; END IF;
 UPDATE public.account_deletion_auth_fences SET prepared_at=clock_timestamp()-interval '31 days 1 second' WHERE user_id=deletion_user;

 PERFORM public.resolve_account_auth_reconciliation_authority_atomic(recovery_user);
 PERFORM public.resolve_account_auth_reconciliation_authority_atomic(deletion_user);
 IF (SELECT auth_finalization_state FROM public.account_recovery_admissions WHERE operation_id=recovery_operation)<>'expired_manual' THEN RAISE EXCEPTION 'cron left recovery expiry live'; END IF;
 IF (SELECT state FROM public.account_deletion_auth_fences WHERE user_id=deletion_user)<>'expired_manual' THEN RAISE EXCEPTION 'cron left deletion expiry live'; END IF;
END $cron_terminalizes_unattended_expiry$;

DO $missing_profile_auth_authority_is_fail_closed$
DECLARE deletion_user uuid:='44444444-4444-4444-8444-444444444444'; recovery_user uuid:='33333333-3333-4333-8333-333333333333'; authority jsonb;
BEGIN
 DELETE FROM public.user_profiles WHERE id=deletion_user;
 authority:=public.resolve_account_auth_reconciliation_authority_atomic(deletion_user);
 IF authority->>'state'<>'banned' OR authority->>'ban_duration'<>'876000h' THEN RAISE EXCEPTION 'expired deletion drift was not fail-closed: %',authority; END IF;
 DELETE FROM public.user_profiles WHERE id=recovery_user;
 authority:=public.resolve_account_auth_reconciliation_authority_atomic(recovery_user);
 IF authority->>'state'<>'banned' OR authority->>'ban_duration'<>'876000h' THEN RAISE EXCEPTION 'recovery-only missing profile was not fail-closed: %',authority; END IF;
END $missing_profile_auth_authority_is_fail_closed$;

DO $long_lived_auth_ban_authority$
DECLARE
  pending_user uuid:='aaaaaaaa-0000-4000-8000-000000000001';
  timed_user uuid:='aaaaaaaa-0000-4000-8000-000000000002';
  deleted_user uuid:='aaaaaaaa-0000-4000-8000-000000000003';
  pending_operation uuid:='aaaaaaaa-0000-4000-8000-000000000011';
  capability_hash text:=repeat('7',64);
  authority jsonb;
  timed_until timestamptz:=clock_timestamp()+interval '1 hour';
BEGIN
  INSERT INTO auth.users(id,email) VALUES
    (pending_user,'pending@test'),(timed_user,'timed@test'),(deleted_user,'deleted@test');
  INSERT INTO public.user_profiles(
    id,email,deleted_at,deletion_scheduled_at,banned_at,is_banned,ban_expires_at
  )
  VALUES
    (pending_user,'pending@test',clock_timestamp(),clock_timestamp()+interval '30 days',NULL,false,NULL),
    (timed_user,'timed@test',NULL,NULL,clock_timestamp(),true,timed_until),
    (deleted_user,'deleted@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day',NULL,false,NULL);
  IF public.claim_account_recovery_with_deletion_fence_atomic(pending_user,NULL,pending_operation)<>'claimed' THEN RAISE EXCEPTION 'long-ban recovery claim'; END IF;
  IF public.prepare_account_recovery_auth_finalization_atomic(pending_user,pending_operation,capability_hash)<>'prepared' THEN RAISE EXCEPTION 'long-ban recovery prepare'; END IF;
  IF public.finish_account_recovery_with_auth_finalization_atomic(pending_user,pending_operation,capability_hash)<>'finished' THEN RAISE EXCEPTION 'long-ban recovery finish'; END IF;

  authority:=public.resolve_account_auth_reconciliation_authority_atomic(pending_user);
  IF authority->>'state'<>'banned' OR authority->>'ban_duration'<>'876000h'
    OR (authority->>'minimum_banned_until')::timestamptz<clock_timestamp()+interval '98 years'
  THEN RAISE EXCEPTION 'pending recovery did not receive a long ban: %',authority; END IF;
  authority:=public.resolve_account_auth_reconciliation_authority_atomic(deleted_user);
  IF authority->>'state'<>'banned' OR authority->>'ban_duration'<>'876000h'
    OR (authority->>'minimum_banned_until')::timestamptz<clock_timestamp()+interval '98 years'
  THEN RAISE EXCEPTION 'deleted profile did not receive a long ban: %',authority; END IF;
  authority:=public.resolve_account_auth_reconciliation_authority_atomic(timed_user);
  IF authority->>'state'<>'banned' OR authority->>'ban_duration'='876000h'
    OR (authority->>'minimum_banned_until')::timestamptz IS DISTINCT FROM timed_until
  THEN RAISE EXCEPTION 'standalone timed moderation did not retain its exact deadline: %',authority; END IF;

  IF public.claim_account_recovery_auth_finalization_atomic(
    pending_user,pending_operation,capability_hash,'aaaaaaaa-0000-4000-8000-000000000012'
  )<>'claimed' THEN RAISE EXCEPTION 'expiry scope claim'; END IF;
  IF public.require_account_recovery_auth_compensation_atomic(
    pending_user,pending_operation,capability_hash,'aaaaaaaa-0000-4000-8000-000000000012'
  )<>'compensation_auth_only' THEN RAISE EXCEPTION 'expiry scope compensation'; END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_prepared_at=clock_timestamp()-interval '30 days 1 second'
  WHERE operation_id=pending_operation;
  IF public.resolve_account_recovery_compensation_scope_atomic(
    pending_user,pending_operation,capability_hash,'aaaaaaaa-0000-4000-8000-000000000012'
  )<>'invalid' THEN RAISE EXCEPTION 'expired compensation scope remained executable'; END IF;
  IF (SELECT auth_finalization_state FROM public.account_recovery_admissions WHERE operation_id=pending_operation)<>'expired_manual'
  THEN RAISE EXCEPTION 'expired compensation scope was not terminalized'; END IF;
END $long_lived_auth_ban_authority$;

DO $hard_delete_worker_finalizer_is_atomic$
DECLARE
  u uuid:='bbbbbbbb-0000-4000-8000-000000000001';
  wrong_user uuid:='bbbbbbbb-0000-4000-8000-000000000002';
  w uuid:='bbbbbbbb-0000-4000-8000-000000000011';
  wrong_worker uuid:='bbbbbbbb-0000-4000-8000-000000000012';
BEGIN
  INSERT INTO auth.users(id,email) VALUES (u,'worker@test'),(wrong_user,'wrong@test');
  INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at)
  VALUES
    (u,'worker@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day'),
    (wrong_user,'wrong@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day');
  INSERT INTO public.account_hard_deletion_fences(
    user_id,worker_attempt_id,state,claimed_at,lease_expires_at,armed_at,updated_at
  ) VALUES
    (u,w,'hard_delete_pending',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '10 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()),
    (wrong_user,w,'hard_delete_pending',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '10 minutes',clock_timestamp()-interval '1 minute',clock_timestamp());

  IF public.finalize_account_hard_deletion_worker_atomic(wrong_user,wrong_worker)<>'invalid' THEN RAISE EXCEPTION 'wrong worker finalized hard deletion'; END IF;
  IF public.finalize_account_hard_deletion_worker_atomic(wrong_user,w)<>'invalid' THEN RAISE EXCEPTION 'active Auth finalized hard deletion'; END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=wrong_user)
    OR NOT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=wrong_user)
  THEN RAISE EXCEPTION 'rejected worker finalization mutated account'; END IF;

  DELETE FROM auth.users WHERE id=u;
  IF EXISTS(SELECT 1 FROM public.user_profiles WHERE id=u) THEN RAISE EXCEPTION 'Auth deletion did not cascade profile'; END IF;
  IF public.finalize_account_hard_deletion_worker_atomic(u,w)<>'completed' THEN RAISE EXCEPTION 'exact worker did not complete'; END IF;
  IF public.finalize_account_hard_deletion_worker_atomic(u,w)<>'completed' THEN RAISE EXCEPTION 'lost-response worker replay was not idempotent'; END IF;
END $hard_delete_worker_finalizer_is_atomic$;

DO $hard_delete_takeover_finalizer_is_exact$
DECLARE
  takeover_user uuid:='cccccccc-0000-4000-8000-000000000001';
  active_lease_user uuid:='cccccccc-0000-4000-8000-000000000002';
  unarmed_user uuid:='cccccccc-0000-4000-8000-000000000003';
  residual_user uuid:='cccccccc-0000-4000-8000-000000000004';
  w uuid:='cccccccc-0000-4000-8000-000000000011';
  authority jsonb;
BEGIN
  INSERT INTO auth.users(id,email) VALUES
    (takeover_user,'takeover@test'),(active_lease_user,'lease@test'),(unarmed_user,'unarmed@test');
  INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at)
  VALUES
    (takeover_user,'takeover@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day'),
    (active_lease_user,'lease@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day'),
    (unarmed_user,'unarmed@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day');
  INSERT INTO public.account_hard_deletion_fences(
    user_id,worker_attempt_id,state,claimed_at,lease_expires_at,armed_at,updated_at
  ) VALUES
    (takeover_user,w,'hard_delete_pending',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second',clock_timestamp()-interval '19 minutes',clock_timestamp()),
    (active_lease_user,w,'hard_delete_pending',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '10 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()),
    (unarmed_user,w,'claimed',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second',NULL,clock_timestamp());
  DELETE FROM auth.users WHERE id IN (takeover_user,active_lease_user,unarmed_user);

  authority:=public.resolve_account_auth_reconciliation_authority_atomic(takeover_user);
  IF authority IS DISTINCT FROM '{"state":"delete_absent","hard_delete_takeover_required":true}'::jsonb
  THEN RAISE EXCEPTION 'armed orphan did not request takeover: %',authority; END IF;
  IF public.finalize_account_hard_deletion_takeover_atomic(takeover_user)<>'completed' THEN RAISE EXCEPTION 'expired armed takeover failed'; END IF;
  IF public.finalize_account_hard_deletion_takeover_atomic(takeover_user)<>'completed' THEN RAISE EXCEPTION 'takeover replay was not idempotent'; END IF;
  IF public.finalize_account_hard_deletion_takeover_atomic(active_lease_user)<>'invalid' THEN RAISE EXCEPTION 'active lease was taken over'; END IF;
  UPDATE public.account_hard_deletion_fences SET lease_expires_at=clock_timestamp()-interval '1 second'
  WHERE user_id=active_lease_user;
  IF public.finalize_account_hard_deletion_takeover_atomic(active_lease_user)<>'completed' THEN RAISE EXCEPTION 'expired lease was not taken over'; END IF;
  IF public.finalize_account_hard_deletion_takeover_atomic(unarmed_user)<>'invalid' THEN RAISE EXCEPTION 'unarmed claim was finalized'; END IF;

  SET LOCAL session_replication_role='replica';
  INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at)
  VALUES(residual_user,'residual@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day');
  SET LOCAL session_replication_role='origin';
  INSERT INTO public.account_hard_deletion_fences(
    user_id,worker_attempt_id,state,claimed_at,lease_expires_at,armed_at,updated_at
  ) VALUES(residual_user,w,'hard_delete_pending',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second',clock_timestamp()-interval '19 minutes',clock_timestamp());
  IF public.finalize_account_hard_deletion_takeover_atomic(residual_user)<>'completed' THEN RAISE EXCEPTION 'residual profile takeover failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.user_profiles WHERE id=residual_user) THEN RAISE EXCEPTION 'residual profile survived atomic takeover'; END IF;
END $hard_delete_takeover_finalizer_is_exact$;

CREATE FUNCTION public.reject_test_hard_delete_completion()
RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  IF NEW.user_id='dddddddd-0000-4000-8000-000000000001'::uuid AND NEW.state='completed' THEN
    RAISE EXCEPTION 'injected completion failure';
  END IF;
  RETURN NEW;
END
$trigger$;
CREATE TRIGGER reject_test_hard_delete_completion
BEFORE UPDATE ON public.account_hard_deletion_fences
FOR EACH ROW EXECUTE FUNCTION public.reject_test_hard_delete_completion();
DO $hard_delete_finalizer_rolls_back_as_one_unit$
DECLARE
  u uuid:='dddddddd-0000-4000-8000-000000000001';
  w uuid:='dddddddd-0000-4000-8000-000000000011';
BEGIN
  SET LOCAL session_replication_role='replica';
  INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at)
  VALUES(u,'rollback@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day');
  SET LOCAL session_replication_role='origin';
  INSERT INTO public.account_hard_deletion_fences(
    user_id,worker_attempt_id,state,claimed_at,lease_expires_at,armed_at,updated_at
  ) VALUES(u,w,'hard_delete_pending',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second',clock_timestamp()-interval '19 minutes',clock_timestamp());
  BEGIN
    PERFORM public.finalize_account_hard_deletion_takeover_atomic(u);
    RAISE EXCEPTION 'injected finalizer failure did not fire';
  EXCEPTION WHEN RAISE_EXCEPTION THEN
    IF SQLERRM IS DISTINCT FROM 'injected completion failure' THEN RAISE; END IF;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=u)
    OR (SELECT state FROM public.account_hard_deletion_fences WHERE user_id=u)<>'hard_delete_pending'
  THEN RAISE EXCEPTION 'finalizer failure split profile and fence state'; END IF;
END $hard_delete_finalizer_rolls_back_as_one_unit$;
DROP TRIGGER reject_test_hard_delete_completion ON public.account_hard_deletion_fences;
DROP FUNCTION public.reject_test_hard_delete_completion();

DO $bounded_candidate_rotation_is_fair$
DECLARE first_batch jsonb; second_batch jsonb; hard_first jsonb; hard_second jsonb;
BEGIN
 INSERT INTO public.account_deletion_auth_fences(
   user_id,operation_id,recovery_token_hash,reason,state,prepared_at,claimed_at,
   schedule_ack,completed_at,updated_at
 )
 SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),
   repeat('b',64),'fairness','completed',clock_timestamp()-interval '1 day',
   clock_timestamp()-interval '1 day','{}'::jsonb,clock_timestamp(),clock_timestamp()
 FROM generate_series(1,102) AS series(i);
 first_batch:=public.list_account_auth_reconciliation_candidates_atomic(100);
 second_batch:=public.list_account_auth_reconciliation_candidates_atomic(100);
 IF EXISTS (
   SELECT 1 FROM generate_series(1,102) AS series(i)
   WHERE NOT (first_batch||second_batch) @> pg_catalog.jsonb_build_array(
     pg_catalog.jsonb_build_object('user_id',('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid)
   )
 ) THEN RAISE EXCEPTION 'Auth candidate 101+ starved'; END IF;

 INSERT INTO auth.users(id,email)
 SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
   'hard-'||i||'@test'
 FROM generate_series(1,102) AS series(i);
 INSERT INTO public.user_profiles(id,email,deleted_at,deletion_scheduled_at,original_email)
 SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
   'hard-'||i||'@test',clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day','hard@test'
 FROM generate_series(1,102) AS series(i);
 hard_first:=public.list_account_hard_deletion_candidates_atomic(100);
 hard_second:=public.list_account_hard_deletion_candidates_atomic(100);
 IF EXISTS (
   SELECT 1 FROM generate_series(1,102) AS series(i)
   WHERE NOT (hard_first||hard_second) @> pg_catalog.jsonb_build_array(
     pg_catalog.jsonb_build_object('id',('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid)
   )
 ) THEN RAISE EXCEPTION 'hard-delete candidate 101+ starved'; END IF;
END $bounded_candidate_rotation_is_fair$;
SQL

if psql_cmd >/dev/null 2>&1 <<'SQL'; then
SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.claim_account_hard_deletion_atomic('22222222-2222-4222-8222-222222222222',gen_random_uuid());
SQL
  echo 'anon unexpectedly executed owner-only hard-delete RPC' >&2; exit 1
fi
if psql_cmd >/dev/null 2>&1 <<'SQL'; then
SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.finalize_account_hard_deletion_worker_atomic(
  '22222222-2222-4222-8222-222222222222',gen_random_uuid()
);
SQL
  echo 'anon unexpectedly executed worker hard-delete finalizer' >&2; exit 1
fi
if psql_cmd >/dev/null 2>&1 <<'SQL'; then
SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.finalize_account_hard_deletion_takeover_atomic(
  '22222222-2222-4222-8222-222222222222'
);
SQL
  echo 'anon unexpectedly executed takeover hard-delete finalizer' >&2; exit 1
fi
psql_cmd -Atq <<'SQL' >/dev/null
DO $obsolete_hard_delete_finalizer_is_absent$
BEGIN
 IF pg_catalog.to_regprocedure('public.complete_account_hard_deletion_atomic(uuid,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'obsolete split hard-delete finalizer still exists'; END IF;
END $obsolete_hard_delete_finalizer_is_absent$;
SQL

# $transactional_replay_fail_closed$: the launch ledger never reapplies an
# installed migration. A hostile/manual replay must fail before mutation, and
# the original authority must remain intact after the failed transaction.
if psql_cmd -f "$FINALIZATION" >/dev/null 2>&1; then
  echo 'installed Auth finalization migration unexpectedly replayed' >&2; exit 1
fi
psql_cmd -Atq <<'SQL' >/dev/null
DO $transactional_replay_fail_closed$
BEGIN
 IF pg_catalog.to_regprocedure('public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid)') IS NULL
   OR NOT EXISTS (SELECT 1 FROM public.account_recovery_admissions WHERE auth_finalization_state IN ('superseded','expired_manual'))
 THEN RAISE EXCEPTION 'failed replay damaged installed Auth finalization authority'; END IF;
END $transactional_replay_fail_closed$;
SQL

echo 'Account recovery Auth finalization PostgreSQL 17 proof passed'
