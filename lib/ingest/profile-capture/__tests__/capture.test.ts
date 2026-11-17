import type { ParsedProfile, ParsedStats, RawPage } from '../../core/types'
import {
  buildProfileAcquisition,
  lastStatsBlock,
  type BuildProfileAcquisitionInput,
} from '../capture'
import {
  assertProfileCaptureContract,
  getProfileCaptureContract,
  profileCaptureContractSha256,
  PROFILE_CAPTURE_CONTRACT_DOCUMENT,
  type ProfileCaptureContract,
} from '../contract'
import { expectProfileContractAttests, runProfileContractFixture } from '../test-helper'

const CONTRACT: ProfileCaptureContract = {
  document: PROFILE_CAPTURE_CONTRACT_DOCUMENT,
  captureContract: 'alpha_futures-profile-capture@1',
  sourceSlug: 'alpha_futures',
  timeframes: [30, 90],
  endpoints: [
    {
      id: 'detail',
      origin: 'https://api.alpha.example',
      pathname: '/v1/trader/detail',
      queryAllowlist: ['uid', 'range'],
      required: true,
    },
    {
      id: 'risk',
      origin: 'https://api.alpha.example',
      pathname: '/v1/trader/risk',
      queryAllowlist: ['uid', 'range'],
      required: true,
    },
  ],
  metrics: {
    pnl: { endpoint: 'detail', path: ['data', 'pnl'], transform: 'identity' },
    win_rate: { endpoint: 'detail', path: ['data', 'winRate'], transform: 'fraction_to_percent' },
    mdd: {
      endpoint: 'risk',
      path: ['data', 'items', 0, 'mdd'],
      transform: 'abs_fraction_to_percent',
    },
    total_positions: { endpoint: 'risk', path: ['data', 'trades'], transform: 'identity' },
  },
}

function stats(overrides: Partial<ParsedStats> = {}): ParsedStats {
  return {
    timeframe: 90,
    asOf: '2026-01-01T00:00:00.000Z',
    roi: 12,
    pnl: 1500.5,
    sharpe: null,
    mdd: 23.5,
    winRate: 61,
    winPositions: null,
    totalPositions: 40,
    copierPnl: null,
    copierCount: null,
    aum: null,
    volume: null,
    profitShareRate: null,
    holdingDurationAvgHours: null,
    tradingPreferences: null,
    extras: {},
    ...overrides,
  }
}

function pages(
  detail: Record<string, unknown> = { pnl: '1500.5', winRate: 0.61 },
  risk: Record<string, unknown> = { items: [{ mdd: -0.235 }], trades: 40 },
  query = 'uid=T1&range=90&_=1700000000'
): RawPage[] {
  return [
    {
      pageIndex: 0,
      url: `https://api.alpha.example/v1/trader/detail?${query}`,
      payload: { code: 0, data: detail },
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      pageIndex: 1,
      url: `https://api.alpha.example/v1/trader/risk?${query}`,
      payload: { code: 0, data: risk },
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
}

function build(overrides: Partial<BuildProfileAcquisitionInput> = {}) {
  const parsed = stats()
  return buildProfileAcquisition({
    contract: CONTRACT,
    contractSha256: profileCaptureContractSha256(CONTRACT),
    attemptId: '00000000-0000-4000-8000-0000000000aa',
    exchangeTraderId: 'T1',
    timeframe: 90,
    pages: pages(),
    parsed,
    stored: parsed,
    ...overrides,
  })
}

describe('profile capture contract', () => {
  it('pins the contract document by a stable hash that changes with any edit', () => {
    const sha = profileCaptureContractSha256(CONTRACT)
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(profileCaptureContractSha256({ ...CONTRACT })).toBe(sha)
    expect(
      profileCaptureContractSha256({
        ...CONTRACT,
        metrics: {
          ...CONTRACT.metrics,
          pnl: { endpoint: 'detail', path: ['data', 'totalPnl'], transform: 'identity' },
        },
      })
    ).not.toBe(sha)
  })

  it.each([
    ['a name of another source', { captureContract: 'beta_futures-profile-capture@1' }],
    [
      'an undeclared timeframe',
      { timeframes: [7, 14] as unknown as ProfileCaptureContract['timeframes'] },
    ],
    [
      'a metric from an optional endpoint',
      {
        endpoints: CONTRACT.endpoints.map((endpoint) => ({
          ...endpoint,
          required: endpoint.id === 'detail',
        })),
      },
    ],
    [
      'a duplicated route',
      { endpoints: [CONTRACT.endpoints[0], { ...CONTRACT.endpoints[0], id: 'again' }] },
    ],
    [
      'a non-https origin',
      {
        endpoints: CONTRACT.endpoints.map((endpoint) => ({
          ...endpoint,
          origin: 'http://api.alpha.example',
        })),
      },
    ],
    [
      'a non-attestable metric',
      { metrics: { aum: { endpoint: 'detail', path: ['x'], transform: 'identity' } } },
    ],
    [
      'a per-timeframe key missing a contracted window',
      {
        metrics: {
          pnl: {
            endpoint: 'detail',
            path: ['data', { byTimeframe: { '90': 'pnl90' } }],
            transform: 'identity',
          },
        },
      },
    ],
    [
      'a per-timeframe key for an unknown window',
      {
        metrics: {
          pnl: {
            endpoint: 'detail',
            path: ['data', { byTimeframe: { '30': 'pnl30', '90': 'pnl90', '180': 'x' } }],
            transform: 'identity',
          },
        },
      },
    ],
  ])('rejects %s', (_label, change) => {
    expect(() =>
      assertProfileCaptureContract({ ...CONTRACT, ...change } as ProfileCaptureContract)
    ).toThrow(TypeError)
  })

  it('declares no source until a reviewed contract is added', () => {
    expect(getProfileCaptureContract('binance_futures')).toBeNull()
    expect(getProfileCaptureContract('alpha_futures', new Map([['alpha_futures', CONTRACT]]))).toBe(
      CONTRACT
    )
    expect(() => getProfileCaptureContract('beta', new Map([['beta', CONTRACT]]))).toThrow(
      'holds another source'
    )
  })
})

describe('buildProfileAcquisition', () => {
  it('proves a complete capture and attests every declared metric the parser read from RAW', () => {
    const result = build()
    expect(result.terminalState).toBe('complete')
    if (result.terminalState !== 'complete') return
    expect(result.attestedMetrics).toEqual(['mdd', 'pnl', 'total_positions', 'win_rate'])
    expect(result.manifest.metrics.mdd).toEqual({
      endpoint: 'risk',
      path: ['data', 'items', 0, 'mdd'],
      raw_value: -0.235,
      value: 23.5,
    })
    expect(result.manifest.metrics.pnl?.raw_value).toBe('1500.5')
    expect(result.manifest.requests.map((request) => request.endpoint)).toEqual(['detail', 'risk'])
    expect(result.sourceRunId).toMatch(/^[0-9a-f]{64}$/)
    expect(build().sourceRunId).toBe(result.sourceRunId)
  })

  it('binds the request projection to identity parameters only', () => {
    const base = build()
    const cacheBusted = build({ pages: pages(undefined, undefined, 'range=90&uid=T1&_=9') })
    const otherTrader = build({ pages: pages(undefined, undefined, 'uid=T2&range=90') })
    if (
      base.terminalState !== 'complete' ||
      cacheBusted.terminalState !== 'complete' ||
      otherTrader.terminalState !== 'complete'
    ) {
      throw new Error('expected complete captures')
    }
    expect(cacheBusted.manifest.requests).toEqual(base.manifest.requests)
    expect(otherTrader.manifest.requests[0].request_projection_sha256).not.toBe(
      base.manifest.requests[0].request_projection_sha256
    )
    // The response hash binds the payload: a different answer is a different run.
    const otherAnswer = build({ pages: pages({ pnl: '1500.5', winRate: 0.61, extra: 1 }) })
    if (otherAnswer.terminalState !== 'complete') throw new Error('expected complete')
    expect(otherAnswer.sourceRunId).not.toBe(base.sourceRunId)
  })

  it('leaves an honest parser NULL and a validation-clamped value unattested', () => {
    const parsed = stats({ winRate: null, mdd: 150 })
    const result = build({
      pages: pages({ pnl: 1500.5, winRate: null }, { items: [{ mdd: 1.5 }], trades: 40 }),
      parsed,
      stored: { ...parsed, mdd: null },
    })
    expect(result.terminalState).toBe('complete')
    expect(result.attestedMetrics).toEqual(['pnl', 'total_positions'])
  })

  it.each([
    [
      'a parser value the declared field does not supply',
      { pages: pages({ pnl: 1499, winRate: 0.61 }) },
      'processing_failed',
      'projection_mismatch',
    ],
    [
      'a parser value whose declared field is absent',
      { pages: pages({ winRate: 0.61 }) },
      'processing_failed',
      'projection_mismatch',
    ],
    ['a missing required endpoint', { pages: pages().slice(0, 1) }, 'partial', 'endpoint_missing'],
    [
      'a page from an undeclared endpoint',
      {
        pages: [
          ...pages(),
          { pageIndex: 2, url: 'https://api.alpha.example/v1/other', payload: {}, fetchedAt: '' },
        ],
      },
      'processing_failed',
      'undeclared_endpoint',
    ],
    [
      'a second page of one endpoint',
      { pages: [...pages(), pages()[0]] },
      'processing_failed',
      'duplicate_endpoint_page',
    ],
    [
      'no block for the attempt timeframe',
      { parsed: stats({ timeframe: 30 }) },
      'processing_failed',
      'stats_block_missing',
    ],
  ])('refuses %s', (_label, change, state, reason) => {
    const result = build(change as Partial<BuildProfileAcquisitionInput>)
    expect(result.terminalState).toBe(state)
    expect(result.reasonCode).toBe(reason)
    expect(result.attestedMetrics).toEqual([])
    expect(result.manifest).toBeNull()
  })

  it('refuses a timeframe the contract does not cover', () => {
    expect(() => build({ timeframe: 7 })).toThrow('does not cover 7d')
  })
})

describe('lastStatsBlock', () => {
  it('selects the block the writer stores last for the timeframe', () => {
    const first = stats({ pnl: 1 })
    const last = stats({ pnl: 2 })
    expect(
      lastStatsBlock([{ stats: [first] }, { stats: [stats({ timeframe: 30 }), last] }], 90)
    ).toEqual({
      profileIndex: 1,
      block: last,
    })
    expect(lastStatsBlock([{ stats: [first] }], 7)).toBeNull()
  })
})

describe('test helper', () => {
  const parseProfile = (payload: unknown): ParsedProfile => {
    const data = (payload as { data: Record<string, unknown> }).data
    const block =
      'pnl' in data
        ? stats({
            pnl: Number(data.pnl),
            winRate: Number(data.winRate) * 100,
            mdd: null,
            totalPositions: null,
          })
        : stats({
            pnl: null,
            winRate: null,
            mdd: Math.abs(Number((data.items as Array<{ mdd: number }>)[0].mdd)) * 100,
            totalPositions: Number(data.trades),
          })
    return { stats: [block], series: [], nickname: null, avatarUrlOrigin: null }
  }

  it('runs a source parser over recorded pages like the worker does', () => {
    // Each page's block replaces the row: only the last page's values survive,
    // so a two-endpoint source must merge them in its parser to attest both.
    const result = runProfileContractFixture({
      contract: CONTRACT,
      timeframe: 90,
      pages: pages(),
      parseProfile,
    })
    expect(result.terminalState).toBe('complete')
    expect(result.attestedMetrics).toEqual(['mdd', 'total_positions'])
  })

  it('throws with the typed outcome when a declared contract is not met', () => {
    expect(() =>
      expectProfileContractAttests({
        contract: CONTRACT,
        timeframe: 90,
        pages: pages(),
        parseProfile,
        metrics: ['mdd', 'pnl', 'total_positions', 'win_rate'],
      })
    ).toThrow('attests [mdd,total_positions], expected [mdd,pnl,total_positions,win_rate]')
    expect(() =>
      expectProfileContractAttests({
        contract: CONTRACT,
        timeframe: 90,
        pages: pages().slice(1),
        parseProfile,
        metrics: ['mdd'],
      })
    ).toThrow('partial/endpoint_missing')
  })
})
