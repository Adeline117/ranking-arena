import {
  DEX_CENSUS_SOURCES,
  assertDexCensusSources,
  buildDexCensusSnapshot,
  canonicalDexIdentity,
  canonicalJson,
  canonicalSha256,
  mergeDexCensusObservations,
} from '../lib/dex-census'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('DEX census contract', () => {
  it('keeps complete, provisional, and bounded universes distinct', () => {
    expect(() => assertDexCensusSources()).not.toThrow()
    expect(DEX_CENSUS_SOURCES).toHaveLength(10)

    const hyperliquid = DEX_CENSUS_SOURCES.filter((source) => source.protocol === 'hyperliquid')
    const gmx = DEX_CENSUS_SOURCES.filter((source) => source.protocol === 'gmx')
    const gtrade = DEX_CENSUS_SOURCES.filter((source) => source.protocol === 'gtrade')

    expect(hyperliquid).toHaveLength(1)
    expect(hyperliquid[0]).toMatchObject({
      scope: 'full_public_file',
      universe_complete: true,
      coverage_denominator: 'eligible',
    })
    expect(gmx).toHaveLength(4)
    expect(gmx.every((source) => source.coverage_denominator === 'provisional')).toBe(true)
    expect(gmx.every((source) => source.universe_complete === false)).toBe(true)
    expect(gtrade).toHaveLength(5)
    expect(gtrade.every((source) => source.scope === 'public_top25_board')).toBe(true)
    expect(gtrade.every((source) => source.coverage_denominator === 'excluded')).toBe(true)
  })

  it('rejects a bounded board entering the complete-universe denominator', () => {
    const bounded = DEX_CENSUS_SOURCES.find((source) => source.protocol === 'gtrade')!
    expect(() =>
      assertDexCensusSources([{ ...bounded, coverage_denominator: 'eligible' }])
    ).toThrow('bounded sample cannot enter coverage denominator')
  })

  it('normalizes case without merging the same address across chains or protocols', () => {
    expect(canonicalDexIdentity('gmx', 42161, A.toUpperCase().replace('0X', '0x'))).toEqual({
      identity: `gmx:42161:${A}`,
      address: A,
    })

    const identities = mergeDexCensusObservations([
      { protocol: 'gmx', chainId: 42161, address: A, timeframe: 7, metricReady: true },
      { protocol: 'gmx', chainId: 43114, address: A, timeframe: 7, metricReady: true },
      { protocol: 'gtrade', chainId: 42161, address: A, timeframe: 7, metricReady: true },
    ])
    expect(identities.map((row) => row.identity)).toEqual([
      `gmx:42161:${A}`,
      `gmx:43114:${A}`,
      `gtrade:42161:${A}`,
    ])
  })

  it('merges windows, promotes metric readiness, and never promotes ranking', () => {
    const identities = mergeDexCensusObservations([
      { protocol: 'gmx', chainId: 42161, address: A, timeframe: 90, metricReady: false },
      { protocol: 'gmx', chainId: 42161, address: A, timeframe: 7, metricReady: true },
      { protocol: 'gmx', chainId: 42161, address: A, timeframe: 30, metricReady: false },
    ])
    expect(identities).toEqual([
      {
        identity: `gmx:42161:${A}`,
        protocol: 'gmx',
        chain_id: 42161,
        address: A,
        timeframes: [7, 30, 90],
        metric_ready: true,
        rank_eligible: false,
      },
    ])
    expect(() =>
      mergeDexCensusObservations([
        {
          protocol: 'gmx',
          chainId: 42161,
          address: A,
          timeframe: 7,
          metricReady: true,
          rankEligible: true,
        },
      ])
    ).toThrow('shadow-only')
  })

  it.each(['0x1234', 'not-an-address', `0x${'g'.repeat(40)}`])(
    'rejects invalid identity %s',
    (address) => {
      expect(() => canonicalDexIdentity('gmx', 42161, address)).toThrow('invalid DEX address')
    }
  )

  it('rejects an otherwise valid address on an unlisted protocol-chain pair', () => {
    expect(() => canonicalDexIdentity('hyperliquid', 42161, A)).toThrow('unsupported DEX source')
  })

  it('produces the same canonical snapshot and hash for shuffled observations', () => {
    const generatedAt = '2026-07-16T12:00:00.000Z'
    const observations = [
      {
        protocol: 'gtrade' as const,
        chainId: 8453,
        address: B,
        timeframe: 30 as const,
        metricReady: true,
      },
      {
        protocol: 'gmx' as const,
        chainId: 42161,
        address: A,
        timeframe: 7 as const,
        metricReady: false,
      },
      {
        protocol: 'gmx' as const,
        chainId: 42161,
        address: A,
        timeframe: 30 as const,
        metricReady: true,
      },
    ]
    const left = buildDexCensusSnapshot({ generatedAt, observations })
    const right = buildDexCensusSnapshot({ generatedAt, observations: [...observations].reverse() })

    expect(canonicalJson(left.snapshot)).toBe(canonicalJson(right.snapshot))
    expect(left.sha256).toBe(right.sha256)
    expect(left.snapshot.stages).toMatchObject({
      discovered: 2,
      metric_ready: 2,
      rank_eligible: 0,
    })
  })

  it('sorts object keys, rejects non-JSON values, and hashes content changes', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe('{"a":{"b":1,"d":2},"z":1}')
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow('non-finite')
    expect(() => canonicalJson({ bad: undefined })).toThrow('rejects undefined')
    expect(canonicalSha256({ value: 1 })).not.toBe(canonicalSha256({ value: 2 }))
  })
})
