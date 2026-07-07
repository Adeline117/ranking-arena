-- Migration: 20260706202941_add_flash_news_ja_ko_columns.sql
-- Created: 2026-07-07T03:29:41Z
-- Description: Add ja/ko title+content columns to flash_news (U7-5).
--
-- flash_news already has title_zh/title_en/content_zh/content_en but no ja/ko.
-- ja/ko users saw English titles even though the UI was localized. The ingest
-- cron now pre-translates title (+content) to zh/ja/ko via the free Google gtx
-- endpoint (unlogged users benefit — no auth-gated client translation), and a
-- one-time backfill fills recent rows. These nullable columns hold the results;
-- getNewsTitle reads them per UI language.

-- Up
ALTER TABLE public.flash_news
  ADD COLUMN IF NOT EXISTS title_ja text,
  ADD COLUMN IF NOT EXISTS title_ko text,
  ADD COLUMN IF NOT EXISTS content_ja text,
  ADD COLUMN IF NOT EXISTS content_ko text;
