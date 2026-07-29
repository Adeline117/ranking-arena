import { fetchFirstPartyAccount, type CcxtLike } from '../fetch'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')

function client(overrides: Partial<CcxtLike> = {}): CcxtLike {
  return {
    fetchBalance: jest.fn().mockResolvedValue({ total: { USDT: 100 } }),
    fetchPositions: jest.fn().mockResolvedValue([{ unrealizedPnl: 20, contracts: 1 }]),
    ...overrides,
  }
}

describe('first-party account equity evidence', () => {
  it('does not add unrealized PnL when CCXT balance.total already represents equity', async () => {
    const result = await fetchFirstPartyAccount(client(), {
      nowMs: NOW,
      balanceSemantics: 'total_includes_unrealized',
    })

    expect(result).toMatchObject({
      balanceNow: 100,
      unrealizedNow: 20,
      equityNow: 100,
    })
  })

  it('adds unrealized PnL exactly once when CCXT balance.total is wallet balance', async () => {
    const result = await fetchFirstPartyAccount(client(), {
      nowMs: NOW,
      balanceSemantics: 'wallet_excludes_unrealized',
    })

    expect(result).toMatchObject({
      balanceNow: 100,
      unrealizedNow: 20,
      equityNow: 120,
    })
  })

  it('rejects a response with no finite stablecoin balance evidence', async () => {
    const missingBalance = client({
      fetchBalance: jest.fn().mockResolvedValue({ total: {} }),
    })

    await expect(
      fetchFirstPartyAccount(missingBalance, {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
      })
    ).rejects.toThrow('stablecoin balance evidence is unavailable')
  })

  it('rejects missing position evidence when wallet balance excludes unrealized PnL', async () => {
    const missingPositions = client({
      fetchPositions: jest.fn().mockRejectedValue(new Error('positions unavailable')),
    })

    await expect(
      fetchFirstPartyAccount(missingPositions, {
        nowMs: NOW,
        balanceSemantics: 'wallet_excludes_unrealized',
      })
    ).rejects.toThrow('unrealized PnL evidence is unavailable')
  })

  it('can use authoritative total equity when the optional positions surface is unavailable', async () => {
    const missingPositions = client({
      fetchPositions: jest.fn().mockRejectedValue(new Error('positions unavailable')),
    })

    await expect(
      fetchFirstPartyAccount(missingPositions, {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
      })
    ).resolves.toMatchObject({
      balanceNow: 100,
      unrealizedNow: null,
      equityNow: 100,
    })
  })

  it('preserves the loss sign from a normalized CCXT Binance ledger entry', async () => {
    const fetchLedger = jest.fn().mockResolvedValue([
      {
        timestamp: NOW - 1_000,
        amount: 25,
        direction: 'out',
        type: 'trade',
        info: { incomeType: 'REALIZED_PNL', income: '-25' },
      },
    ])

    const result = await fetchFirstPartyAccount(
      client({
        has: { fetchPositionsHistory: false },
        fetchLedger,
      }),
      {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
      }
    )

    expect(result.events).toEqual([{ ts: NOW - 1_000, pnl: -25, positionLevel: false }])
  })

  it('windows realized PnL by position close time instead of open time', async () => {
    const openedBeforeWindow = NOW - 100 * 86_400_000
    const closedInsideWindow = NOW - 1_000
    const result = await fetchFirstPartyAccount(
      client({
        has: { fetchPositionsHistory: true },
        fetchPositionsHistory: jest.fn().mockResolvedValue([
          {
            timestamp: openedBeforeWindow,
            lastUpdateTimestamp: closedInsideWindow,
            realizedPnl: 12,
          },
        ]),
      }),
      {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
      }
    )

    expect(result.events).toEqual([{ ts: closedInsideWindow, pnl: 12, positionLevel: true }])
  })
})
