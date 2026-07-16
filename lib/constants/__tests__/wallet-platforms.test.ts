import {
  EVM_WALLET_PLATFORMS,
  SOLANA_WALLET_PLATFORMS,
  isDexWalletPlatform,
  isSolanaPlatform,
} from '../wallet-platforms'

describe('wallet claim platform contract', () => {
  it('recognizes every supported EVM and Solana source case-insensitively', () => {
    for (const platform of EVM_WALLET_PLATFORMS) {
      expect(isDexWalletPlatform(platform.toUpperCase())).toBe(true)
      expect(isSolanaPlatform(platform)).toBe(false)
    }
    for (const platform of SOLANA_WALLET_PLATFORMS) {
      expect(isDexWalletPlatform(platform.toUpperCase())).toBe(true)
      expect(isSolanaPlatform(platform.toUpperCase())).toBe(true)
    }
  })

  it.each(['kwenta', 'vertex', 'binance_futures', 'gmx_arbitrum'])(
    'fails closed for unsupported or retired source %s',
    (platform) => {
      expect(isDexWalletPlatform(platform)).toBe(false)
    }
  )
})
