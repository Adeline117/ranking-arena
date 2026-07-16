-- Align the replayable GMX source row with the active adapter contract.
-- GMX's own leaderboard is total mark-to-market; Arena intentionally publishes
-- a separately disclosed realized-net reconstruction until ending unrealized
-- state can be joined for every account.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE arena.sources
  SET timeframes_native = ARRAY[7, 30, 90]::integer[],
      timeframes_derived = ARRAY[]::integer[],
      meta = ((COALESCE(meta, '{}'::jsonb) - 'compute_90d') - 'unavailable_timeframes') || jsonb_build_object(
        'endpoints',
        CASE
          WHEN jsonb_typeof(meta->'endpoints') = 'object' THEN meta->'endpoints'
          ELSE '{}'::jsonb
        END || jsonb_build_object(
          'subgraph', 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
        ),
        'pnl_basis_board', 'gmx_period_realized_net',
        'roi_basis_board', 'max_capital_usd',
        'pnl_includes_unrealized', false,
        'pnl_provenance', 'arena_normalized_from_gmx_period_components',
        'pnl_contract_version', 2,
        'window_semantics', 'completed_utc_days',
        'window_timezone', 'UTC',
        'window_max_lag_hours', 24
      )
  WHERE slug = 'gmx';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'expected exactly one gmx source row, updated %', v_updated;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.sources
    WHERE slug = 'gmx'
      AND (
        timeframes_native <> ARRAY[7, 30, 90]::integer[]
        OR timeframes_derived <> ARRAY[]::integer[]
        OR meta->'endpoints'->>'subgraph'
          <> 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
        OR meta->>'pnl_basis_board' <> 'gmx_period_realized_net'
        OR meta->>'roi_basis_board' <> 'max_capital_usd'
        OR meta->>'pnl_includes_unrealized' <> 'false'
        OR meta->>'window_semantics' <> 'completed_utc_days'
        OR meta->>'window_timezone' <> 'UTC'
        OR meta ? 'unavailable_timeframes'
        OR meta ? 'compute_90d'
      )
  ) THEN
    RAISE EXCEPTION 'gmx source contract verification failed';
  END IF;
END
$$;

COMMIT;
