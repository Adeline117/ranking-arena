-- Migration: 20260627040550_add_fk_covering_indexes.sql
-- Created: 2026-06-27T04:05:50Z (ledger version 20260627040550)
-- Description: Track 1c — add covering indexes for two unindexed foreign keys
--   flagged by the unindexed_foreign_keys performance advisor.
--
-- arena.sources.exchange_id -> arena.exchanges, public.tips.post_id -> public.posts.
-- Both tables are tiny today (sources=36 rows, tips=0) so a plain CREATE INDEX is
-- instant; the index prevents future seq-scans on FK lookups / cascade checks.

-- Up
create index if not exists idx_sources_exchange_id on arena.sources (exchange_id);
create index if not exists idx_tips_post_id on public.tips (post_id);
