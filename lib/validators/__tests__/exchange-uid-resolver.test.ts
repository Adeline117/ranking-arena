jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { isCexVerifiable, resolveExchangeUid } from '../exchange-uid-resolver'

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
      permissions: ['Wallet:AccountTransfer', 'readOnly=1'],
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

  it('accepts Bitget only when V3 account info reports exact permType=read-only', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        code: '00000',
        msg: 'success',
        requestTime: 1744617600000,
        data: {
          userId: '123456789',
          inviterId: '987654321',
          parentId: '',
          channelCode: '6258',
          channel: 'official',
          ips: '192.168.1.1,192.168.1.2',
          permType: 'read-only',
          permissions: ['uta_mgt', 'uta_trade'],
          regisTime: '1704067200000',
        },
      })
    )
    const result = await resolveExchangeUid('bitget', {
      apiKey: 'k',
      apiSecret: 's',
      passphrase: 'p',
    })
    expect(result).toMatchObject({
      success: true,
      uid: '123456789',
      isReadOnly: true,
      permissions: ['permType=read-only', 'uta_mgt', 'uta_trade'],
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.bitget.com/api/v3/account/info',
      expect.objectContaining({
        headers: expect.objectContaining({
          'ACCESS-KEY': 'k',
          'ACCESS-PASSPHRASE': 'p',
        }),
      })
    )
  })

  it.each([
    ['read-and-write', ['uta_mgt', 'uta_trade', 'withdraw']],
    ['READ-ONLY', ['uta_mgt']],
    ['read-only ', ['uta_mgt']],
    ['unknown', []],
    [undefined, ['uta_mgt']],
  ])('fails Bitget closed for non-canonical permType %p', async (permType, permissions) => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        code: '00000',
        msg: 'success',
        requestTime: 1744617600000,
        data: {
          userId: '123456789',
          inviterId: '987654321',
          parentId: '',
          channelCode: '6258',
          channel: 'official',
          ips: '',
          permType,
          permissions,
          regisTime: '1704067200000',
        },
      })
    )

    const result = await resolveExchangeUid('bitget', {
      apiKey: 'k',
      apiSecret: 's',
      passphrase: 'p',
    })

    expect(result).toMatchObject({ success: true, uid: '123456789', isReadOnly: false })
  })

  it('does not accept the legacy V2 authorities shape as V3 read-only proof', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        code: '00000',
        msg: 'success',
        requestTime: 1695808949356,
        data: {
          userId: '123456789',
          authorities: ['cpor', 'coor'],
        },
      })
    )

    const result = await resolveExchangeUid('bitget', {
      apiKey: 'k',
      apiSecret: 's',
      passphrase: 'p',
    })

    expect(result).toMatchObject({
      success: true,
      uid: '123456789',
      permissions: [],
      isReadOnly: false,
    })
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

  it.each(['enableFixApiTrade', 'enablePortfolioMarginTrading'])(
    'rejects Binance keys when the current API restriction field %s is enabled',
    async (writeFlag) => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ uid: '9' }))
        .mockResolvedValueOnce(
          jsonResponse({
            ipRestrict: true,
            createTime: 1744617600000,
            enableReading: true,
            enableSpotAndMarginTrading: false,
            enableWithdrawals: false,
            enableInternalTransfer: false,
            enableMargin: false,
            enableFutures: false,
            permitsUniversalTransfer: false,
            enableVanillaOptions: false,
            enableFixApiTrade: false,
            enablePortfolioMarginTrading: false,
            [writeFlag]: true,
          })
        )

      const result = await resolveExchangeUid('binance', { apiKey: 'k', apiSecret: 's' })

      expect(result).toMatchObject({ success: true, uid: '9', isReadOnly: false })
      expect(result.permissions).toContain(writeFlag)
    }
  )
})

describe('CEX claim platform classification', () => {
  it('rejects web3 and unknown family variants before UID resolution', () => {
    expect(isCexVerifiable('binance_web3')).toBe(false)
    expect(isCexVerifiable('okx_web3_solana')).toBe(false)
    expect(isCexVerifiable('binance_not_a_real_source')).toBe(false)
    expect(isCexVerifiable('bitget_bots_spot')).toBe(false)
    expect(isCexVerifiable('gate_cfd')).toBe(false)
  })

  it('does not advertise account-UID resolution as copy-trader identity verification', () => {
    expect(isCexVerifiable('binance_futures')).toBe(false)
    expect(isCexVerifiable('bitget_spot')).toBe(false)
    expect(isCexVerifiable('gateio')).toBe(false)
    expect(isCexVerifiable('htx_futures')).toBe(false)
  })
})
