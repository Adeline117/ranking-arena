import { walletMatchesTrader } from '../types'

describe('claim wallet identity feedback', () => {
  const solanaTrader = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const caseCollidingSolanaWallet = '7XKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'

  it('requires exact Solana Base58 case', () => {
    expect(walletMatchesTrader(solanaTrader, solanaTrader, 'drift')).toBe(true)
    expect(walletMatchesTrader(caseCollidingSolanaWallet, solanaTrader, 'drift')).toBe(false)
  })

  it('accepts EVM checksum case while comparing one canonical identity', () => {
    expect(walletMatchesTrader(checksumEvm, checksumEvm.toLowerCase(), 'hyperliquid')).toBe(true)
  })

  it('fails closed for a non-wallet source', () => {
    expect(walletMatchesTrader('12345', '12345', 'binance_futures')).toBe(false)
  })
})
