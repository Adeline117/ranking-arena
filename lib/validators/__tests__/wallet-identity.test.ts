import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '../wallet-identity'

describe('wallet identity rules', () => {
  const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'

  it('uses one lowercase EVM database identity', () => {
    expect(canonicalizeWalletIdentity(checksumEvm, 'hyperliquid')).toBe(checksumEvm.toLowerCase())
    expect(walletIdentitiesMatch(checksumEvm, checksumEvm.toLowerCase(), 'hyperliquid')).toBe(true)
  })

  it('rejects malformed identities before issuing or consuming a challenge', () => {
    expect(() => canonicalizeWalletIdentity('0x1234', 'hyperliquid')).toThrow(
      '20-byte hexadecimal address'
    )
    expect(walletIdentitiesMatch('0x1234', '0x1234', 'hyperliquid')).toBe(false)
  })

  it('fails closed outside the V1 wallet-claim platform matrix', () => {
    expect(() => canonicalizeWalletIdentity('12345', 'binance_futures')).toThrow(
      'does not use wallet identities'
    )
    expect(walletIdentitiesMatch('12345', '12345', 'binance_futures')).toBe(false)
    expect(() =>
      canonicalizeWalletIdentity('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'drift')
    ).toThrow('does not use wallet identities')
  })
})
