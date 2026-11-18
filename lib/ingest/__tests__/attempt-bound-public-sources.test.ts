/**
 * Every public Tier-A source registered for attempt-bound capture must turn a
 * captured board into evidence that the season publisher accepts.
 *
 * Per source: replay the adapter fixture through the adapter's own
 * `captureLeaderboard`, parse and validate the rows exactly as Tier-A does,
 * build the attempt-bound V3 manifest, project the terminal outcome, and run
 * the publication trust predicate (a port of
 * `public.rank_publication_trust_evidence`, PR #476) against the resulting
 * attempt/outcome/snapshot rows. A board whose upstream total is not fully
 * captured must never pass.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  buildLeaderboardAcquisitionManifestV3,
} from '../acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  projectLeaderboardManifestV3Outcome,
  type LeaderboardAcquisitionAttempt,
} from '../acquisition-attempts'
import type { SourceAdapter } from '../core/adapter'
import type { RankingTimeframe, SourceRow } from '../core/types'
import { isPartitionedNumericLeaderboardCapture } from '../fetch/capture'
import type { FetchSession, ReplayRequestTemplate } from '../fetch/types'
import { hasRegisteredLeaderboardMetricTrust } from '../serving/metric-trust-publish'
import { validateLeaderboardRows } from '../staging/validate'
import { binanceAdapter } from '../adapters/binance'
import { bitunixAdapter } from '../adapters/bitunix'
import { blofinAdapter } from '../adapters/blofin'
import { btccAdapter } from '../adapters/btcc'
import { bybitCopytradeAdapter } from '../adapters/bybit-copytrade'
import { bybitMt5Adapter } from '../adapters/bybit-mt5'
import { coinexAdapter } from '../adapters/coinex'
import { gateAdapter } from '../adapters/gate'
import { htxAdapter } from '../adapters/htx'
import { kucoinAdapter } from '../adapters/kucoin'
import { lbankAdapter } from '../adapters/lbank'
import { mexcAdapter } from '../adapters/mexc'
import { okxWeb3Adapter } from '../adapters/okx-web3'
import { toobitAdapter } from '../adapters/toobit'
import { xtAdapter } from '../adapters/xt'

const V3 = 'arena.ingest.leaderboard-acquisition-manifest@3'

// ── Port of public.rank_publication_trust_evidence (PR #476) ──

interface AttemptRow {
  attempt_seq: number
  source_id: number
  timeframe: number
  capture_contract: string
}
interface OutcomeRow {
  attempt_seq: number
  terminal_state: string
  source_run_id: string | null
  manifest_raw_object_id: number | null
  source_payload_raw_object_id: number | null
}
interface SnapshotRow {
  id: number
  source_id: number
  timeframe: number
  raw_object_id: number
  count_check_passed: boolean
}

function rankPublicationTrustBound(
  snapshot: SnapshotRow,
  attempts: readonly AttemptRow[],
  outcomes: readonly OutcomeRow[]
): boolean {
  if (!snapshot.count_check_passed) return false
  return outcomes.some((outcome) => {
    const attempt = attempts.find((row) => row.attempt_seq === outcome.attempt_seq)
    return (
      attempt !== undefined &&
      attempt.source_id === snapshot.source_id &&
      attempt.timeframe === snapshot.timeframe &&
      (attempt.capture_contract === V3 ||
        attempt.capture_contract === 'arena.ingest.leaderboard-acquisition-manifest@4') &&
      outcome.terminal_state === 'complete' &&
      outcome.source_run_id !== null &&
      outcome.manifest_raw_object_id !== null &&
      outcome.source_payload_raw_object_id === snapshot.raw_object_id
    )
  })
}

// ── Fake upstream session ──

type Responder = (request: ReplayRequestTemplate) => { status: number; json: unknown }

function fakeSession(slug: string, respond: Responder): FetchSession {
  const page = {
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
  }
  const apiResponse = (request: ReplayRequestTemplate) => {
    const answer = respond(request)
    return { status: () => answer.status, json: async () => answer.json }
  }
  const api = {
    get: async (url: string, options?: { headers?: Record<string, string> }) =>
      apiResponse({ url, method: 'GET', headers: options?.headers ?? {} }),
    post: async (url: string, options?: { headers?: Record<string, string>; data?: unknown }) =>
      apiResponse({ url, method: 'POST', headers: options?.headers ?? {}, body: options?.data }),
  }
  return {
    sourceSlug: slug,
    page: async () => page,
    api: async () => api,
    pageFetch: async (request: ReplayRequestTemplate) => respond(request),
    capture: async () => ({
      first: async () => ({ template: { url: '', method: 'GET', headers: {} } }),
      dispose: () => undefined,
    }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

function fixture(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'adapters', dir, '__tests__', 'fixtures', name), 'utf8')
  ) as Record<string, unknown>
}

function at(payload: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let value: unknown = payload
  for (const segment of path) value = (value as Record<string, unknown>)[segment]
  return value as Record<string, unknown>
}

interface SourceCase {
  slug: string
  adapter: SourceAdapter
  adapterSlug: string
  currency: SourceRow['currency']
  timeframe: RankingTimeframe
  pageSize: number
  meta?: Record<string, unknown>
  /** One upstream board page whose reported total equals `total`. */
  page: (total: number) => Record<string, unknown>
  rows: number
}

/** Fixture page with its source-reported population replaced. */
function withTotal(
  payload: Record<string, unknown>,
  container: readonly string[],
  key: string,
  options: { asString?: boolean; pageCountKey?: string; pageSize: number }
): (total: number) => Record<string, unknown> {
  const encode = (value: number) => (options.asString ? String(value) : value)
  return (total) => {
    const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    at(copy, container)[key] = encode(total)
    if (options.pageCountKey) {
      at(copy, container)[options.pageCountKey] = encode(Math.ceil(total / options.pageSize))
    }
    return copy
  }
}

function rowCount(payload: Record<string, unknown>, path: readonly string[]): number {
  return (at(payload, path.slice(0, -1))[path.at(-1)!] as unknown[]).length
}

function fixtureCase(
  base: Omit<SourceCase, 'page' | 'rows'>,
  payload: Record<string, unknown>,
  list: readonly string[],
  totalContainer: readonly string[],
  totalKey: string,
  options: { asString?: boolean; pageCountKey?: string } = {}
): SourceCase {
  return {
    ...base,
    page: withTotal(payload, totalContainer, totalKey, { ...options, pageSize: base.pageSize }),
    rows: rowCount(payload, list),
  }
}

function okxWeb3Page(total: number): Record<string, unknown> {
  const wallet = '3CkgBB2ryzxQuSmzPSQ53jtVffPf1Wb1t1HBVs8GmGfw'
  return {
    code: 0,
    msg: '',
    data: {
      rankStart: 0,
      rankEnd: 20,
      totalCount: total,
      rankingInfos: [0, 1].map((index) => ({
        walletAddress: `${wallet.slice(0, -2)}A${'BC'[index]}`, // base58 alphabet
        periodType: '4',
        chainId: 501,
        roi: '10',
        pnl: '100',
        winRate: '50',
      })),
      rankingFilter: { periodType: '4', chainId: '501', rankBy: '1', desc: 'true', label: '' },
    },
  }
}

const CASES: SourceCase[] = [
  fixtureCase(
    {
      slug: 'binance_spot',
      adapter: binanceAdapter,
      adapterSlug: 'binance',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 20,
      meta: { boardKey: 'spot' },
    },
    fixture('binance', 'spot-leaderboard-p1.json'),
    ['data', 'list'],
    ['data'],
    'total'
  ),
  fixtureCase(
    {
      slug: 'coinex_futures',
      adapter: coinexAdapter,
      adapterSlug: 'coinex',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 12,
    },
    fixture('coinex', 'leaderboard-p1.json'),
    ['data', 'data'],
    ['data'],
    'total',
    { pageCountKey: 'total_page' }
  ),
  ...(['futures', 'spot'] as const).map((board) =>
    fixtureCase(
      {
        slug: `htx_${board}`,
        adapter: htxAdapter,
        adapterSlug: 'htx',
        currency: 'USDT',
        timeframe: 90,
        pageSize: 12,
        meta: { boardKey: board },
      },
      fixture('htx', `rank-${board}-p1.json`),
      ['data', 'itemList'],
      ['data'],
      'totalNum'
    )
  ),
  fixtureCase(
    {
      slug: 'kucoin_futures',
      adapter: kucoinAdapter,
      adapterSlug: 'kucoin',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 12,
    },
    fixture('kucoin', 'leaderboard-p1.json'),
    ['data', 'items'],
    ['data'],
    'totalNum',
    { pageCountKey: 'totalPage' }
  ),
  fixtureCase(
    {
      slug: 'bybit_copytrade',
      adapter: bybitCopytradeAdapter,
      adapterSlug: 'bybit_copytrade',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 16,
    },
    fixture('bybit-copytrade', 'leaderboard-p1.json'),
    ['result', 'leaderDetails'],
    ['result'],
    'totalCount',
    { asString: true, pageCountKey: 'totalPageCount' }
  ),
  fixtureCase(
    {
      slug: 'bybit_mt5',
      adapter: bybitMt5Adapter,
      adapterSlug: 'bybit_mt5',
      currency: 'USDx',
      timeframe: 30,
      pageSize: 16,
    },
    fixture('bybit-mt5', 'leaderboard-p1.json'),
    ['result', 'providerDetailsList'],
    ['result'],
    'totalCount',
    { asString: true }
  ),
  ...(
    [
      ['futures', 'fut', 'USDT', 'list'],
      ['cfd', 'cfd', 'USDx', 'lists'],
    ] as const
  ).map(([board, file, currency, collection]) =>
    fixtureCase(
      {
        slug: `gate_${board}`,
        adapter: gateAdapter,
        adapterSlug: 'gate',
        currency,
        timeframe: 30,
        pageSize: 12,
        meta: { boardKey: board },
      },
      fixture('gate', `leaderboard-${file}-p1.json`),
      ['data', collection],
      ['data'],
      'totalcount',
      { pageCountKey: 'pagecount' }
    )
  ),
  ...(
    [
      ['futures', 'fut'],
      ['spot', 'spot'],
    ] as const
  ).map(([board, file]) =>
    fixtureCase(
      {
        slug: `blofin_${board}`,
        adapter: blofinAdapter,
        adapterSlug: 'blofin',
        currency: 'USDT',
        timeframe: 30,
        pageSize: 12,
        meta: { boardKey: board },
      },
      fixture('blofin', `board-${file}-30.json`),
      ['data', 'trader_info'],
      ['data'],
      'page_total',
      { pageCountKey: 'pages' }
    )
  ),
  fixtureCase(
    {
      slug: 'btcc_futures',
      adapter: btccAdapter,
      adapterSlug: 'btcc',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 12,
    },
    fixture('btcc', 'trader-page-p1.json'),
    ['rows'],
    [],
    'total'
  ),
  fixtureCase(
    {
      slug: 'bitunix_futures',
      adapter: bitunixAdapter,
      adapterSlug: 'bitunix',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 9,
    },
    fixture('bitunix', 'trader-list-30d-p1.json'),
    ['data', 'records'],
    ['data'],
    'total',
    { pageCountKey: 'totalPage' }
  ),
  fixtureCase(
    {
      slug: 'lbank_futures',
      adapter: lbankAdapter,
      adapterSlug: 'lbank',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 20,
    },
    fixture('lbank', 'getall-30d-p1.json'),
    ['data', 'records'],
    ['data'],
    'total',
    { pageCountKey: 'pages' }
  ),
  fixtureCase(
    {
      slug: 'mexc_futures',
      adapter: mexcAdapter,
      adapterSlug: 'mexc',
      currency: 'USDT',
      timeframe: 7,
      pageSize: 100,
    },
    fixture('mexc', 'traders-v2-p1.json'),
    ['data', 'content'],
    ['data'],
    'total'
  ),
  fixtureCase(
    {
      slug: 'toobit_futures',
      adapter: toobitAdapter,
      adapterSlug: 'toobit',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 1000,
    },
    fixture('toobit', 'leaders-new-p1.json'),
    ['data', 'list'],
    ['data'],
    'total',
    { asString: true, pageCountKey: 'pages' }
  ),
  fixtureCase(
    {
      slug: 'xt_futures',
      adapter: xtAdapter,
      adapterSlug: 'xt',
      currency: 'USDT',
      timeframe: 30,
      pageSize: 1000,
      meta: { boardKey: 'futures' },
    },
    fixture('xt', 'leaderboard-fut-30.json'),
    ['result', 'items'],
    ['result'],
    'total'
  ),
  {
    slug: 'okx_web3_solana',
    adapter: okxWeb3Adapter,
    adapterSlug: 'okx_web3',
    currency: 'USDC',
    timeframe: 30,
    pageSize: 20,
    page: okxWeb3Page,
    rows: 2,
  },
]

function sourceRow(item: SourceCase): SourceRow {
  return {
    id: 41,
    slug: item.slug,
    exchange_id: 41,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: item.adapterSlug,
    leaderboard_url: 'https://example.invalid/board',
    timeframes_native: [item.timeframe],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 0,
    positions_topn: 0,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'none',
    currency: item.currency,
    page_size: item.pageSize,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 0,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: item.meta ?? {},
  }
}

async function captureEvidence(item: SourceCase, reportedTotal: number) {
  const src = sourceRow(item)
  const payload = item.page(reportedTotal)
  const respond: Responder = () => ({ status: 200, json: payload })
  const originalFetch = global.fetch
  global.fetch = (async () =>
    ({ status: 200, json: async () => payload }) as Response) as unknown as typeof fetch
  let capture
  try {
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    capture = await item.adapter.captureLeaderboard!(
      fakeSession(item.slug, respond),
      src,
      item.timeframe
    )
    if (isPartitionedNumericLeaderboardCapture(capture)) {
      throw new Error('public sources use identity captures')
    }
    const completedAt = new Date(Date.now() + 1_000).toISOString()
    const ctx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt: completedAt,
      meta: src.meta,
    }
    const parsed = capture.parsePages.flatMap(
      (page) => item.adapter.parseLeaderboard(page.payload, ctx).rows
    )
    const validated = validateLeaderboardRows(parsed)
    const attempt: LeaderboardAcquisitionAttempt = {
      attemptId: '00000000-0000-4000-8000-000000000001',
      attemptSeq: 7,
      sourceId: src.id,
      sourceSlug: src.slug,
      adapterSlug: src.adapter_slug,
      timeframe: item.timeframe,
      observationCycleId: `tier-a:${src.slug}:fixture`,
      queueJobId: 'job-1',
      queueAttempt: 1,
      captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
      attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      runnerGitSha: 'a'.repeat(40),
      workerRegion: 'local',
      sourceStatus: 'active',
      sourceServingMode: 'serving',
      sourceCurrency: src.currency,
      sourceFetchRegion: 'local',
      recordedStartedAt: startedAt,
    }
    const built = buildLeaderboardAcquisitionManifestV3({
      source: {
        id: src.id,
        slug: src.slug,
        adapter_slug: src.adapter_slug,
        configured_page_size: src.page_size,
        configured_pagination_kind: src.pagination_kind,
      },
      surface: 'tier_a_leaderboard',
      timeframe: item.timeframe,
      started_at: startedAt,
      completed_at: completedAt,
      runner_git_sha: 'a'.repeat(40),
      observation_cycle_id: attempt.observationCycleId,
      capture_evidence_state: 'verified',
      termination_reason: capture.terminationReason,
      capture_config: capture.captureConfig,
      source_pages: capture.sourcePages.map((page) => ({
        raw_page: page.rawPage,
        source_row_count: page.sourceRowCount,
        request_sha256: page.requestSha256,
        http_status: page.httpStatus,
        pagination_position: page.paginationPosition,
        source_reports: page.sourceReports,
      })),
      parse_pages: capture.parsePages,
      parser_transformation: capture.parserTransformation,
      accepted_population: validated.valid.length,
      rejected_row_count: validated.rejects.length,
      acquisition_attempt: {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: attempt.attemptId,
        attempt_seq: attempt.attemptSeq,
      },
    })
    const projection = projectLeaderboardManifestV3Outcome(attempt, built)
    const trustBound = rankPublicationTrustBound(
      {
        id: 1,
        source_id: src.id,
        timeframe: item.timeframe,
        raw_object_id: 901,
        count_check_passed: true,
      },
      [
        {
          attempt_seq: attempt.attemptSeq,
          source_id: src.id,
          timeframe: item.timeframe,
          capture_contract: attempt.captureContract,
        },
      ],
      [
        {
          attempt_seq: attempt.attemptSeq,
          terminal_state: projection.terminalState,
          source_run_id: projection.sourceRunId,
          manifest_raw_object_id: 902,
          source_payload_raw_object_id: 901,
        },
      ]
    )
    return { src, capture, validated, projection, trustBound }
  } finally {
    global.fetch = originalFetch
  }
}

describe('attempt-bound capture for public Tier-A sources', () => {
  it.each(CASES.map((item) => [item.slug, item] as const))(
    '%s: a fully captured board is publication evidence',
    async (_slug, item) => {
      const { src, capture, validated, projection, trustBound } = await captureEvidence(
        item,
        item.rows
      )

      expect(item.adapter.leaderboardAcquisitionContract ?? V3).toBe(V3)
      expect(hasRegisteredLeaderboardMetricTrust(src, item.timeframe)).toBe(true)
      expect(capture.sourcePages).toHaveLength(1)
      expect(capture.sourcePages[0].sourceRowCount).toBe(item.rows)
      expect(capture.sourcePages[0].requestSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(validated.valid).toHaveLength(item.rows)
      expect(validated.rejects).toHaveLength(0)
      expect(projection).toMatchObject({
        terminalState: 'complete',
        acquisitionState: 'complete',
        populationState: 'verified',
        reportedPopulation: item.rows,
      })
      expect(trustBound).toBe(true)
    }
  )

  it.each(CASES.map((item) => [item.slug, item] as const))(
    '%s: a board short of its reported population is not evidence',
    async (_slug, item) => {
      const { projection, trustBound } = await captureEvidence(item, item.rows + 1)

      expect(projection.terminalState).not.toBe('complete')
      expect(trustBound).toBe(false)
    }
  )

  it.each(CASES.map((item) => [item.slug, item] as const))(
    '%s: persisted request evidence carries no request headers',
    async (_slug, item) => {
      const { capture } = await captureEvidence(item, item.rows)
      expect(JSON.stringify(capture.sourcePages[0].rawPage)).not.toMatch(
        /user-agent|referer|cookie|authorization/i
      )
    }
  )
})
