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

  it('uses Bybit account-wide USD equity instead of omitting non-stable collateral', async () => {
    const result = await fetchFirstPartyAccount(
      client({
        fetchBalance: jest.fn().mockResolvedValue({
          total: { USDT: 100 },
          info: {
            result: {
              list: [{ totalEquity: '12920.95352538' }],
            },
          },
        }),
      }),
      {
        nowMs: NOW,
        balanceSource: 'bybit_total_equity',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result).toMatchObject({
      balanceNow: 12920.95352538,
      unrealizedNow: 20,
      equityNow: 12920.95352538,
    })
  })

  it('rejects missing contracted Bybit total-equity evidence instead of falling back to stables', async () => {
    await expect(
      fetchFirstPartyAccount(client(), {
        nowMs: NOW,
        balanceSource: 'bybit_total_equity',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      })
    ).rejects.toThrow('account equity evidence is unavailable')
  })

  it('uses OKX total USD equity instead of adding unlike currency units', async () => {
    const result = await fetchFirstPartyAccount(
      client({
        fetchBalance: jest.fn().mockResolvedValue({
          total: { USDT: 100, USDC: 50 },
          info: {
            data: [
              {
                totalEq: '1918.55678',
                details: [{ ccy: 'BTC', eq: '0.049', eqUsd: '1918.55678' }],
              },
            ],
          },
        }),
      }),
      {
        nowMs: NOW,
        balanceSource: 'okx_total_equity',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result).toMatchObject({
      balanceNow: 1918.55678,
      equityNow: 1918.55678,
    })
  })

  it('uses Binance total margin balance in multi-assets mode', async () => {
    const result = await fetchFirstPartyAccount(
      client({
        fetchBalance: jest.fn().mockResolvedValue({
          total: { USDT: 23.72469206 },
          info: {
            multiAssetsMargin: true,
            totalWalletBalance: '126.72469206',
            totalUnrealizedProfit: '5',
            totalMarginBalance: '131.72469206',
          },
        }),
      }),
      {
        nowMs: NOW,
        balanceSource: 'binance_margin_balance',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result).toMatchObject({
      balanceNow: 131.72469206,
      equityNow: 131.72469206,
    })
  })

  it('uses Bitget USDT-valued account equity', async () => {
    const result = await fetchFirstPartyAccount(
      client({
        fetchBalance: jest.fn().mockResolvedValue({
          total: { USDT: 11.13919278 },
          info: [
            {
              marginCoin: 'USDT',
              accountEquity: '11.13919278',
              usdtEquity: '11.13921165',
            },
          ],
        }),
      }),
      {
        nowMs: NOW,
        balanceSource: 'bitget_usdt_equity',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result).toMatchObject({
      balanceNow: 11.13921165,
      equityNow: 11.13921165,
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

  it('rejects incomplete live-position PnL instead of treating the missing amount as zero', async () => {
    const incompletePositions = client({
      fetchPositions: jest.fn().mockResolvedValue([
        { contracts: 1, unrealizedPnl: 20 },
        { contracts: 2, unrealizedPnl: null },
        { contracts: 0, unrealizedPnl: null },
      ]),
    })

    await expect(
      fetchFirstPartyAccount(incompletePositions, {
        nowMs: NOW,
        balanceSemantics: 'wallet_excludes_unrealized',
        realizedPnlSource: 'positions_history',
      })
    ).rejects.toThrow('unrealized PnL evidence is unavailable')
  })

  it('does not publish a partial unrealized total beside authoritative total equity', async () => {
    const incompletePositions = client({
      fetchPositions: jest.fn().mockResolvedValue([
        { contracts: 1, unrealizedPnl: 20 },
        { contracts: 2, unrealizedPnl: null },
      ]),
    })

    await expect(
      fetchFirstPartyAccount(incompletePositions, {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      })
    ).resolves.toMatchObject({
      equityNow: 100,
      unrealizedNow: null,
    })
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
        currency: 'USDT',
        info: { incomeType: 'REALIZED_PNL', income: '-25', asset: 'USDT' },
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
        requireStablePnlCurrency: true,
      }
    )

    expect(result.events).toEqual([{ ts: NOW - 1_000, pnl: -25, positionLevel: false }])
    expect(fetchLedger).toHaveBeenCalledWith(undefined, NOW - 90 * DAY, 1000, {
      incomeType: 'REALIZED_PNL',
      until: NOW,
    })
  })

  it('time-partitions a saturated realized-PnL ledger instead of publishing a partial page', async () => {
    const since = NOW - 2 * DAY
    const midpoint = Math.floor((since + NOW) / 2)
    const saturated = Array.from({ length: 1000 }, () => ({
      timestamp: midpoint,
      amount: 1,
      direction: 'in',
      info: { incomeType: 'REALIZED_PNL', income: '1' },
    }))
    const fetchLedger = jest
      .fn()
      .mockResolvedValueOnce(saturated)
      .mockResolvedValueOnce([
        {
          timestamp: since + 1,
          amount: 2,
          direction: 'in',
          info: { incomeType: 'REALIZED_PNL', income: '2' },
        },
      ])
      .mockResolvedValueOnce([
        {
          timestamp: midpoint + 1,
          amount: 3,
          direction: 'in',
          info: { incomeType: 'REALIZED_PNL', income: '3' },
        },
      ])

    const result = await fetchFirstPartyAccount(client({ fetchLedger }), {
      nowMs: NOW,
      lookbackDays: 2,
      balanceSemantics: 'total_includes_unrealized',
      realizedPnlSource: 'income_ledger',
    })

    expect(result.events).toEqual([
      { ts: since + 1, pnl: 2, positionLevel: false },
      { ts: midpoint + 1, pnl: 3, positionLevel: false },
    ])
    expect(fetchLedger).toHaveBeenNthCalledWith(2, undefined, since, 1000, {
      incomeType: 'REALIZED_PNL',
      until: midpoint,
    })
    expect(fetchLedger).toHaveBeenNthCalledWith(3, undefined, midpoint + 1, 1000, {
      incomeType: 'REALIZED_PNL',
      until: NOW,
    })
  })

  it('rejects non-stable realized-PnL ledger units', async () => {
    await expect(
      fetchFirstPartyAccount(
        client({
          fetchLedger: jest.fn().mockResolvedValue([
            {
              timestamp: NOW - 1_000,
              amount: 0.25,
              direction: 'in',
              type: 'trade',
              currency: 'BTC',
              info: { incomeType: 'REALIZED_PNL', income: '0.25', asset: 'BTC' },
            },
          ]),
        }),
        {
          nowMs: NOW,
          balanceSemantics: 'total_includes_unrealized',
          realizedPnlSource: 'income_ledger',
          requireStablePnlCurrency: true,
        }
      )
    ).rejects.toThrow('realized PnL ledger currency evidence is invalid')
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

  it('rejects position PnL denominated in an unvalued collateral coin', async () => {
    await expect(
      fetchFirstPartyAccount(
        client({
          fetchPositionsHistory: jest.fn().mockResolvedValue([
            {
              symbol: 'BTC/USD:BTC',
              lastUpdateTimestamp: NOW - 1_000,
              realizedPnl: 0.25,
              info: { ccy: 'BTC', instId: 'BTC-USD-SWAP' },
            },
          ]),
        }),
        {
          nowMs: NOW,
          balanceSemantics: 'total_includes_unrealized',
          realizedPnlSource: 'positions_history',
          requireStablePnlCurrency: true,
        }
      )
    ).rejects.toThrow('position history currency evidence is invalid')
  })

  it('uses net closed-position profit when the exchange exposes fee-adjusted evidence', async () => {
    const closedInsideWindow = NOW - 1_000
    const result = await fetchFirstPartyAccount(
      client({
        fetchPositionsHistory: jest.fn().mockResolvedValue([
          {
            lastUpdateTimestamp: closedInsideWindow,
            realizedPnl: -0.0007,
            info: {
              netProfit: '-0.0454261',
              openFee: '-0.02236326',
              closeFee: '-0.02236284',
              totalFunding: '0',
            },
          },
        ]),
      }),
      {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
      }
    )

    expect(result.events).toEqual([
      { ts: closedInsideWindow, pnl: -0.0454261, positionLevel: true },
    ])
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

  it('time-partitions saturated position history for adapters with bounded ranges', async () => {
    const since = NOW - 2 * DAY
    const midpoint = Math.floor((since + NOW) / 2)
    const saturated = Array.from({ length: 100 }, () => ({
      lastUpdateTimestamp: midpoint,
      realizedPnl: 1,
    }))
    const fetchPositionsHistory = jest
      .fn()
      .mockResolvedValueOnce(saturated)
      .mockResolvedValueOnce([{ lastUpdateTimestamp: since + 1, realizedPnl: -2 }])
      .mockResolvedValueOnce([{ lastUpdateTimestamp: midpoint + 1, realizedPnl: 3 }])

    const result = await fetchFirstPartyAccount(client({ fetchPositionsHistory }), {
      nowMs: NOW,
      lookbackDays: 2,
      balanceSemantics: 'total_includes_unrealized',
      realizedPnlSource: 'positions_history',
      positionHistoryMaxRangeDays: 90,
    })

    expect(result.events).toEqual([
      { ts: since + 1, pnl: -2, positionLevel: true },
      { ts: midpoint + 1, pnl: 3, positionLevel: true },
    ])
    expect(fetchPositionsHistory).toHaveBeenNthCalledWith(2, undefined, since, 100, {
      until: midpoint,
    })
    expect(fetchPositionsHistory).toHaveBeenNthCalledWith(3, undefined, midpoint + 1, 100, {
      until: NOW,
    })
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

  it('recognizes Bybit transfer directions from the raw transaction type', async () => {
    const transferAt = NOW - 1_000
    const result = await fetchFirstPartyAccount(
      client({
        fetchLedger: jest.fn().mockResolvedValue([
          {
            timestamp: transferAt,
            amount: 40,
            direction: 'out',
            type: 'transaction',
            currency: 'USDT',
            info: { type: 'TRANSFER_OUT', currency: 'USDT' },
          },
        ]),
      }),
      {
        nowMs: NOW,
        balanceSemantics: 'wallet_excludes_unrealized',
        realizedPnlSource: 'positions_history',
        lastSyncMs: NOW - DAY,
        transferLedgerContract: {
          maxRangeDays: 90,
          pageLimit: 50,
          untilParam: 'endTime',
          queries: [{ type: 'TRANSFER_OUT' }],
        },
      }
    )

    expect(result.netTransfersIn).toEqual({ 7: -40, 30: -40, 90: -40 })
    expect(result.netTransfersSinceLast).toBe(-40)
  })

  it('rejects non-stable transfer units instead of treating coin amounts as USDT', async () => {
    const result = await fetchFirstPartyAccount(
      client({
        fetchLedger: jest.fn().mockResolvedValue([
          {
            timestamp: NOW - 1_000,
            amount: 1,
            direction: 'in',
            type: 'transaction',
            currency: 'BTC',
            info: { type: 'TRANSFER_IN', currency: 'BTC' },
          },
        ]),
      }),
      {
        nowMs: NOW,
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
        lastSyncMs: NOW - DAY,
        transferLedgerContract: {
          maxRangeDays: 90,
          pageLimit: 50,
          untilParam: 'endTime',
          queries: [{ type: 'TRANSFER_IN' }],
        },
      }
    )

    expect(result.netTransfersIn).toEqual({})
    expect(result.netTransfersSinceLast).toBeNull()
  })

  it('queries the complete Bybit transfer window in bounded IN/OUT ranges', async () => {
    const fetchLedger = jest.fn().mockResolvedValue([])

    await fetchFirstPartyAccount(client({ fetchLedger }), {
      nowMs: NOW,
      balanceSemantics: 'wallet_excludes_unrealized',
      realizedPnlSource: 'positions_history',
      lookbackDays: 8,
      transferLedgerContract: {
        maxRangeDays: 7,
        pageLimit: 50,
        untilParam: 'endTime',
        queries: [{ type: 'TRANSFER_IN' }, { type: 'TRANSFER_OUT' }],
      },
    })

    expect(fetchLedger).toHaveBeenCalledTimes(4)
    expect(fetchLedger).toHaveBeenNthCalledWith(1, undefined, NOW - 8 * DAY, 50, {
      type: 'TRANSFER_IN',
      endTime: NOW - DAY,
    })
    expect(fetchLedger).toHaveBeenNthCalledWith(2, undefined, NOW - DAY + 1, 50, {
      type: 'TRANSFER_IN',
      endTime: NOW,
    })
    expect(fetchLedger).toHaveBeenNthCalledWith(3, undefined, NOW - 8 * DAY, 50, {
      type: 'TRANSFER_OUT',
      endTime: NOW - DAY,
    })
    expect(fetchLedger).toHaveBeenNthCalledWith(4, undefined, NOW - DAY + 1, 50, {
      type: 'TRANSFER_OUT',
      endTime: NOW,
    })
  })
})
