import {
  runDexCensusBaseline,
  type CensusFetch,
  type CensusFetchResponse,
} from '../lib/dex-census-baseline'
import { DEX_CENSUS_SOURCES } from '../lib/dex-census'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GENERATED_AT = '2026-07-16T12:00:00.000Z'

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, '0')}`
}

function response(payload: unknown): CensusFetchResponse {
  return { ok: true, status: 200, json: async () => payload }
}

function hyperliquidRow(value: number) {
  return {
    ethAddress: address(value),
    windowPerformances: [
      ['week', { pnl: String(value), roi: '0.1' }],
      ['month', { pnl: String(value * 2), roi: '0.2' }],
      ['allTime', { pnl: String(value * 3), roi: '0.3' }],
    ],
  }
}

function gmxRow(value: number) {
  return {
    id: address(value),
    realizedPnl: '10',
    realizedFees: '1',
    realizedSwapFees: '0',
    realizedPriceImpact: '0',
    realizedSwapImpact: '0',
  }
}

function gtradeRow(value: number) {
  return { address: address(value), total_pnl_usd: value, count: 1 }
}

describe('DEX census baseline collector', () => {
  it('keeps the executable and package script wired to the tested implementation', () => {
    const wrapper = readFileSync(join(process.cwd(), 'scripts', 'dex-census-baseline.mts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(wrapper).toContain("from './lib/dex-census-baseline'")
    expect(wrapper).toContain('runDexCensusBaselineCli()')
    expect(packageJson.scripts['census:dex']).toBe('tsx scripts/dex-census-baseline.mts')
  })

  it('rejects an unapproved source before issuing any network request', async () => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'hyperliquid')!
    const fetch = jest.fn<CensusFetch>()

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [{ ...source, endpoint: 'https://unapproved.example/leaderboard' }],
      })
    ).rejects.toThrow('unapproved census endpoint')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [
      'same-host path',
      (source: (typeof DEX_CENSUS_SOURCES)[number]) => ({
        ...source,
        endpoint: `${new URL(source.endpoint).origin}/not-the-registered-dataset`,
      }),
    ],
    [
      'unknown protocol-chain pair',
      (source: (typeof DEX_CENSUS_SOURCES)[number]) => ({ ...source, chain_id: 999_999 }),
    ],
    [
      'tampered completeness metadata',
      (source: (typeof DEX_CENSUS_SOURCES)[number]) => ({
        ...source,
        coverage_denominator: 'eligible' as const,
      }),
    ],
  ])('rejects a %s before issuing any network request', async (_label, mutate) => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
    const fetch = jest.fn<CensusFetch>()

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [mutate(source) as typeof source],
      })
    ).rejects.toThrow(/unapproved census source|does not match registry/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('limits source-level concurrency to three requests', async () => {
    const sources = DEX_CENSUS_SOURCES.filter((candidate) => candidate.protocol === 'gtrade')
    let active = 0
    let maxActive = 0
    const fetch: CensusFetch = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return response({ '1': [], '7': [], '30': [], '90': [] })
    }

    await runDexCensusBaseline({ generatedAt: GENERATED_AT, fetch, sources })

    expect(maxActive).toBe(3)
  })

  it('censuses every row in the complete Hyperliquid public file without a board cap', async () => {
    // Production serving deliberately caps this source at 10k. Census must
    // cross that boundary because its contract is the complete public file.
    const rows = Array.from({ length: 10_001 }, (_, index) => hyperliquidRow(index + 1))
    const fetch = jest.fn<CensusFetch>(async () => response({ leaderboardRows: rows }))
    const source = DEX_CENSUS_SOURCES.filter((candidate) => candidate.protocol === 'hyperliquid')

    const report = await runDexCensusBaseline({
      generatedAt: GENERATED_AT,
      fetch,
      sources: source,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
    expect(report.snapshot.identities).toHaveLength(10_001)
    expect(report.snapshot.identities[0]).toMatchObject({
      timeframes: [7, 30],
      metric_ready: true,
      rank_eligible: false,
    })
    expect(report.source_evidence[0]).toMatchObject({
      observed_unique_addresses: 10_001,
      score_window_unique_addresses: 10_001,
      metric_ready_unique_addresses: 10_001,
      completeness_status: 'complete',
      coverage_denominator: 'eligible',
    })
    expect(report.source_evidence[0].windows.map((window) => window.window)).toEqual([
      '7D',
      '30D',
      'all_time',
    ])
    expect(report.coverage_denominator).toMatchObject({
      discovered: 10_001,
      metric_ready: 10_001,
      included_sources: ['hyperliquid:999'],
      provisional_discovered: 0,
      excluded_discovered: 0,
    })
  })

  it('double-scans every page on all four GMX chains while preserving chain identity', async () => {
    const sources = DEX_CENSUS_SOURCES.filter((candidate) => candidate.protocol === 'gmx')
    const calls = new Map<string, number>()
    const fetch: CensusFetch = jest.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      expect(init?.method).toBe('POST')
      const limit = Number(body.query.match(/limit:\s*(\d+)/)?.[1])
      const offset = Number(body.query.match(/offset:\s*(\d+)/)?.[1])
      const from = Number(body.query.match(/from:\s*(\d+)/)?.[1])
      const to = Number(body.query.match(/to:\s*(\d+)/)?.[1])
      expect(limit).toBe(2)
      const chain = sources.find((source) => source.endpoint === url)!.chain_id
      const timeframe = (to - from) / 86_400
      const key = `${chain}:${timeframe}:${offset}`
      calls.set(key, (calls.get(key) ?? 0) + 1)

      const base = chain * 10
      if (offset === 0)
        return response({ data: { periodAccountStats: [gmxRow(base + 1), gmxRow(base + 2)] } })
      if (offset === 2) return response({ data: { periodAccountStats: [gmxRow(base + 3)] } })
      return response({ data: { periodAccountStats: [] } })
    })

    const report = await runDexCensusBaseline({
      generatedAt: GENERATED_AT,
      fetch,
      sources,
      gmxPageSize: 2,
      gmxMaxPages: 4,
    })

    expect(report.snapshot.identities).toHaveLength(12)
    expect(report.snapshot.stages.by_source).toHaveLength(4)
    expect(report.coverage_denominator).toMatchObject({
      discovered: 0,
      provisional_discovered: 12,
      excluded_discovered: 0,
    })
    expect(report.source_evidence).toHaveLength(4)
    for (const evidence of report.source_evidence) {
      expect(evidence).toMatchObject({
        observed_unique_addresses: 3,
        completeness_status: 'provisional',
        coverage_denominator: 'provisional',
      })
      expect(evidence.windows).toHaveLength(3)
      for (const window of evidence.windows) {
        expect(window).toMatchObject({
          unique_addresses: 3,
          repeatable: true,
          truncation_detected: false,
        })
        expect(window.query_bounds).toMatchObject({ semantics: 'completed_utc_days' })
        expect(
          window.query_bounds!.to_epoch_seconds - window.query_bounds!.from_epoch_seconds
        ).toBe(Number(window.window.slice(0, -1)) * 86_400)
        expect(window.scans).toHaveLength(2)
        expect(window.scans[0]).toMatchObject({ raw_rows: 3, duplicate_rows: 0 })
        expect(window.scans[1]).toMatchObject({ raw_rows: 3, duplicate_rows: 0 })
        expect(window.scans[0].identity_set_sha256).toBe(window.scans[1].identity_set_sha256)
      }
    }
    expect(calls.size).toBe(4 * 3 * 2)
    expect([...calls.values()].every((count) => count === 2)).toBe(true)
  })

  it('fails closed when GMX offset pagination repeats an identity', async () => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
    const fetch: CensusFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      const offset = Number(body.query.match(/offset:\s*(\d+)/)?.[1])
      return response({
        data: {
          periodAccountStats: offset === 0 ? [gmxRow(1), gmxRow(2)] : [gmxRow(2)],
        },
      })
    }

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [source],
        gmxPageSize: 2,
      })
    ).rejects.toThrow('pagination drift (duplicate_rows=1)')
  })

  it('fails closed when the two GMX offset scans observe different address sets', async () => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
    let requests = 0
    const fetch: CensusFetch = async () => {
      requests += 1
      return response({
        data: { periodAccountStats: [gmxRow(requests === 1 ? 1 : 2)] },
      })
    }

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [source],
        gmxPageSize: 10,
      })
    ).rejects.toThrow('double-scan drift')
  })

  it('fails closed when GMX metric readiness changes between otherwise equal scans', async () => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
    let requests = 0
    const fetch: CensusFetch = async () => {
      requests += 1
      const row = gmxRow(1)
      return response({
        data: {
          periodAccountStats: [requests === 1 ? row : { ...row, realizedFees: null }],
        },
      })
    }

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [source],
        gmxPageSize: 10,
      })
    ).rejects.toThrow('metric_ready_changes=1')
  })

  it.each([true, ['1'], ' ', '0x10'])(
    'does not coerce malformed JSON value %p into a metric-ready number',
    async (malformedValue) => {
      const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
      const malformed = { ...gmxRow(1), realizedPnl: malformedValue }
      const fetch: CensusFetch = async () => response({ data: { periodAccountStats: [malformed] } })

      const report = await runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [source],
        gmxPageSize: 10,
      })

      expect(report.source_evidence[0].metric_ready_unique_addresses).toBe(0)
      expect(report.snapshot.identities).toHaveLength(1)
      expect(report.snapshot.identities[0].metric_ready).toBe(false)
    }
  )

  it('fails closed when a GMX scan reaches its page guard without exhaustion', async () => {
    const source = DEX_CENSUS_SOURCES.find((candidate) => candidate.protocol === 'gmx')!
    const fetch = jest.fn<CensusFetch>(async () =>
      response({ data: { periodAccountStats: [gmxRow(1)] } })
    )

    await expect(
      runDexCensusBaseline({
        generatedAt: GENERATED_AT,
        fetch,
        sources: [source],
        gmxPageSize: 1,
        gmxMaxPages: 2,
      })
    ).rejects.toThrow('guard limit')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('collects all five bounded gTrade Top-25 boards but excludes them from the denominator', async () => {
    const sources = DEX_CENSUS_SOURCES.filter((candidate) => candidate.protocol === 'gtrade')
    const rows = Array.from({ length: 25 }, (_, index) => gtradeRow(index + 1))
    const oneDayOnlyRows = Array.from({ length: 25 }, (_, index) => gtradeRow(index + 26))
    const fetch = jest.fn<CensusFetch>(async () =>
      response({ '1': oneDayOnlyRows, '7': [...rows].reverse(), '30': rows, '90': rows })
    )

    const report = await runDexCensusBaseline({
      generatedAt: GENERATED_AT,
      fetch,
      sources,
    })

    expect(fetch).toHaveBeenCalledTimes(5)
    expect(report.snapshot.identities).toHaveLength(250)
    expect(report.coverage_denominator).toEqual({
      policy: 'universe_complete_and_eligible_sources_only',
      discovered: 0,
      metric_ready: 0,
      included_sources: [],
      provisional_discovered: 0,
      excluded_discovered: 250,
    })
    expect(report.source_evidence).toHaveLength(5)
    for (const evidence of report.source_evidence) {
      expect(evidence.coverage_denominator).toBe('excluded')
      expect(evidence.observed_unique_addresses).toBe(50)
      expect(evidence.score_window_unique_addresses).toBe(25)
      expect(evidence.windows.map((window) => window.window)).toEqual(['1D', '7D', '30D', '90D'])
      expect(evidence.windows.every((window) => window.truncation_detected)).toBe(true)
    }
    expect(
      report.snapshot.identities.filter((identity) => identity.timeframes[0] === 1)
    ).toHaveLength(125)
    expect(
      report.snapshot.identities
        .filter((identity) => identity.timeframes[0] === 1)
        .every((identity) => identity.metric_ready === false)
    ).toBe(true)
    expect(report.snapshot.identities.every((identity) => identity.rank_eligible === false)).toBe(
      true
    )
  })
})
