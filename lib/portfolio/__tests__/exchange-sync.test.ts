const mockExchangeState = {
  positionsCapability: true as boolean | string,
  positions: [] as Array<Record<string, unknown>>,
  balance: {
    total: { USDT: 0 },
    info: { result: { list: [{ totalEquity: '0' }] } },
  } as { total?: Record<string, number>; info?: unknown },
  positionsError: null as Error | null,
  balanceError: null as Error | null,
  positionsCalls: 0,
  balanceCalls: 0,
}

jest.mock('@/lib/exchange/secure-encryption', () => ({
  decryptApiKey: () => 'decrypted-credential',
}))

jest.mock('ccxt', () => ({
  bybit: class {
    has = { fetchPositions: mockExchangeState.positionsCapability }

    async fetchPositions() {
      mockExchangeState.positionsCalls += 1
      if (mockExchangeState.positionsError) throw mockExchangeState.positionsError
      return mockExchangeState.positions
    }

    async fetchBalance() {
      mockExchangeState.balanceCalls += 1
      if (mockExchangeState.balanceError) throw mockExchangeState.balanceError
      return mockExchangeState.balance
    }
  },
}))

import { resolvePortfolioEquityEvidence, syncExchangePortfolio } from '../exchange-sync'

const base = {
  portfolioId: 'portfolio-1',
  apiKeyEncrypted: 'not-read',
  apiSecretEncrypted: 'not-read',
  userId: 'user-1',
}

describe('syncExchangePortfolio guardrails', () => {
  beforeEach(() => {
    mockExchangeState.positionsCapability = true
    mockExchangeState.positions = []
    mockExchangeState.balance = {
      total: { USDT: 0 },
      info: { result: { list: [{ totalEquity: '0' }] } },
    }
    mockExchangeState.positionsError = null
    mockExchangeState.balanceError = null
    mockExchangeState.positionsCalls = 0
    mockExchangeState.balanceCalls = 0
  })

  it('refuses an unsupported exchange before attempting to decrypt credentials', async () => {
    await expect(syncExchangePortfolio({ ...base, exchange: 'unknown-exchange' })).resolves.toEqual(
      {
        ok: false,
        reason: 'unsupported',
      }
    )
  })

  it('does not attempt geo-blocked exchange sync without a configured proxy', async () => {
    const oldUrl = process.env.PORTFOLIO_SYNC_PROXY_URL
    const oldKey = process.env.PORTFOLIO_SYNC_PROXY_KEY
    const oldVpsUrl = process.env.VPS_PROXY_SG
    const oldVpsKey = process.env.VPS_PROXY_KEY
    delete process.env.PORTFOLIO_SYNC_PROXY_URL
    delete process.env.PORTFOLIO_SYNC_PROXY_KEY
    delete process.env.VPS_PROXY_SG
    delete process.env.VPS_PROXY_KEY
    try {
      await expect(syncExchangePortfolio({ ...base, exchange: 'binance' })).resolves.toEqual({
        ok: false,
        reason: 'geo_unavailable',
      })
    } finally {
      if (oldUrl === undefined) delete process.env.PORTFOLIO_SYNC_PROXY_URL
      else process.env.PORTFOLIO_SYNC_PROXY_URL = oldUrl
      if (oldKey === undefined) delete process.env.PORTFOLIO_SYNC_PROXY_KEY
      else process.env.PORTFOLIO_SYNC_PROXY_KEY = oldKey
      if (oldVpsUrl === undefined) delete process.env.VPS_PROXY_SG
      else process.env.VPS_PROXY_SG = oldVpsUrl
      if (oldVpsKey === undefined) delete process.env.VPS_PROXY_KEY
      else process.env.VPS_PROXY_KEY = oldVpsKey
    }
  })

  it('requires a passphrase before reading credentials for passphrase exchanges', async () => {
    await expect(syncExchangePortfolio({ ...base, exchange: 'bitget' })).resolves.toEqual({
      ok: false,
      reason: 'passphrase_required',
    })
  })

  it('does not publish an empty snapshot when fetchPositions is unavailable', async () => {
    mockExchangeState.positionsCapability = false

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(mockExchangeState.positionsCalls).toBe(0)
    expect(mockExchangeState.balanceCalls).toBe(0)
  })

  it('fails the whole financial snapshot when the balance fetch fails', async () => {
    mockExchangeState.positions = [
      {
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        contracts: 1,
        entryPrice: 100,
        markPrice: 101,
        unrealizedPnl: 1,
        percentage: 1,
        leverage: 2,
      },
    ]
    mockExchangeState.balanceError = new Error('upstream unavailable')

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toEqual({
      ok: false,
      reason: 'exchange_error',
    })
    expect(mockExchangeState.positionsCalls).toBe(1)
    expect(mockExchangeState.balanceCalls).toBe(1)
  })

  it('rejects a balance response without the exchange account-equity evidence', async () => {
    mockExchangeState.balance = { total: { USDT: 1_000 } }

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toEqual({
      ok: false,
      reason: 'exchange_error',
    })
  })

  it.each([
    ['missing contracts', { contracts: undefined }],
    ['unknown side', { side: 'flat' }],
    ['zero mark price', { markPrice: 0 }],
    ['missing PnL', { unrealizedPnl: undefined }],
  ])('rejects an active position with %s', async (_label, override) => {
    mockExchangeState.positions = [
      {
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        contracts: 1,
        entryPrice: 100,
        markPrice: 101,
        unrealizedPnl: 1,
        percentage: 1,
        leverage: 2,
        ...override,
      },
    ]
    mockExchangeState.balance = {
      total: { USDT: 1000 },
      info: { result: { list: [{ totalEquity: '1000' }] } },
    }

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toEqual({
      ok: false,
      reason: 'exchange_error',
    })
  })

  it('accepts an authoritative empty portfolio with an exact zero balance', async () => {
    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toMatchObject({
      ok: true,
      positions: [],
      equity: 0,
      pnl: 0,
      pnlPct: 0,
    })
  })

  it('returns one complete position-and-equity snapshot only after both reads succeed', async () => {
    mockExchangeState.positions = [
      {
        symbol: 'BTC/USDT:USDT',
        side: 'short',
        contracts: 2,
        entryPrice: 100,
        markPrice: 90,
        unrealizedPnl: 20,
        percentage: 10,
        leverage: 3,
      },
      {
        symbol: 'ETH/USDT:USDT',
        side: 'long',
        contracts: 0,
      },
    ]
    mockExchangeState.balance = {
      total: { USDT: 500 },
      info: { result: { list: [{ totalEquity: '500' }] } },
    }

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toMatchObject({
      ok: true,
      equity: 500,
      pnl: 20,
      pnlPct: 4,
      positions: [
        {
          portfolio_id: base.portfolioId,
          symbol: 'BTC/USDT:USDT',
          side: 'short',
          size: 2,
          entry_price: 100,
          mark_price: 90,
          pnl: 20,
          pnl_pct: 10,
          leverage: 3,
        },
      ],
    })
  })

  it('uses the exchange account total instead of one CCXT currency bucket', async () => {
    mockExchangeState.balance = {
      total: { USDT: 1 },
      info: { result: { list: [{ totalEquity: '2500.75' }] } },
    }

    await expect(syncExchangePortfolio({ ...base, exchange: 'bybit' })).resolves.toMatchObject({
      ok: true,
      equity: 2500.75,
    })
  })
})

describe('resolvePortfolioEquityEvidence', () => {
  it.each([
    ['binance', { info: { totalMarginBalance: '131.72' } }, 131.72],
    ['bybit', { info: { result: { list: [{ totalEquity: '12920.95' }] } } }, 12920.95],
    ['okx', { info: { data: [{ totalEq: '1918.55' }] } }, 1918.55],
    ['bitget', { info: [{ usdtEquity: '11.13' }, { usdtEquity: '2.5' }] }, 13.63],
  ])('reads %s account-total evidence', (exchange, balance, expected) => {
    expect(resolvePortfolioEquityEvidence(exchange, balance)).toBeCloseTo(expected)
  })

  it('does not fall back to a partial currency bucket for a governed exchange', () => {
    expect(resolvePortfolioEquityEvidence('bybit', { total: { USDT: 999 } })).toBeNull()
  })
})
