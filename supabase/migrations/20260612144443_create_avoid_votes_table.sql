-- Migration: 20260612144443_create_avoid_votes_table.sql
-- Created: 2026-06-12T21:44:43Z
-- Description: CREATE TABLE for `avoid_votes` (避雷榜投票) + the
--   `trader_avoid_scores` aggregate view it feeds.
--
-- ── Phantom-table history ────────────────────────────────────────────
-- `avoid_votes` is referenced by LIVE code (lib/data/avoid-list.ts,
-- app/api/avoid-list/route.ts) but NO repo migration ever created it.
-- Only RLS policies were committed, all guarded by
-- `IF EXISTS (information_schema.tables ...)`:
--   * 00010_rls_policies.sql (§25)            — SELECT status='active',
--     INSERT/UPDATE/DELETE own rows
--   * 20260319l_rls_security_fixes.sql (§2)   — extra SELECT "own votes"
--   * 20260331a2_security_audit_rls_fixes.sql — CHECK status IN
--     ('pending','approved','rejected') — NOTE: contradicts 00010's
--     status='active' visibility policy; reconciled below by allowing
--     both vocabularies with DEFAULT 'active'.
-- On a fresh replay those guarded blocks were no-ops, so the table only
-- ever existed if created out-of-band (dashboard). This migration is the
-- canonical CREATE, derived from every code read/write. Policies are
-- (re)created here using current conventions: (SELECT auth.uid()) initplan
-- wrapping, no FOR ALL, one permissive policy per action.
--
-- Column derivation (lib/data/avoid-list.ts):
--   SELECT list (L146 / L215): id, user_id, trader_id, source, reason,
--     reason_type, loss_amount, loss_percent, follow_duration_days,
--     screenshot_url, created_at, updated_at
--   INSERT (L241-253): user_id + trader_id + source + optional fields
--   reason_type enum (L12-17): high_drawdown | fake_data | inconsistent |
--     poor_communication | other (mirrored by zod in app/api/avoid-list/route.ts L36)
--   Uniqueness: hasUserVoted() (L183-202) uses .maybeSingle() on
--     (user_id, trader_id, source) and the POST route pre-checks it →
--     one vote per user per (trader, source). Enforced with UNIQUE
--     (CLAUDE.md one-per-user mandate).
--   trader_id is TEXT: joined against leaderboard_ranks.source_trader_id
--     (L91-94), which is text — NOT a uuid FK.

-- ============================================================
-- Table
-- ============================================================

CREATE TABLE IF NOT EXISTS avoid_votes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id            text NOT NULL,            -- source_trader_id (text, not uuid)
  source               text NOT NULL,            -- exchange/platform key
  reason               text,                     -- free text, zod-capped at 1000 chars
  reason_type          text
                       CHECK (reason_type IN ('high_drawdown', 'fake_data', 'inconsistent', 'poor_communication', 'other')),
  loss_amount          numeric,                  -- USD amount lost (>= 0 enforced in zod)
  loss_percent         numeric,
  follow_duration_days integer,
  screenshot_url       text,                     -- zod-capped at 500 chars
  -- `status` never appears in TS code but is REQUIRED by the 00010 SELECT
  -- policy (status = 'active') and the 20260331a2 CHECK constraint.
  -- Reconciled vocabulary: new votes are immediately 'active' (visible);
  -- moderation states from 20260331a2 retained for future use.
  status               text NOT NULL DEFAULT 'active'
                       CONSTRAINT avoid_votes_status_check
                       CHECK (status IN ('active', 'pending', 'approved', 'rejected')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One vote per user per trader (hasUserVoted semantics)
  CONSTRAINT avoid_votes_user_trader_unique UNIQUE (user_id, trader_id, source)
);

-- ============================================================
-- Indexes (query patterns from lib/data/avoid-list.ts)
-- ============================================================

-- getTraderAvoidVotes: WHERE trader_id = ? AND source = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_avoid_votes_trader
  ON avoid_votes (trader_id, source, created_at DESC);

-- hasUserVoted / getUserAvoidVote: WHERE user_id = ? AND trader_id = ? AND source = ?
-- → fully covered by the UNIQUE constraint's underlying index.

-- ============================================================
-- updated_at trigger (repo convention: per-table trigger fn,
-- cf. 00007_push_subscriptions.sql)
-- ============================================================

CREATE OR REPLACE FUNCTION update_avoid_votes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_avoid_votes_updated_at ON avoid_votes;
CREATE TRIGGER trigger_avoid_votes_updated_at
  BEFORE UPDATE ON avoid_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_avoid_votes_updated_at();

-- ============================================================
-- RLS — intent of 00010 §25 + 20260319l §2, current conventions
-- ============================================================

ALTER TABLE avoid_votes ENABLE ROW LEVEL SECURITY;

-- Single permissive SELECT policy (avoids "multiple permissive policies"
-- lint, cf. 20260413213521): merges 00010 "Active votes are viewable"
-- (status = 'active') with 20260319l "Users can view own votes".
DROP POLICY IF EXISTS "Active votes are viewable" ON avoid_votes;
DROP POLICY IF EXISTS "Users can view own votes" ON avoid_votes;
DROP POLICY IF EXISTS "Active or own votes are viewable" ON avoid_votes;
CREATE POLICY "Active or own votes are viewable"
  ON avoid_votes FOR SELECT
  USING (status = 'active' OR (SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create risk reports" ON avoid_votes;
CREATE POLICY "Users can create risk reports"
  ON avoid_votes FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own reports" ON avoid_votes;
CREATE POLICY "Users can update own reports"
  ON avoid_votes FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own reports" ON avoid_votes;
CREATE POLICY "Users can delete own reports"
  ON avoid_votes FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

-- ============================================================
-- trader_avoid_scores — aggregate VIEW read by getAvoidList() /
-- getTraderAvoidScore() (lib/data/avoid-list.ts L78, L120).
-- Also phantom: no repo migration ever defined it. Column list is exactly
-- the SELECT list in code: trader_id, source, avoid_count,
-- high_drawdown_count, fake_data_count, inconsistent_count,
-- avg_loss_percent, avg_follow_days, latest_vote_at.
-- security_invoker so the underlying avoid_votes RLS applies (anon sees
-- only status='active' rows — the same rows the view aggregates).
-- ============================================================

CREATE OR REPLACE VIEW trader_avoid_scores
WITH (security_invoker = true)
AS
SELECT
  trader_id,
  source,
  count(*)::integer                                              AS avoid_count,
  count(*) FILTER (WHERE reason_type = 'high_drawdown')::integer AS high_drawdown_count,
  count(*) FILTER (WHERE reason_type = 'fake_data')::integer     AS fake_data_count,
  count(*) FILTER (WHERE reason_type = 'inconsistent')::integer  AS inconsistent_count,
  avg(loss_percent)                                              AS avg_loss_percent,
  avg(follow_duration_days)                                      AS avg_follow_days,
  max(created_at)                                                AS latest_vote_at
FROM avoid_votes
WHERE status = 'active'
GROUP BY trader_id, source;

COMMENT ON TABLE avoid_votes IS '避雷榜投票 — one vote per user per (trader_id, source). Created 2026-06-12 from code usage; table was previously phantom (RLS-only in repo).';
COMMENT ON VIEW trader_avoid_scores IS 'Aggregate of active avoid_votes per trader; read by lib/data/avoid-list.ts (ORDER BY avoid_count DESC at query time).';
