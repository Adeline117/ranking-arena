#!/usr/bin/env node
/* eslint-disable no-console -- this read-only operator report intentionally writes JSON */

import pg from 'pg'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

config({ path: resolve(process.cwd(), 'worker', '.env'), quiet: true })
config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

export const TOKEN_RANKING_AUTHORITY_REPORT_CONTRACT = 'arena.token-ranking-authority-report@1'
export const TOKEN_RANKING_AUTHORITY_COUNT_UNIT = 'authority_trade_window_rows'

const WINDOWS = new Set([7, 30, 90])
const COUNT_KEYS = [
  'captured',
  'history_complete',
  'trusted_price',
  'known_cost_basis',
  'trusted_fx',
  'rank_eligible',
]

const REQUIRED_AUTHORITY_COLUMNS = Object.freeze({
  source_slug: 'text',
  window_days: 'smallint',
  source_run_id: 'text',
  source_raw_object_id: 'bigint',
  history_completeness_state: 'text',
  price_trust_state: 'text',
  cost_basis_trust_state: 'text',
  fx_trust_state: 'text',
  source_as_of: 'timestamp with time zone',
  blocker_reasons: 'text[]',
  rank_eligible: 'boolean',
})

const REQUIRED_SOURCE_CONTRACT_COLUMNS = Object.freeze({
  source_slug: 'text',
  active: 'boolean',
})

const REQUIRED_PUBLICATION_HEAD_COLUMNS = Object.freeze({
  singleton: 'boolean',
  generation_seq: 'bigint',
  published_at: 'timestamp with time zone',
  window_through_date: 'date',
  source_as_of: 'timestamp with time zone',
})

export const TOKEN_AUTHORITY_SCHEMA_QUERY = `
SELECT
  pg_catalog.to_regclass(
    'arena.token_trade_fact_authority_shadow'
  )::text AS authority_view,
  (
    SELECT relation.relkind::text
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass(
      'arena.token_trade_fact_authority_shadow'
    )
  ) AS authority_view_kind,
  (
    SELECT relation.reloptions
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass(
      'arena.token_trade_fact_authority_shadow'
    )
  ) AS authority_view_options,
  pg_catalog.to_regclass(
    'arena.token_trade_source_contracts'
  )::text AS source_contracts,
  pg_catalog.to_regclass(
    'arena.token_ranking_publication_head'
  )::text AS publication_head,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_object_agg(
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
        ORDER BY attribute.attname
      )
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'arena.token_trade_fact_authority_shadow'
      )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ),
    '{}'::jsonb
  ) AS authority_columns,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_object_agg(
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
        ORDER BY attribute.attname
      )
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'arena.token_trade_source_contracts'
      )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ),
    '{}'::jsonb
  ) AS source_contract_columns,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_object_agg(
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
        ORDER BY attribute.attname
      )
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'arena.token_ranking_publication_head'
      )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ),
    '{}'::jsonb
  ) AS publication_head_columns
`.trim()

export const TOKEN_AUTHORITY_COUNTS_QUERY = `
WITH authority_windows(window_days) AS MATERIALIZED (
  VALUES (7::smallint), (30::smallint), (90::smallint)
), expected_groups AS MATERIALIZED (
  SELECT contract.source_slug, authority_window.window_days
  FROM arena.token_trade_source_contracts AS contract
  CROSS JOIN authority_windows AS authority_window
  WHERE contract.active
), authority AS MATERIALIZED (
  SELECT
    shadow.source_slug,
    shadow.window_days,
    shadow.source_run_id,
    shadow.history_completeness_state,
    shadow.price_trust_state,
    shadow.cost_basis_trust_state,
    shadow.fx_trust_state,
    shadow.source_as_of,
    shadow.blocker_reasons,
    shadow.rank_eligible
  FROM arena.token_trade_fact_authority_shadow AS shadow
  JOIN expected_groups AS expected
    ON expected.source_slug = shadow.source_slug
   AND expected.window_days = shadow.window_days
), grouped AS MATERIALIZED (
  SELECT
    expected.source_slug,
    expected.window_days,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.source_run_id IS NOT NULL
      )
    )::text AS captured_count,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.source_run_id IS NOT NULL
          AND authority.history_completeness_state = 'complete'
      )
    )::text AS history_complete_count,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.source_run_id IS NOT NULL
          AND authority.price_trust_state IN ('source_owned', 'verified')
      )
    )::text AS trusted_price_count,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.source_run_id IS NOT NULL
          AND authority.cost_basis_trust_state IN ('source_owned', 'verified')
      )
    )::text AS known_cost_basis_count,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.source_run_id IS NOT NULL
          AND authority.fx_trust_state IN ('not_required', 'verified')
      )
    )::text AS trusted_fx_count,
    (
      pg_catalog.count(*) FILTER (
        WHERE authority.rank_eligible IS TRUE
      )
    )::text AS rank_eligible_count,
    pg_catalog.percentile_cont(0.50) WITHIN GROUP (
      ORDER BY EXTRACT(
        epoch FROM ($1::timestamptz - authority.source_as_of)
      ) / 3600.0
    ) FILTER (
      WHERE authority.source_as_of IS NOT NULL
    ) AS source_as_of_age_p50_hours,
    pg_catalog.percentile_cont(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(
        epoch FROM ($1::timestamptz - authority.source_as_of)
      ) / 3600.0
    ) FILTER (
      WHERE authority.source_as_of IS NOT NULL
    ) AS source_as_of_age_p95_hours,
    pg_catalog.max(
      EXTRACT(
        epoch FROM ($1::timestamptz - authority.source_as_of)
      ) / 3600.0
    ) FILTER (
      WHERE authority.source_as_of IS NOT NULL
    ) AS source_as_of_age_max_hours
  FROM expected_groups AS expected
  LEFT JOIN authority
    ON authority.source_slug = expected.source_slug
   AND authority.window_days = expected.window_days
  GROUP BY expected.source_slug, expected.window_days
), blocker_counts AS MATERIALIZED (
  SELECT
    authority.source_slug,
    authority.window_days,
    blocker.reason,
    pg_catalog.count(*)::text AS blocker_count
  FROM authority
  CROSS JOIN LATERAL pg_catalog.unnest(
    CASE
      WHEN authority.blocker_reasons IS NULL
        THEN ARRAY['authority_blocker_reasons_missing']::text[]
      ELSE authority.blocker_reasons
    END
  ) AS blocker(reason)
  GROUP BY authority.source_slug, authority.window_days, blocker.reason
)
SELECT
  grouped.source_slug,
  grouped.window_days,
  grouped.captured_count,
  grouped.history_complete_count,
  grouped.trusted_price_count,
  grouped.known_cost_basis_count,
  grouped.trusted_fx_count,
  grouped.rank_eligible_count,
  grouped.source_as_of_age_p50_hours,
  grouped.source_as_of_age_p95_hours,
  grouped.source_as_of_age_max_hours,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_object_agg(
        blocker.reason,
        blocker.blocker_count
        ORDER BY blocker.reason
      )
      FROM blocker_counts AS blocker
      WHERE blocker.source_slug = grouped.source_slug
        AND blocker.window_days = grouped.window_days
    ),
    '{}'::jsonb
  ) AS exact_blockers
FROM grouped
ORDER BY grouped.source_slug, grouped.window_days
`.trim()

export const TOKEN_PUBLICATION_HEAD_QUERY = `
SELECT
  publication.generation_seq::text AS generation_seq,
  publication.published_at,
  publication.window_through_date,
  publication.source_as_of
FROM ONLY arena.token_ranking_publication_head AS publication
WHERE publication.singleton
`.trim()

export const TOKEN_AUTHORITY_QUERY_PLAN = Object.freeze([
  'validate the typed private token authority view and publication-head schema',
  'aggregate reviewed source contracts across exact 7D/30D/90D authority rows',
  'read the private token publication head without consulting retired legacy MVs',
])

function blankCounts() {
  return {
    population: null,
    captured: null,
    history_complete: null,
    trusted_price: null,
    known_cost_basis: null,
    trusted_fx: null,
    rank_eligible: null,
    published_rank: null,
  }
}

function baseReport(now) {
  return {
    contract: TOKEN_RANKING_AUTHORITY_REPORT_CONTRACT,
    generated_at: now.toISOString(),
    status: 'blocked',
    healthy: false,
    count_unit: TOKEN_RANKING_AUTHORITY_COUNT_UNIT,
    query_plan: [...TOKEN_AUTHORITY_QUERY_PLAN],
    population: {
      state: 'unknown',
      count: null,
      reason: 'token_population_authority_not_modeled',
    },
    totals: blankCounts(),
    groups: [],
    blockers: {
      report: ['token_population_authority_not_modeled'],
      exact: {},
      categories: {},
    },
    publication: {
      state: 'unknown',
      generation: null,
      published_at: null,
      window_through_date: null,
      source_as_of: null,
      published_rank_count: null,
    },
    schema_state: 'unknown',
  }
}

function safeDate(value) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid timestamp result')
  return date.toISOString()
}

function safeCount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid count result')
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) throw new Error('unsafe count result')
  return count
}

function finiteAgeOrNull(value) {
  if (value === null || value === undefined) return null
  const age = Number(value)
  if (!Number.isFinite(age)) throw new Error('invalid source age result')
  return Math.round(age * 1000) / 1000
}

function exactColumnContract(actual, required, prefix) {
  const missing = []
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${prefix}_columns_unavailable`]
  }
  for (const [name, type] of Object.entries(required)) {
    if (actual[name] !== type) missing.push(`${prefix}.${name}:${type}`)
  }
  return missing
}

export function validateTokenAuthoritySchema(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return ['schema_contract_query_returned_no_row']
  }

  const missing = []
  if (row.authority_view !== 'arena.token_trade_fact_authority_shadow') {
    missing.push('arena.token_trade_fact_authority_shadow')
  }
  if (row.authority_view_kind !== 'v') missing.push('token_authority_view_kind')
  if (
    !Array.isArray(row.authority_view_options) ||
    !row.authority_view_options.includes('security_invoker=true') ||
    !row.authority_view_options.includes('security_barrier=true')
  ) {
    missing.push('token_authority_view_security_options')
  }
  if (row.source_contracts !== 'arena.token_trade_source_contracts') {
    missing.push('arena.token_trade_source_contracts')
  }
  if (row.publication_head !== 'arena.token_ranking_publication_head') {
    missing.push('arena.token_ranking_publication_head')
  }
  missing.push(
    ...exactColumnContract(row.authority_columns, REQUIRED_AUTHORITY_COLUMNS, 'token_authority'),
    ...exactColumnContract(
      row.source_contract_columns,
      REQUIRED_SOURCE_CONTRACT_COLUMNS,
      'token_source_contract'
    ),
    ...exactColumnContract(
      row.publication_head_columns,
      REQUIRED_PUBLICATION_HEAD_COLUMNS,
      'token_publication_head'
    )
  )
  return [...new Set(missing)].sort()
}

export function classifyTokenAuthorityBlocker(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') return 'unknown'
  if (reason.startsWith('history_') || reason.startsWith('coverage_')) return 'history'
  if (reason === 'trade_outside_window' || reason.startsWith('window_end_')) return 'history'
  if (reason.startsWith('price_')) return 'price'
  if (reason.startsWith('cost_basis_')) return 'cost_basis'
  if (reason.startsWith('fx_')) return 'fx'
  if (
    reason.startsWith('token_') ||
    reason.startsWith('canonical_asset_') ||
    reason.startsWith('source_instrument_')
  ) {
    return 'asset_identity'
  }
  if (
    reason.startsWith('pnl_') ||
    reason.startsWith('currency_') ||
    reason.startsWith('fact_method_')
  ) {
    return 'pnl'
  }
  if (reason.startsWith('legacy_')) return 'legacy_unattested'
  if (
    reason.startsWith('source_') ||
    reason.startsWith('fact_') ||
    reason.startsWith('lifecycle_') ||
    reason.startsWith('opened_at_') ||
    reason.startsWith('closed_at_')
  ) {
    return 'capture_lineage'
  }
  return 'declared_or_other'
}

function parseExactBlockers(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid blocker result')
  }
  const exact = {}
  for (const [reason, count] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (reason.trim() === '' || reason.trim() !== reason) {
      throw new Error('invalid blocker reason')
    }
    exact[reason] = safeCount(count)
  }
  return exact
}

function blockerCategories(exact) {
  const categories = {}
  for (const [reason, count] of Object.entries(exact)) {
    const category = classifyTokenAuthorityBlocker(reason)
    categories[category] = (categories[category] ?? 0) + count
  }
  return Object.fromEntries(
    Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))
  )
}

function parseAuthorityGroups(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('no active token authority source contracts')
  }

  const seen = new Set()
  const windowsBySource = new Map()
  const groups = rows.map((row) => {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.source_slug !== 'string' ||
      !/^[a-z0-9_]+$/.test(row.source_slug) ||
      !WINDOWS.has(Number(row.window_days))
    ) {
      throw new Error('invalid authority group identity')
    }
    const windowDays = Number(row.window_days)
    const identity = `${row.source_slug}|${windowDays}`
    if (seen.has(identity)) throw new Error('duplicate authority group identity')
    seen.add(identity)
    const sourceWindows = windowsBySource.get(row.source_slug) ?? new Set()
    sourceWindows.add(windowDays)
    windowsBySource.set(row.source_slug, sourceWindows)

    const counts = {
      population: null,
      captured: safeCount(row.captured_count),
      history_complete: safeCount(row.history_complete_count),
      trusted_price: safeCount(row.trusted_price_count),
      known_cost_basis: safeCount(row.known_cost_basis_count),
      trusted_fx: safeCount(row.trusted_fx_count),
      rank_eligible: safeCount(row.rank_eligible_count),
      published_rank: null,
    }
    const ages = {
      p50: finiteAgeOrNull(row.source_as_of_age_p50_hours),
      p95: finiteAgeOrNull(row.source_as_of_age_p95_hours),
      max: finiteAgeOrNull(row.source_as_of_age_max_hours),
    }
    if (
      ages.p50 !== null &&
      (ages.p95 === null || ages.max === null || ages.p50 > ages.p95 || ages.p95 > ages.max)
    ) {
      throw new Error('source age percentiles are inconsistent')
    }
    if (ages.p50 === null && (ages.p95 !== null || ages.max !== null)) {
      throw new Error('source age percentiles are incomplete')
    }

    const exact = parseExactBlockers(row.exact_blockers)
    return {
      source: row.source_slug,
      window_days: windowDays,
      counts,
      source_as_of_age_hours: ages,
      blockers: {
        exact,
        categories: blockerCategories(exact),
      },
    }
  })

  for (const windows of windowsBySource.values()) {
    if (windows.size !== WINDOWS.size || [...WINDOWS].some((window) => !windows.has(window))) {
      throw new Error('token authority source windows are incomplete')
    }
  }
  return groups
}

function addCounts(target, source) {
  for (const key of COUNT_KEYS) {
    const total = target[key] + source[key]
    if (!Number.isSafeInteger(total)) throw new Error('unsafe aggregate count result')
    target[key] = total
  }
}

function mergeCountMap(target, source) {
  for (const [key, count] of Object.entries(source)) {
    const total = (target[key] ?? 0) + count
    if (!Number.isSafeInteger(total)) throw new Error('unsafe aggregate blocker count result')
    target[key] = total
  }
}

function buildReport({ now, groups, publicationRow }) {
  const report = baseReport(now)
  report.schema_state = 'ready'
  report.groups = groups
  report.totals = {
    population: null,
    captured: 0,
    history_complete: 0,
    trusted_price: 0,
    known_cost_basis: 0,
    trusted_fx: 0,
    rank_eligible: 0,
    published_rank: null,
  }
  for (const group of groups) {
    addCounts(report.totals, group.counts)
    mergeCountMap(report.blockers.exact, group.blockers.exact)
    mergeCountMap(report.blockers.categories, group.blockers.categories)
  }
  report.blockers.exact = Object.fromEntries(
    Object.entries(report.blockers.exact).sort(([left], [right]) => left.localeCompare(right))
  )
  report.blockers.categories = Object.fromEntries(
    Object.entries(report.blockers.categories).sort(([left], [right]) => left.localeCompare(right))
  )

  if (publicationRow === null || typeof publicationRow !== 'object') {
    throw new Error('publication head is missing')
  }
  const generation = publicationRow.generation_seq
  if (typeof generation !== 'string' || !/^(0|[1-9][0-9]*)$/.test(generation)) {
    throw new Error('publication generation is invalid')
  }
  report.publication = {
    state: 'unknown',
    generation,
    published_at: safeDate(publicationRow.published_at),
    window_through_date:
      publicationRow.window_through_date === null
        ? null
        : String(publicationRow.window_through_date),
    source_as_of: safeDate(publicationRow.source_as_of),
    published_rank_count: null,
  }

  if (generation === '0') {
    if (
      report.publication.published_at !== null ||
      report.publication.window_through_date !== null ||
      report.publication.source_as_of !== null
    ) {
      throw new Error('generation-zero publication head is inconsistent')
    }
    report.status = 'intentional_unavailable'
    report.publication.state = 'intentional_unavailable'
    report.blockers.report.push('token_ranking_generation_zero')
    return { report, exitCode: 0 }
  }

  report.status = 'blocked'
  report.publication.state = 'blocked_unverifiable_publication'
  report.blockers.report.push('published_token_rank_authority_not_modeled')
  return { report, exitCode: 1 }
}

function blockedReport(now, reason, errorCode) {
  const report = baseReport(now)
  report.schema_state = 'blocked'
  report.blockers.report.push(reason)
  if (errorCode) report.error_code = errorCode
  return { report, exitCode: 1 }
}

function safePgErrorCode(error) {
  return typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code
    : undefined
}

export async function collectTokenRankingAuthorityReport({ client, now = new Date() }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return blockedReport(new Date(0), 'report_timestamp_invalid')
  }

  let transactionStarted = false
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    transactionStarted = true
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '2s'")

    const schemaResult = await client.query(TOKEN_AUTHORITY_SCHEMA_QUERY)
    const schemaMissing = validateTokenAuthoritySchema(schemaResult.rows?.[0])
    if (schemaMissing.length > 0) {
      await client.query('ROLLBACK')
      transactionStarted = false
      const blocked = blockedReport(now, 'token_authority_schema_contract_blocked')
      blocked.report.schema_missing = schemaMissing
      return blocked
    }

    const countResult = await client.query({
      text: TOKEN_AUTHORITY_COUNTS_QUERY,
      values: [now.toISOString()],
    })
    const groups = parseAuthorityGroups(countResult.rows)
    const publicationResult = await client.query(TOKEN_PUBLICATION_HEAD_QUERY)
    if (publicationResult.rows?.length !== 1) {
      throw new Error('publication head cardinality is invalid')
    }
    const result = buildReport({ now, groups, publicationRow: publicationResult.rows[0] })
    await client.query('ROLLBACK')
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch {}
    }
    return blockedReport(now, 'token_authority_query_failed', safePgErrorCode(error))
  }
}

async function main() {
  const databaseUrl = process.env.INGEST_DATABASE_URL || process.env.DATABASE_URL
  const now = new Date()
  if (!databaseUrl) {
    const blocked = blockedReport(now, 'database_url_unavailable')
    process.stdout.write(`${JSON.stringify(blocked.report, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  const localDatabase = /(?:localhost|127\.0\.0\.1|\[::1\])/.test(databaseUrl)
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: localDatabase ? undefined : { rejectUnauthorized: false },
    application_name: 'token-ranking-authority-report',
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 15_000,
  })

  let result
  try {
    await client.connect()
    result = await collectTokenRankingAuthorityReport({ client, now })
  } catch (error) {
    result = blockedReport(now, 'token_authority_connection_failed', safePgErrorCode(error))
  } finally {
    try {
      await client.end()
    } catch {}
  }

  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  process.exitCode = result.exitCode
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) await main()
