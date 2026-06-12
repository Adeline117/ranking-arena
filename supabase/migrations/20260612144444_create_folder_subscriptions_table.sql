-- Migration: 20260612144443_create_folder_subscriptions_table.sql
-- Created: 2026-06-12T21:44:43Z
-- Description: CREATE TABLE for `folder_subscriptions` (收藏夹订阅).
--
-- ── Phantom-table history ────────────────────────────────────────────
-- `folder_subscriptions` is referenced by LIVE code:
--   * app/api/bookmark-folders/subscribed/route.ts        (list my subs,
--     embedded join → bookmark_folders)
--   * app/api/bookmark-folders/[id]/subscribe/route.ts    (GET/POST/DELETE)
--   * app/api/bookmark-folders/[id]/route.ts              (subscriber count,
--     is_subscribed check)
-- ...but NO repo migration ever created it. Only RLS policies were committed
-- in 00010_rls_policies.sql (§28), guarded by an information_schema IF EXISTS
-- check (no-op on fresh replay). All routes defensively swallow 42P01
-- ("relation does not exist") — direct evidence the table was known to be
-- missing. This migration is the canonical CREATE, derived from code usage.
--
-- Column derivation:
--   subscribe/route.ts POST INSERT (L97-100): { user_id, folder_id }
--   subscribed/route.ts SELECT (L21-34): id, created_at,
--     bookmark_folders(...) — embedded resource join requires an FK from
--     folder_subscriptions.folder_id → bookmark_folders.id (PostgREST
--     resolves embeds via FKs).
--   Ordering (subscribed L36): ORDER BY created_at DESC, paged by user_id.
--   Uniqueness: subscribe POST pre-checks (user_id, folder_id) .single()
--     and returns 409 "Already subscribed" → one subscription per user per
--     folder. Enforced with UNIQUE (CLAUDE.md one-per-user mandate; 23505
--     should be handled gracefully).
--   Counts ([id]/route.ts L48-55, subscribe L109-118): count('exact') by
--     folder_id → needs a folder_id index.
--
-- FK target verification: `bookmark_folders` has NO CREATE TABLE in repo
-- migrations either (it exists only in the live DB) — but later repo
-- migrations treat it as real and reference columns id / user_id /
-- is_default (20260422121411_unique_default_bookmark_folder.sql) and its
-- RLS policies (20260413183345, 20260413213521). Its PK is `id` (uuid),
-- per `.eq('id', folderId).single()` usage in the routes. Because a fresh
-- replay would not have bookmark_folders at this point, the FK and the
-- bookmark_folders-dependent policy are added conditionally (DO block) —
-- they WILL apply on the live DB.

-- ============================================================
-- Table
-- ============================================================

CREATE TABLE IF NOT EXISTS folder_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id  uuid NOT NULL,  -- FK added conditionally below (bookmark_folders is itself repo-phantom)
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One subscription per user per folder (subscribe POST 409 semantics)
  CONSTRAINT folder_subscriptions_user_folder_unique UNIQUE (user_id, folder_id)
);

-- FK → bookmark_folders(id), CASCADE so subscriptions vanish with the folder.
-- Conditional because bookmark_folders only exists in the live DB (no repo
-- CREATE TABLE migration); unconditional FK would break fresh replays.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bookmark_folders'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'folder_subscriptions'
      AND constraint_name = 'folder_subscriptions_folder_id_fkey'
  ) THEN
    ALTER TABLE folder_subscriptions
      ADD CONSTRAINT folder_subscriptions_folder_id_fkey
      FOREIGN KEY (folder_id) REFERENCES bookmark_folders(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================================
-- Indexes
-- ============================================================

-- Subscriber counts + FK cascade support: WHERE folder_id = ?
CREATE INDEX IF NOT EXISTS idx_folder_subscriptions_folder_id
  ON folder_subscriptions (folder_id);

-- subscribed list: WHERE user_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_folder_subscriptions_user_created
  ON folder_subscriptions (user_id, created_at DESC);

-- ============================================================
-- RLS — intent of 00010 §28 ("view own" + "manage own" FOR ALL),
-- translated to current conventions: (SELECT auth.uid()) initplan
-- wrapping, FOR ALL split into INSERT/UPDATE/DELETE.
-- ============================================================

ALTER TABLE folder_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own subscriptions" ON folder_subscriptions;
DROP POLICY IF EXISTS "Users can manage own subscriptions" ON folder_subscriptions;
DROP POLICY IF EXISTS "Users can subscribe to public folders" ON folder_subscriptions;

CREATE POLICY "Users can view own subscriptions"
  ON folder_subscriptions FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create own subscriptions"
  ON folder_subscriptions FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own subscriptions"
  ON folder_subscriptions FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own subscriptions"
  ON folder_subscriptions FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

-- Subscriber-count visibility: the routes count OTHER users' rows with the
-- caller's (anon/user) client — `select('id', { count: 'exact', head: true })
-- .eq('folder_id', ...)`. With only the own-rows SELECT policy above, those
-- counts would always come back as 0/1. 00010 hinted at this with the
-- dropped-but-never-recreated "Users can subscribe to public folders"
-- policy. Allow counting/reading subscriptions of PUBLIC folders.
-- Conditional for the same fresh-replay reason as the FK.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bookmark_folders'
  ) THEN
    DROP POLICY IF EXISTS "Subscriptions of public folders are viewable" ON folder_subscriptions;
    CREATE POLICY "Subscriptions of public folders are viewable"
      ON folder_subscriptions FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM bookmark_folders bf
          WHERE bf.id = folder_subscriptions.folder_id
            AND bf.is_public = true
        )
      );
  END IF;
END $$;

COMMENT ON TABLE folder_subscriptions IS '收藏夹订阅 — one row per (user_id, folder_id). Created 2026-06-12 from code usage; table was previously phantom (RLS-only in repo, routes swallowed 42P01).';
