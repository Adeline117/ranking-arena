import { requestExchangeOAuthUrl, resolveOAuthCallbackExchange } from '../oauth-client'

describe('requestExchangeOAuthUrl', () => {
  const viewer = {
    accessToken: 'access-token',
    sessionGeneration: 7,
    userId: 'user-1',
  }

  it('binds the request and strict navigation ACK to the exact viewer generation', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: {
          viewerId: 'user-1',
          exchange: 'binance',
          authUrl: 'https://accounts.binance.com/en/oauth/authorize?state=binance.nonce',
        },
      },
    })
    const controller = new AbortController()

    await expect(
      requestExchangeOAuthUrl('binance', viewer, controller.signal, fetcher)
    ).resolves.toContain('https://accounts.binance.com/')

    expect(fetcher).toHaveBeenCalledWith(
      '/api/exchange/oauth/authorize?exchange=binance',
      'GET',
      'access-token',
      undefined,
      15_000,
      {
        expectedUserId: 'user-1',
        expectedSessionGeneration: 7,
        signal: controller.signal,
      }
    )
    expect(fetcher.mock.calls[0][0]).not.toContain('userId')
  })

  it.each([
    {
      label: 'non-2xx response',
      response: {
        ok: false,
        status: 401,
        data: { error: 'Unauthorized' },
      },
    },
    {
      label: 'stale viewer result',
      response: {
        ok: false,
        status: 0,
        data: null,
        stale: true,
      },
    },
    {
      label: 'legacy top-level-only response',
      response: {
        ok: true,
        status: 200,
        data: { authUrl: 'https://accounts.binance.com/authorize' },
      },
    },
    {
      label: 'wrong viewer ACK',
      response: {
        ok: true,
        status: 200,
        data: {
          success: true,
          data: {
            viewerId: 'user-2',
            exchange: 'binance',
            authUrl: 'https://accounts.binance.com/authorize',
          },
        },
      },
    },
    {
      label: 'wrong exchange ACK',
      response: {
        ok: true,
        status: 200,
        data: {
          success: true,
          data: {
            viewerId: 'user-1',
            exchange: 'bybit',
            authUrl: 'https://accounts.binance.com/authorize',
          },
        },
      },
    },
    {
      label: 'unsafe navigation URL',
      response: {
        ok: true,
        status: 200,
        data: {
          success: true,
          data: {
            viewerId: 'user-1',
            exchange: 'binance',
            authUrl: 'javascript:alert(1)',
          },
        },
      },
    },
  ])('rejects a $label', async ({ response }) => {
    const fetcher = jest.fn().mockResolvedValue(response)

    await expect(requestExchangeOAuthUrl('binance', viewer, undefined, fetcher)).rejects.toThrow()
  })
})

describe('resolveOAuthCallbackExchange', () => {
  it('recovers the exchange from the state returned by the provider', () => {
    expect(resolveOAuthCallbackExchange(null, 'binance.0123456789abcdef')).toBe('binance')
    expect(resolveOAuthCallbackExchange(null, 'bybit.0123456789abcdef')).toBe('bybit')
  })

  it('accepts a matching legacy query parameter but rejects ambiguity', () => {
    expect(resolveOAuthCallbackExchange('binance', 'binance.nonce')).toBe('binance')
    expect(resolveOAuthCallbackExchange('binance', 'legacy-random-state')).toBe('binance')
    expect(resolveOAuthCallbackExchange('bybit', 'binance.nonce')).toBeNull()
    expect(resolveOAuthCallbackExchange('unsupported', 'unsupported.nonce')).toBeNull()
    expect(resolveOAuthCallbackExchange(null, 'legacy-random-state')).toBeNull()
  })
})
