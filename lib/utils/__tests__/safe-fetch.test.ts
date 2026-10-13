/**
 * @jest-environment node
 */
const mockLookup = jest.fn()
jest.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => mockLookup(...args) }))

import { isPrivateIP, readBodyCapped, safeFetch, SafeFetchError } from '../safe-fetch'

const allowExample = (u: URL) => u.hostname === 'example.com' || u.hostname.endsWith('.example.com')

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } })
}

describe('isPrivateIP', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '172.20.0.1',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('blocks %s', (ip) => expect(isPrivateIP(ip)).toBe(true))
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111'])('allows %s', (ip) =>
    expect(isPrivateIP(ip)).toBe(false)
  )
})

describe('safeFetch', () => {
  const fetchMock = jest.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    mockLookup.mockReset()
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('always uses redirect: manual', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok'))
    await safeFetch('https://example.com/a.png', { isAllowed: allowExample })
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('re-validates allowlist on each redirect hop', async () => {
    fetchMock.mockResolvedValueOnce(redirect('https://evil.test/x'))
    await expect(
      safeFetch('https://example.com/a.png', { isAllowed: allowExample })
    ).rejects.toMatchObject({ code: 'blocked' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('blocks redirect to an allowlisted host that resolves to a private IP', async () => {
    fetchMock.mockResolvedValueOnce(redirect('https://internal.example.com/meta'))
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    await expect(
      safeFetch('https://example.com/a.png', { isAllowed: allowExample })
    ).rejects.toMatchObject({ code: 'blocked' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('blocks redirect to an IP literal / non-http protocol', async () => {
    fetchMock.mockResolvedValueOnce(redirect('http://127.0.0.1/'))
    await expect(
      safeFetch('https://example.com/a', { isAllowed: () => true })
    ).rejects.toMatchObject({ code: 'blocked' })
    fetchMock.mockResolvedValueOnce(redirect('file:///etc/passwd'))
    await expect(
      safeFetch('https://example.com/a', { isAllowed: () => true })
    ).rejects.toMatchObject({ code: 'blocked' })
  })

  it('follows relative redirects and caps hop count', async () => {
    fetchMock.mockResolvedValueOnce(redirect('/b')).mockResolvedValueOnce(new Response('final'))
    const { finalUrl } = await safeFetch('https://example.com/a', { isAllowed: allowExample })
    expect(finalUrl.href).toBe('https://example.com/b')

    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => redirect('/loop'))
    await expect(
      safeFetch('https://example.com/a', { isAllowed: allowExample, maxRedirects: 3 })
    ).rejects.toMatchObject({ code: 'too_many_redirects' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('fails closed when DNS resolution fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    await expect(
      safeFetch('https://example.com/a', { isAllowed: allowExample })
    ).rejects.toBeInstanceOf(SafeFetchError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('readBodyCapped', () => {
  it('rejects oversized declared Content-Length', async () => {
    const res = new Response('x', { headers: { 'content-length': '999' } })
    await expect(readBodyCapped(res, 10)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('rejects chunked bodies that exceed the cap while streaming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(4))
        controller.close()
      },
    })
    await expect(readBodyCapped(new Response(stream), 10)).rejects.toMatchObject({
      code: 'too_large',
    })
  })

  it('returns the body when under the cap', async () => {
    const buf = await readBodyCapped(new Response('hello'), 10)
    expect(buf.toString()).toBe('hello')
  })
})
