-- Migration: 20260627035852_arena_partitions_enable_rls_public_read.sql
-- Created: 2026-06-27T03:58:52Z (ledger version 20260627035852)
-- Description: Track 1a — enable RLS + public-read SELECT policy on all arena.*
--   partition child tables (silences the critical rls_disabled advisor).
--
-- Why: 61 partition children (arena.leaderboard_entries_y*, trader_series_y*,
-- position_history_*, order_records_y*, transfer_history_y*, copier_records_y*)
-- had relrowsecurity=false. Direct partition access via PostgREST bypasses the
-- parent's "Public read" policy. The parents already serve this data public-read
-- (qual=true) and writes are blocked by table grants (anon/authenticated have
-- SELECT only; service_role bypasses RLS), so there is NO new data/write exposure
-- — but it trips the critical "rls_disabled" advisor and is an inconsistent
-- posture. We enable RLS + a USING(true) SELECT policy matching the parent so the
-- read result is identical whether a row is fetched via parent or child partition.
--
-- Idempotent: only touches arena partition children that still have RLS disabled.

-- Up
do $$
declare
  t record;
  pol_name text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'arena'
      and c.relkind = 'r'
      and c.relispartition = true
      and c.relrowsecurity = false
  loop
    execute format('alter table arena.%I enable row level security', t.relname);
    pol_name := 'public_read_' || t.relname;
    execute format('drop policy if exists %I on arena.%I', pol_name, t.relname);
    execute format(
      'create policy %I on arena.%I for select to anon, authenticated using (true)',
      pol_name, t.relname
    );
  end loop;
end $$;
