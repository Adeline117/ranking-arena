/**
 * arbitrage — 跨所价差 + 三角套利检测。
 * 含 getRate 方向修复的回归锁(卖在 bid/买在 ask 的可执行语义)。
 */

jest.mock('server-only', () => ({}), { virtual: true })

// 每个交易所的 mock ticker 数据(测试内配置)
const mockTickersByExchange: Record<
  string,
  Record<string, { bid?: number; ask?: number }> | Error
> = {}
let mockFetchCalls = 0

jest.mock('ccxt', () => {
  const mk = (id: string) =>
    class {
      constructor(_opts: object) {}
      async fetchTickers() {
        mockFetchCalls++
        const t = mockTickersByExchange[id]
        if (t instanceof Error) throw t
        return t ?? {}
      }
    }
  return {
    binance: mk('binance'),
    okx: mk('okx'),
    bybit: mk('bybit'),
    gateio: mk('gateio'),
    kucoin: mk('kucoin'),
    htx: mk('htx'),
  }
})

type ArbModule = typeof import('../arbitrage')

async function loadFresh(): Promise<ArbModule> {
  jest.resetModules()
  return import('../arbitrage')
}

beforeEach(() => {
  for (const k of Object.keys(mockTickersByExchange)) delete mockTickersByExchange[k]
  mockFetchCalls = 0
})

describe('跨所套利', () => {
  it('买低卖高:cheap 所 ask < expensive 所 bid → 机会,价差正确', async () => {
    mockTickersByExchange.binance = { 'BTC/USDT': { bid: 99990, ask: 100000 } }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 100500, ask: 100510 } }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    const cross = ops.find((o) => o.type === 'cross-exchange')
    expect(cross).toBeDefined()
    if (cross?.type === 'cross-exchange') {
      expect(cross.buyExchange).toBe('binance') // 最低 ask
      expect(cross.sellExchange).toBe('okx') // 最高 bid
      expect(cross.spreadPct).toBeCloseTo(0.5, 2) // (100500-100000)/100000
    }
  })

  it('价差为负(正常市场)→ 无机会', async () => {
    mockTickersByExchange.binance = { 'ETH/USDT': { bid: 1999, ask: 2000 } }
    mockTickersByExchange.okx = { 'ETH/USDT': { bid: 1999.5, ask: 2000.5 } }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    expect(ops.filter((o) => o.type === 'cross-exchange')).toHaveLength(0)
  })

  it('bid/ask 缺失或 <=0 的 ticker 被跳过', async () => {
    mockTickersByExchange.binance = { 'BTC/USDT': { bid: 0, ask: 100000 } }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 100500, ask: 100510 } }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    // binance 条目无效 → 只剩一个交易所有该 symbol → 无跨所机会
    expect(ops.filter((o) => o.type === 'cross-exchange')).toHaveLength(0)
  })
})

describe('三角套利(getRate 方向修复回归锁)', () => {
  it('可执行的正向循环 BTC→ETH→USDT→BTC:买 ETH 在 ask、卖 ETH 在 bid、买 BTC 在 ask', async () => {
    // r1(BTC→ETH) = 1/ask(ETH/BTC) = 1/0.0211
    // r2(ETH→USDT) = bid(ETH/USDT) = 2200
    // r3(USDT→BTC) = 1/ask(BTC/USDT) = 1/100010
    // product = 2200/(0.0211*100010) ≈ 1.0425 → +4.25%
    mockTickersByExchange.binance = {
      'ETH/BTC': { bid: 0.021, ask: 0.0211 },
      'ETH/USDT': { bid: 2200, ask: 2201 },
      'BTC/USDT': { bid: 100000, ask: 100010 },
    }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 100000, ask: 100010 } } // 凑满 2 所
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    const tri = ops.find((o) => o.type === 'triangular')
    expect(tri).toBeDefined()
    if (tri?.type === 'triangular') {
      expect(tri.path).toEqual(['BTC', 'ETH', 'USDT', 'BTC'])
      expect(tri.profitPct).toBeCloseTo(4.25, 1)
      // 回归锁:每步 rate 与 from/to 标签一致(修复前方向相反)
      const [s1, s2, s3] = tri.steps
      expect(s1).toMatchObject({ from: 'BTC', to: 'ETH', symbol: 'ETH/BTC' })
      expect(s1.rate).toBeCloseTo(1 / 0.0211, 4) // 买 ETH 付 ask
      expect(s2).toMatchObject({ from: 'ETH', to: 'USDT', symbol: 'ETH/USDT' })
      expect(s2.rate).toBe(2200) // 卖 ETH 得 bid
      expect(s3.rate).toBeCloseTo(1 / 100010, 10) // 买 BTC 付 ask
    }
  })

  it('一致定价(无套利空间)→ 不产生机会', async () => {
    // ETH/BTC = 2000/100000 = 0.02 完全一致 + 点差 → product < 1
    mockTickersByExchange.binance = {
      'ETH/BTC': { bid: 0.0199, ask: 0.0201 },
      'ETH/USDT': { bid: 1999, ask: 2001 },
      'BTC/USDT': { bid: 99990, ask: 100010 },
    }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 99990, ask: 100010 } }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    expect(ops.filter((o) => o.type === 'triangular')).toHaveLength(0)
  })

  it('路径缺腿(无 ETH/USDT 对)→ 跳过该路径不崩', async () => {
    mockTickersByExchange.binance = {
      'ETH/BTC': { bid: 0.021, ask: 0.0211 },
      'BTC/USDT': { bid: 100000, ask: 100010 },
    }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 100000, ask: 100010 } }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    expect(ops.filter((o) => o.type === 'triangular')).toHaveLength(0)
  })
})

describe('容错 + 缓存', () => {
  it('少于 2 个交易所可用 → 返回旧缓存(空)', async () => {
    mockTickersByExchange.binance = { 'BTC/USDT': { bid: 100000, ask: 100010 } }
    // 其余全部失败
    for (const id of ['okx', 'bybit', 'gateio', 'kucoin', 'htx']) {
      mockTickersByExchange[id] = new Error('geo blocked')
    }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    expect(ops).toEqual([])
  })

  it('30s 内二次调用命中结果缓存,不重新抓取', async () => {
    mockTickersByExchange.binance = { 'BTC/USDT': { bid: 99990, ask: 100000 } }
    mockTickersByExchange.okx = { 'BTC/USDT': { bid: 100500, ask: 100510 } }
    const mod = await loadFresh()
    const first = await mod.detectArbitrageOpportunities()
    expect(first.length).toBeGreaterThan(0)
    const callsAfterFirst = mockFetchCalls
    const second = await mod.detectArbitrageOpportunities()
    expect(second).toBe(first) // 同一引用 = 缓存
    expect(mockFetchCalls).toBe(callsAfterFirst) // 无新抓取
  })

  it('结果按收益率降序,最多 20 条', async () => {
    mockTickersByExchange.binance = {
      'BTC/USDT': { bid: 99990, ask: 100000 },
      'ETH/USDT': { bid: 1999, ask: 2000 },
    }
    mockTickersByExchange.okx = {
      'BTC/USDT': { bid: 100500, ask: 100510 }, // +0.5%
      'ETH/USDT': { bid: 2040, ask: 2041 }, // +2%
    }
    const mod = await loadFresh()
    const ops = await mod.detectArbitrageOpportunities()
    expect(ops.length).toBeLessThanOrEqual(20)
    const pcts = ops.map((o) => (o.type === 'cross-exchange' ? o.spreadPct : o.profitPct))
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a)) // 降序
    expect(pcts[0]).toBeCloseTo(2, 1) // ETH 的 2% 排最前
  })
})
