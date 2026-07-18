#!/usr/bin/env node
/**
 * Source x timeframe x metric completeness sentinel.
 *
 * Authority boundaries:
 * - expected set: active+serving registry rows, declared 7/30/90 windows, and
 *   explicit sources.meta.expected_metrics only;
 * - population: membership of the latest count-check-passed board snapshot;
 * - upstream freshness: leaderboard_source_freshness.source_as_of, never a
 *   score recomputation timestamp;
 * - evidence: arena.metric_completeness_daily (one row per contract cell).
 *
 * DATABASE_URL may be omitted for local/offline checks. Scheduled callers set
 * REQUIRE_DATABASE_URL=1. Once a database is configured, every contract,
 * query, snapshot, and evidence-write failure exits non-zero.
 */

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { TREND_METRICS as TREND_METRIC_LIST, TYPED_METRICS } from './metric-columns.mjs'

const ALLOWED_TIMEFRAMES = new Set([7, 30, 90])
const TYPED_METRIC_SET = new Set(TYPED_METRICS)
const STATS_FRESHNESS_HOURS_DEFAULT = 48
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000
const TREND_METRICS = new Set(TREND_METRIC_LIST)
const TREND_PLATEAU_OK = 0.9

/** slug:metric -> verified reason. Never use this as a generic mute switch. */
const ZERO_FILL_EXEMPT = new Map()

/** Legitimately sparse declarations that should not trigger the low-fill warning. */
const LOW_FILL_EXEMPT = new Map([
  ['bybit_copytrade:pnl', 'pnl is available only from the sparse deep-profile crawl'],
])

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export const SOURCE_CONTRACT_SQL = `
select
  source_row.id as source_id,
  source_row.slug,
  coalesce(
    nullif(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
    source_row.slug
  ) as filter_source,
  source_row.timeframes_native,
  source_row.timeframes_derived,
  source_row.meta->'expected_metrics' as expected_metrics
from arena.sources as source_row
where source_row.status = 'active'
  and source_row.serving_mode = 'serving'
  and pg_catalog.btrim(
    coalesce(source_row.meta->>'legacy_platform', '')
  ) <> 'null'
order by source_row.id
`

export const MEASUREMENT_SQL = `
with expected as (
  select *
  from pg_catalog.jsonb_to_recordset($3::jsonb) as contract(
    source_id smallint,
    slug text,
    filter_source text,
    timeframe smallint,
    metric text
  )
),
contract_keys as (
  select distinct source_id, timeframe
  from expected
),
latest_snapshot as (
  select distinct on (snapshot.source_id, snapshot.timeframe)
    snapshot.id as snapshot_id,
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at as board_snapshot_at,
    snapshot.actual_count as declared_actual_count
  from arena.leaderboard_snapshots as snapshot
  join contract_keys as contract_key
    on contract_key.source_id = snapshot.source_id
   and contract_key.timeframe = snapshot.timeframe
  where snapshot.count_check_passed
  order by
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at desc,
    snapshot.id desc
),
cohort as (
  select
    latest.source_id,
    latest.timeframe,
    latest.board_snapshot_at,
    latest.declared_actual_count,
    count(entry.trader_id)::bigint as population_total,
    count(distinct entry.trader_id)::bigint as distinct_trader_total,
    coalesce(
      bool_and(
        entry.trader_id is null
        or (
          entry.scraped_at = latest.board_snapshot_at
          and entry.timeframe = latest.timeframe
          and member.id is not null
          and member.source_id = latest.source_id
        )
      ),
      true
    ) as membership_consistent,
    count(stats.trader_id)::bigint as stats_total,
    count(stats.trader_id) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_stats_total,
    min(stats.as_of) as oldest_stats_as_of,
    max(stats.as_of) as newest_stats_as_of,
    count(stats.roi)::bigint as roi,
    count(stats.roi) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_roi,
    count(stats.pnl)::bigint as pnl,
    count(stats.pnl) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_pnl,
    count(stats.sharpe)::bigint as sharpe,
    count(stats.sharpe) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_sharpe,
    count(stats.mdd)::bigint as mdd,
    count(stats.mdd) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_mdd,
    count(stats.win_rate)::bigint as win_rate,
    count(stats.win_rate) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_win_rate,
    count(stats.win_positions)::bigint as win_positions,
    count(stats.win_positions) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_win_positions,
    count(stats.total_positions)::bigint as total_positions,
    count(stats.total_positions) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_total_positions,
    count(stats.copier_pnl)::bigint as copier_pnl,
    count(stats.copier_pnl) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_copier_pnl,
    count(stats.copier_count)::bigint as copier_count,
    count(stats.copier_count) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_copier_count,
    count(stats.aum)::bigint as aum,
    count(stats.aum) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_aum,
    count(stats.volume)::bigint as volume,
    count(stats.volume) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_volume,
    count(stats.profit_share_rate)::bigint as profit_share_rate,
    count(stats.profit_share_rate) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_profit_share_rate,
    count(stats.holding_duration_avg)::bigint as holding_duration_avg,
    count(stats.holding_duration_avg) filter (
      where stats.as_of >= $1::timestamptz - ($2::integer * interval '1 hour')
    )::bigint as fresh_holding_duration_avg
  from latest_snapshot as latest
  left join arena.leaderboard_entries as entry
    on entry.snapshot_id = latest.snapshot_id
  left join arena.traders as member
    on member.id = entry.trader_id
  left join arena.trader_stats as stats
    on stats.trader_id = member.id
   and stats.timeframe = latest.timeframe
  group by
    latest.source_id,
    latest.timeframe,
    latest.board_snapshot_at,
    latest.declared_actual_count
)
select
  expected.source_id,
  expected.slug,
  expected.filter_source,
  expected.timeframe,
  expected.metric,
  cohort.board_snapshot_at,
  watermark.source_as_of as upstream_source_as_of,
  cohort.declared_actual_count,
  coalesce(cohort.population_total, 0)::bigint as population_total,
  cohort.distinct_trader_total,
  cohort.membership_consistent,
  coalesce(cohort.stats_total, 0)::bigint as stats_total,
  coalesce(cohort.fresh_stats_total, 0)::bigint as fresh_stats_total,
  coalesce(
    case expected.metric
      when 'roi' then cohort.roi
      when 'pnl' then cohort.pnl
      when 'sharpe' then cohort.sharpe
      when 'mdd' then cohort.mdd
      when 'win_rate' then cohort.win_rate
      when 'win_positions' then cohort.win_positions
      when 'total_positions' then cohort.total_positions
      when 'copier_pnl' then cohort.copier_pnl
      when 'copier_count' then cohort.copier_count
      when 'aum' then cohort.aum
      when 'volume' then cohort.volume
      when 'profit_share_rate' then cohort.profit_share_rate
      when 'holding_duration_avg' then cohort.holding_duration_avg
    end,
    0
  )::bigint as filled,
  coalesce(
    case expected.metric
      when 'roi' then cohort.fresh_roi
      when 'pnl' then cohort.fresh_pnl
      when 'sharpe' then cohort.fresh_sharpe
      when 'mdd' then cohort.fresh_mdd
      when 'win_rate' then cohort.fresh_win_rate
      when 'win_positions' then cohort.fresh_win_positions
      when 'total_positions' then cohort.fresh_total_positions
      when 'copier_pnl' then cohort.fresh_copier_pnl
      when 'copier_count' then cohort.fresh_copier_count
      when 'aum' then cohort.fresh_aum
      when 'volume' then cohort.fresh_volume
      when 'profit_share_rate' then cohort.fresh_profit_share_rate
      when 'holding_duration_avg' then cohort.fresh_holding_duration_avg
    end,
    0
  )::bigint as fresh_filled,
  cohort.oldest_stats_as_of,
  cohort.newest_stats_as_of
from expected
left join cohort
  on cohort.source_id = expected.source_id
 and cohort.timeframe = expected.timeframe
left join public.leaderboard_source_freshness as watermark
  on watermark.season_id = (expected.timeframe::text || 'D')
 and watermark.source = expected.filter_source
order by expected.source_id, expected.timeframe, expected.metric
`

export const LEGACY_TREND_SQL = `
with contract as (
  select *
  from pg_catalog.jsonb_to_recordset($1::jsonb) as expected(
    source_id smallint,
    slug text,
    filter_source text,
    timeframe smallint,
    metric text
  )
),
expected as (
  select distinct source_id, slug, metric
  from contract
),
fill as (
  select
    trader.source_id,
    count(*)::bigint as total,
    count(stats.roi)::bigint as roi,
    count(stats.pnl)::bigint as pnl,
    count(stats.sharpe)::bigint as sharpe,
    count(stats.mdd)::bigint as mdd,
    count(stats.win_rate)::bigint as win_rate,
    count(stats.win_positions)::bigint as win_positions,
    count(stats.total_positions)::bigint as total_positions,
    count(stats.copier_pnl)::bigint as copier_pnl,
    count(stats.copier_count)::bigint as copier_count,
    count(stats.aum)::bigint as aum,
    count(stats.volume)::bigint as volume,
    count(stats.profit_share_rate)::bigint as profit_share_rate,
    count(stats.holding_duration_avg)::bigint as holding_duration_avg
  from arena.traders as trader
  join arena.trader_stats as stats on stats.trader_id = trader.id
  group by trader.source_id
)
select
  expected.slug,
  expected.metric,
  fill.total,
  case expected.metric
    when 'roi' then fill.roi
    when 'pnl' then fill.pnl
    when 'sharpe' then fill.sharpe
    when 'mdd' then fill.mdd
    when 'win_rate' then fill.win_rate
    when 'win_positions' then fill.win_positions
    when 'total_positions' then fill.total_positions
    when 'copier_pnl' then fill.copier_pnl
    when 'copier_count' then fill.copier_count
    when 'aum' then fill.aum
    when 'volume' then fill.volume
    when 'profit_share_rate' then fill.profit_share_rate
    when 'holding_duration_avg' then fill.holding_duration_avg
  end::bigint as filled
from expected
join fill on fill.source_id = expected.source_id
order by expected.slug, expected.metric
`

const UPSERT_EVIDENCE_SQL = `
insert into arena.metric_completeness_daily (
  taken_on,
  measured_at,
  source_id,
  timeframe,
  metric,
  board_snapshot_at,
  upstream_source_as_of,
  population_total,
  stats_total,
  fresh_stats_total,
  filled,
  fresh_filled,
  oldest_stats_as_of,
  newest_stats_as_of,
  stats_freshness_hours,
  contract_hash,
  measurement_state
)
select
  evidence.taken_on,
  evidence.measured_at,
  evidence.source_id,
  evidence.timeframe,
  evidence.metric,
  evidence.board_snapshot_at,
  evidence.upstream_source_as_of,
  evidence.population_total,
  evidence.stats_total,
  evidence.fresh_stats_total,
  evidence.filled,
  evidence.fresh_filled,
  evidence.oldest_stats_as_of,
  evidence.newest_stats_as_of,
  evidence.stats_freshness_hours,
  evidence.contract_hash,
  evidence.measurement_state
from pg_catalog.jsonb_to_recordset($1::jsonb) as evidence(
  taken_on date,
  measured_at timestamptz,
  source_id smallint,
  timeframe smallint,
  metric text,
  board_snapshot_at timestamptz,
  upstream_source_as_of timestamptz,
  population_total bigint,
  stats_total bigint,
  fresh_stats_total bigint,
  filled bigint,
  fresh_filled bigint,
  oldest_stats_as_of timestamptz,
  newest_stats_as_of timestamptz,
  stats_freshness_hours smallint,
  contract_hash text,
  measurement_state text
)
on conflict (taken_on, source_id, timeframe, metric)
do update set
  measured_at = excluded.measured_at,
  board_snapshot_at = excluded.board_snapshot_at,
  upstream_source_as_of = excluded.upstream_source_as_of,
  population_total = excluded.population_total,
  stats_total = excluded.stats_total,
  fresh_stats_total = excluded.fresh_stats_total,
  filled = excluded.filled,
  fresh_filled = excluded.fresh_filled,
  oldest_stats_as_of = excluded.oldest_stats_as_of,
  newest_stats_as_of = excluded.newest_stats_as_of,
  stats_freshness_hours = excluded.stats_freshness_hours,
  contract_hash = excluded.contract_hash,
  measurement_state = excluded.measurement_state
returning 1
`

function parsePositiveInteger(value, label, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 32767) {
    throw new Error(`${label} must be an integer between 1 and 32767`)
  }
  return parsed
}

function parseRatio(value, label, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be greater than 0 and at most 1`)
  }
  return parsed
}

function parseCount(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return parsed
}

function timestampMs(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`)
  return parsed
}

function timestampIso(value, label, { nullable = false } = {}) {
  const parsed = timestampMs(value, label, { nullable })
  return parsed == null ? null : new Date(parsed).toISOString()
}

export function buildContractCells(sourceRows) {
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    throw new Error('active+serving source contract is empty')
  }

  const cells = []
  const seenSourceIds = new Set()
  const seenSlugs = new Set()

  for (const source of sourceRows) {
    const sourceId = Number(source.source_id)
    const slug = typeof source.slug === 'string' ? source.slug.trim() : ''
    const filterSource = typeof source.filter_source === 'string' ? source.filter_source.trim() : ''

    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      throw new Error(`source ${slug || '<unknown>'} has an invalid source_id`)
    }
    if (!slug || !filterSource || filterSource === 'null') {
      throw new Error(`source ${sourceId} has an invalid slug/filter_source`)
    }
    if (seenSourceIds.has(sourceId) || seenSlugs.has(slug)) {
      throw new Error(`duplicate source identity in contract: ${slug}`)
    }
    seenSourceIds.add(sourceId)
    seenSlugs.add(slug)

    if (!Array.isArray(source.timeframes_native) || !Array.isArray(source.timeframes_derived)) {
      throw new Error(`${slug} timeframes must be PostgreSQL integer arrays`)
    }
    const timeframes = [
      ...new Set(
        [...source.timeframes_native, ...source.timeframes_derived]
          .map(Number)
          .filter((timeframe) => ALLOWED_TIMEFRAMES.has(timeframe))
      ),
    ].sort((a, b) => a - b)
    if (timeframes.length === 0) {
      throw new Error(`${slug} declares no ranking timeframe in 7/30/90`)
    }

    const metrics = source.expected_metrics
    if (!Array.isArray(metrics) || metrics.length === 0) {
      throw new Error(`${slug} meta.expected_metrics must be a non-empty JSON array`)
    }
    if (
      metrics.some(
        (metric) =>
          typeof metric !== 'string' || metric !== metric.trim() || !TYPED_METRIC_SET.has(metric)
      )
    ) {
      throw new Error(`${slug} meta.expected_metrics contains an unsupported metric`)
    }
    if (new Set(metrics).size !== metrics.length) {
      throw new Error(`${slug} meta.expected_metrics contains duplicates`)
    }

    for (const timeframe of timeframes) {
      for (const metric of metrics) {
        cells.push({
          source_id: sourceId,
          slug,
          filter_source: filterSource,
          timeframe,
          metric,
        })
      }
    }
  }

  cells.sort(
    (left, right) =>
      left.source_id - right.source_id ||
      left.timeframe - right.timeframe ||
      compareText(left.metric, right.metric)
  )
  return cells
}

export function completenessContractHash(cells, statsFreshnessHours) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        stats_freshness_hours: statsFreshnessHours,
        cells,
      })
    )
    .digest('hex')
}

export function deriveMeasurementState(row, measuredAt, statsFreshnessHours) {
  const measuredMs = timestampMs(measuredAt, 'measured_at')
  const cutoffMs = measuredMs - statsFreshnessHours * 60 * 60 * 1000
  const boardMs = timestampMs(row.board_snapshot_at, 'board_snapshot_at', {
    nullable: true,
  })
  const upstreamMs = timestampMs(row.upstream_source_as_of, 'upstream_source_as_of', {
    nullable: true,
  })

  if (boardMs != null && boardMs > measuredMs + FUTURE_TOLERANCE_MS) {
    throw new Error(`${row.slug}[tf${row.timeframe}] board snapshot is in the future`)
  }
  if (upstreamMs != null && upstreamMs > measuredMs + FUTURE_TOLERANCE_MS) {
    throw new Error(`${row.slug}[tf${row.timeframe}] upstream watermark is in the future`)
  }
  if (boardMs == null) return 'missing_board_snapshot'
  if (boardMs < cutoffMs) return 'stale_board_snapshot'
  if (upstreamMs == null) return 'missing_upstream_watermark'
  if (upstreamMs < cutoffMs) return 'stale_upstream_watermark'
  if (row.population_total === 0) return 'empty_population'
  if (row.stats_total === 0) return 'no_stats'
  if (row.fresh_stats_total === 0) return 'no_fresh_stats'
  return 'measured'
}

export function normalizeEvidenceRows(
  measurementRows,
  cells,
  measuredAt,
  statsFreshnessHours,
  contractHash
) {
  if (!Array.isArray(measurementRows) || measurementRows.length !== cells.length) {
    throw new Error(
      `measurement returned ${measurementRows?.length ?? 'invalid'} rows for ${cells.length} cells`
    )
  }

  const measuredIso = timestampIso(measuredAt, 'measured_at')
  const takenOn = measuredIso.slice(0, 10)
  const expectedKeys = new Set(
    cells.map((cell) => `${cell.source_id}:${cell.timeframe}:${cell.metric}`)
  )
  const expectedByKey = new Map(
    cells.map((cell) => [`${cell.source_id}:${cell.timeframe}:${cell.metric}`, cell])
  )
  const seen = new Set()

  const evidence = measurementRows.map((row) => {
    const key = `${row.source_id}:${row.timeframe}:${row.metric}`
    if (!expectedKeys.has(key) || seen.has(key)) {
      throw new Error(`measurement returned an unexpected or duplicate cell: ${key}`)
    }
    seen.add(key)
    const expected = expectedByKey.get(key)
    if (row.slug !== expected.slug || row.filter_source !== expected.filter_source) {
      throw new Error(`measurement identity disagrees with contract for cell: ${key}`)
    }

    const normalized = {
      taken_on: takenOn,
      measured_at: measuredIso,
      source_id: Number(row.source_id),
      slug: row.slug,
      timeframe: Number(row.timeframe),
      metric: row.metric,
      board_snapshot_at: timestampIso(row.board_snapshot_at, 'board_snapshot_at', {
        nullable: true,
      }),
      upstream_source_as_of: timestampIso(row.upstream_source_as_of, 'upstream_source_as_of', {
        nullable: true,
      }),
      population_total: parseCount(row.population_total, `${key}.population_total`),
      stats_total: parseCount(row.stats_total, `${key}.stats_total`),
      fresh_stats_total: parseCount(row.fresh_stats_total, `${key}.fresh_stats_total`),
      filled: parseCount(row.filled, `${key}.filled`),
      fresh_filled: parseCount(row.fresh_filled, `${key}.fresh_filled`),
      oldest_stats_as_of: timestampIso(row.oldest_stats_as_of, 'oldest_stats_as_of', {
        nullable: true,
      }),
      newest_stats_as_of: timestampIso(row.newest_stats_as_of, 'newest_stats_as_of', {
        nullable: true,
      }),
      stats_freshness_hours: statsFreshnessHours,
      contract_hash: contractHash,
    }

    if (normalized.board_snapshot_at != null) {
      const declaredActual = parseCount(row.declared_actual_count, `${key}.declared_actual_count`)
      const distinctTraders = parseCount(row.distinct_trader_total, `${key}.distinct_trader_total`)
      if (
        declaredActual !== normalized.population_total ||
        distinctTraders !== normalized.population_total ||
        row.membership_consistent !== true
      ) {
        throw new Error(
          `${row.slug}[tf${row.timeframe}] passed snapshot membership is inconsistent`
        )
      }
    }
    if (
      normalized.stats_total > normalized.population_total ||
      normalized.fresh_stats_total > normalized.stats_total ||
      normalized.filled > normalized.stats_total ||
      normalized.fresh_filled > normalized.filled ||
      normalized.fresh_filled > normalized.fresh_stats_total
    ) {
      throw new Error(`${key} aggregate counts are inconsistent`)
    }
    const measuredMs = timestampMs(measuredIso, 'measured_at')
    const newestMs = timestampMs(normalized.newest_stats_as_of, 'newest_stats_as_of', {
      nullable: true,
    })
    if (newestMs != null && newestMs > measuredMs + FUTURE_TOLERANCE_MS) {
      throw new Error(`${row.slug}[tf${row.timeframe}] stats timestamp is in the future`)
    }

    return {
      ...normalized,
      measurement_state: deriveMeasurementState(normalized, measuredIso, statsFreshnessHours),
    }
  })

  if (seen.size !== expectedKeys.size) {
    throw new Error('measurement did not close over the complete expected contract')
  }
  return evidence
}

export function evaluateEvidence(
  evidence,
  {
    lowFillPct = 0.2,
    lowFillMinRows = 200,
    strictLowFill = false,
    zeroFillExempt = ZERO_FILL_EXEMPT,
    lowFillExempt = LOW_FILL_EXEMPT,
  } = {}
) {
  const violations = []
  const lowFill = []
  const stateFailures = new Set()

  for (const row of evidence) {
    if (row.measurement_state !== 'measured') {
      const stateKey = `${row.source_id}:${row.timeframe}:${row.measurement_state}`
      if (!stateFailures.has(stateKey)) {
        stateFailures.add(stateKey)
        violations.push(
          `${row.slug}[tf${row.timeframe}] completeness state=${row.measurement_state}`
        )
      }
      continue
    }

    const metricKey = `${row.slug}:${row.metric}`
    if (row.fresh_filled === 0 && !zeroFillExempt.has(metricKey)) {
      violations.push(
        `${row.slug}.${row.metric}[tf${row.timeframe}] has 0/${row.population_total} fresh values`
      )
      continue
    }

    if (
      row.population_total >= lowFillMinRows &&
      row.fresh_filled > 0 &&
      !lowFillExempt.has(metricKey)
    ) {
      const ratio = row.fresh_filled / row.population_total
      if (ratio < lowFillPct) {
        const warning = {
          slug: row.slug,
          timeframe: row.timeframe,
          metric: row.metric,
          ratio,
          fresh_filled: row.fresh_filled,
          population_total: row.population_total,
        }
        lowFill.push(warning)
        if (strictLowFill) {
          violations.push(
            `${row.slug}.${row.metric}[tf${row.timeframe}] fresh coverage ${(ratio * 100).toFixed(
              1
            )}% (${row.fresh_filled}/${row.population_total})`
          )
        }
      }
    }
  }

  lowFill.sort((left, right) => left.ratio - right.ratio)
  return { violations, lowFill }
}

function evidencePayload(evidence) {
  return evidence.map(({ slug: _slug, ...row }) => row)
}

async function writeEvidence(client, evidence, takenOn, contractHash) {
  const result = await client.query(UPSERT_EVIDENCE_SQL, [
    JSON.stringify(evidencePayload(evidence)),
  ])
  if (result.rowCount !== evidence.length) {
    throw new Error(
      `evidence upsert returned ${result.rowCount ?? 'unknown'} rows for ${evidence.length} cells`
    )
  }

  await client.query(
    `delete from arena.metric_completeness_daily
     where taken_on = $1::date and contract_hash <> $2`,
    [takenOn, contractHash]
  )
  const exact = await client.query(
    `select count(*)::bigint as cell_count
     from arena.metric_completeness_daily
     where taken_on = $1::date and contract_hash = $2`,
    [takenOn, contractHash]
  )
  const persisted = parseCount(exact.rows[0]?.cell_count, 'persisted evidence cell_count')
  if (persisted !== evidence.length) {
    throw new Error(`persisted evidence has ${persisted} rows, expected ${evidence.length}`)
  }
}

async function snapshotLegacyTrend(client, cells, takenOn) {
  const legacy = await client.query(LEGACY_TREND_SQL, [JSON.stringify(cells)])
  const rows = legacy.rows.map((row) => ({
    slug: row.slug,
    metric: row.metric,
    filled: parseCount(row.filled, `${row.slug}.${row.metric}.legacy_filled`),
    total: parseCount(row.total, `${row.slug}.${row.metric}.legacy_total`),
  }))
  await client.query(`delete from arena.metric_fill_trend where taken_on = $1::date`, [takenOn])
  await client.query(
    `insert into arena.metric_fill_trend (taken_on, slug, metric, filled, total)
     select $1::date, trend.slug, trend.metric, trend.filled, trend.total
     from pg_catalog.jsonb_to_recordset($2::jsonb) as trend(
       slug text,
       metric text,
       filled bigint,
       total bigint
     )
     on conflict (taken_on, slug, metric)
     do update set filled = excluded.filled, total = excluded.total`,
    [takenOn, JSON.stringify(rows)]
  )

  const { rows: stalled } = await client.query(
    `with backfill_sources as (
       select slug
       from arena.sources
       where status = 'active'
         and serving_mode = 'serving'
         and (meta->>'series_backfill_topn') ~ '^[0-9]+$'
         and (meta->>'series_backfill_topn')::bigint > deep_profile_topn
     )
     select
       today.slug,
       today.metric,
       today.filled,
       today.total,
       old.filled as filled_7d_ago
     from arena.metric_fill_trend as today
     join arena.metric_fill_trend as old
       on old.slug = today.slug
      and old.metric = today.metric
      and old.taken_on = $1::date - 7
     join backfill_sources as source_row on source_row.slug = today.slug
     where today.taken_on = $1::date
       and today.filled <= old.filled
       and today.total > 0
       and today.filled::double precision / today.total < $2`,
    [takenOn, TREND_PLATEAU_OK]
  )
  return stalled
    .filter((row) => TREND_METRICS.has(row.metric))
    .sort(
      (left, right) => compareText(left.slug, right.slug) || compareText(left.metric, right.metric)
    )
}

function formatStateSummary(evidence) {
  const counts = new Map()
  for (const row of evidence) {
    counts.set(row.measurement_state, (counts.get(row.measurement_state) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}=${count}`)
    .join(', ')
}

async function executeCheck(pool, config) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query('begin isolation level repeatable read')
    transactionOpen = true
    await client.query(`set local lock_timeout = '5s'`)
    await client.query(`set local statement_timeout = '110s'`)
    const lock = await client.query(
      `select pg_catalog.pg_try_advisory_xact_lock(174598901, 1) as acquired`
    )
    if (lock.rows[0]?.acquired !== true) {
      throw new Error('another metric completeness measurement is already running')
    }

    const clock = await client.query(`select pg_catalog.transaction_timestamp() as measured_at`)
    const measuredAt = clock.rows[0]?.measured_at
    timestampMs(measuredAt, 'transaction measured_at')

    const sourceResult = await client.query(SOURCE_CONTRACT_SQL)
    const cells = buildContractCells(sourceResult.rows)
    const contractHash = completenessContractHash(cells, config.statsFreshnessHours)

    const measurementResult = await client.query(MEASUREMENT_SQL, [
      measuredAt,
      config.statsFreshnessHours,
      JSON.stringify(cells),
    ])
    const evidence = normalizeEvidenceRows(
      measurementResult.rows,
      cells,
      measuredAt,
      config.statsFreshnessHours,
      contractHash
    )
    const takenOn = evidence[0].taken_on
    const evaluation = evaluateEvidence(evidence, config)

    await writeEvidence(client, evidence, takenOn, contractHash)
    const stalled = await snapshotLegacyTrend(client, cells, takenOn)
    for (const row of stalled) {
      evaluation.violations.push(
        `${row.slug}.${row.metric} backfill stalled for 7 days ` +
          `(${row.filled_7d_ago}->${row.filled}/${row.total})`
      )
    }
    await client.query('commit')
    transactionOpen = false

    console.log(
      `metric-completeness: ${sourceResult.rows.length} sources, ${cells.length} cells, ` +
        `contract=${contractHash.slice(0, 12)}`
    )
    console.log(`measurement states: ${formatStateSummary(evidence)}`)
    console.log('daily evidence and aggregate compatibility trend committed')

    if (evaluation.lowFill.length > 0) {
      console.log(
        `${evaluation.lowFill.length} cells below ${(config.lowFillPct * 100).toFixed(
          0
        )}% fresh population coverage:`
      )
      for (const warning of evaluation.lowFill) {
        console.log(
          `  - ${warning.slug}.${warning.metric}[tf${warning.timeframe}] ` +
            `${(warning.ratio * 100).toFixed(1)}% ` +
            `(${warning.fresh_filled}/${warning.population_total})`
        )
      }
    }

    if (evaluation.violations.length === 0) {
      console.log('✅ completeness contract is healthy')
      return 0
    }
    console.error(`❌ ${evaluation.violations.length} completeness violations:`)
    for (const violation of evaluation.violations) console.error(`  - ${violation}`)
    return 1
  } catch (error) {
    if (transactionOpen) {
      await client.query('rollback').catch(() => {})
    }
    throw error
  } finally {
    client.release()
  }
}

export async function main(env = process.env) {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    if (env.REQUIRE_DATABASE_URL === '1') {
      console.error('fill-rate-check requires DATABASE_URL in this environment')
      return 1
    }
    console.log('fill-rate-check SKIPPED - DATABASE_URL not set')
    return 0
  }

  const config = {
    statsFreshnessHours: parsePositiveInteger(
      env.STATS_FRESHNESS_HOURS,
      'STATS_FRESHNESS_HOURS',
      STATS_FRESHNESS_HOURS_DEFAULT
    ),
    lowFillPct: parseRatio(env.LOW_FILL_PCT, 'LOW_FILL_PCT', 0.2),
    lowFillMinRows: parsePositiveInteger(env.LOW_FILL_MIN_ROWS, 'LOW_FILL_MIN_ROWS', 200),
    strictLowFill: env.STRICT_LOW_FILL === '1',
  }
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  try {
    return await executeCheck(pool, config)
  } finally {
    await pool.end()
  }
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        'fill-rate-check infrastructure/contract error:',
        error instanceof Error ? error.message : String(error)
      )
      process.exit(1)
    }
  )
}
