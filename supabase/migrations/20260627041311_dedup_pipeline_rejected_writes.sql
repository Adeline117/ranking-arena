-- Migration: 20260627041311_dedup_pipeline_rejected_writes.sql
-- Created: 2026-06-27T04:13:11Z (ledger version 20260627041311)
-- Description: Track 2c — dedup pipeline_rejected_writes so recurring outliers
--   collapse to one row with an occurrence_count, instead of re-inserting the
--   same rejection every pipeline cycle (was accumulating unbounded noise; a
--   single hyperliquid whale + a few coincidences re-logged every 2h).
--
-- Turns the table from an append log into a "distinct known rejects" state:
--   key = (platform, trader_key, target_table, field). On repeat, code upserts
--   and bumps occurrence_count / last_seen_at (see logRejectedWrites).

-- Up
-- 1) New tracking columns.
alter table public.pipeline_rejected_writes
  add column if not exists last_seen_at timestamptz,
  add column if not exists occurrence_count integer not null default 1;

update public.pipeline_rejected_writes
  set last_seen_at = created_at
  where last_seen_at is null;

-- 2) Stamp the surviving (newest) row of each key with the total dup count.
with ranked as (
  select id,
         row_number() over (
           partition by platform, trader_key, target_table, field
           order by created_at desc, id desc
         ) as rn,
         count(*) over (
           partition by platform, trader_key, target_table, field
         ) as dup_count
  from public.pipeline_rejected_writes
)
update public.pipeline_rejected_writes p
  set occurrence_count = r.dup_count
  from ranked r
  where p.id = r.id and r.rn = 1;

-- 3) Delete the non-newest duplicate rows per key.
delete from public.pipeline_rejected_writes p
  where exists (
    select 1 from public.pipeline_rejected_writes q
    where q.platform = p.platform
      and q.trader_key = p.trader_key
      and q.target_table = p.target_table
      and q.field = p.field
      and (q.created_at > p.created_at
           or (q.created_at = p.created_at and q.id > p.id))
  );

-- 4) Enforce uniqueness so future writes upsert instead of append.
create unique index if not exists uq_rejected_writes_key
  on public.pipeline_rejected_writes (platform, trader_key, target_table, field);
