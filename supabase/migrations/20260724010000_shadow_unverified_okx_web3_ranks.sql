-- OKX Wallet Web3 exposes useful public trader observations, but Arena has not
-- yet proved a snapshot-stable multi-page population, native window boundaries,
-- or a reviewed USD comparison method. Those rows may remain available for
-- discovery and contract work, but they must not remain in the public ranking.
--
-- This emergency PREDEPLOY is deliberately independent of the newer metric
-- trust tables so it can repair a production database whose trust-migration
-- ledger is incomplete. It preserves every arena snapshot/profile/stat/raw row,
-- archives the exact public rank rows, removes only the derived public ranks,
-- refreshes their derived count cache, and installs two durable promotion
-- guards. A later reviewed promotion must explicitly drop both named guards.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '3min';
SET LOCAL TIME ZONE 'UTC';

DO $preflight$
DECLARE
  v_source_count integer;
  v_source_status text;
  v_serving_mode text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_count_cache') IS NULL THEN
    RAISE EXCEPTION
      'OKX rank quarantine requires arena.sources and public rank/cache foundations';
  END IF;

  IF pg_catalog.to_regprocedure('public.refresh_leaderboard_count_cache()') IS NULL THEN
    RAISE EXCEPTION
      'OKX rank quarantine requires public.refresh_leaderboard_count_cache()';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'OKX rank quarantine requires Supabase runtime roles';
  END IF;

  SELECT count(*), min(source.status), min(source.serving_mode)
  INTO v_source_count, v_source_status, v_serving_mode
  FROM arena.sources AS source
  WHERE source.slug = 'okx_web3_solana';

  IF v_source_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one okx_web3_solana source, found %', v_source_count;
  END IF;

  IF v_source_status <> 'active'
     OR v_serving_mode NOT IN ('serving', 'shadow') THEN
    RAISE EXCEPTION
      'okx_web3_solana must be active serving (first run) or active shadow (replay), found %/%',
      v_source_status,
      v_serving_mode;
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.okx_web3_rank_quarantine_batches (
  batch_id text PRIMARY KEY,
  source_slug text NOT NULL,
  reason text NOT NULL,
  source_row_before jsonb NOT NULL,
  archived_rank_count bigint NOT NULL CHECK (archived_rank_count >= 0),
  archived_rank_digest text NOT NULL CHECK (
    archived_rank_digest ~ '^[0-9a-f]{32}$'
  ),
  state text NOT NULL CHECK (state = 'COMPLETE'),
  completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (source_slug = 'okx_web3_solana')
);

CREATE TABLE IF NOT EXISTS arena.okx_web3_rank_quarantine_rows (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  live_rank_id text NOT NULL,
  season_id text NOT NULL,
  source_trader_id text NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, season_id, source_trader_id),
  FOREIGN KEY (batch_id)
    REFERENCES arena.okx_web3_rank_quarantine_batches(batch_id),
  CHECK (source_slug = 'okx_web3_solana')
);

ALTER TABLE arena.okx_web3_rank_quarantine_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.okx_web3_rank_quarantine_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  arena.okx_web3_rank_quarantine_batches,
  arena.okx_web3_rank_quarantine_rows
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  arena.okx_web3_rank_quarantine_batches,
  arena.okx_web3_rank_quarantine_rows
TO service_role;

COMMENT ON TABLE arena.okx_web3_rank_quarantine_batches IS
  'Private, replay-safe ledger for public-rank visibility quarantines.';
COMMENT ON TABLE arena.okx_web3_rank_quarantine_rows IS
  'Private full-row archive of derived public ranks removed by a visibility quarantine; live IDs are stored as text to tolerate historical ID type drift.';

-- Share the exact per-source advisory lock used by board publication. The
-- table locks also fence legacy/in-flight rank writers which do not use that
-- protocol. LOCK without ONLY includes the leaderboard partitions.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260724_okx_web3_unverified_rank_quarantine', 0)
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('arena.publish-board-series:' || source.id::text, 0)
)
FROM arena.sources AS source
WHERE source.slug = 'okx_web3_solana';

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;

DO $quarantine$
DECLARE
  v_batch_id constant text := '20260724_okx_web3_unverified_rank_quarantine';
  v_source_slug constant text := 'okx_web3_solana';
  v_reason constant text :=
    'population_window_currency_authority_unverified_not_rank_eligible';
  v_source arena.sources%ROWTYPE;
  v_batch arena.okx_web3_rank_quarantine_batches%ROWTYPE;
  v_live_count bigint;
  v_live_digest text;
  v_archive_count bigint;
  v_archive_digest text;
  v_updated integer;
  v_deleted integer;
  v_blockers jsonb;
BEGIN
  SELECT source.*
  INTO STRICT v_source
  FROM arena.sources AS source
  WHERE source.slug = v_source_slug;

  SELECT batch.*
  INTO v_batch
  FROM arena.okx_web3_rank_quarantine_batches AS batch
  WHERE batch.batch_id = v_batch_id;

  IF FOUND THEN
    IF v_batch.source_slug <> v_source_slug
       OR v_batch.reason <> v_reason
       OR v_batch.state <> 'COMPLETE'
       OR v_batch.source_row_before->>'slug' <> v_source_slug
       OR v_batch.source_row_before->>'serving_mode' <> 'serving' THEN
      RAISE EXCEPTION 'OKX rank quarantine batch ledger drifted: %', v_batch_id;
    END IF;

    IF v_source.status <> 'active' OR v_source.serving_mode <> 'shadow' THEN
      RAISE EXCEPTION
        'completed OKX quarantine requires active/shadow source, found %/%',
        v_source.status,
        v_source.serving_mode;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.leaderboard_ranks AS rank_row
      WHERE rank_row.source = v_source_slug
    ) THEN
      RAISE EXCEPTION
        'completed OKX quarantine replay found newly published public ranks';
    END IF;
  ELSE
    IF v_source.status <> 'active' OR v_source.serving_mode <> 'serving' THEN
      RAISE EXCEPTION
        'first OKX quarantine run requires active/serving source, found %/%',
        v_source.status,
        v_source.serving_mode;
    END IF;

    SELECT
      count(*),
      pg_catalog.md5(
        COALESCE(
          pg_catalog.string_agg(
            pg_catalog.to_jsonb(rank_row)::text,
            E'\n' ORDER BY rank_row.season_id, rank_row.source_trader_id
          ),
          ''
        )
      )
    INTO v_live_count, v_live_digest
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = v_source_slug;

    INSERT INTO arena.okx_web3_rank_quarantine_batches (
      batch_id,
      source_slug,
      reason,
      source_row_before,
      archived_rank_count,
      archived_rank_digest,
      state
    ) VALUES (
      v_batch_id,
      v_source_slug,
      v_reason,
      pg_catalog.to_jsonb(v_source),
      v_live_count,
      v_live_digest,
      'COMPLETE'
    );

    INSERT INTO arena.okx_web3_rank_quarantine_rows (
      batch_id,
      source_slug,
      live_rank_id,
      season_id,
      source_trader_id,
      row_data,
      reason
    )
    SELECT
      v_batch_id,
      v_source_slug,
      rank_row.id::text,
      rank_row.season_id,
      rank_row.source_trader_id,
      pg_catalog.to_jsonb(rank_row),
      v_reason
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = v_source_slug;

    SELECT
      count(*),
      pg_catalog.md5(
        COALESCE(
          pg_catalog.string_agg(
            archive.row_data::text,
            E'\n' ORDER BY archive.season_id, archive.source_trader_id
          ),
          ''
        )
      )
    INTO v_archive_count, v_archive_digest
    FROM arena.okx_web3_rank_quarantine_rows AS archive
    WHERE archive.batch_id = v_batch_id;

    IF v_archive_count <> v_live_count
       OR v_archive_digest <> v_live_digest THEN
      RAISE EXCEPTION
        'OKX rank archive mismatch: live %/%, archive %/%',
        v_live_count,
        v_live_digest,
        v_archive_count,
        v_archive_digest;
    END IF;

    v_blockers := pg_catalog.to_jsonb(ARRAY[
      'pagination_snapshot_unavailable',
      'native_window_boundary_unverified',
      'ranking_method_currency_mismatch'
    ]::text[]);

    IF v_source.currency IS DISTINCT FROM 'USD' THEN
      v_blockers := v_blockers || '"source_currency_label_mismatch"'::jsonb;
    END IF;

    UPDATE arena.sources AS source
    SET
      serving_mode = 'shadow',
      meta = COALESCE(source.meta, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'rank_visibility', 'shadow',
        'rank_visibility_contract', 'okx-web3-ranking-quarantine@1',
        'rank_visibility_blocker', 'population_and_window_authority_unverified',
        'rank_visibility_blockers', v_blockers,
        'rank_visibility_reviewed_at', '2026-07-24',
        'rank_visibility_note',
          'Keep public wallet observations, snapshots, stats, and raw evidence; exclude Arena Score until population, native-window, and currency/method authorities are proven.'
      )
    WHERE source.id = v_source.id
      AND source.slug = v_source_slug
      AND source.status = 'active'
      AND source.serving_mode = 'serving';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'expected to shadow one OKX source, updated %', v_updated;
    END IF;

    DELETE FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = v_source_slug;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted::bigint <> v_live_count THEN
      RAISE EXCEPTION
        'OKX public-rank delete mismatch: expected %, deleted %',
        v_live_count,
        v_deleted;
    END IF;

    PERFORM public.refresh_leaderboard_count_cache();
  END IF;
END
$quarantine$;

-- The source guard makes re-promotion an explicit reviewed migration. The
-- rank guard also rejects a compute job which read serving inputs before this
-- transaction and attempts a delayed upsert after the source is shadowed.
DO $install_guards$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
      AND constraint_row.conname =
        'sources_block_unverified_okx_web3_solana_serving'
  ) THEN
    ALTER TABLE arena.sources
      ADD CONSTRAINT sources_block_unverified_okx_web3_solana_serving
      CHECK (
        slug <> 'okx_web3_solana'
        OR serving_mode <> 'serving'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_ranks_block_unverified_okx_web3_solana'
  ) THEN
    ALTER TABLE public.leaderboard_ranks
      ADD CONSTRAINT leaderboard_ranks_block_unverified_okx_web3_solana
      CHECK (source <> 'okx_web3_solana');
  END IF;
END
$install_guards$;

DO $postflight$
DECLARE
  v_batch_id constant text := '20260724_okx_web3_unverified_rank_quarantine';
  v_source_slug constant text := 'okx_web3_solana';
  v_batch arena.okx_web3_rank_quarantine_batches%ROWTYPE;
  v_archive_count bigint;
  v_archive_digest text;
  v_guard_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.sources AS source
    WHERE source.slug = v_source_slug
      AND source.status = 'active'
      AND source.serving_mode = 'shadow'
      AND source.meta->>'rank_visibility' = 'shadow'
      AND source.meta->>'rank_visibility_contract' =
          'okx-web3-ranking-quarantine@1'
      AND source.meta->'rank_visibility_blockers'
          ? 'pagination_snapshot_unavailable'
      AND source.meta->'rank_visibility_blockers'
          ? 'native_window_boundary_unverified'
  ) THEN
    RAISE EXCEPTION 'OKX source shadow postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = v_source_slug
  ) THEN
    RAISE EXCEPTION 'OKX public ranks remain after quarantine';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_count_cache AS cache_row
    WHERE cache_row.source IN (v_source_slug, v_source_slug || '_gt0')
  ) THEN
    RAISE EXCEPTION 'OKX direct count-cache rows remain after quarantine';
  END IF;

  SELECT batch.*
  INTO STRICT v_batch
  FROM arena.okx_web3_rank_quarantine_batches AS batch
  WHERE batch.batch_id = v_batch_id
    AND batch.source_slug = v_source_slug
    AND batch.state = 'COMPLETE';

  SELECT
    count(*),
    pg_catalog.md5(
      COALESCE(
        pg_catalog.string_agg(
          archive.row_data::text,
          E'\n' ORDER BY archive.season_id, archive.source_trader_id
        ),
        ''
      )
    )
  INTO v_archive_count, v_archive_digest
  FROM arena.okx_web3_rank_quarantine_rows AS archive
  WHERE archive.batch_id = v_batch_id;

  IF v_archive_count <> v_batch.archived_rank_count
     OR v_archive_digest <> v_batch.archived_rank_digest THEN
    RAISE EXCEPTION
      'OKX rank archive postflight mismatch: batch %/%, archive %/%',
      v_batch.archived_rank_count,
      v_batch.archived_rank_digest,
      v_archive_count,
      v_archive_digest;
  END IF;

  SELECT count(*)
  INTO v_guard_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE (
    (
      constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
      AND constraint_row.conname =
        'sources_block_unverified_okx_web3_solana_serving'
    ) OR (
      constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_ranks_block_unverified_okx_web3_solana'
    )
  )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_guard_count <> 2 THEN
    RAISE EXCEPTION 'OKX quarantine guard postflight failed: %/2', v_guard_count;
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
