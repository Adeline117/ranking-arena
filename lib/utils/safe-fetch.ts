/**
 * SSRF-hardened outbound fetch helpers for server-side proxies.
 *
 * - Redirects are never followed automatically (`redirect: 'manual'`); each hop
 *   is resolved against the previous URL and re-validated with the caller's
 *   allowlist AND a DNS check that rejects private / reserved addresses.
 * - Response bodies are read through a streamed byte counter so a chunked
 *   response without Content-Length cannot exceed the cap.
 *
 * Server-only (uses node:dns).
 */

import { lookup as dnsLookup } from 'node:dns/promises'

export type SafeFetchErrorCode =
  | 'blocked' // allowlist miss, private IP, unsupported protocol, DNS failure
  | 'too_many_redirects'
  | 'invalid_redirect'
  | 'too_large'

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
  }
}

/** Reject IPv4/IPv6 addresses that point at private, loopback, link-local, or cloud-metadata ranges. */
export function isPrivateIP(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // 10.0.0.0/8 private
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
    if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF
    if (a === 192 && b === 168) return true // 192.168.0.0/16 private
    if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
    if (a >= 224) return true // 224.0.0.0/4 multicast + reserved
    return false
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v6.includes(':')) {
    if (v6 === '::' || v6 === '::1') return true // unspecified, loopback
    if (/^fe[89ab]/.test(v6)) return true // fe80::/10 link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true // fc00::/7 unique-local
    if (v6.startsWith('ff')) return true // ff00::/8 multicast
    const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return isPrivateIP(mapped[1])
    if (v6.startsWith('::ffff:')) return true // hex-form IPv4-mapped — never legitimate here
    if (v6.startsWith('2002:')) return true // 6to4 — could tunnel to private
    return false
  }
  return false
}

/**
 * Throws SafeFetchError('blocked') unless every address the hostname resolves to
 * is public. DNS failure fails closed.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const stripped = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    stripped === 'localhost' ||
    stripped.endsWith('.localhost') ||
    stripped.endsWith('.internal')
  ) {
    throw new SafeFetchError('blocked', `blocked hostname ${stripped}`)
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(stripped) || stripped.includes(':')) {
    if (isPrivateIP(stripped)) throw new SafeFetchError('blocked', 'private IP literal')
    return
  }
  let records: Array<{ address: string }>
  try {
    records = await dnsLookup(stripped, { all: true })
  } catch {
    throw new SafeFetchError('blocked', `DNS resolution failed for ${stripped}`)
  }
  if (records.length === 0) throw new SafeFetchError('blocked', 'no DNS records')
  for (const r of records) {
    if (isPrivateIP(r.address)) {
      throw new SafeFetchError('blocked', `${stripped} resolves to private IP`)
    }
  }
}

export interface SafeFetchOptions {
  /** Allowlist check applied to the initial URL and every redirect hop. */
  isAllowed: (url: URL) => boolean
  /** Request init for each hop (headers etc.). `redirect` is always forced to 'manual'. */
  init?: (url: URL) => RequestInit
  maxRedirects?: number
  signal?: AbortSignal
}

/**
 * Fetch `rawUrl`, following up to `maxRedirects` redirects manually and
 * re-validating every hop. Returns the final non-redirect response (body unread).
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions
): Promise<{ response: Response; finalUrl: URL }> {
  const maxRedirects = opts.maxRedirects ?? 3
  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    throw new SafeFetchError('blocked', 'invalid URL')
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new SafeFetchError('blocked', `protocol ${current.protocol} not allowed`)
    }
    if (current.username || current.password) {
      throw new SafeFetchError('blocked', 'credentials in URL not allowed')
    }
    if (!opts.isAllowed(current)) {
      throw new SafeFetchError('blocked', `host ${current.hostname} not allowlisted`)
    }
    await assertPublicHost(current.hostname)

    const init = opts.init?.(current) ?? {}
    const response = await fetch(current.href, {
      ...init,
      signal: opts.signal ?? init.signal,
      redirect: 'manual',
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      // Drain/cancel the redirect body so the socket is released.
      try {
        await response.body?.cancel()
      } catch {
        /* body already closed */
      }
      if (!location) throw new SafeFetchError('invalid_redirect', 'redirect without Location')
      try {
        current = new URL(location, current)
      } catch {
        throw new SafeFetchError('invalid_redirect', 'unparseable redirect Location')
      }
      continue
    }
    return { response, finalUrl: current }
  }
  throw new SafeFetchError('too_many_redirects', `more than ${maxRedirects} redirects`)
}

/**
 * Read a response body with a hard byte cap enforced while streaming
 * (Content-Length is only used as an early reject, never trusted alone).
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel()
    } catch {
      /* ignore */
    }
    throw new SafeFetchError('too_large', `declared ${declared} bytes > cap ${maxBytes}`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw new SafeFetchError('too_large', `body exceeded cap ${maxBytes}`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}
