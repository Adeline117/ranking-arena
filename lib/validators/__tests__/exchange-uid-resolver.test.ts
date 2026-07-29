jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { resolveExchangeReadOnlyAccess, resolveExchangeUid } from '../exchange-uid-resolver'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body, status: ok ? 200 : 400 } as Response
}

describe('exchange-reported read-only permissions', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('accepts Bybit only when query-api reports readOnly=1', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        retCode: 0,
        result: { uid: '42', readOnly: 1, permissions: { Wallet: ['AccountTransfer'] } },
      })
    )
    expect(await resolveExchangeUid('bybit', { apiKey: 'k', apiSecret: 's' })).toMatchObject({
      success: true,
      uid: '42',
      isReadOnly: true,
    })

    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ retCode: 0, result: { uid: '42', readOnly: 0 } }))
    expect((await resolveExchangeUid('bybit', { apiKey: 'k', apiSecret: 's' })).isReadOnly).toBe(
      false
    )
  })

  it('rejects OKX permission sets that include trade', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ code: '0', data: [{ uid: '7', perm: 'read_only,trade' }] }))
    expect(
      (
        await resolveExchangeUid('okx', {
          apiKey: 'k',
          apiSecret: 's',
          passphrase: 'p',
        })
      ).isReadOnly
    ).toBe(false)
  })

  it('uses Bitget authorities rather than an Arena hard-coded permission', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: '00000', data: { userId: '8', authorities: ['read'] } })
      )
    const result = await resolveExchangeUid('bitget', {
      apiKey: 'k',
      apiSecret: 's',
      passphrase: 'p',
    })
    expect(result).toMatchObject({ isReadOnly: true, permissions: ['read'] })
  })

  it('recognizes Bitget classic read codes and rejects write codes', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: '00000', data: { userId: '8', authorities: ['cpor', 'coor'] } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: '00000', data: { userId: '8', authorities: ['cpor', 'coow'] } })
      )

    await expect(
      resolveExchangeUid('bitget', { apiKey: 'k', apiSecret: 's', passphrase: 'p' })
    ).resolves.toMatchObject({ isReadOnly: true })
    await expect(
      resolveExchangeUid('bitget', { apiKey: 'k', apiSecret: 's', passphrase: 'p' })
    ).resolves.toMatchObject({ isReadOnly: false })
  })

  it('rejects Binance keys when any write capability is enabled', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uid: '9' }))
      .mockResolvedValueOnce(
        jsonResponse({
          enableReading: true,
          enableSpotAndMarginTrading: true,
          enableWithdrawals: false,
        })
      )
    const result = await resolveExchangeUid('binance', { apiKey: 'k', apiSecret: 's' })
    expect(result.isReadOnly).toBe(false)
    expect(result.permissions).toContain('enableSpotAndMarginTrading')
  })

  it('rejects current and future Binance write capabilities without requiring a UID', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          enableReading: true,
          enableFixReadOnly: true,
          enableFixApiTrade: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          enableReading: true,
          enableFutureTradingCapability: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          enableReading: true,
          enableFixReadOnly: true,
        })
      )

    await expect(
      resolveExchangeReadOnlyAccess('binance', { apiKey: 'k', apiSecret: 's' })
    ).resolves.toMatchObject({ success: true, isReadOnly: false })
    await expect(
      resolveExchangeReadOnlyAccess('binance', { apiKey: 'k', apiSecret: 's' })
    ).resolves.toMatchObject({ success: true, isReadOnly: false })
    await expect(
      resolveExchangeReadOnlyAccess('binance', { apiKey: 'k', apiSecret: 's' })
    ).resolves.toMatchObject({ success: true, isReadOnly: true })
  })

  it('fails closed when an exchange has no permission-proof integration', async () => {
    await expect(
      resolveExchangeReadOnlyAccess('mexc', { apiKey: 'k', apiSecret: 's' })
    ).resolves.toMatchObject({ success: false, isReadOnly: false })
    expect(global.fetch).toBe(originalFetch)
  })
})
