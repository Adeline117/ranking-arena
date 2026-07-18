import {
  buildCompareApiUrl,
  buildCompareUrl,
  compareAccountKey,
  isSameCompareAccount,
  parseCompareAccounts,
  parseUnifiedSearchTraderId,
} from '../identity'

describe('compare composite identity', () => {
  const bybit = { id: 'shared:id', source: 'bybit' }
  const binance = { id: 'shared:id', source: 'binance_futures' }

  it('keeps equal raw IDs on different platforms distinct', () => {
    expect(compareAccountKey(bybit)).not.toBe(compareAccountKey(binance))
    expect(isSameCompareAccount(bybit, binance)).toBe(false)
    expect(isSameCompareAccount(bybit, { ...bybit })).toBe(true)
  })

  it('builds paired page and API query parameters in the same order', () => {
    const accounts = [
      { id: 'wallet one', source: 'bybit' },
      { id: 'wallet:two', source: 'binance_futures' },
    ]

    expect(buildCompareUrl(accounts)).toBe(
      '/compare?ids=wallet%20one%2Cwallet%3Atwo&platforms=bybit%2Cbinance_futures'
    )
    expect(buildCompareApiUrl(accounts, { includeEquity: true })).toBe(
      '/api/compare?ids=wallet%20one%2Cwallet%3Atwo&platforms=bybit%2Cbinance_futures&include_equity=1'
    )
  })

  it('parses paired params and rejects incomplete or ambiguous input', () => {
    expect(parseCompareAccounts('same,same', 'bybit,binance_futures')).toEqual({
      ok: true,
      accounts: [
        { id: 'same', source: 'bybit' },
        { id: 'same', source: 'binance_futures' },
      ],
    })
    expect(parseCompareAccounts('one,two', null)).toEqual({
      ok: false,
      error: 'missing_platforms',
    })
    expect(parseCompareAccounts('one,two', 'bybit')).toEqual({
      ok: false,
      error: 'length_mismatch',
    })
    expect(parseCompareAccounts('one,one', 'bybit,bybit')).toEqual({
      ok: false,
      error: 'duplicate_account',
    })
  })

  it('splits unified search identity at only the first colon', () => {
    expect(parseUnifiedSearchTraderId('hyperliquid:0xabc:subaccount')).toEqual({
      source: 'hyperliquid',
      id: '0xabc:subaccount',
    })
    expect(parseUnifiedSearchTraderId('missing-platform')).toBeNull()
  })
})
