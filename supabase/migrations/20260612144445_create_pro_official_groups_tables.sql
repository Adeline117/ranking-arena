-- Migration: 20260612144443_create_pro_official_groups_tables.sql
-- Created: 2026-06-12T21:44:43Z
-- Description: CREATE TABLEs for `pro_official_groups` (Pro 会员官方群配置)
--   and `pro_official_group_members` (官方群成员记录).
--
-- ── Phantom-table history ────────────────────────────────────────────
-- Both tables are referenced by LIVE code (app/api/pro-official-group/route.ts,
-- incl. the Stripe-webhook helpers joinProOfficialGroup/leaveProOfficialGroup)
-- but NO repo migration ever created them. Only RLS policies were committed
-- in 00010_rls_policies.sql (§18, §19), guarded by information_schema
-- IF EXISTS checks (no-op on fresh replay).
--
-- The route primarily calls RPCs:
--   get_user_pro_official_group(p_user_id uuid)
--   join_pro_official_group(p_user_id uuid)   → jsonb { success, message:
--     'joined'|'already_member', group_id }
--   leave_pro_official_group(p_user_id uuid)  → boolean
-- ⚠ Those RPC definitions exist in NO repo migration either (grepped all of
-- supabase/migrations/). They live only in the production DB. The code has
-- fallback paths for join/leave when the function is missing (42883), and
-- those fallbacks — plus createNewProOfficialGroup() — are the source of the
-- column derivation below. The RPCs depend on these tables, so the tables
-- must exist first; the RPC bodies should be dumped from prod and committed
-- in a follow-up migration (NOT recreated from guesswork here, to avoid
-- silently diverging from the prod implementation).
--
-- Column derivation (app/api/pro-official-group/route.ts):
--   pro_official_groups:
--     SELECT 'id, group_id'        (L243-249) with filters
--       is_active = true, current_member_count < 500 (MAX_MEMBERS_PER_GROUP),
--       ORDER BY group_number ASC  → is_active boolean, current_member_count
--       int, group_number int
--     SELECT 'group_number' ORDER BY group_number DESC LIMIT 1 (L317-322)
--       → next group number = max + 1 (sequential, unique)
--     INSERT { group_id, group_number } (L347-354) → all other columns need
--       defaults; group_id is groups.id (uuid, from groups INSERT L327-339)
--     SELECT 'group_id' WHERE id = membership.pro_group_id (L228-232)
--   pro_official_group_members:
--     SELECT 'pro_group_id' WHERE user_id = ? .single() (L221-225, L411-415)
--       → AT MOST ONE membership per user → UNIQUE (user_id)
--     INSERT { user_id, pro_group_id } (L268-270)
--     DELETE WHERE user_id = ? (L433-436)
--
-- current_member_count is a counter: per CLAUDE.md it must be maintained by
-- an atomic RPC (the prod join/leave RPCs), never trigger-based count+1.
-- NOTE: the TS fallback path inserts members WITHOUT bumping the counter —
-- pre-existing code gap, documented here, not fixed in this migration.

-- ============================================================
-- Parent: pro_official_groups
-- ============================================================

CREATE TABLE IF NOT EXISTS pro_official_groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id             uuid NOT NULL,            -- groups.id; FK added conditionally below
  group_number         integer NOT NULL,         -- sequential: Arena Pro 会员群 #N
  is_active            boolean NOT NULL DEFAULT true,
  current_member_count integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- one config row per underlying group, and group numbers are unique
  CONSTRAINT pro_official_groups_group_id_unique UNIQUE (group_id),
  CONSTRAINT pro_official_groups_group_number_unique UNIQUE (group_number)
);

-- FK → groups(id), CASCADE so config dies with the group. Conditional because
-- `groups` only exists in the live DB (no repo CREATE TABLE migration);
-- unconditional FK would break fresh replays.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'groups'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'pro_official_groups'
      AND constraint_name = 'pro_official_groups_group_id_fkey'
  ) THEN
    ALTER TABLE pro_official_groups
      ADD CONSTRAINT pro_official_groups_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;

-- "Find first group with space": WHERE is_active AND current_member_count < N
-- ORDER BY group_number ASC LIMIT 1 (route L243-249)
CREATE INDEX IF NOT EXISTS idx_pro_official_groups_active_number
  ON pro_official_groups (group_number)
  WHERE is_active = true;

-- ============================================================
-- Child: pro_official_group_members
-- ============================================================

CREATE TABLE IF NOT EXISTS pro_official_group_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pro_group_id uuid NOT NULL REFERENCES pro_official_groups(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- a user belongs to AT MOST ONE official group:
  -- .eq('user_id', userId).single() in route L221-225 / L411-415
  CONSTRAINT pro_official_group_members_user_unique UNIQUE (user_id)
);

-- member listing / counting per group + FK cascade support
CREATE INDEX IF NOT EXISTS idx_pro_official_group_members_group
  ON pro_official_group_members (pro_group_id);

-- ============================================================
-- RLS — intent of 00010 §18 + §19, current conventions
-- ((SELECT auth.uid()) initplan wrapping; no write policies — all writes go
-- through getSupabaseAdmin() (service role), which bypasses RLS.)
-- ============================================================

ALTER TABLE pro_official_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_official_group_members ENABLE ROW LEVEL SECURITY;

-- 00010 §18: pro members can view official groups. The policy depends on the
-- `subscriptions` table (tier/status), which has no repo CREATE TABLE either
-- → conditional for fresh-replay safety; applies on the live DB.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
  ) THEN
    DROP POLICY IF EXISTS "Pro official groups are viewable by pro members" ON pro_official_groups;
    CREATE POLICY "Pro official groups are viewable by pro members"
      ON pro_official_groups FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM subscriptions
          WHERE user_id = (SELECT auth.uid())
            AND tier = 'pro'
            AND status = 'active'
        )
      );
  END IF;
END $$;

-- 00010 §19: users can only view their own membership row
DROP POLICY IF EXISTS "Pro members can view their membership" ON pro_official_group_members;
CREATE POLICY "Pro members can view their membership"
  ON pro_official_group_members FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE pro_official_groups IS 'Pro 会员官方群配置 — one row per official group (max 500 members each, sequential group_number). Created 2026-06-12 from code usage; previously phantom (RLS-only in repo). Depended on by prod RPCs get_user_pro_official_group / join_pro_official_group / leave_pro_official_group, whose definitions are NOT in the repo.';
COMMENT ON TABLE pro_official_group_members IS '官方群成员 — at most one official group per user (UNIQUE user_id). current_member_count on the parent is maintained by the prod join/leave RPCs.';
