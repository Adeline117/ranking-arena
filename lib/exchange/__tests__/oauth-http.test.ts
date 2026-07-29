import { fetchOAuthJsonWithTimeout } from '../oauth-http'

describe('OAuth HTTP deadlines', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  it('keeps the deadline active while consuming the response body', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn().mockImplementation(async (_url, init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        }),
    })) as jest.Mock

    const pending = fetchOAuthJsonWithTimeout('https://oauth.example/token', {}, 20_000)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    jest.advanceTimersByTime(20_000)
    await assertion
  })

  it('parses JSON and forwards the timeout signal', async () => {
    let signal: AbortSignal | null = null
    global.fetch = jest.fn().mockImplementation(async (_url, init: RequestInit) => {
      signal = init.signal ?? null
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '{"access_token":"access-token"}',
      }
    }) as jest.Mock

    await expect(
      fetchOAuthJsonWithTimeout('https://oauth.example/token', { method: 'POST' }, 20_000)
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { access_token: 'access-token' },
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  it('rejects oversized provider responses', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({ 'content-length': String(64 * 1024 + 1) }),
      text: jest.fn(),
    }) as jest.Mock

    await expect(
      fetchOAuthJsonWithTimeout('https://oauth.example/token', {}, 20_000)
    ).rejects.toThrow(/too large/)
  })
})
