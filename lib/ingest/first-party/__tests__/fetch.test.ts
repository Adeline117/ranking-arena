import { fetchFirstPartyAccount, type CcxtLike } from '../fetch'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')
const DAY = 86_400_000

function client(overrides: Partial<CcxtLike> = {}): CcxtLike {
  return {
    fetchBalance: jest.fn().mockResolvedValue({ total: { USDT: 100 } }),
    fetchPositions: jest.fn().mockResolvedValue([{ unrealizedPnl: 20, contracts: 1 }]),
    fetchPositionsHistory: jest.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('first-party account equity evidence', () => {
  it('does not add unrealized PnL when CCXT balance.total already represents equity', async () => {
    const result = await fetchFirstPartyAccount(client(), {
      nowMs: NOW,
      balanceSemantics: 'total_includes_unrealized',
      realizedPnlSource: 'positions_history',
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
      realizedPnlSource: 'positions_history',
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
        realizedPnlSource: 'positions_history',
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
        realizedPnlSource: 'positions_history',
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
        realizedPnlSource: 'positions_history',
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
        realizedPnlSource: 'income_ledger',
      }
    )

    expect(result.events).toEqual([{ ts: NOW - 1_000, pnl: -25, positionLevel: false }])
  })

  it('windows realized PnL by position close time instead of open time', async () => {
    const openedBeforeWindow = NOW - 100 * DAY
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
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result.events).toEqual([{ ts: closedInsideWindow, pnl: 12, positionLevel: true }])
  })

  it('splits position history into exchange-bounded time ranges', async () => {
    const firstClose = NOW - 7.5 * DAY
    const secondClose = NOW - 0.5 * DAY
    const fetchPositionsHistory = jest
      .fn()
      .mockResolvedValueOnce([{ lastUpdateTimestamp: firstClose, realizedPnl: -2 }])
      .mockResolvedValueOnce([{ lastUpdateTimestamp: secondClose, realizedPnl: 3 }])

    const result = await fetchFirstPartyAccount(client({ fetchPositionsHistory }), {
      nowMs: NOW,
      balanceSemantics: 'total_includes_unrealized',
      realizedPnlSource: 'positions_history',
      positionHistoryMaxRangeDays: 7,
      lookbackDays: 8,
    })

    expect(result.events).toEqual([
      { ts: firstClose, pnl: -2, positionLevel: true },
      { ts: secondClose, pnl: 3, positionLevel: true },
    ])
    expect(fetchPositionsHistory).toHaveBeenCalledTimes(2)
    expect(fetchPositionsHistory.mock.calls[0]?.[1]).toBe(NOW - 8 * DAY)
    expect(fetchPositionsHistory.mock.calls[0]?.[3]).toEqual({ until: NOW - DAY })
    expect(fetchPositionsHistory.mock.calls[1]?.[1]).toBe(NOW - DAY + 1)
    expect(fetchPositionsHistory.mock.calls[1]?.[3]).toEqual({ until: NOW })
  })

  it('rejects a saturated position-history page instead of publishing partial PnL', async () => {
    const saturated = Array.from({ length: 100 }, (_, index) => ({
      lastUpdateTimestamp: NOW - index,
      realizedPnl: 1,
    }))

    await expect(
      fetchFirstPartyAccount(
        client({ fetchPositionsHistory: jest.fn().mockResolvedValue(saturated) }),
        {
          nowMs: NOW,
          balanceSemantics: 'total_includes_unrealized',
          realizedPnlSource: 'positions_history',
        }
      )
    ).rejects.toThrow('position history evidence is truncated')
  })

  it('rejects an exchange without its contracted realized-PnL surface', async () => {
    await expect(
      fetchFirstPartyAccount(client({ fetchPositionsHistory: undefined }), {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      })
    ).rejects.toThrow('position history evidence is unavailable')
  })

  it('preserves unavailable transfer evidence instead of inventing zero transfers', async () => {
    const result = await fetchFirstPartyAccount(client({ fetchLedger: undefined }), {
      nowMs: NOW,
      balanceSemantics: 'total_includes_unrealized',
      realizedPnlSource: 'positions_history',
      lastSyncMs: NOW - DAY,
    })

    expect(result.netTransfersIn).toEqual({})
    expect(result.netTransfersSinceLast).toBeNull()
  })
})
