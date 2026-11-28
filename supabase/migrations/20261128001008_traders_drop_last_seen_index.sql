-- Migration: 20261128001008_traders_drop_last_seen_index.sql
-- Description: drop idx_arena_traders_last_seen, an index of arena.traders
--   that no query uses and that keeps every board upsert from being a HOT
--   update.
--
-- Why: a Tier-A publication upserts the whole board into arena.traders
--   (about 32,700 rows for each bybit_mt5 window) and sets last_seen_at =
--   now() on every row (lib/ingest/serving/publish.ts). While last_seen_at is
--   indexed, no such update can be HOT: each one writes a new heap tuple and
--   a new entry in every index of the table (production: 330,005 updates,
--   0 % HOT). idx_arena_traders_last_seen is 168 MB and has 0 scans in
--   production (statistics never reset). It was created with the table
--   (20260610223752) for a homepage counter; production shows nothing reads
--   it. The only last_seen_at ordering in this repository
--   (public.arena_resolve_trader, 20261122204058) sorts the few rows that
--   match one handle, found through the unique key or the nickname index.
--
-- After the drop, an upsert whose nickname, avatar, wallet and meta are
--   unchanged changes no indexed column and can be HOT when its page has room.
--
-- Not dropped: the primary key, the (source_id, exchange_trader_id) unique
--   key, idx_arena_traders_nickname_lower (search), and the partial kind,
--   wallet, unmirrored and claimed indexes. Those partial indexes are small
--   and filter columns a board upsert rarely changes.
--
-- Locking: DROP INDEX takes ACCESS EXCLUSIVE on the table for the drop
--   itself, a catalog change that takes milliseconds. lock_timeout is 3 s, so
--   if a publication or reader holds the table the migration fails without
--   waiting and can be re-run. Apply between Tier-A publication windows.
--
-- Safety: refuses unless the index, if it still exists, has exactly the
--   production definition, is valid and backs no constraint; an index
--   someone changed is refused, not dropped. A replay (already gone) is a
--   no-op. Afterwards the seven remaining indexes must exist, valid, with
--   their production definitions. No table, column, trigger or constraint
--   changes, and nothing the worker startup gate pins. Independent of
--   20261128001007 (trader_stats), which can be applied or rolled back alone.
--
-- Rollback: scripts/maintenance/rollbacks/20261128001008_traders_drop_last_seen_index.rollback.sql
--   (CREATE INDEX CONCURRENTLY, outside a transaction).
--
-- POSTDEPLOY. No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_index regclass;
  v_def text;
BEGIN
  IF pg_catalog.to_regclass('arena.traders') IS NULL THEN
    RAISE EXCEPTION 'arena.traders is missing';
  END IF;

  v_index := pg_catalog.to_regclass('arena.idx_arena_traders_last_seen');
  IF v_index IS NULL THEN
    RETURN;  -- already dropped (replay)
  END IF;

  v_def := pg_catalog.pg_get_indexdef(v_index);
  IF v_def IS DISTINCT FROM
     'CREATE INDEX idx_arena_traders_last_seen ON arena.traders USING btree (last_seen_at DESC)' THEN
    RAISE EXCEPTION 'idx_arena_traders_last_seen is not the expected definition (found: %); refusing', v_def;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
     WHERE i.indexrelid = v_index
       AND i.indrelid = 'arena.traders'::regclass
       AND i.indisvalid
       AND NOT i.indisunique
       AND NOT i.indisprimary
  ) THEN
    RAISE EXCEPTION 'idx_arena_traders_last_seen is not a valid plain index of arena.traders; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conindid = v_index) THEN
    RAISE EXCEPTION 'idx_arena_traders_last_seen backs a constraint; refusing';
  END IF;
END
$preflight$;

DROP INDEX IF EXISTS arena.idx_arena_traders_last_seen;

DO $postflight$
DECLARE
  v_kept constant jsonb := pg_catalog.jsonb_build_object(
    'traders_pkey',
    'CREATE UNIQUE INDEX traders_pkey ON arena.traders USING btree (id)',
    'traders_source_id_exchange_trader_id_key',
    'CREATE UNIQUE INDEX traders_source_id_exchange_trader_id_key ON arena.traders USING btree (source_id, exchange_trader_id)',
    'idx_arena_traders_nickname_lower',
    'CREATE INDEX idx_arena_traders_nickname_lower ON arena.traders USING btree (lower(nickname))',
    'idx_arena_traders_kind',
    'CREATE INDEX idx_arena_traders_kind ON arena.traders USING btree (source_id, trader_kind) WHERE (trader_kind = ''bot''::text)',
    'idx_arena_traders_wallet',
    'CREATE INDEX idx_arena_traders_wallet ON arena.traders USING btree (wallet_address) WHERE (wallet_address IS NOT NULL)',
    'idx_arena_traders_unmirrored',
    'CREATE INDEX idx_arena_traders_unmirrored ON arena.traders USING btree (id) WHERE ((avatar_url_origin IS NOT NULL) AND (avatar_url_mirror IS NULL))',
    'traders_claimed_idx',
    'CREATE INDEX traders_claimed_idx ON arena.traders USING btree (((meta ->> ''claimed''::text))) WHERE ((meta ->> ''claimed''::text) = ''true''::text)'
  );
  v_name text;
  v_index regclass;
BEGIN
  IF pg_catalog.to_regclass('arena.idx_arena_traders_last_seen') IS NOT NULL THEN
    RAISE EXCEPTION 'idx_arena_traders_last_seen still exists';
  END IF;

  FOR v_name IN SELECT pg_catalog.jsonb_object_keys(v_kept) LOOP
    v_index := pg_catalog.to_regclass('arena.' || v_name);
    IF v_index IS NULL
       OR pg_catalog.pg_get_indexdef(v_index) IS DISTINCT FROM v_kept->>v_name
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i WHERE i.indexrelid = v_index AND i.indisvalid) THEN
      RAISE EXCEPTION 'kept index % is missing, invalid or changed', v_name;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
