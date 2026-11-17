/**
 * toobit_futures profile capture contract against recorded public responses
 * (leader-detail + get-leader-radar-chart + accumulate-profit for one leader,
 * 7/30/90, probed 2026-11-17; identity fields replaced, accumulate and
 * symbolConfigs trimmed). The real getProfile builds the page; the real
 * parser and the worker's capture path decide what is attested.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '../../../profile-capture/contract'
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '../../../profile-capture/test-helper'
import { toobitAdapter } from '../index'
import { parseToobitProfile } from '../parsers'
import { TOOBIT_FUTURES_PROFILE_CAPTURE } from '../profile-capture-contract'

type Json = Record<string, unknown>
type Envelopes = { detail: Json; radar: Json; accumulate: Json }

const LEADER = '668939882'

function envelopes(timeframe: RankingTimeframe): Envelopes {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', `profile-capture-${timeframe}.json`), 'utf8')
  ) as Envelopes
}

const source = (meta: Json = {}): SourceRow => ({
  id: 25,
  slug: 'toobit_futures',
  exchange_id: 25,
  product_type: 'futures',
  trader_kind_scope: 'human',
  adapter_slug: 'toobit',
  leaderboard_url: null,
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 300,
  positions_topn: 100,
  profile_cache_ttl: '6 hours',
  copier_table_depth: 'full',
  currency: 'USDT',
  page_size: 1000,
  pagination_kind: 'numeric',
  cadence_tier_a: '4 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 2_000,
  phase: 3,
  serving_mode: 'serving',
  status: 'active',
  meta,
})

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

/** Real getProfile, upstream answered by the recorded envelopes. */
async function capture(
  timeframe: RankingTimeframe,
  served: Envelopes = envelopes(timeframe),
  leader = LEADER,
  meta: Json = {}
): Promise<{ pages: RawPage[]; requested: string[] }> {
  const requested: string[] = []
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    const path = new URL(url).pathname
    const body = path.endsWith('/leader-detail')
      ? served.detail
      : path.endsWith('/get-leader-radar-chart')
        ? served.radar
        : served.accumulate
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }
  }) as unknown as typeof fetch
  // A fresh session per capture: leader-detail is memoized per session.
  const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession
  const bundle = await toobitAdapter.getProfile!(session, source(meta), leader, timeframe)
  return { pages: bundle.pages, requested }
}

const ctx = { sourceSlug: 'toobit_futures' }

describe('toobit_futures profile capture contract', () => {
  it('is the registered contract of the source', () => {
    expect(getProfileCaptureContract('toobit_futures')).toBe(TOOBIT_FUTURES_PROFILE_CAPTURE)
    // Pinned: any contract change must bump @n and register a new hash.
    expect(profileCaptureContractSha256(TOOBIT_FUTURES_PROFILE_CAPTURE)).toBe(
      'db50788a5a83b231d7e8a71145ec683e6fa2ed77b088f38a62b2e9261e46b9f8'
    )
  })

  it.each([
    [7, '0.3222', 32.22],
    [30, '0.9587', 95.87],
    [90, '0.9587', 95.87],
  ] as const)('%sd: attests the radar drawdown of the real request', async (tf, raw, value) => {
    const { pages, requested } = await capture(tf)
    expect(requested).toContain(
      `https://bapi.toobit.com/bapi/v1/copy-trading/get-leader-radar-chart?leaderUserId=${LEADER}&type=${tf}`
    )
    const result = expectProfileContractAttests({
      contract: TOOBIT_FUTURES_PROFILE_CAPTURE,
      timeframe: tf,
      pages,
      parseProfile: parseToobitProfile,
      ctx,
      exchangeTraderId: LEADER,
      metrics: ['mdd'],
    })
    expect(result.manifest?.metrics).toEqual({
      mdd: {
        endpoint: 'radar',
        path: ['radar', 'data', 'leaderMaximumDrawdown'],
        raw_value: raw,
        value: expect.closeTo(value, 9),
      },
    })
    // The only trade count is leader-detail's lifetime count (545 for every
    // window): kept as an extra, never a window total_positions.
    expect(result.parsed?.totalPositions).toBeNull()
    expect(result.parsed?.extras.trade_count_lifetime).toBe(545)
  })

  it('binds the trader and the window into the request projection', async () => {
    const projection = async (leader: string, tf: RankingTimeframe) =>
      runProfileContractFixture({
        contract: TOOBIT_FUTURES_PROFILE_CAPTURE,
        timeframe: tf,
        pages: (await capture(tf, envelopes(tf), leader)).pages,
        parseProfile: parseToobitProfile,
        ctx,
      }).manifest?.requests[0].request_projection_sha256
    const base = await projection(LEADER, 30)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await projection('522025357', 30)).not.toBe(base)
    expect(await projection(LEADER, 90)).not.toBe(base)
  })

  it('refuses a response for another window than the one requested', async () => {
    // 90D radar + series served for a 30D request: no 30D block, nothing attested.
    const { pages } = await capture(30, envelopes(90))
    const result = runProfileContractFixture({
      contract: TOOBIT_FUTURES_PROFILE_CAPTURE,
      timeframe: 30,
      pages,
      parseProfile: parseToobitProfile,
      ctx,
    })
    expect([result.terminalState, result.reasonCode]).toEqual([
      'processing_failed',
      'stats_block_missing',
    ])
    expect(result.attestedMetrics).toEqual([])
  })

  it('an incomplete capture attests nothing', async () => {
    const run = (pages: RawPage[]) =>
      runProfileContractFixture({
        contract: TOOBIT_FUTURES_PROFILE_CAPTURE,
        timeframe: 30,
        pages,
        parseProfile: parseToobitProfile,
        ctx,
      })
    // No page at all.
    expect([run([]).terminalState, run([]).reasonCode]).toEqual(['partial', 'endpoint_missing'])
    // Pages from an overridden (undeclared) API base.
    const overridden = await capture(30, envelopes(30), LEADER, {
      endpoints: { base: 'https://bapi.toobit.com/bapi/v2/copy-trading' },
    })
    expect(run(overridden.pages).reasonCode).toBe('undeclared_endpoint')
    // Radar answered without data: an honest absence, so no drawdown is attested.
    const served = envelopes(30)
    const empty = await capture(30, { ...served, radar: { code: 200, data: null } })
    const result = run(empty.pages)
    expect(result.terminalState).toBe('complete')
    expect(result.attestedMetrics).toEqual([])
  })

  it('refuses a stored drawdown the parser did not read from the declared field', async () => {
    const { pages } = await capture(90)
    const result = runProfileContractFixture({
      contract: TOOBIT_FUTURES_PROFILE_CAPTURE,
      timeframe: 90,
      pages,
      parseProfile: (payload, parseCtx) => {
        const profile = parseToobitProfile(payload, parseCtx)
        return { ...profile, stats: profile.stats.map((s) => ({ ...s, mdd: 95 })) }
      },
      ctx,
    })
    expect(result.reasonCode).toBe('projection_mismatch')
  })
})
