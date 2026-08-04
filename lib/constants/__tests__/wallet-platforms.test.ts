import { EVM_WALLET_PLATFORMS, isDexWalletPlatform } from '../wallet-platforms'

describe('wallet claim platform contract', () => {
  it('recognizes every supported EVM source case-insensitively', () => {
    for (const platform of EVM_WALLET_PLATFORMS) {
      expect(isDexWalletPlatform(platform.toUpperCase())).toBe(true)
    }
  })

  it.each([
    'gains',
    'aevo',
    'dydx',
    'jupiter_perps',
    'drift',
    'kwenta',
    'vertex',
    'binance_futures',
    'gmx_arbitrum',
  ])('fails closed for unsupported or retired source %s', (platform) => {
    expect(isDexWalletPlatform(platform)).toBe(false)
  })
})
