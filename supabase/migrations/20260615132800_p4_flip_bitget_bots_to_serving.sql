-- Migration: 20260615132800_p4_flip_bitget_bots_to_serving.sql
-- Created: 2026-06-15T20:28:00Z
-- Description: P4 unification — flip the last two non-serving active sources
--   (bitget_bots_futures / bitget_bots_spot) onto the serving read path so ALL
--   active sources render the rich serving panel instead of the sparse legacy
--   page. Verified pre-flip: arena.trader_stats fresh at tf 0/7/30/90 (30D has
--   100% trader coverage), arena_first_screen returns a 30D bot entry with
--   strategy/owner, /core returns bot extras. The panel now defaults to the
--   first available timeframe (30D for these bots) so the [30]-only capability
--   renders coherently. Reversible: set serving_mode='legacy' to roll back.
--   serving_mode is the single source of truth; the worker scheduler mirrors it
--   into the Redis `serving_sources` key each reconcile.

-- Up
update arena.sources
   set serving_mode = 'serving'
 where slug in ('bitget_bots_futures', 'bitget_bots_spot')
   and serving_mode = 'legacy';
