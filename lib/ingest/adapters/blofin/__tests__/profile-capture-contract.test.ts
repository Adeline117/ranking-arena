/**
 * blofin_futures attempt-bound profile capture: the real getProfile request
 * builder replays recorded public responses (probe 2026-11-17, one trader,
 * D7/D30/D90), and the real parser + the worker's capture flow must attest
 * exactly the contracted period metrics.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { supportsSourceSurface } from '../../../core/surface-capabilities'
import { blofinAdapter } from '../index'
import { parseBlofinProfile } from '../parsers'
import {
  BLOFIN_FUTURES_PROFILE_CAPTURE,
  BLOFIN_SPOT_PROFILE_CAPTURE,
} from '../profile-capture-contract'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '../../../profile-capture/contract'
import { buildProfileAcquisition } from '../../../profile-capture/capture'
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '../../../profile-capture/test-helper'

interface Recorded {
  uid: string
  responses: Record<string, unknown>
}
const recorded = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'profile-capture-27374913988.json'), 'utf8')
) as Recorded

function source(slug: 'blofin_futures' | 'blofin_spot'): SourceRow {
  return {
    slug,
    meta: { boardKey: slug === 'blofin_spot' ? 'spot' : 'futures' },
  } as unknown as SourceRow
}

/** A session whose API context answers from the recording (no network). */
function replaySession(failing: string[] = []): { session: FetchSession; bodies: unknown[] } {
  const bodies: unknown[] = []
  const api = {
    post: async (url: string, options: { data: Record<string, unknown> }) => {
      bodies.push(options.data)
      const path = url.replace('https://blofin.com/uapi/v1/copy/', '')
      const key = `${path}|${String(options.data.stat_period ?? '')}`
      if (failing.includes(path)) return { status: () => 503, json: async () => null }
      if (options.data.uid !== recorded.uid || !(key in recorded.responses)) {
        return { status: () => 404, json: async () => null }
      }
      return { status: () => 200, json: async () => recorded.responses[key] }
    },
  }
  const session = {
    sourceSlug: 'blofin_futures',
    api: async () => api,
    pageFetch: async (_: ReplayRequestTemplate) => ({ status: 500, json: null }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  return { session, bodies }
}

async function capturedPages(
  timeframe: RankingTimeframe,
  options: { uid?: string; failing?: string[] } = {}
): Promise<RawPage[]> {
  const { session } = replaySession(options.failing)
  const bundle = await blofinAdapter.getProfile!(
    session,
    source('blofin_futures'),
    options.uid ?? recorded.uid,
    timeframe
  )
  return bundle.pages
}

function run(timeframe: RankingTimeframe, pages: RawPage[], exchangeTraderId = recorded.uid) {
  return runProfileContractFixture({
    contract: BLOFIN_FUTURES_PROFILE_CAPTURE,
    timeframe,
    pages,
    parseProfile: parseBlofinProfile,
    exchangeTraderId,
    ctx: { sourceSlug: 'blofin_futures' },
  })
}

describe('blofin_futures profile capture contract', () => {
  it('is the registered contract for blofin_futures only', () => {
    expect(getProfileCaptureContract('blofin_futures')).toBe(BLOFIN_FUTURES_PROFILE_CAPTURE)
    expect(getProfileCaptureContract('blofin_spot')).toBe(BLOFIN_SPOT_PROFILE_CAPTURE)
    expect(profileCaptureContractSha256(BLOFIN_FUTURES_PROFILE_CAPTURE)).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    [30, 100, 9],
    [90, 81.81, 11],
  ] as const)(
    '%sd capture attests exactly the period win rate and trade count',
    async (timeframe, winRate, trades) => {
      const result = expectProfileContractAttests({
        contract: BLOFIN_FUTURES_PROFILE_CAPTURE,
        timeframe,
        pages: await capturedPages(timeframe),
        parseProfile: parseBlofinProfile,
        exchangeTraderId: recorded.uid,
        metrics: ['total_positions', 'win_rate'],
      })
      expect(result.stored?.winRate).toBeCloseTo(winRate, 9)
      expect(result.stored?.totalPositions).toBe(trades)
      expect(result.manifest).toMatchObject({
        capture_contract: 'blofin_futures-profile-capture@1',
        capture_contract_sha256: profileCaptureContractSha256(BLOFIN_FUTURES_PROFILE_CAPTURE),
        source_slug: 'blofin_futures',
        exchange_trader_id: recorded.uid,
        timeframe,
        metrics: {
          win_rate: { endpoint: 'indicators', path: ['indicators', 'data', 'win_ratio_all'] },
          total_positions: { endpoint: 'indicators', path: ['indicators', 'data', 'trades'] },
        },
      })
    }
  )

  it('keeps the zero-trade period win rate NULL and attests only the trade count', async () => {
    const result = expectProfileContractAttests({
      contract: BLOFIN_FUTURES_PROFILE_CAPTURE,
      timeframe: 7,
      pages: await capturedPages(7),
      parseProfile: parseBlofinProfile,
      exchangeTraderId: recorded.uid,
      metrics: ['total_positions'],
    })
    expect(result.stored?.winRate).toBeNull()
    expect(result.stored?.totalPositions).toBe(0)
  })

  it('binds the request projection to the trader and the stat period', async () => {
    const d30 = run(30, await capturedPages(30))
    const d90 = run(90, await capturedPages(90))
    expect(d30.terminalState).toBe('complete')
    expect(d90.terminalState).toBe('complete')
    const projection = (r: typeof d30) => r.manifest?.requests[0].request_projection_sha256
    expect(projection(d30)).not.toBe(projection(d90))

    // Same recorded responses, requested for another uid: another projection.
    const pages = await capturedPages(30)
    const otherUid = new URL(pages[0].url)
    otherUid.searchParams.set('uid', '1')
    const other = run(30, [{ ...pages[0], url: otherUid.toString() }])
    expect(projection(other)).not.toBe(projection(d30))
  })

  it('refuses a capture of another timeframe', async () => {
    const result = run(30, await capturedPages(90))
    expect(result.terminalState).toBe('processing_failed')
    expect(result.reasonCode).toBe('stats_block_missing')
    expect(result.attestedMetrics).toEqual([])
  })

  it('refuses an incomplete capture', async () => {
    // The indicators POST failed: the composite carries no stats block.
    const failed = run(30, await capturedPages(30, { failing: ['trader/stat/indicators'] }))
    expect(failed.terminalState).toBe('processing_failed')
    expect(failed.reasonCode).toBe('stats_block_missing')
    // No page of the required endpoint at all.
    const missing = run(30, [])
    expect(missing.terminalState).toBe('partial')
    expect(missing.reasonCode).toBe('endpoint_missing')
  })

  it('refuses a RAW whose value is not the parser value', async () => {
    const pages = await capturedPages(30)
    const parsed = run(30, pages).parsed!
    const result = buildProfileAcquisition({
      contract: BLOFIN_FUTURES_PROFILE_CAPTURE,
      contractSha256: profileCaptureContractSha256(BLOFIN_FUTURES_PROFILE_CAPTURE),
      attemptId: '00000000-0000-4000-8000-000000000002',
      exchangeTraderId: recorded.uid,
      timeframe: 30,
      pages,
      parsed: { ...parsed, winRate: 99 },
      stored: { ...parsed, winRate: 99 },
    })
    expect(result.terminalState).toBe('processing_failed')
    expect(result.reasonCode).toBe('projection_mismatch')
  })
})

/**
 * blofin_spot: the same proof over the spot detail endpoints (public probe
 * 2026-11-20, one trader, D7/D30/D90 of /sapi/v1/spot_copy/trader/*).
 */
const spotRecorded = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'profile-capture-spot-4187422152.json'), 'utf8')
) as Recorded

const SPOT_PREFIX = 'https://blofin.com/sapi/v1/spot_copy/'

function spotReplaySession(failing: string[] = []): { session: FetchSession; urls: string[] } {
  const urls: string[] = []
  const api = {
    post: async (url: string, options: { data: Record<string, unknown> }) => {
      urls.push(url)
      // Only the spot route holds the spot account; anything else is a miss.
      if (!url.startsWith(SPOT_PREFIX)) return { status: () => 404, json: async () => null }
      const path = url.slice(SPOT_PREFIX.length)
      const key = `${path}|${String(options.data.stat_period ?? '')}`
      if (failing.includes(path)) return { status: () => 503, json: async () => null }
      if (options.data.uid !== spotRecorded.uid || !(key in spotRecorded.responses)) {
        return { status: () => 404, json: async () => null }
      }
      return { status: () => 200, json: async () => spotRecorded.responses[key] }
    },
  }
  const session = {
    sourceSlug: 'blofin_spot',
    api: async () => api,
    pageFetch: async (_: ReplayRequestTemplate) => ({ status: 500, json: null }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  return { session, urls }
}

async function spotCapturedPages(
  timeframe: RankingTimeframe,
  options: { failing?: string[] } = {}
): Promise<RawPage[]> {
  const { session } = spotReplaySession(options.failing)
  const bundle = await blofinAdapter.getProfile!(
    session,
    source('blofin_spot'),
    spotRecorded.uid,
    timeframe
  )
  return bundle.pages
}

function spotRun(timeframe: RankingTimeframe, pages: RawPage[]) {
  return runProfileContractFixture({
    contract: BLOFIN_SPOT_PROFILE_CAPTURE,
    timeframe,
    pages,
    parseProfile: parseBlofinProfile,
    exchangeTraderId: spotRecorded.uid,
    ctx: { sourceSlug: 'blofin_spot' },
  })
}

describe('blofin_spot profile capture contract', () => {
  it('schedules the profile surface and requests only the spot account route', async () => {
    expect(supportsSourceSurface(blofinAdapter, source('blofin_futures'), 'profile')).toBe(true)
    expect(supportsSourceSurface(blofinAdapter, source('blofin_spot'), 'profile')).toBe(true)

    const { session, urls } = spotReplaySession()
    const bundle = await blofinAdapter.getProfile!(
      session,
      source('blofin_spot'),
      spotRecorded.uid,
      30
    )
    expect([...urls].sort()).toEqual([
      `${SPOT_PREFIX}trader/info`,
      `${SPOT_PREFIX}trader/stat/indicators`,
      `${SPOT_PREFIX}trader/stat/performance`,
    ])
    expect(bundle.pages).toHaveLength(1)
    expect(bundle.pages[0].url).toBe(
      `https://blofin.com/sapi/v1/spot_copy/trader/stat/indicators?uid=${spotRecorded.uid}&stat_period=D30`
    )
    expect(profileCaptureContractSha256(BLOFIN_SPOT_PROFILE_CAPTURE)).not.toBe(
      profileCaptureContractSha256(BLOFIN_FUTURES_PROFILE_CAPTURE)
    )
  })

  it.each([
    [30, 35.29, 17, 14.7976082140442],
    [90, 48.27, 29, 27.566833876268518],
  ] as const)(
    '%sd capture attests exactly the period win rate and trade count, not the drawdown',
    async (timeframe, winRate, trades, mdd) => {
      const result = expectProfileContractAttests({
        contract: BLOFIN_SPOT_PROFILE_CAPTURE,
        timeframe,
        pages: await spotCapturedPages(timeframe),
        parseProfile: parseBlofinProfile,
        exchangeTraderId: spotRecorded.uid,
        metrics: ['total_positions', 'win_rate'],
      })
      expect(result.stored?.winRate).toBeCloseTo(winRate, 9)
      expect(result.stored?.totalPositions).toBe(trades)
      // Parsed and stored, but never attested by this contract.
      expect(result.stored?.mdd).toBeCloseTo(mdd, 9)
      expect(result.manifest?.metrics).not.toHaveProperty('mdd')
      expect(result.manifest).toMatchObject({
        capture_contract: 'blofin_spot-profile-capture@1',
        capture_contract_sha256: profileCaptureContractSha256(BLOFIN_SPOT_PROFILE_CAPTURE),
        source_slug: 'blofin_spot',
        exchange_trader_id: spotRecorded.uid,
        timeframe,
        metrics: {
          win_rate: { endpoint: 'indicators', path: ['indicators', 'data', 'win_ratio_all'] },
          total_positions: { endpoint: 'indicators', path: ['indicators', 'data', 'trades'] },
        },
      })
    }
  )

  it('keeps the zero-trade period win rate NULL and attests only the trade count', async () => {
    const result = expectProfileContractAttests({
      contract: BLOFIN_SPOT_PROFILE_CAPTURE,
      timeframe: 7,
      pages: await spotCapturedPages(7),
      parseProfile: parseBlofinProfile,
      exchangeTraderId: spotRecorded.uid,
      metrics: ['total_positions'],
    })
    expect(result.stored?.winRate).toBeNull()
    expect(result.stored?.totalPositions).toBe(0)
  })

  it('does not contract the drawdown: a flat window reports one carried-over value', () => {
    // Public probe 2026-11-21: an idle spot account (roi 0, real_pnl 0, no
    // trades in any window) reports the same 64.3% drawdown for D7, D30 and
    // D90. That cannot be a drawdown of the requested window, so the field is
    // not period evidence and the contract must not attest it.
    const flat = JSON.parse(
      readFileSync(
        join(__dirname, 'fixtures', 'profile-indicators-spot-flat-16199513701.json'),
        'utf8'
      )
    ) as Recorded
    const blocks = ([7, 30, 90] as const).map((timeframe) => {
      const profile = parseBlofinProfile(
        {
          info: null,
          indicators: flat.responses[`trader/stat/indicators|D${timeframe}`],
          symbolPerf: null,
          performance: null,
          timeframe,
        },
        {
          sourceSlug: 'blofin_spot',
          currency: 'USDT',
          tfLabelMap: {},
          scrapedAt: '2026-11-21T00:00:00.000Z',
          meta: {},
        }
      )
      return profile.stats[0]
    })
    for (const block of blocks) {
      expect(block.roi).toBe(0)
      expect(block.pnl).toBe(0)
      expect(block.totalPositions).toBe(0)
      expect(block.winRate).toBeNull()
    }
    expect(blocks[0].mdd).toBeGreaterThan(64)
    expect(new Set(blocks.map((block) => block.mdd)).size).toBe(1)
    expect(Object.keys(BLOFIN_SPOT_PROFILE_CAPTURE.metrics).sort()).toEqual([
      'total_positions',
      'win_rate',
    ])
  })

  it('binds the request projection to the stat period and refuses another timeframe', async () => {
    const d30 = spotRun(30, await spotCapturedPages(30))
    const d90 = spotRun(90, await spotCapturedPages(90))
    expect(d30.manifest?.requests[0].request_projection_sha256).not.toBe(
      d90.manifest?.requests[0].request_projection_sha256
    )
    const wrong = spotRun(30, await spotCapturedPages(90))
    expect(wrong.terminalState).toBe('processing_failed')
    expect(wrong.reasonCode).toBe('stats_block_missing')
  })

  it('refuses a capture taken from the futures route', async () => {
    // A futures-route page is not an endpoint of the spot contract, so the
    // trader's futures copy account can never be attested as spot evidence.
    const futuresPages = await capturedPages(30)
    const result = runProfileContractFixture({
      contract: BLOFIN_SPOT_PROFILE_CAPTURE,
      timeframe: 30,
      pages: futuresPages,
      parseProfile: parseBlofinProfile,
      exchangeTraderId: recorded.uid,
      ctx: { sourceSlug: 'blofin_spot' },
    })
    expect(result.terminalState).toBe('processing_failed')
    expect(result.reasonCode).toBe('undeclared_endpoint')
    expect(result.attestedMetrics).toEqual([])
  })

  it('refuses an incomplete capture and a RAW whose win rate is not the parser value', async () => {
    const failed = spotRun(30, await spotCapturedPages(30, { failing: ['trader/stat/indicators'] }))
    expect(failed.terminalState).toBe('processing_failed')
    expect(failed.reasonCode).toBe('stats_block_missing')

    const pages = await spotCapturedPages(30)
    const parsed = spotRun(30, pages).parsed!
    const result = buildProfileAcquisition({
      contract: BLOFIN_SPOT_PROFILE_CAPTURE,
      contractSha256: profileCaptureContractSha256(BLOFIN_SPOT_PROFILE_CAPTURE),
      attemptId: '00000000-0000-4000-8000-000000000003',
      exchangeTraderId: spotRecorded.uid,
      timeframe: 30,
      pages,
      parsed: { ...parsed, winRate: 99 },
      stored: { ...parsed, winRate: 99 },
    })
    expect(result.terminalState).toBe('processing_failed')
    expect(result.reasonCode).toBe('projection_mismatch')
  })
})
