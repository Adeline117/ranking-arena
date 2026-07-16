import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '../wallet-identity'

describe('wallet identity rules', () => {
  const solanaA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const solanaB = '7XKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'

  it('preserves Solana Base58 case and rejects a lowercase collision', () => {
    expect(canonicalizeWalletIdentity(solanaA, 'drift')).toBe(solanaA)
    expect(canonicalizeWalletIdentity(solanaB, 'drift')).toBe(solanaB)
    expect(walletIdentitiesMatch(solanaA, solanaB, 'drift')).toBe(false)
  })

  it('uses one lowercase EVM database identity', () => {
    expect(canonicalizeWalletIdentity(checksumEvm, 'hyperliquid')).toBe(checksumEvm.toLowerCase())
    expect(walletIdentitiesMatch(checksumEvm, checksumEvm.toLowerCase(), 'hyperliquid')).toBe(true)
  })

  it('fails closed outside wallet-owned DEX platforms', () => {
    expect(() => canonicalizeWalletIdentity('12345', 'binance_futures')).toThrow(
      'does not use wallet identities'
    )
    expect(walletIdentitiesMatch('12345', '12345', 'binance_futures')).toBe(false)
  })
})
