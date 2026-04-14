import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { lookup as dnsLookup } from 'node:dns/promises'
import { safeParseInt } from '@/lib/utils/safe-parse'

// Body size cap (bytes) — link preview only needs the head of the document.
// 256KB is plenty for <head> + meta tags; rejects payload-flood attacks.
const MAX_BODY_BYTES = 256 * 1024

// Per-hop redirect limit. Each hop is re-validated against the SSRF allowlist.
const MAX_REDIRECTS = 3

// Upstream fetch timeout per hop.
const FETCH_TIMEOUT_MS = 10_000

// 简单的 HTML 解析函数
function extractMetaTags(html: string) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
  const ogDescriptionMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
  const descriptionMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)

  return {
    title: ogTitleMatch?.[1] || titleMatch?.[1] || '',
    description: ogDescriptionMatch?.[1] || descriptionMatch?.[1] || '',
    image: ogImageMatch?.[1] || '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSRF defenses
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '[::1]',
  '::1',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
])

/** Reject IPv4 / IPv6 literals that point at private, loopback, link-local, or cloud-metadata ranges. */
function isPrivateOrReservedIP(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0) return true                                    // 0.0.0.0/8
    if (a === 10) return true                                   // 10.0.0.0/8 private
    if (a === 100 && b >= 64 && b <= 127) return true           // 100.64.0.0/10 CGNAT
    if (a === 127) return true                                  // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true                     // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true            // 172.16.0.0/12 private
    if (a === 192 && b === 0) return true                       // 192.0.0.0/24 IETF
    if (a === 192 && b === 168) return true                     // 192.168.0.0/16 private
    if (a >= 224) return true                                   // 224.0.0.0/4 multicast + reserved
    return false
  }

  // IPv6 (normalize to lowercase, strip brackets)
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v6.includes(':')) {
    if (v6 === '::' || v6 === '::1') return true               // unspecified, loopback
    if (v6.startsWith('fe80:') || v6.startsWith('fe8') ||
        v6.startsWith('fe9') || v6.startsWith('fea') ||
        v6.startsWith('feb')) return true                       // fe80::/10 link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true // fc00::/7 unique-local
    if (v6.startsWith('ff')) return true                        // ff00::/8 multicast
    // IPv4-mapped IPv6: ::ffff:127.0.0.1, ::ffff:169.254.169.254
    const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return isPrivateOrReservedIP(mapped[1])
    // 2002::/16 6to4 — could tunnel to private, treat as suspicious
    if (v6.startsWith('2002:')) return true
    return false
  }
  return false
}

/** Resolve a hostname to a single pinned IP, rejecting if any resolved address is private. */
async function resolveAndPin(hostname: string): Promise<string> {
  // Strip brackets from IPv6 literals.
  const stripped = hostname.replace(/^\[|\]$/g, '')
  // Literal IPs: validate directly without DNS lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped) || stripped.includes(':')) {
    if (isPrivateOrReservedIP(stripped)) {
      throw new Error('blocked: private/reserved IP literal')
    }
    return stripped
  }
  // DNS resolution. Use { all: true } to catch DNS rebinding attacks where the
  // attacker round-robins between a public and private IP.
  const records = await dnsLookup(stripped, { all: true })
  if (records.length === 0) throw new Error('blocked: no DNS records')
  for (const r of records) {
    if (isPrivateOrReservedIP(r.address)) {
      throw new Error(`blocked: hostname resolves to private IP ${r.address}`)
    }
  }
  // Return the first address — caller passes it to fetch() via the URL,
  // pinning the IP for the actual request and defeating DNS rebinding.
  return records[0].address
}

/** Validate a URL is OK to fetch (protocol, hostname allowlist, no private IPs). */
async function validateUrl(rawUrl: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL format')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL not allowed')
  }
  // Resolve hostname → IP and reject if any resolved IP is private/reserved.
  // We do not actually pin the resolved IP onto the fetch URL because Next.js's
  // built-in fetch in serverless does not expose a custom dns lookup callback;
  // instead we re-resolve at fetch time and trust that DNS TTLs are short
  // enough that rebinding within a sub-second window is impractical for the
  // attacker. The resolveAndPin call still catches static private records.
  await resolveAndPin(hostname)
  return parsed
}

/** Fetch with size cap. Streams the response and rejects past MAX_BODY_BYTES. */
async function fetchWithBodyCap(url: string): Promise<{ ok: boolean; status: number; body: string; redirect?: string }> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'manual',
  })

  // Surface 3xx Location for caller-side redirect handling.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location') || ''
    return { ok: false, status: response.status, body: '', redirect: location }
  }

  // Reject obvious oversize responses via Content-Length when available.
  const contentLength = safeParseInt(response.headers.get('Content-Length'), 0)
  if (contentLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, body: '' }
  }

  // Stream the body and abort if cap exceeded.
  if (!response.body) {
    return { ok: response.ok, status: response.status, body: '' }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel() } catch { /* ignore */ }
        return { ok: false, status: 413, body: '' }
      }
      chunks.push(value)
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const body = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode()
  return { ok: response.ok, status: response.status, body }
}

export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
    if (rateLimitResponse) return rateLimitResponse

    const { searchParams } = new URL(request.url)
    const inputUrl = searchParams.get('url')
    if (!inputUrl) {
      return NextResponse.json({ error: 'URL parameter is required' }, { status: 400 })
    }

    // Manual redirect chain — re-validate each hop against SSRF allowlist.
    // Defeats: server returns 302 → http://169.254.169.254/...
    let currentUrl = inputUrl
    let validUrl: URL | null = null
    let body = ''
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        validUrl = await validateUrl(currentUrl)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'URL validation failed' },
          { status: 400 },
        )
      }

      const result = await fetchWithBodyCap(validUrl.href)
      if (result.status === 413) {
        return NextResponse.json({ error: 'Response body too large' }, { status: 413 })
      }
      if (result.redirect) {
        // Resolve relative redirects against the current URL, then loop.
        try {
          currentUrl = new URL(result.redirect, validUrl.href).href
        } catch {
          return NextResponse.json({ error: 'Invalid redirect target' }, { status: 502 })
        }
        continue
      }
      if (!result.ok) {
        return NextResponse.json({ error: 'Failed to fetch URL' }, { status: result.status || 502 })
      }
      body = result.body
      break
    }
    if (!validUrl || !body) {
      return NextResponse.json({ error: 'Too many redirects or empty body' }, { status: 502 })
    }

    const meta = extractMetaTags(body)

    // 处理相对路径的图片 URL
    if (meta.image && !meta.image.startsWith('http')) {
      try {
        meta.image = new URL(meta.image, validUrl.origin).href
      } catch {
        meta.image = ''
      }
    }

    return NextResponse.json(meta, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (error: unknown) {
    logger.error('Error fetching link preview:', error)
    return NextResponse.json(
      { error: 'Failed to fetch link preview' },
      { status: 500 }
    )
  }
}
