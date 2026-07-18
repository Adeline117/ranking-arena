import { readCurrentOAuthAccessToken, requestExchangeOAuthUrl } from '../oauth-client'

describe('readCurrentOAuthAccessToken', () => {
  it('returns the current token only for the expected viewer', async () => {
    const getSession = jest.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'refreshed-token',
          user: { id: 'user-1' },
        },
      },
      error: null,
    })

    await expect(readCurrentOAuthAccessToken(getSession, 'user-1')).resolves.toBe('refreshed-token')
  })

  it.each([
    {
      label: 'session read error',
      result: {
        data: { session: null },
        error: new Error('refresh failed'),
      },
      expectedUserId: 'user-1',
    },
    {
      label: 'missing session',
      result: {
        data: { session: null },
        error: null,
      },
      expectedUserId: 'user-1',
    },
    {
      label: 'viewer switch',
      result: {
        data: {
          session: {
            access_token: 'other-token',
            user: { id: 'user-2' },
          },
        },
        error: null,
      },
      expectedUserId: 'user-1',
    },
  ])('fails closed on $label', async ({ result, expectedUserId }) => {
    const getSession = jest.fn().mockResolvedValue(result)

    await expect(readCurrentOAuthAccessToken(getSession, expectedUserId)).rejects.toThrow()
  })
})

describe('requestExchangeOAuthUrl', () => {
  it('authenticates the protected authorize request without sending a userId', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ authUrl: 'https://exchange.example/authorize' }),
    })

    await expect(requestExchangeOAuthUrl('binance', 'access-token', fetcher)).resolves.toBe(
      'https://exchange.example/authorize'
    )

    expect(fetcher).toHaveBeenCalledWith('/api/exchange/oauth/authorize?exchange=binance', {
      headers: { Authorization: 'Bearer access-token' },
    })
    expect(fetcher.mock.calls[0][0]).not.toContain('userId')
  })

  it.each([
    {
      label: 'non-2xx response',
      response: {
        ok: false,
        json: jest.fn().mockResolvedValue({ error: 'Unauthorized' }),
      },
    },
    {
      label: 'malformed success response',
      response: {
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      },
    },
    {
      label: 'invalid JSON response',
      response: {
        ok: false,
        json: jest.fn().mockRejectedValue(new Error('invalid json')),
      },
    },
  ])('rejects a $label', async ({ response }) => {
    const fetcher = jest.fn().mockResolvedValue(response)

    await expect(requestExchangeOAuthUrl('binance', 'access-token', fetcher)).rejects.toThrow()
  })
})
