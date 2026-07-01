-- Migration: 20260701153007_sensitive_rpc_notify_trader_events.sql
-- Created: 2026-07-01T22:30:07Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Expose notify_trader_events via the own-profile sensitive RPC so the Settings
-- toggle round-trips like the other notify_* prefs (otherwise the read omits it
-- and the toggle would always display ON regardless of the saved value).

-- Up
-- DROP first: changing the RETURNS TABLE shape can't be done via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS public.get_own_profile_sensitive();
CREATE OR REPLACE FUNCTION public.get_own_profile_sensitive()
 RETURNS TABLE(email text, original_email text, wallet_address text, stripe_subscription_id text, totp_enabled boolean, pro_plan text, pro_expires_at timestamp with time zone, search_history jsonb, onboarding_completed boolean, notify_comment boolean, notify_follow boolean, notify_like boolean, notify_mention boolean, notify_message boolean, notify_trader_events boolean, email_digest text, interests jsonb, market_pairs jsonb, settings_version integer, utm_source text, utm_medium text, utm_campaign text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    email, original_email, wallet_address, stripe_subscription_id,
    totp_enabled, pro_plan, pro_expires_at, search_history,
    onboarding_completed, notify_comment, notify_follow, notify_like,
    notify_mention, notify_message, notify_trader_events, email_digest, interests, market_pairs,
    settings_version, utm_source, utm_medium, utm_campaign
  FROM user_profiles
  WHERE id = auth.uid();
$function$;

-- DROP reset grants to default (PUBLIC); restore least-privilege for this PII fn.
REVOKE EXECUTE ON FUNCTION public.get_own_profile_sensitive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_own_profile_sensitive() TO authenticated;
