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

// Mock AbortSignal.timeout
const mockSignal = { aborted: false } as AbortSignal
const originalTimeout = AbortSignal.timeout
beforeAll(() => {
  AbortSignal.timeout = jest.fn(() => mockSignal)
})
afterAll(() => {
  AbortSignal.timeout = originalTimeout
})

afterEach(() => {
  mockFetch.mockReset()
  ;(AbortSignal.timeout as jest.Mock).mockClear()
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
    mockFetch.mockResolvedValueOnce(
      mockResponse(data, { status: 200, statusText: 'OK', ok: true }),
    )

    const result = await apiFetch<{ traders: { id: number }[] }>('/api/traders')
    expect(result).toEqual(data)
    expect(mockFetch).toHaveBeenCalledWith('/api/traders', {
      signal: mockSignal,
    })
  })

  it('throws ApiFetchError on 404 response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(null, { status: 404, statusText: 'Not Found', ok: false }),
    )

    await expect(apiFetch('/api/missing')).rejects.toThrow(ApiFetchError)

    // Verify error details
    mockFetch.mockResolvedValueOnce(
      mockResponse(null, { status: 404, statusText: 'Not Found', ok: false }),
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
      mockResponse(null, { status: 500, statusText: 'Internal Server Error', ok: false }),
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

  it('uses AbortSignal.timeout with default 15000ms', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({}, { status: 200, statusText: 'OK', ok: true }),
    )

    await apiFetch('/api/test')
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000)
  })

  it('uses custom timeoutMs when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({}, { status: 200, statusText: 'OK', ok: true }),
    )

    await apiFetch('/api/test', { timeoutMs: 5000 })
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000)
  })

  it('preserves caller-provided signal instead of creating timeout signal', async () => {
    const customSignal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(
      mockResponse({}, { status: 200, statusText: 'OK', ok: true }),
    )

    await apiFetch('/api/test', { signal: customSignal })

    // The caller's signal takes precedence via the ?? operator
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.signal).toBe(customSignal)
  })

  it('passes through additional fetch options', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({}, { status: 200, statusText: 'OK', ok: true }),
    )

    await apiFetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    })

    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.method).toBe('POST')
    expect((fetchCall[1]?.headers as Record<string, string>)?.['Content-Type']).toBe(
      'application/json',
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
