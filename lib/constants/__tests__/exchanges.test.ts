import {
  ALL_SOURCES,
  EXCHANGE_CONFIG,
  PRIORITY_SOURCES,
  SOURCES_WITH_DATA,
  validateExchangeConfig,
} from '../exchanges'
import { RETIRED_SOURCES } from '../retired-sources'

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
})
