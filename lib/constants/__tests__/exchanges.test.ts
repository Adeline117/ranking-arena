import { EXCHANGE_CONFIG, PRIORITY_SOURCES, SOURCES_WITH_DATA } from '../exchanges'
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
})
