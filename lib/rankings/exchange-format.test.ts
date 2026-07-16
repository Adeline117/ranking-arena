import {
  formatExchangeMoney,
  formatExchangePercent,
  formatExchangeTraderCount,
} from './exchange-format'

describe('exchange ranking display formatting', () => {
  it('keeps percentages independent from the browser locale', () => {
    expect(formatExchangePercent(9396.99, true)).toBe('+9,397%')
    expect(formatExchangePercent(-12.34, true)).toBe('-12.3%')
    expect(formatExchangePercent(null)).toBe('—')
  })

  it('uses one deterministic format for money and trader counts', () => {
    expect(formatExchangeMoney(12_345, 'USDT')).toBe('+12.3K USDT')
    expect(formatExchangeTraderCount(12_345)).toBe('12,345')
  })
})
