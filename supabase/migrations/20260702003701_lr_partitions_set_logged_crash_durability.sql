-- Root fix for the 2026-07-02 00:22 UTC serving wipe: the lr_* partitions had
-- been switched to UNLOGGED (write-speed optimization, done OUTSIDE migrations).
-- PostgreSQL truncates unlogged tables on crash recovery — a concurrent
-- session's heavy queries crashed the DB and emptied the entire serving layer
-- (empty rankings sitewide until the next compute, up to 2h).
-- SET LOGGED restores crash durability; the write-perf cost on 2h recomputes
-- of ~10k rows per partition is negligible. Owner-approved 2026-07-02.
--
-- NOTE: applied to prod via MCP apply_migration at 00:37 UTC (P0, Bash tooling
-- was down); this file mirrors ledger version 20260702003701 for repo↔ledger
-- consistency (CLAUDE.md schema single-channel rule).
ALTER TABLE public.lr_7d SET LOGGED;
ALTER TABLE public.lr_30d SET LOGGED;
ALTER TABLE public.lr_90d SET LOGGED;
ALTER TABLE public.lr_default SET LOGGED;
