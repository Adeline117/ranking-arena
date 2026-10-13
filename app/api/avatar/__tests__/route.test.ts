/**
 * @jest-environment node
 */
const mockLookup = jest.fn()
jest.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => mockLookup(...args) }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const IMMUTABLE = /immutable/

function req(target: string) {
  return new NextRequest(`https://www.arenafi.org/api/avatar?url=${encodeURIComponent(target)}`)
}

describe('GET /api/avatar SSRF hardening', () => {
  const fetchMock = jest.fn()
  const OLD_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL

  beforeEach(() => {
    fetchMock.mockReset()
    mockLookup.mockReset()
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://myproj.supabase.co'
  })
  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_ENV
  })

  it('serves an allowlisted image with immutable cache and manual redirects', async () => {
    fetchMock.mockResolvedValueOnce(new Response(PNG, { headers: { 'content-type': 'image/png' } }))
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toMatch(IMMUTABLE)
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('only allows this project Supabase host, not arbitrary *.supabase.co', async () => {
    const res = await GET(req('https://attacker.supabase.co/storage/v1/x.png'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)

    fetchMock.mockResolvedValueOnce(new Response(PNG, { headers: { 'content-type': 'image/png' } }))
    const ok = await GET(req('https://myproj.supabase.co/storage/v1/x.png'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ok.headers.get('cache-control')).toMatch(IMMUTABLE)
  })

  it('does not follow a redirect to cloud metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      })
    )
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
  })

  it('does not follow a redirect to a non-allowlisted host', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 301, headers: { location: 'https://evil.test/x.png' } })
    )
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
  })

  it('also applies manual redirects on the minimal-header retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })
      )
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].redirect).toBe('manual')
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
  })

  it('refuses non-image payloads instead of caching them for a year', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } })
    )
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('sniffs real images labelled application/octet-stream', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } })
    )
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(res.headers.get('cache-control')).toMatch(IMMUTABLE)
  })

  it('caps streamed body size (chunked, no Content-Length)', async () => {
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG)
        for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(1024 * 1024))
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(big, { headers: { 'content-type': 'image/png' } }))
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
  })

  it('rejects allowlisted hosts resolving to private IPs', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    const res = await GET(req('https://cdn.bnbstatic.com/a.png'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.headers.get('cache-control')).not.toMatch(IMMUTABLE)
  })
})
