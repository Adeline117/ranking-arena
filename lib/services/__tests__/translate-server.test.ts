import { fixCryptoTerms } from '../translate-server'

describe('fixCryptoTerms', () => {
  it('normalizes zh crypto jargon to Arena canonical terms', () => {
    // hits the zh branch + several replacements
    expect(fixCryptoTerms('这是一份期货合同', 'zh')).toContain('合约')
    expect(fixCryptoTerms('该货币上涨', 'zh')).toContain('代币')
    expect(fixCryptoTerms('最大跌幅很大', 'zh')).toContain('最大回撤')
    expect(fixCryptoTerms('持仓被清算', 'zh')).toContain('爆仓')
  })

  it('returns a string for every supported target language (each branch)', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
      expect(typeof fixCryptoTerms('bitcoin and ethereum roundup', lang)).toBe('string')
    }
  })

  it('leaves text without jargon unchanged', () => {
    const plain = 'A perfectly ordinary sentence.'
    expect(fixCryptoTerms(plain, 'en')).toBe(plain)
  })

  it('is idempotent on already-canonical zh terms', () => {
    const canonical = '合约 多仓 爆仓 盈亏'
    // running twice should not further mangle already-fixed terms
    expect(fixCryptoTerms(fixCryptoTerms(canonical, 'zh'), 'zh')).toContain('合约')
  })
})
