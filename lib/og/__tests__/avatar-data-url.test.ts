import { fetchOgAvatarDataUrl } from '../avatar-data-url'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

function pngBytes(): Uint8Array {
  return Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0))
}

function response(
  body: Uint8Array | null,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const status = init.status ?? 200
  const bytes = body ?? new Uint8Array()
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  let delivered = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response
}

describe('fetchOgAvatarDataUrl', () => {
  it('accepts a bounded PNG data URL without using a fetch implementation', async () => {
    const fetchImpl = jest.fn()

    await expect(
      fetchOgAvatarDataUrl(PNG_DATA_URL, {
        proxyBaseUrl: 'https://www.arenafi.org',
        fetchImpl,
      })
    ).resolves.toBe(PNG_DATA_URL)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    'data:image/webp;base64,UklGRg==',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,not_base64!',
    'data:image/png;base64,iVBORw0KGgo=',
    'data:text/html;base64,PGgxPmJvb208L2gxPg==',
  ])('rejects an unsafe embedded payload: %s', async (avatarUrl) => {
    await expect(
      fetchOgAvatarDataUrl(avatarUrl, {
        proxyBaseUrl: 'https://www.arenafi.org',
      })
    ).resolves.toBeNull()
  })

  it('accepts a bounded JPEG data URL and canonicalizes its MIME', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9)
    let binary = ''
    for (const byte of jpeg) binary += String.fromCharCode(byte)

    await expect(
      fetchOgAvatarDataUrl(`data:image/jpg;base64,${btoa(binary)}`, {
        proxyBaseUrl: 'https://www.arenafi.org',
      })
    ).resolves.toBe(`data:image/jpeg;base64,${btoa(binary)}`)
  })

  it('fetches a remote avatar only through the same-origin proxy', async () => {
    const fetchImpl = jest.fn(async () =>
      response(pngBytes(), {
        status: 200,
        headers: {
          'content-type': 'image/png; charset=binary',
          'content-length': String(pngBytes().byteLength),
        },
      })
    )

    await expect(
      fetchOgAvatarDataUrl('https://cdn.example.com/a.png?x=1', {
        proxyBaseUrl: 'https://www.arenafi.org/',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toBe(PNG_DATA_URL)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://www.arenafi.org/api/avatar?url=https%3A%2F%2Fcdn.example.com%2Fa.png%3Fx%3D1'
    )
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['unsupported MIME', { 'content-type': 'image/webp' }, pngBytes()],
    ['mislabeled body', { 'content-type': 'image/png' }, Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)],
    [
      'invalid content length',
      { 'content-type': 'image/png', 'content-length': 'NaN' },
      pngBytes(),
    ],
    [
      'oversized content length',
      { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024 + 1) },
      pngBytes(),
    ],
  ])('rejects a remote %s response', async (_label, headers, body) => {
    const fetchImpl = jest.fn(async () => response(body, { status: 200, headers }))

    await expect(
      fetchOgAvatarDataUrl('https://cdn.example.com/avatar', {
        proxyBaseUrl: 'https://www.arenafi.org',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toBeNull()
  })

  it('rejects an oversized body even without a content-length header', async () => {
    const body = new Uint8Array(2 * 1024 * 1024 + 1)
    const fetchImpl = jest.fn(async () =>
      response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    )

    await expect(
      fetchOgAvatarDataUrl('https://cdn.example.com/avatar', {
        proxyBaseUrl: 'https://www.arenafi.org',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toBeNull()
  })

  it.each([
    ['not a URL', 'https://www.arenafi.org'],
    ['ftp://cdn.example.com/avatar', 'https://www.arenafi.org'],
    ['https://cdn.example.com/avatar', 'javascript:alert(1)'],
  ])('rejects invalid source or proxy URLs', async (avatarUrl, proxyBaseUrl) => {
    const fetchImpl = jest.fn()

    await expect(
      fetchOgAvatarDataUrl(avatarUrl, {
        proxyBaseUrl,
        fetchImpl,
      })
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed on proxy errors and non-success responses', async () => {
    const failedFetch = jest.fn(async () => {
      throw new Error('network failed')
    })
    const missingFetch = jest.fn(async () => response(null, { status: 404 }))

    await expect(
      fetchOgAvatarDataUrl('https://cdn.example.com/avatar', {
        proxyBaseUrl: 'https://www.arenafi.org',
        fetchImpl: failedFetch as typeof fetch,
      })
    ).resolves.toBeNull()
    await expect(
      fetchOgAvatarDataUrl('https://cdn.example.com/avatar', {
        proxyBaseUrl: 'https://www.arenafi.org',
        fetchImpl: missingFetch as typeof fetch,
      })
    ).resolves.toBeNull()
  })
})
