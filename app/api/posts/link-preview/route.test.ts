jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Map<string, string>

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockDnsLookup = jest.fn()
jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}))

const mockUndiciFetch = jest.fn()
const mockAgentOptions = jest.fn()
const mockDispatcherClose = jest.fn()
const mockPinnedConnect = jest.fn()
jest.mock('undici', () => ({
  Agent: function MockAgent(options: unknown) {
    mockAgentOptions(options)
    return { close: mockDispatcherClose }
  },
  buildConnector: () => mockPinnedConnect,
  fetch: (...args: unknown[]) => mockUndiciFetch(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {} },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), error: jest.fn() },
}))

import { GET } from './route'

type UpstreamResponseOptions = {
  body?: string
  headers?: Record<string, string>
  status?: number
}

type ConnectOptions = {
  host: string
  hostname: string
  port: string
  protocol: string
  servername?: string | null
}

type AgentOptions = {
  connect: (options: ConnectOptions, callback: jest.Mock) => void
}

function upstreamResponse({ body = '', headers = {}, status = 200 }: UpstreamResponseOptions = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  )
  const bytes = Uint8Array.from(Buffer.from(body))
  let sent = false
  const cancel = jest.fn().mockResolvedValue(undefined)

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
    body: {
      cancel,
      getReader: () => ({
        cancel,
        read: jest.fn(async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        }),
      }),
    },
  }
}

function request(target: string) {
  return {
    url: `https://arena.test/api/posts/link-preview?url=${encodeURIComponent(target)}`,
  }
}

function runAgentConnect(index: number, options: ConnectOptions) {
  const agentOptions = mockAgentOptions.mock.calls[index]?.[0] as AgentOptions
  const callback = jest.fn()
  agentOptions.connect(options, callback)
  return callback
}

describe('link preview URL authority', () => {
  beforeEach(() => {
    mockDnsLookup.mockReset()
    mockUndiciFetch.mockReset()
    mockAgentOptions.mockClear()
    mockDispatcherClose.mockReset()
    mockPinnedConnect.mockClear()
    mockDispatcherClose.mockResolvedValue(undefined)
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })

  it('pins the network URL while preserving Host, explicit TLS servername, and receipt URL semantics', async () => {
    mockUndiciFetch.mockResolvedValue(
      upstreamResponse({
        body: [
          '<meta property="og:title" content="Pinned preview">',
          '<meta property="og:description" content="Trusted description">',
          '<meta property="og:image" content="cover.jpg">',
        ].join(''),
      })
    )

    const response = await GET(
      request('https://preview.example:8443/articles/start?source=arena') as never
    )

    expect(mockDnsLookup).toHaveBeenCalledWith('preview.example', { all: true })
    expect(mockAgentOptions).toHaveBeenCalledWith({ connect: expect.any(Function) })
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      'https://preview.example:8443/articles/start?source=arena',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Host: expect.anything() }),
        redirect: 'manual',
      })
    )
    const connectOptions = {
      host: 'preview.example:8443',
      hostname: 'preview.example',
      port: '8443',
      protocol: 'https:',
    }
    const callback = runAgentConnect(0, connectOptions)
    expect(mockPinnedConnect).toHaveBeenCalledWith(
      { ...connectOptions, hostname: '93.184.216.34', servername: 'preview.example' },
      callback
    )
    expect(mockDispatcherClose).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400'
    )
    expect(await response.json()).toEqual({
      title: 'Pinned preview',
      description: 'Trusted description',
      image: 'https://preview.example:8443/articles/cover.jpg',
    })
  })

  it('resolves a relative redirect against the logical URL and revalidates DNS before repinning', async () => {
    mockDnsLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.35', family: 4 }])
    mockUndiciFetch
      .mockResolvedValueOnce(upstreamResponse({ status: 302, headers: { Location: '/article' } }))
      .mockResolvedValueOnce(
        upstreamResponse({ body: '<meta property="og:title" content="Redirected">' })
      )

    const response = await GET(request('https://preview.example/start') as never)

    expect(mockDnsLookup).toHaveBeenNthCalledWith(1, 'preview.example', { all: true })
    expect(mockDnsLookup).toHaveBeenNthCalledWith(2, 'preview.example', { all: true })
    expect(mockUndiciFetch).toHaveBeenNthCalledWith(
      1,
      'https://preview.example/start',
      expect.objectContaining({ redirect: 'manual' })
    )
    expect(mockUndiciFetch).toHaveBeenNthCalledWith(
      2,
      'https://preview.example/article',
      expect.objectContaining({ redirect: 'manual' })
    )
    const connectOptions = {
      host: 'preview.example',
      hostname: 'preview.example',
      port: '443',
      protocol: 'https:',
    }
    const firstCallback = runAgentConnect(0, connectOptions)
    const secondCallback = runAgentConnect(1, connectOptions)
    expect(mockPinnedConnect).toHaveBeenNthCalledWith(
      1,
      { ...connectOptions, hostname: '93.184.216.34', servername: 'preview.example' },
      firstCallback
    )
    expect(mockPinnedConnect).toHaveBeenNthCalledWith(
      2,
      { ...connectOptions, hostname: '93.184.216.35', servername: 'preview.example' },
      secondCallback
    )
    expect(mockDispatcherClose).toHaveBeenCalledTimes(2)
    expect(await response.json()).toEqual({ title: 'Redirected', description: '', image: '' })
  })

  it('rejects an absolute private redirect before opening a second connection', async () => {
    mockUndiciFetch.mockResolvedValue(
      upstreamResponse({ status: 302, headers: { Location: 'http://127.0.0.1/admin' } })
    )

    const response = await GET(request('https://preview.example/start') as never)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'blocked: private/reserved IP literal' })
    expect(mockDnsLookup).toHaveBeenCalledTimes(1)
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1)
    expect(mockDispatcherClose).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['hexadecimal IPv4-mapped loopback', '::ffff:7f00:1', 6],
    ['IPv4-mapped public embedding', '::ffff:808:808', 6],
    ['IPv4-compatible embedding', '::808:808', 6],
    ['IPv4-translatable embedding', '::ffff:0:808:808', 6],
    ['NAT64 well-known prefix', '64:ff9b::808:808', 6],
    ['NAT64 local-use prefix', '64:ff9b:1::808:808', 6],
    ['IPv6 discard-only prefix', '100::1', 6],
    ['6to4 embedding', '2002:808:808::', 6],
    ['IPv6 documentation prefix', '2001:db8::1', 6],
    ['new IPv6 documentation prefix', '3fff::1', 6],
    ['deprecated IPv6 site-local prefix', 'fec0::1', 6],
    ['IPv4 documentation prefix', '192.0.2.1', 4],
    ['IPv4 benchmark prefix', '198.18.0.1', 4],
    ['second IPv4 documentation prefix', '198.51.100.1', 4],
    ['third IPv4 documentation prefix', '203.0.113.1', 4],
  ])('rejects a DNS result using %s before fetch', async (_label, address, family) => {
    mockDnsLookup.mockResolvedValue([{ address, family }])

    const response = await GET(request('https://preview.example/start') as never)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `blocked: hostname resolves to private IP ${address}`,
    })
    expect(mockDnsLookup).toHaveBeenCalledTimes(1)
    expect(mockAgentOptions).not.toHaveBeenCalled()
    expect(mockUndiciFetch).not.toHaveBeenCalled()
  })

  it('keeps a globally routable DNS IPv6 answer as the pinned connector destination', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }])
    mockUndiciFetch.mockResolvedValue(
      upstreamResponse({ body: '<meta property="og:title" content="Public IPv6">' })
    )

    const response = await GET(request('https://preview.example/v6') as never)

    expect(mockUndiciFetch).toHaveBeenCalledWith(
      'https://preview.example/v6',
      expect.objectContaining({ redirect: 'manual' })
    )
    const connectOptions = {
      host: 'preview.example',
      hostname: 'preview.example',
      port: '443',
      protocol: 'https:',
    }
    const callback = runAgentConnect(0, connectOptions)
    expect(mockPinnedConnect).toHaveBeenCalledWith(
      {
        ...connectOptions,
        hostname: '2606:4700:4700::1111',
        servername: 'preview.example',
      },
      callback
    )
    expect(await response.json()).toEqual({ title: 'Public IPv6', description: '', image: '' })
  })

  it('never forwards a bracketed HTTPS IPv6 literal as TLS servername', async () => {
    mockUndiciFetch.mockResolvedValue(
      upstreamResponse({ body: '<meta property="og:title" content="Literal IPv6">' })
    )

    const response = await GET(request('https://[2606:4700:4700::1111]/v6') as never)

    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      'https://[2606:4700:4700::1111]/v6',
      expect.objectContaining({ redirect: 'manual' })
    )
    const connectOptions = {
      host: '[2606:4700:4700::1111]',
      hostname: '2606:4700:4700::1111',
      port: '443',
      protocol: 'https:',
      servername: '[2606:4700:4700::1111]',
    }
    const callback = runAgentConnect(0, connectOptions)
    expect(mockPinnedConnect).toHaveBeenCalledWith(
      {
        ...connectOptions,
        hostname: '2606:4700:4700::1111',
        servername: undefined,
      },
      callback
    )
    expect(await response.json()).toEqual({ title: 'Literal IPv6', description: '', image: '' })
  })

  it('stops after the bounded redirect receipt count', async () => {
    mockUndiciFetch.mockImplementation(async () =>
      upstreamResponse({
        status: 302,
        headers: { Location: `/hop-${mockUndiciFetch.mock.calls.length}` },
      })
    )

    const response = await GET(request('https://preview.example/start') as never)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Too many redirects or empty body' })
    expect(mockDnsLookup).toHaveBeenCalledTimes(4)
    expect(mockUndiciFetch).toHaveBeenCalledTimes(4)
    expect(mockAgentOptions).toHaveBeenCalledTimes(4)
    expect(mockDispatcherClose).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['non-HTTP scheme', 'ftp://preview.example/file', 'Only HTTP/HTTPS URLs are allowed'],
    [
      'embedded credentials',
      'https://user:secret@preview.example/file',
      'URL credentials are not allowed',
    ],
    [
      'private literal',
      'http://169.254.169.254/latest/meta-data',
      'blocked: private/reserved IP literal',
    ],
  ])('rejects %s without DNS or a network connection', async (_label, target, error) => {
    const response = await GET(request(target) as never)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockUndiciFetch).not.toHaveBeenCalled()
    expect(mockAgentOptions).not.toHaveBeenCalled()
  })

  describe('metadata extraction', () => {
    async function preview(body: string) {
      mockUndiciFetch.mockResolvedValue(upstreamResponse({ body }))
      const response = await GET(request('https://preview.example/articles/page') as never)
      expect(response.status).toBe(200)
      return response.json()
    }

    it('accepts content before property or name', async () => {
      await expect(
        preview(
          [
            '<meta content="Content-first title" property="og:title">',
            '<meta content="Content-first description" name="description">',
            '<meta content="/content-first.jpg" property="og:image">',
          ].join('')
        )
      ).resolves.toEqual({
        title: 'Content-first title',
        description: 'Content-first description',
        image: 'https://preview.example/content-first.jpg',
      })
    })

    it('handles mixed-case names, whitespace, quotes, and a quoted greater-than sign', async () => {
      await expect(
        preview(
          [
            '<MeTa\n CoNtEnT = \'A > B\'\tPrOpErTy = "OG:TITLE" >',
            '<META PROPERTY=og:description CONTENT="First > second">',
          ].join('')
        )
      ).resolves.toEqual({
        title: 'A > B',
        description: 'First > second',
        image: '',
      })
    })

    it('supports valid unquoted attribute values', async () => {
      await expect(
        preview(
          [
            '<meta property=og:title content=Unquoted>',
            '<meta name=description content=Fallback>',
            '<meta property=og:image content=/unquoted.png?large>',
          ].join('')
        )
      ).resolves.toEqual({
        title: 'Unquoted',
        description: 'Fallback',
        image: 'https://preview.example/unquoted.png?large',
      })
    })

    it('gives Open Graph fields priority even when fallbacks occur first', async () => {
      await expect(
        preview(
          [
            '<title>Document title</title>',
            '<meta name="description" content="Document description">',
            '<meta property="og:title" content="Open Graph title">',
            '<meta property="og:description" content="Open Graph description">',
          ].join('')
        )
      ).resolves.toEqual({
        title: 'Open Graph title',
        description: 'Open Graph description',
        image: '',
      })
    })

    it('decodes common named and safe numeric entities, including image queries', async () => {
      await expect(
        preview(
          [
            '<meta property="og:title" content="Tom &amp; Jerry &#x2014; &#169;">',
            '<meta property="og:description" content="One&nbsp;two &hellip; &#128512;">',
            '<meta property="og:image" content="/cover?one=1&amp;two=&#50;">',
          ].join('')
        )
      ).resolves.toEqual({
        title: 'Tom & Jerry — ©',
        description: 'One\u00a0two … 😀',
        image: 'https://preview.example/cover?one=1&two=2',
      })
    })

    it('preserves unknown or unsafe numeric entities literally', async () => {
      await expect(
        preview('<meta property="og:title" content="&unknown; &#0; &#xD800; &#x110000;">')
      ).resolves.toEqual({
        title: '&unknown; &#0; &#xD800; &#x110000;',
        description: '',
        image: '',
      })
    })

    it('uses the first duplicate attribute and first non-empty field deterministically', async () => {
      await expect(
        preview(
          [
            '<meta property="og:title" property="og:description" content="First">',
            '<meta property="og:title" content="Second">',
            '<meta property="og:description" content="Description one">',
            '<meta property="og:description" content="Description two">',
          ].join('')
        )
      ).resolves.toEqual({ title: 'First', description: 'Description one', image: '' })
    })

    it('does not combine attributes across separate or malformed tags', async () => {
      await expect(
        preview(
          [
            '<meta property="og:title">',
            '<meta content="Must not cross">',
            '<meta property="og:description" content=>',
            '<title data-label="1 > 0">Safe title</title>',
          ].join('')
        )
      ).resolves.toEqual({ title: 'Safe title', description: '', image: '' })
    })

    it('ignores meta-looking text inside a title element', async () => {
      await expect(
        preview('<title>Text <meta property="og:title" content="Injected"></title>')
      ).resolves.toEqual({
        title: 'Text <meta property="og:title" content="Injected">',
        description: '',
        image: '',
      })
    })

    it('ignores metadata lookalikes in comments, scripts, and other tag attributes', async () => {
      await expect(
        preview(
          [
            '<!-- <meta property="og:title" content="Comment"> -->',
            '<script>const fake = \'<meta property="og:title" content="Script">\'</script>',
            '<div data-fake=\'<meta property="og:title" content="Attribute">\'>',
            '<title>Real title</title>',
          ].join('')
        )
      ).resolves.toEqual({ title: 'Real title', description: '', image: '' })
    })

    it('caps decoded output fields and keeps surrogate pairs intact', async () => {
      const longTitle = `${'t'.repeat(511)}😀tail`
      const longDescription = `description-${'d'.repeat(3_000)}`
      const longImage = `/image?value=${'i'.repeat(5_000)}`
      const result = await preview(
        [
          `<meta property="og:title" content="${longTitle}">`,
          `<meta property="og:description" content="${longDescription}">`,
          `<meta property="og:image" content="${longImage}">`,
        ].join('')
      )

      expect(result.title).toBe('t'.repeat(511))
      expect(result.description).toHaveLength(2_048)
      expect(result.image).toBe('')
    })
  })
})
