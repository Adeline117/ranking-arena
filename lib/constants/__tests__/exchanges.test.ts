import {
  ALL_SOURCES,
  EXCHANGE_CONFIG,
  EXCHANGE_SLUG_ALIASES,
  PRIORITY_SOURCES,
  PUBLIC_ACTIVE_RANKING_SOURCES,
  SOURCE_TYPE_MAP,
  SOURCES_WITH_DATA,
  parsePublicActiveRankingSource,
  validateExchangeConfig,
} from '../exchanges'
import { RETIRED_SOURCES } from '../retired-sources'
import { GRANULAR_PLATFORMS, PLATFORM_CATEGORY } from '../../types/leaderboard'

describe('exchange lifecycle boundaries', () => {
  it.each([
    ['PRIORITY_SOURCES', PRIORITY_SOURCES],
    ['SOURCES_WITH_DATA', SOURCES_WITH_DATA],
  ] as const)('%s excludes every retired source', (_name, sources) => {
    expect(sources.filter((source) => RETIRED_SOURCES.has(source))).toEqual([])
  })

  it('retains archived exchange config for retired rows', () => {
    for (const source of RETIRED_SOURCES) {
      expect(EXCHANGE_CONFIG).toHaveProperty(source)
    }
  })

  it.each([
    ['okx_web3', 'okx_web3_solana'],
    ['toobit', 'toobit_futures'],
  ])('does not retire canonical source %s replacement %s', (retired, canonical) => {
    expect(RETIRED_SOURCES.has(retired)).toBe(true)
    expect(RETIRED_SOURCES.has(canonical)).toBe(false)
  })

  it.each([
    ['bitget_bots_futures', 'futures'],
    ['bitget_bots_spot', 'spot'],
    ['blofin_spot', 'spot'],
    ['bybit_mt5', 'futures'],
    ['gate_cfd', 'futures'],
    ['okx_web3_solana', 'web3'],
    ['toobit_futures', 'futures'],
    ['xt_spot', 'spot'],
  ] as const)('keeps active arena source %s rankable as %s', (source, sourceType) => {
    expect(ALL_SOURCES).toContain(source)
    expect(SOURCES_WITH_DATA).toContain(source)
    expect(EXCHANGE_CONFIG[source]).toMatchObject({ sourceType })
  })

  it('keeps the active source lists backed by exchange metadata', () => {
    expect(SOURCES_WITH_DATA.filter((source) => !ALL_SOURCES.includes(source))).toEqual([])
    expect(validateExchangeConfig()).toEqual([])
  })

  it('keeps every queryable source represented and correctly classified', () => {
    const granular = new Set<string>(GRANULAR_PLATFORMS)
    const expectedCategory = {
      futures: 'futures',
      spot: 'spot',
      web3: 'onchain',
    } as const

    expect(ALL_SOURCES.filter((source) => !granular.has(source))).toEqual([])
    for (const source of ALL_SOURCES) {
      expect(PLATFORM_CATEGORY[source]).toBe(expectedCategory[SOURCE_TYPE_MAP[source]])
    }
  })

  it('keeps the public ranking input boundary canonical, active, and alias-free', () => {
    expect(PUBLIC_ACTIVE_RANKING_SOURCES).toEqual(ALL_SOURCES)
    expect(PUBLIC_ACTIVE_RANKING_SOURCES.filter((source) => RETIRED_SOURCES.has(source))).toEqual(
      []
    )

    for (const source of PUBLIC_ACTIVE_RANKING_SOURCES) {
      expect(parsePublicActiveRankingSource(source)).toBe(source)
    }
    for (const source of RETIRED_SOURCES) {
      expect(parsePublicActiveRankingSource(source)).toBeNull()
    }
    for (const alias of Object.keys(EXCHANGE_SLUG_ALIASES)) {
      expect(parsePublicActiveRankingSource(alias)).toBeNull()
    }

    expect(parsePublicActiveRankingSource(' OKX_FUTURES ')).toBeNull()
    expect(parsePublicActiveRankingSource('OKX_FUTURES')).toBeNull()
    expect(parsePublicActiveRankingSource(null)).toBeNull()
  })
})
