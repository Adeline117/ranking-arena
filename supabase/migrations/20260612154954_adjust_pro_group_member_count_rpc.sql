-- Migration: 20260612154954_adjust_pro_group_member_count_rpc.sql
-- Created: 2026-06-12T22:49:54Z
-- Description: adjust_pro_group_member_count(p_group_id uuid, p_delta int) —
--   atomic counter maintenance for pro_official_groups.current_member_count.
--
-- Context: the never-existed RPC trio (get_user_pro_official_group /
-- join_pro_official_group / leave_pro_official_group) was removed from
-- app/api/pro-official-group/route.ts on 2026-06-12; the TS implementation
-- (formerly the "fallback") is now the only path. That path inserts/deletes
-- pro_official_group_members rows and must keep the parent counter in sync.
--
-- Per CLAUDE.md counter mandate: NO read-modify-write, NO trigger-based
-- count+1. A single SQL UPDATE with a relative delta is atomic — concurrent
-- callers serialize on the row lock and each delta is applied exactly once.
-- GREATEST(..., 0) guards against double-decrement drift going negative.
--
-- The caller (adjustMemberCount in app/api/pro-official-group/route.ts) gates
-- this RPC with a recount fallback (SELECT count(*) → UPDATE absolute value)
-- so the route keeps working before this migration is applied.

-- Concurrency Safety Checklist:
-- [x] Counter columns: atomic RPC (this function), NOT trigger-based count+1
-- [x] New functions: SET search_path = public, SECURITY DEFINER
-- [x] Privileges: EXECUTE revoked from public/anon/authenticated —
--     only service_role (the route runs with getSupabaseAdmin()) may call it

-- Up

CREATE OR REPLACE FUNCTION adjust_pro_group_member_count(p_group_id uuid, p_delta int)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pro_official_groups
  SET current_member_count = GREATEST(current_member_count + p_delta, 0)
  WHERE id = p_group_id;
$$;

REVOKE ALL ON FUNCTION adjust_pro_group_member_count(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION adjust_pro_group_member_count(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION adjust_pro_group_member_count(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION adjust_pro_group_member_count(uuid, int) TO service_role;

COMMENT ON FUNCTION adjust_pro_group_member_count(uuid, int) IS
  'Atomic delta update of pro_official_groups.current_member_count (clamped at 0). Called by app/api/pro-official-group/route.ts after membership insert (+1) / delete (-1). Caller has a recount fallback for pre-migration environments.';
