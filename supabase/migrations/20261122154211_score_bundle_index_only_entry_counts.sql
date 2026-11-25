-- Migration: 20261122154211_score_bundle_index_only_entry_counts.sql
-- Description: public.arena_score_inputs_publish_bundle_json counts each
--   latest passed snapshot's entries from indexes instead of the heap.
--
-- Why: the scoring worker calls this bundle with a 30 s timeout. On
--   2026-11-22 the first 7D attempt of three consecutive cycles timed out
--   (retry succeeded once the cache was warm); pg_stat_statements shows a mean
--   of 11.8 s and a maximum of 39 s. More than half of a warm 9.9 s run is the
--   passed_entry_counts CTE: for each of 23 latest passed snapshots it joined
--   arena.leaderboard_entries (53 GB, 17 partitions) and read every entry row
--   from the heap only to count it and test its rank: 90,840 rows, 56,000
--   buffers, 5.5 s. Several sources' latest passed snapshot is months old and
--   cold. The entry counts are publication evidence (entry_count_mismatch,
--   rank-limited totals) and must stay.
--
-- What changes: that one CTE. Both counts keep their exact values (see the
--   comment in the body) and come from index-only scans; a production probe of
--   the same three counts took 742 ms with heap fetches only in the current
--   month's partition. Everything else in the function, its signature, owner,
--   SECURITY DEFINER, configuration and grants are unchanged.
--
-- POSTDEPLOY, after 20261116204006 (whose body it re-creates). No worker
-- release depends on it. It touches no table 20261111192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
     ) IS NULL
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM 'bb652e14c48fe612ba3ab3e957d840ce449f7ae74c78bd49a1e37467995fd682' THEN
    RAISE EXCEPTION 'score bundle is not the 20261116204006 definition';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json(p_window text, p_per_platform_limit integer DEFAULT 1000, p_max_age_hours integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_window IS NULL OR p_window NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid score-input publish window: %', p_window
      USING ERRCODE = '22023';
  END IF;

  IF p_per_platform_limit IS NULL OR p_per_platform_limit <= 0 THEN
    RAISE EXCEPTION 'score-input publish limit must be positive: %',
      p_per_platform_limit
      USING ERRCODE = '22023';
  END IF;

  IF p_max_age_hours IS NULL OR p_max_age_hours <= 0 THEN
    RAISE EXCEPTION 'score-input publish max age must be positive: %',
      p_max_age_hours
      USING ERRCODE = '22023';
  END IF;

  -- Every arena relation and the legacy score-row RPC are read by this one SQL
  -- statement, so scoreRows and physicalBoards share one statement snapshot.
  RETURN (
  WITH requested_window AS MATERIALIZED (
    SELECT CASE p_window
      WHEN '7D' THEN 7::pg_catalog.int2
      WHEN '30D' THEN 30::pg_catalog.int2
      WHEN '90D' THEN 90::pg_catalog.int2
      ELSE NULL::pg_catalog.int2
    END AS timeframe
  ),
  registry_boards AS MATERIALIZED (
    SELECT
      source_row.id AS source_id,
      source_row.slug AS registry_slug,
      COALESCE(
        NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
        source_row.slug
      ) AS filter_source,
      requested.timeframe
    FROM arena.sources AS source_row
    CROSS JOIN requested_window AS requested
    WHERE requested.timeframe IS NOT NULL
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
      -- bitget-bot-cumulative-rank-quarantine@1
      AND NOT (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
      )
      AND requested.timeframe = ANY (
        COALESCE(source_row.timeframes_native, ARRAY[]::pg_catalog.int4[])
        || COALESCE(source_row.timeframes_derived, ARRAY[]::pg_catalog.int4[])
      )
      AND pg_catalog.btrim(
        COALESCE(source_row.meta->>'legacy_platform', '')
      ) <> 'null'
  ),
  latest_snapshot_attempt AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.id AS latest_attempt_id,
      snapshot.scraped_at AS latest_attempt_scraped_at,
      snapshot.count_check_passed AS latest_attempt_passed
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  passed_snapshots AS MATERIALIZED (
    SELECT
      snapshot.source_id,
      snapshot.id AS snapshot_id,
      snapshot.scraped_at,
      snapshot.actual_count,
      pg_catalog.count(*) OVER (
        PARTITION BY snapshot.source_id, snapshot.scraped_at
      )::bigint AS latest_passed_tie_count,
      pg_catalog.row_number() OVER (
        PARTITION BY snapshot.source_id
        ORDER BY snapshot.scraped_at DESC, snapshot.id DESC
      ) AS selected_order
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    WHERE snapshot.count_check_passed
  ),
  latest_passed_snapshot AS MATERIALIZED (
    SELECT
      passed.source_id,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      passed.latest_passed_tie_count
    FROM passed_snapshots AS passed
    WHERE passed.selected_order = 1
  ),
  -- entry-counts:begin
  -- Same two numbers as before, answered from indexes (20261122): the old
  -- join fetched every entry row from the heap to read its rank (90,840 rows,
  -- 56,000 buffers, 5.5 s in production for 23 snapshots).
  --   entry_count: the primary key (scraped_at, snapshot_id, trader_id).
  --   rank_limited_entry_count: the (snapshot_id, rank) index, which does not
  --   carry scraped_at. It is used only when the snapshot has no entry with a
  --   different scraped_at (count by snapshot_id = count by primary key; the
  --   first set contains the second), in which case both sets are the same
  --   rows. Otherwise the exact heap count is taken, as before.
  passed_entry_counts AS MATERIALIZED (
    SELECT
      passed.snapshot_id,
      exact.entry_count,
      CASE
        WHEN any_time.entry_count = exact.entry_count
          THEN any_time.rank_limited_entry_count
        ELSE (
          SELECT pg_catalog.count(*)::bigint
          FROM arena.leaderboard_entries AS entry
          WHERE entry.snapshot_id = passed.snapshot_id
            AND entry.scraped_at = passed.scraped_at
            AND entry.rank <= p_per_platform_limit
        )
      END AS rank_limited_entry_count
    FROM latest_passed_snapshot AS passed
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*)::bigint AS entry_count
      FROM arena.leaderboard_entries AS entry
      WHERE entry.snapshot_id = passed.snapshot_id
        AND entry.scraped_at = passed.scraped_at
    ) AS exact
    CROSS JOIN LATERAL (
      SELECT
        pg_catalog.count(*)::bigint AS entry_count,
        pg_catalog.count(*) FILTER (
          WHERE entry.rank <= p_per_platform_limit
        )::bigint AS rank_limited_entry_count
      FROM arena.leaderboard_entries AS entry
      WHERE entry.snapshot_id = passed.snapshot_id
    ) AS any_time
  ),
  -- entry-counts:end
  physical_board_evidence AS MATERIALIZED (
    SELECT
      registry.registry_slug,
      registry.filter_source,
      registry.timeframe,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.entry_count, 0::bigint)
      END AS entry_count,
      p_per_platform_limit AS rank_limit,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.rank_limited_entry_count, 0::bigint)
      END AS rank_limited_entry_count,
      COALESCE(passed.latest_passed_tie_count, 0::bigint)
        AS latest_passed_tie_count,
      CASE
        WHEN passed.snapshot_id IS NULL
             AND attempt.latest_attempt_id IS NULL THEN 'missing'
        WHEN passed.snapshot_id IS NULL THEN 'failed'
        WHEN passed.latest_passed_tie_count > 1 THEN 'ambiguous_latest'
        WHEN attempt.latest_attempt_passed IS FALSE
             AND attempt.latest_attempt_scraped_at >= passed.scraped_at
          THEN 'latest_attempt_failed'
        WHEN passed.scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          THEN 'future'
        WHEN passed.scraped_at
             <= pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours)
          THEN 'stale'
        WHEN passed.actual_count::bigint
             IS DISTINCT FROM COALESCE(entry_count.entry_count, 0::bigint)
          THEN 'entry_count_mismatch'
        ELSE 'passed'
      END AS evidence_status,
      attempt.latest_attempt_id,
      attempt.latest_attempt_scraped_at,
      attempt.latest_attempt_passed
    FROM registry_boards AS registry
    LEFT JOIN latest_passed_snapshot AS passed
      ON passed.source_id = registry.source_id
    LEFT JOIN passed_entry_counts AS entry_count
      ON entry_count.snapshot_id = passed.snapshot_id
    LEFT JOIN latest_snapshot_attempt AS attempt
      ON attempt.source_id = registry.source_id
  ),
  physical_boards_json AS MATERIALIZED (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'registry_slug', evidence.registry_slug,
          'filter_source', evidence.filter_source,
          'window', evidence.timeframe::text || 'D',
          'snapshot_id', evidence.snapshot_id,
          'scraped_at', evidence.scraped_at,
          'actual_count', evidence.actual_count,
          'entry_count', evidence.entry_count,
          'rank_limit', evidence.rank_limit,
          'rank_limited_entry_count', evidence.rank_limited_entry_count,
          'latest_passed_tie_count', evidence.latest_passed_tie_count,
          'evidence_status', evidence.evidence_status,
          'latest_attempt_id', evidence.latest_attempt_id,
          'latest_attempt_scraped_at', evidence.latest_attempt_scraped_at,
          'latest_attempt_passed', evidence.latest_attempt_passed
        )
        ORDER BY evidence.registry_slug
      ),
      '[]'::pg_catalog.jsonb
    ) AS payload
    FROM physical_board_evidence AS evidence
  )
  SELECT pg_catalog.jsonb_build_object(
    'scoreRows', arena.publication_score_rows_json(
      p_window,
      p_per_platform_limit,
      p_max_age_hours
    ),
    'physicalBoards', physical_boards.payload
  )
  FROM physical_boards_json AS physical_boards
  );
END;
$function$;

COMMIT;
