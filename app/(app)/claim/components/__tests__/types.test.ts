import { DEX_PLATFORMS, isDex, walletMatchesTrader } from '../types'

describe('claim wallet identity feedback', () => {
  const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'

  it('accepts EVM checksum case while comparing one canonical identity', () => {
    expect(walletMatchesTrader(checksumEvm, checksumEvm.toLowerCase(), 'hyperliquid')).toBe(true)
  })

  it('fails closed for a non-wallet source', () => {
    expect(walletMatchesTrader('12345', '12345', 'binance_futures')).toBe(false)
  })

  it('exposes only wallet sources that the signature service supports', () => {
    expect(DEX_PLATFORMS).toEqual(['hyperliquid', 'gmx'])
    expect(isDex('kwenta')).toBe(false)
    expect(isDex('vertex')).toBe(false)
    expect(isDex('drift')).toBe(false)
  })
})
