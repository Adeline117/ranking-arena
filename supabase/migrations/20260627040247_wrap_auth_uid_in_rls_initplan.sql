-- Migration: 20260627040247_wrap_auth_uid_in_rls_initplan.sql
-- Created: 2026-06-27T04:02:47Z (ledger version 20260627040247)
-- Description: Track 1b — wrap auth.uid() in (select auth.uid()) for 8 RLS policies
--   flagged by the auth_rls_initplan performance advisor.
--
-- Why: a bare auth.uid() in an RLS qual is re-evaluated per row. Wrapping it in a
-- scalar subselect lets Postgres evaluate it once (initplan), a standard Supabase
-- optimization. Logic, roles ({public}) and cmd are preserved exactly — only the
-- function call is wrapped.

-- Up
-- api_keys
drop policy if exists "Users can read own api_keys" on public.api_keys;
create policy "Users can read own api_keys" on public.api_keys
  for select to public using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own api_keys" on public.api_keys;
create policy "Users can insert own api_keys" on public.api_keys
  for insert to public with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own api_keys" on public.api_keys;
create policy "Users can update own api_keys" on public.api_keys
  for update to public using ((select auth.uid()) = user_id);

-- api_key_usage_daily
drop policy if exists "Users can read own api_key_usage_daily" on public.api_key_usage_daily;
create policy "Users can read own api_key_usage_daily" on public.api_key_usage_daily
  for select to public using (exists (
    select 1 from public.api_keys
    where api_keys.id = api_key_usage_daily.api_key_id
      and api_keys.user_id = (select auth.uid())
  ));

-- quiz_results
drop policy if exists "quiz_select_own" on public.quiz_results;
create policy "quiz_select_own" on public.quiz_results
  for select to public using (
    ((select auth.uid()) is not null) and ((select auth.uid()) = user_id)
  );

-- trader_watchlist
drop policy if exists "Users can view own watchlist" on public.trader_watchlist;
create policy "Users can view own watchlist" on public.trader_watchlist
  for select to public using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own watchlist" on public.trader_watchlist;
create policy "Users can insert own watchlist" on public.trader_watchlist
  for insert to public with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own watchlist" on public.trader_watchlist;
create policy "Users can delete own watchlist" on public.trader_watchlist
  for delete to public using ((select auth.uid()) = user_id);
