import { getCopyTradeUrl, getDexUrl } from '../copy-trade'

describe('getCopyTradeUrl（CEX）', () => {
  it('source 缺失 → null', () => {
    expect(getCopyTradeUrl(undefined, 't1')).toBeNull()
    expect(getCopyTradeUrl('', 't1')).toBeNull()
  })

  it('已知交易所 → 正确 URL 且嵌入 traderId', () => {
    expect(getCopyTradeUrl('binance_futures', 'ABC')).toBe(
      'https://www.binance.com/en/copy-trading/lead-details/ABC?type=um'
    )
    expect(getCopyTradeUrl('bybit', 'XYZ')).toContain('leaderMark=XYZ')
    expect(getCopyTradeUrl('okx', '123')).toBe('https://www.okx.com/copy-trading/trader/123')
  })

  it('大小写不敏感（内部 toLowerCase）', () => {
    expect(getCopyTradeUrl('BINANCE_FUTURES', 'ABC')).toBe(
      getCopyTradeUrl('binance_futures', 'ABC')
    )
    expect(getCopyTradeUrl('Bybit', 'X')).toBe(getCopyTradeUrl('bybit', 'X'))
  })

  it('etoro 用 traderHandle 优先，缺失时回退 traderId', () => {
    expect(getCopyTradeUrl('etoro', 'id1', 'coolTrader')).toBe(
      'https://www.etoro.com/people/coolTrader/portfolio'
    )
    expect(getCopyTradeUrl('etoro', 'id1')).toBe('https://www.etoro.com/people/id1/portfolio')
  })

  it('未知交易所 → null', () => {
    expect(getCopyTradeUrl('nonexistent_exchange', 't1')).toBeNull()
  })

  it('DEX 源传给 CEX 函数 → null（不混淆）', () => {
    expect(getCopyTradeUrl('hyperliquid', 't1')).toBeNull()
  })
})

describe('getDexUrl', () => {
  it('source 缺失 → null', () => {
    expect(getDexUrl(undefined, 'addr')).toBeNull()
  })

  it('已知 DEX → 正确 URL 且嵌入地址', () => {
    expect(getDexUrl('hyperliquid', '0xabc')).toBe(
      'https://app.hyperliquid.xyz/explorer/address/0xabc'
    )
    expect(getDexUrl('gmx', '0x1')).toContain('0x1')
  })

  it('大小写不敏感', () => {
    expect(getDexUrl('HYPERLIQUID', '0xA')).toBe(getDexUrl('hyperliquid', '0xA'))
  })

  it('CEX 源传给 DEX 函数 → null', () => {
    expect(getDexUrl('binance', 't1')).toBeNull()
  })

  it('未知 → null', () => {
    expect(getDexUrl('unknown_dex', 'a')).toBeNull()
  })
})
