import { formatMoney, sumMoney, assertSameCurrency, money } from '../money'

describe('money 构造器', () => {
  it('返回 {value, currency}', () => {
    expect(money(100, 'USDT')).toEqual({ value: 100, currency: 'USDT' })
  })
})

describe('formatMoney', () => {
  it('默认 compact + 带币种后缀', () => {
    expect(formatMoney(money(1500, 'USDT'))).toBe('$1.5K USDT')
    expect(formatMoney(money(2_000_000, 'USDC'))).toBe('$2M USDC')
  })

  it('compact=false → 完整数字', () => {
    expect(formatMoney(money(1500, 'USDT'), { compact: false })).toBe('$1,500 USDT')
  })

  it('signed=true → 正数带 +', () => {
    expect(formatMoney(money(100, 'USDT'), { signed: true, compact: false })).toBe('+$100 USDT')
  })

  it('signed=true 但负数/零 → 不加 +', () => {
    expect(formatMoney(money(-50, 'USDT'), { signed: true, compact: false })).toBe('$-50 USDT')
    expect(formatMoney(money(0, 'USDT'), { signed: true, compact: false })).toBe('$0 USDT')
  })

  it('hideUsdtSuffix：USDT 隐藏后缀，但 USDC 始终显示', () => {
    expect(formatMoney(money(100, 'USDT'), { hideUsdtSuffix: true, compact: false })).toBe('$100')
    // USDC 即使 hideUsdtSuffix=true 也显示（只对 USDT 生效）
    expect(formatMoney(money(100, 'USDC'), { hideUsdtSuffix: true, compact: false })).toBe(
      '$100 USDC'
    )
  })
})

describe('sumMoney — 拒绝跨币种求和', () => {
  it('同币种 → 求和', () => {
    expect(sumMoney([money(10, 'USDT'), money(20, 'USDT'), money(5, 'USDT')])).toEqual({
      value: 35,
      currency: 'USDT',
    })
  })

  it('混合币种 → null（不静默撒谎）', () => {
    expect(sumMoney([money(10, 'USDT'), money(20, 'USDC')])).toBeNull()
  })

  it('空列表 → null', () => {
    expect(sumMoney([])).toBeNull()
  })
})

describe('assertSameCurrency（dev 守卫）', () => {
  it('同币种 → 不抛', () => {
    expect(() => assertSameCurrency([money(1, 'USDT'), money(2, 'USDT')])).not.toThrow()
  })

  it('混合币种 → 抛错（非 production 下）', () => {
    // jest NODE_ENV=test ≠ production → 守卫生效
    expect(() => assertSameCurrency([money(1, 'USDT'), money(2, 'USDC')])).toThrow(/mixed-unit/)
  })

  it('单元素/空 → 不抛', () => {
    expect(() => assertSameCurrency([money(1, 'USDT')])).not.toThrow()
    expect(() => assertSameCurrency([])).not.toThrow()
  })
})
