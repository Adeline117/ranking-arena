import { apiFetch, ApiFetchError } from '../api-fetch'

// Helper to create a mock Response-like object
function mockResponse(body: unknown, init: { status: number; statusText: string; ok: boolean }) {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText,
    json: () => Promise.resolve(body),
  } as Response
}

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>
global.fetch = mockFetch

afterEach(() => {
  mockFetch.mockReset()
  jest.useRealTimers()
})

describe('ApiFetchError', () => {
  it('has correct properties', () => {
    const err = new ApiFetchError(404, 'Not Found', '/api/test')
    expect(err.status).toBe(404)
    expect(err.statusText).toBe('Not Found')
    expect(err.url).toBe('/api/test')
    expect(err.name).toBe('ApiFetchError')
    expect(err.message).toBe('API 404 Not Found: /api/test')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('apiFetch', () => {
  it('returns parsed JSON on successful response', async () => {
    const data = { traders: [{ id: 1 }] }
    mockFetch.mockResolvedValueOnce(mockResponse(data, { status: 200, statusText: 'OK', ok: true }))

    const result = await apiFetch<{ traders: { id: number }[] }>('/api/traders')
    expect(result).toEqual(data)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/traders',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('throws ApiFetchError on 404 response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(null, { status: 404, statusText: 'Not Found', ok: false })
    )

    await expect(apiFetch('/api/missing')).rejects.toThrow(ApiFetchError)

    // Verify error details
    mockFetch.mockResolvedValueOnce(
      mockResponse(null, { status: 404, statusText: 'Not Found', ok: false })
    )
    try {
      await apiFetch('/api/missing')
    } catch (e) {
      const err = e as ApiFetchError
      expect(err.status).toBe(404)
      expect(err.statusText).toBe('Not Found')
      expect(err.url).toBe('/api/missing')
    }
  })

  it('throws ApiFetchError on 500 response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(null, { status: 500, statusText: 'Internal Server Error', ok: false })
    )

    try {
      await apiFetch('/api/broken')
      throw new Error('Expected ApiFetchError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiFetchError)
      const err = e as ApiFetchError
      expect(err.status).toBe(500)
      expect(err.statusText).toBe('Internal Server Error')
      expect(err.url).toBe('/api/broken')
    }
  })

  it('physically rejects at the deadline when fetch ignores its AbortSignal', async () => {
    jest.useFakeTimers()
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => undefined))

    const request = apiFetch('/api/test', { timeoutMs: 5_000 })
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
    await jest.advanceTimersByTimeAsync(5_000)
    await rejection
  })

  it('uses the same physical deadline for a stuck JSON decoder', async () => {
    jest.useFakeTimers()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise<unknown>(() => undefined),
    } as Response)

    const request = apiFetch('/api/test', { timeoutMs: 2_000 })
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
    await jest.advanceTimersByTimeAsync(2_000)
    await rejection
  })

  it('combines caller cancellation with the hard deadline', async () => {
    const caller = new AbortController()
    mockFetch.mockResolvedValueOnce(mockResponse({}, { status: 200, statusText: 'OK', ok: true }))

    await apiFetch('/api/test', { signal: caller.signal })

    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchCall[1]?.signal).not.toBe(caller.signal)
  })

  it('physically rejects when the caller aborts and fetch ignores it', async () => {
    const caller = new AbortController()
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => undefined))

    const request = apiFetch('/api/test', { signal: caller.signal })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort(new DOMException('cancelled', 'AbortError'))
    await rejection
  })

  it('does not start a request for an already-aborted caller', async () => {
    const caller = new AbortController()
    caller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(apiFetch('/api/test', { signal: caller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('passes through additional fetch options', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, { status: 200, statusText: 'OK', ok: true }))

    await apiFetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    })

    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.method).toBe('POST')
    expect((fetchCall[1]?.headers as Record<string, string>)?.['Content-Type']).toBe(
      'application/json'
    )
  })

  it('throws on network error (fetch rejects)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(apiFetch('/api/offline')).rejects.toThrow('Failed to fetch')
  })

  it('throws on abort signal timeout', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    mockFetch.mockRejectedValueOnce(abortError)

    await expect(apiFetch('/api/slow')).rejects.toThrow('The operation was aborted')
  })
})
