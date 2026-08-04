import { fetchMarketJson, MarketHttpError } from './market-fetch'

describe('market request physical deadline', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('terminates when the transport ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const fetchImpl = jest.fn(() => new Promise<Response>(() => undefined))
    const request = fetchMarketJson('/market', { fetchImpl, timeoutMs: 50 })
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })

    await jest.advanceTimersByTimeAsync(50)

    await rejection
  })

  it('terminates when response.json ignores AbortSignal and observes its late result', async () => {
    jest.useFakeTimers()
    let resolveBody!: (value: unknown) => void
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve
    })
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      json: () => body,
    } as Response)
    const request = fetchMarketJson('/market', { fetchImpl, timeoutMs: 50 })
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })

    await jest.advanceTimersByTimeAsync(50)
    await rejection

    resolveBody({ late: true })
    await Promise.resolve()
  })

  it('physically rejects an obsolete caller even if the transport later succeeds', async () => {
    let resolveResponse!: (response: Response) => void
    const transport = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const controller = new AbortController()
    const request = fetchMarketJson('/market', {
      fetchImpl: jest.fn(() => transport),
      callerSignal: controller.signal,
    })

    controller.abort(new DOMException('obsolete market scope', 'AbortError'))
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })

    resolveResponse(
      new Response(JSON.stringify({ late: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    await Promise.resolve()
  })

  it('requires exact HTTP 200', async () => {
    const request = fetchMarketJson('/market', {
      fetchImpl: jest.fn().mockResolvedValue({
        status: 206,
        headers: new Headers(),
        json: jest.fn(),
      } as unknown as Response),
    })

    await expect(request).rejects.toBeInstanceOf(MarketHttpError)
  })
})
