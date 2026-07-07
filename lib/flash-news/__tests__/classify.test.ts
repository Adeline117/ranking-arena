import { classifyCategory, isNonCrypto } from '../classify'

describe('classifyCategory', () => {
  it('routes exchange news (listing / reserves) to exchange', () => {
    expect(classifyCategory('Binance lists new SOL perpetual, adds USDC pairs', '', 'defi')).toBe(
      'exchange'
    )
    expect(classifyCategory('Coinbase publishes proof-of-reserves report', '', 'defi')).toBe(
      'exchange'
    )
  })

  it('routes macro / regulation news to macro', () => {
    expect(classifyCategory('Fed holds rates steady as inflation cools', '', 'defi')).toBe('macro')
    expect(classifyCategory('SEC drops lawsuit against a crypto firm', '', 'btc_eth')).toBe('macro')
  })

  it('routes DeFi protocol news to defi even when it mentions Ethereum', () => {
    // word-boundary matching: "eth"/"ether" must NOT fire inside "ethereum" and
    // let btc_eth outrank defi for an Aave/Uniswap-on-Ethereum headline.
    expect(classifyCategory('Aave v4 TVL crosses $20B on Ethereum', '', 'crypto' as never)).toBe(
      'defi'
    )
    expect(
      classifyCategory('Uniswap governance approves fee switch on Ethereum', '', 'btc_eth')
    ).toBe('defi')
  })

  it('routes genuine BTC/ETH news to btc_eth', () => {
    expect(classifyCategory('Bitcoin ETF sees record $1.2B inflow', '', 'defi')).toBe('btc_eth')
    expect(classifyCategory('Ethereum core devs set Pectra upgrade date', '', 'defi')).toBe(
      'btc_eth'
    )
  })

  it('routes altcoin news to altcoin', () => {
    expect(classifyCategory('Dogecoin whale moves 500M DOGE', '', 'defi')).toBe('altcoin')
  })

  it('falls back to the source category when no keyword matches', () => {
    expect(classifyCategory('An entirely unremarkable sentence', '', 'macro')).toBe('macro')
    expect(classifyCategory('', null, 'defi')).toBe('defi')
  })

  it('considers content, not just title', () => {
    expect(
      classifyCategory('Weekly roundup', 'Binance announced a new token listing today', 'defi')
    ).toBe('exchange')
  })

  it('exercises the CJK substring path without throwing and returns a valid category', () => {
    const valid = ['btc_eth', 'altcoin', 'defi', 'macro', 'exchange']
    expect(valid).toContain(classifyCategory('监管机构就加密资产发布新规定', '', 'defi'))
  })

  it('handles keywords with regex-special characters without throwing', () => {
    expect(() =>
      classifyCategory('c++ dev joins a DeFi team on Ethereum', '', 'defi')
    ).not.toThrow()
  })
})

describe('isNonCrypto', () => {
  it('keeps anything with a core crypto term', () => {
    expect(isNonCrypto('Bitcoin rallies past $100k', null)).toBe(false)
    expect(isNonCrypto('Uniswap TVL hits new high', null)).toBe(false)
    // crypto-adjacent concepts are kept
    expect(isNonCrypto('Polymarket volume surges', null)).toBe(false)
    expect(isNonCrypto('ECB targets 2027 digital euro pilot', null)).toBe(false)
  })

  it('drops obvious non-crypto items (no crypto term + off-topic marker)', () => {
    expect(isNonCrypto('Najaf prepares for the funeral of a late leader', null)).toBe(true)
    expect(isNonCrypto('Spain vs Belgium in the World Cup semi-final', null)).toBe(true)
    expect(isNonCrypto('Oscars ban AI performances from eligibility', null)).toBe(true)
  })

  it('does NOT drop a marker-less non-crypto item (conservative — no false deletes)', () => {
    // no crypto term but also no off-topic marker → kept (avoids nuking real news)
    expect(isNonCrypto('Some ambiguous geopolitics headline about a ship', null)).toBe(false)
  })

  it('uses content as well as title', () => {
    expect(isNonCrypto('Roundup', 'A story about the FIFA World Cup final')).toBe(true)
    expect(isNonCrypto('Roundup', 'A story mentioning bitcoin briefly')).toBe(false)
  })

  it('handles CJK terms (keeps 加密/币, drops 世界杯)', () => {
    expect(isNonCrypto('比特币价格突破新高', null)).toBe(false) // 币 is a core crypto term
    expect(isNonCrypto('世界杯决赛今晚开打', null)).toBe(true) // 世界杯 marker, no crypto term
  })
})
