-- Migration: 20260627041425_record_rejected_writes_rpc.sql
-- Created: 2026-06-27T04:14:25Z (ledger version 20260627041425)
-- Description: Track 2c — RPC that upserts rejected-write rows by their unique key
--   (platform, trader_key, target_table, field), bumping occurrence_count and
--   last_seen_at instead of inserting a fresh row each cycle. Pairs with the
--   uq_rejected_writes_key index from the prior migration.
--
-- Called by logRejectedWrites() with a jsonb array. SECURITY DEFINER so the
-- service-role pipeline can record without per-row RLS overhead.

-- Up
create or replace function public.record_rejected_writes(p_rows jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.pipeline_rejected_writes
    (platform, trader_key, target_table, field, value, reason, metadata,
     created_at, last_seen_at, occurrence_count)
  select distinct on (platform, trader_key, target_table, field)
    r->>'platform'      as platform,
    r->>'trader_key'    as trader_key,
    r->>'target_table'  as target_table,
    r->>'field'         as field,
    r->>'value'         as value,
    r->>'reason'        as reason,
    coalesce(r->'metadata', '{}'::jsonb) as metadata,
    now(), now(), 1
  from jsonb_array_elements(p_rows) as r
  on conflict (platform, trader_key, target_table, field)
  do update set
    value            = excluded.value,
    reason           = excluded.reason,
    metadata         = excluded.metadata,
    last_seen_at     = now(),
    occurrence_count = public.pipeline_rejected_writes.occurrence_count + 1;
$$;

grant execute on function public.record_rejected_writes(jsonb) to service_role;
