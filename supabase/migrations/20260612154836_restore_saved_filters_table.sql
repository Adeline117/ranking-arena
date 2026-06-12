-- Migration: 20260612154836_restore_saved_filters_table.sql
-- Created: 2026-06-12T22:48:36Z
-- Description: Canonical CREATE TABLE for `saved_filters` (Pro 会员保存的
--   排行榜筛选配置). Table was dropped from prod but its feature code is
--   live and healthy.
--
-- ── Phantom-table history ────────────────────────────────────────────
-- `saved_filters` appears in ZERO repo migrations (no CREATE TABLE, no RLS,
-- no index — verified by grep over supabase/). The table only ever existed
-- if created out-of-band (dashboard). There is no prior schema to revive,
-- so this migration is derived entirely from code usage.
--
-- Column derivation (app/api/saved-filters/route.ts — sole DB accessor):
--   GET (L60-66): SELECT id, name, description, filter_config, is_default,
--     use_count, last_used_at, updated_at WHERE user_id = ?
--     ORDER BY is_default DESC, updated_at DESC LIMIT 10
--   POST insert/update (L104-110): user_id, name, description (|| null),
--     filter_config, is_default — zod (L33-39): name 1-50 chars,
--     description <= 200 chars nullable, is_default defaults false,
--     filter_config is a JSON object (FilterConfigSchema L19-30, passthrough)
--   POST update path (L113-121): UPDATE ... WHERE id = ? AND user_id = ?
--     → id is a uuid (SaveFilterSchema L34: z.string().uuid())
--   PUT (L173-187): SELECT use_count then UPDATE use_count = n+1,
--     last_used_at = now() WHERE id = ? AND user_id = ?
--   DELETE (L203-207): DELETE WHERE id = ? AND user_id = ?
--   Client shape (app/components/premium/AdvancedFilter.tsx L31-40):
--     SavedFilter { id, name, description?, filter_config, is_default?,
--     use_count?, last_used_at?, created_at? } → created_at column kept.
--
-- Uniqueness semantics (deliberate NON-constraints):
--   * NO UNIQUE (user_id, name): POST without id always inserts; code never
--     checks name collisions — duplicate names are allowed by design.
--   * MAX 10 filters per user: enforced app-side via count probe
--     (route.ts L129-143) with an explicitly acknowledged race
--     ("acceptable minor overshoot vs. data loss") — not a DB constraint.
--   * NO partial unique on is_default: code never unsets other defaults,
--     so multiple defaults per user are reachable; a unique index would
--     break POST. GET simply orders is_default DESC.
--   → CLAUDE.md "one-per-user UNIQUE" mandate does not apply: this is a
--     bounded-multi-per-user resource, and updates are PK-targeted.
--
-- updated_at: GET orders by it but no code path ever sets it → a BEFORE
-- UPDATE trigger is REQUIRED for the "most recently touched first"
-- ordering to work (rename/PUT-usage bumps recency).
--
-- Client / RLS analysis: all routes run under withAuth, which injects
-- getSupabaseAdmin() (lib/api/middleware.ts L250) — SERVICE ROLE, bypasses
-- RLS; every query is manually scoped by user_id. Own-rows CRUD policies
-- below are defense-in-depth matching exactly those semantics, using
-- current conventions: (SELECT auth.uid()) initplan wrapping, no FOR ALL.

-- ============================================================
-- Table
-- ============================================================

CREATE TABLE IF NOT EXISTS saved_filters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,                       -- zod: 1-50 chars
  description   text,                                -- zod: <= 200 chars, nullable
  filter_config jsonb NOT NULL DEFAULT '{}'::jsonb,  -- FilterConfigSchema (passthrough object)
  is_default    boolean NOT NULL DEFAULT false,
  use_count     integer NOT NULL DEFAULT 0,          -- PUT does read-then-increment, service-role only
  last_used_at  timestamptz,                         -- set by PUT on use
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes (query patterns)
-- ============================================================

-- GET list: WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC
-- LIMIT 10 — fully covered. Also serves the POST count probe (head count
-- on user_id) and all PK+user_id-scoped UPDATE/DELETE pre-filters.
CREATE INDEX IF NOT EXISTS idx_saved_filters_user
  ON saved_filters (user_id, is_default DESC, updated_at DESC);

-- ============================================================
-- updated_at trigger (repo convention: per-table trigger fn,
-- cf. 00007_push_subscriptions.sql, 20260612144443_avoid_votes).
-- Load-bearing here: GET recency ordering depends on it (see header).
-- ============================================================

CREATE OR REPLACE FUNCTION update_saved_filters_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_saved_filters_updated_at ON saved_filters;
CREATE TRIGGER trigger_saved_filters_updated_at
  BEFORE UPDATE ON saved_filters
  FOR EACH ROW
  EXECUTE FUNCTION update_saved_filters_updated_at();

-- ============================================================
-- RLS — own-rows CRUD (defense in depth; live code uses the service
-- role and additionally scopes every statement by user_id).
-- ============================================================

ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own saved filters" ON saved_filters;
CREATE POLICY "Users can view own saved filters"
  ON saved_filters FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create own saved filters" ON saved_filters;
CREATE POLICY "Users can create own saved filters"
  ON saved_filters FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own saved filters" ON saved_filters;
CREATE POLICY "Users can update own saved filters"
  ON saved_filters FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own saved filters" ON saved_filters;
CREATE POLICY "Users can delete own saved filters"
  ON saved_filters FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE saved_filters IS 'Pro 会员保存的排行榜筛选配置 — max 10 per user (app-enforced), duplicate names allowed. Created 2026-06-12 from code usage; table was previously phantom (never referenced by any repo migration).';
COMMENT ON COLUMN saved_filters.filter_config IS 'Ranking filter JSON (category/exchange/roi/drawdown/period/pnl/score/win-rate, passthrough) — see FilterConfigSchema in app/api/saved-filters/route.ts.';
COMMENT ON COLUMN saved_filters.updated_at IS 'Maintained by trigger; GET orders by is_default DESC, updated_at DESC.';
