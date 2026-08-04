import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  TOKEN_AUTHORITY_COUNTS_QUERY,
  TOKEN_AUTHORITY_SCHEMA_QUERY,
  TOKEN_PUBLICATION_HEAD_QUERY,
  TOKEN_RANKING_AUTHORITY_REPORT_CONTRACT,
  classifyTokenAuthorityBlocker,
  collectTokenRankingAuthorityReport,
  validateTokenAuthoritySchema,
} from './token-ranking-authority-report.mjs'

const NOW = new Date('2026-08-04T12:00:00.000Z')

const authorityColumns = {
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
}

function schemaRow(overrides = {}) {
  return {
    authority_view: 'arena.token_trade_fact_authority_shadow',
    authority_view_kind: 'v',
    authority_view_options: ['security_invoker=true', 'security_barrier=true'],
    source_contracts: 'arena.token_trade_source_contracts',
    publication_head: 'arena.token_ranking_publication_head',
    authority_columns: authorityColumns,
    source_contract_columns: { source_slug: 'text', active: 'boolean' },
    publication_head_columns: {
      singleton: 'boolean',
      generation_seq: 'bigint',
      published_at: 'timestamp with time zone',
      window_through_date: 'date',
      source_as_of: 'timestamp with time zone',
    },
    ...overrides,
  }
}

function countRow(source, windowDays, overrides = {}) {
  return {
    source_slug: source,
    window_days: windowDays,
    captured_count: '10',
    history_complete_count: '8',
    trusted_price_count: '9',
    known_cost_basis_count: '9',
    trusted_fx_count: '7',
    rank_eligible_count: '6',
    source_as_of_age_p50_hours: 1.25,
    source_as_of_age_p95_hours: 2.5,
    source_as_of_age_max_hours: 3,
    exact_blockers: { history_partial: '2', fx_unknown: '3' },
    ...overrides,
  }
}

function completeCountRows() {
  return ['binance_futures', 'okx_futures'].flatMap((source) =>
    [7, 30, 90].map((windowDays) => countRow(source, windowDays))
  )
}

function publicationRow(overrides = {}) {
  return {
    generation_seq: '0',
    published_at: null,
    window_through_date: null,
    source_as_of: null,
    ...overrides,
  }
}

function fakeClient({
  schema = schemaRow(),
  counts = completeCountRows(),
  publication = publicationRow(),
  failOn,
} = {}) {
  const calls = []
  return {
    calls,
    async query(input) {
      const text = typeof input === 'string' ? input : input.text
      calls.push(input)
      if (failOn && text.includes(failOn)) {
        const error = new Error(
          'postgresql://operator:must-not-leak@db.example.com/private-trader-identity'
        )
        error.code = '57014'
        throw error
      }
      if (text === TOKEN_AUTHORITY_SCHEMA_QUERY) return { rows: [schema] }
      if (text === TOKEN_AUTHORITY_COUNTS_QUERY) return { rows: counts }
      if (text === TOKEN_PUBLICATION_HEAD_QUERY) return { rows: [publication] }
      return { rows: [] }
    },
  }
}

test('reports generation zero as intentional unavailable while preserving shadow gate counts', async () => {
  const client = fakeClient()
  const { report, exitCode } = await collectTokenRankingAuthorityReport({ client, now: NOW })

  assert.equal(exitCode, 0)
  assert.equal(report.contract, TOKEN_RANKING_AUTHORITY_REPORT_CONTRACT)
  assert.equal(report.status, 'intentional_unavailable')
  assert.equal(report.healthy, false)
  assert.deepEqual(report.population, {
    state: 'unknown',
    count: null,
    reason: 'token_population_authority_not_modeled',
  })
  assert.deepEqual(report.totals, {
    population: null,
    captured: 60,
    history_complete: 48,
    trusted_price: 54,
    known_cost_basis: 54,
    trusted_fx: 42,
    rank_eligible: 36,
    published_rank: null,
  })
  assert.equal(report.publication.state, 'intentional_unavailable')
  assert.equal(report.publication.generation, '0')
  assert.equal(report.publication.published_rank_count, null)
  assert.equal(report.groups.length, 6)
  assert.equal(report.groups[0].source_as_of_age_hours.p95, 2.5)
  assert.deepEqual(report.blockers.categories, { fx: 18, history: 12 })
  assert.equal(JSON.stringify(report).includes('healthy":true'), false)

  const countCall = client.calls.find(
    (call) => typeof call === 'object' && call.text === TOKEN_AUTHORITY_COUNTS_QUERY
  )
  assert.deepEqual(countCall.values, [NOW.toISOString()])
})

test('keeps absent source_as_of evidence null instead of manufacturing zero age', async () => {
  const counts = completeCountRows().map((row) => ({
    ...row,
    source_as_of_age_p50_hours: null,
    source_as_of_age_p95_hours: null,
    source_as_of_age_max_hours: null,
  }))
  const { report, exitCode } = await collectTokenRankingAuthorityReport({
    client: fakeClient({ counts }),
    now: NOW,
  })

  assert.equal(exitCode, 0)
  for (const group of report.groups) {
    assert.deepEqual(group.source_as_of_age_hours, { p50: null, p95: null, max: null })
  }
})

test('does not promote application fact ledgers when no authority evidence writer has published', async () => {
  const counts = completeCountRows().map((row) =>
    countRow(row.source_slug, row.window_days, {
      captured_count: '0',
      history_complete_count: '0',
      trusted_price_count: '0',
      known_cost_basis_count: '0',
      trusted_fx_count: '0',
      rank_eligible_count: '0',
      source_as_of_age_p50_hours: null,
      source_as_of_age_p95_hours: null,
      source_as_of_age_max_hours: null,
      exact_blockers: {},
    })
  )
  const { report, exitCode } = await collectTokenRankingAuthorityReport({
    client: fakeClient({ counts }),
    now: NOW,
  })

  assert.equal(exitCode, 0)
  assert.equal(report.status, 'intentional_unavailable')
  assert.equal(report.healthy, false)
  assert.equal(report.totals.captured, 0)
  assert.equal(report.totals.rank_eligible, 0)
  assert.equal(report.totals.population, null)
  assert.equal(report.totals.published_rank, null)
  assert.equal(report.publication.published_rank_count, null)
})

test('fails closed with null counts when schema evidence is absent', async () => {
  const missingPrice = { ...authorityColumns }
  delete missingPrice.price_trust_state
  const client = fakeClient({ schema: schemaRow({ authority_columns: missingPrice }) })
  const { report, exitCode } = await collectTokenRankingAuthorityReport({ client, now: NOW })

  assert.equal(exitCode, 1)
  assert.equal(report.status, 'blocked')
  assert.equal(report.schema_state, 'blocked')
  assert.deepEqual(report.totals, {
    population: null,
    captured: null,
    history_complete: null,
    trusted_price: null,
    known_cost_basis: null,
    trusted_fx: null,
    rank_eligible: null,
    published_rank: null,
  })
  assert.ok(report.schema_missing.includes('token_authority.price_trust_state:text'))
  assert.equal(
    client.calls.some(
      (call) => typeof call === 'object' && call.text === TOKEN_AUTHORITY_COUNTS_QUERY
    ),
    false
  )
})

test('query failures exit nonzero, discard partial counts, and never expose errors or PII', async () => {
  const client = fakeClient({ failOn: 'FROM ONLY arena.token_ranking_publication_head' })
  const { report, exitCode } = await collectTokenRankingAuthorityReport({ client, now: NOW })
  const serialized = JSON.stringify(report)

  assert.equal(exitCode, 1)
  assert.equal(report.status, 'blocked')
  assert.equal(report.error_code, '57014')
  assert.equal(report.totals.captured, null)
  assert.equal(report.groups.length, 0)
  assert.doesNotMatch(serialized, /must-not-leak|private-trader-identity|postgresql:/)
  assert.equal(client.calls.at(-1), 'ROLLBACK')
})

test('a positive generation remains blocked until a published authority cohort exists', async () => {
  const { report, exitCode } = await collectTokenRankingAuthorityReport({
    client: fakeClient({
      publication: publicationRow({
        generation_seq: '9',
        published_at: '2026-08-04T11:55:00.000Z',
        window_through_date: '2026-08-04',
        source_as_of: '2026-08-04T11:50:00.000Z',
      }),
    }),
    now: NOW,
  })

  assert.equal(exitCode, 1)
  assert.equal(report.status, 'blocked')
  assert.equal(report.publication.state, 'blocked_unverifiable_publication')
  assert.equal(report.publication.generation, '9')
  assert.equal(report.publication.published_rank_count, null)
  assert.ok(report.blockers.report.includes('published_token_rank_authority_not_modeled'))
})

test('classifies blocker reasons without treating declared unknown values as trusted', () => {
  assert.equal(classifyTokenAuthorityBlocker('history_partial'), 'history')
  assert.equal(classifyTokenAuthorityBlocker('coverage_stale'), 'history')
  assert.equal(classifyTokenAuthorityBlocker('price_unknown'), 'price')
  assert.equal(classifyTokenAuthorityBlocker('cost_basis_unknown'), 'cost_basis')
  assert.equal(classifyTokenAuthorityBlocker('fx_raw_quarantined'), 'fx')
  assert.equal(classifyTokenAuthorityBlocker('canonical_asset_mapping_mismatch'), 'asset_identity')
  assert.equal(classifyTokenAuthorityBlocker('legacy_position_unattested'), 'legacy_unattested')
  assert.equal(classifyTokenAuthorityBlocker('custom_writer_blocker'), 'declared_or_other')
})

test('schema validator requires typed trust states and view security options', () => {
  assert.deepEqual(validateTokenAuthoritySchema(schemaRow()), [])
  assert.deepEqual(
    validateTokenAuthoritySchema(schemaRow({ authority_view_options: ['security_invoker=true'] })),
    ['token_authority_view_security_options']
  )
})

test('query plan is read-only, bounded, and anchored to current authority rather than legacy MVs', async () => {
  const source = await readFile(
    new URL('./token-ranking-authority-report.mjs', import.meta.url),
    'utf8'
  )
  const authorityMigration = await readFile(
    new URL(
      '../../supabase/migrations/20260730033000_token_trade_fact_authority_shadow.sql',
      import.meta.url
    ),
    'utf8'
  )
  const retirementMigration = await readFile(
    new URL(
      '../../supabase/migrations/20260804043000_retire_legacy_token_rankings.sql',
      import.meta.url
    ),
    'utf8'
  )

  for (const query of [
    TOKEN_AUTHORITY_SCHEMA_QUERY,
    TOKEN_AUTHORITY_COUNTS_QUERY,
    TOKEN_PUBLICATION_HEAD_QUERY,
  ]) {
    assert.match(query, /^(SELECT|WITH)\b/)
    assert.doesNotMatch(
      query,
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|REFRESH|CALL|COPY)\b/i
    )
  }
  assert.match(source, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/)
  assert.match(source, /SET LOCAL statement_timeout = '15s'/)
  assert.match(source, /query_timeout: 20_000/)
  assert.match(TOKEN_AUTHORITY_COUNTS_QUERY, /\bEXTRACT\(/)
  assert.doesNotMatch(TOKEN_AUTHORITY_COUNTS_QUERY, /pg_catalog\.extract\(/i)
  assert.doesNotMatch(source, /public\.mv_token_trader|public\.mv_popular_tokens/)
  assert.doesNotMatch(source, /public\.trader_position_history/)

  for (const field of [
    'history_completeness_state',
    'price_trust_state',
    'cost_basis_trust_state',
    'fx_trust_state',
    'source_as_of',
    'blocker_reasons',
    'rank_eligible',
  ]) {
    assert.match(authorityMigration, new RegExp(`\\b${field}\\b`))
  }
  assert.match(retirementMigration, /generation_seq = 0/)
  assert.match(retirementMigration, /source_as_of = NULL/)
})
