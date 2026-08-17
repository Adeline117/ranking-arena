import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { Agent, buildConnector, fetch as undiciFetch } from 'undici'

// Body size cap (bytes) — link preview only needs the head of the document.
// 256KB is plenty for <head> + meta tags; rejects payload-flood attacks.
const MAX_BODY_BYTES = 256 * 1024

// Per-hop redirect limit. Each hop is re-validated against the SSRF allowlist.
const MAX_REDIRECTS = 3

// Upstream fetch timeout per hop.
const FETCH_TIMEOUT_MS = 10_000

type ValidatedUrl = {
  /** Browser-visible URL semantics: redirects, Host, SNI, and relative metadata. */
  logicalUrl: URL
  /** Network destination used by the custom connector after DNS validation. */
  pinnedIp: string
  /** DNS hostname required for HTTPS certificate verification; never an IP literal. */
  tlsServername: string | null
}

const MAX_TITLE_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 2_048
const MAX_IMAGE_LENGTH = 4_096

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: '\u00a0',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]+));/gi,
    (entity, numeric, named) => {
      if (named) return HTML_NAMED_ENTITIES[named.toLowerCase()] ?? entity

      const hexadecimal = numeric[0].toLowerCase() === 'x'
      const codePoint = Number.parseInt(
        hexadecimal ? numeric.slice(1) : numeric,
        hexadecimal ? 16 : 10
      )
      // Keep invalid, surrogate, and control entities literal. In particular, never
      // introduce hidden URL delimiters such as NUL/CR/LF into an image candidate.
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint < 0x20 ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      ) {
        return entity
      }
      return String.fromCodePoint(codePoint)
    }
  )
}

function boundedMetadataValue(value: string, maxLength: number): string {
  const decoded = decodeHtmlEntities(value).trim()
  if (decoded.length <= maxLength) return decoded
  const truncated = decoded.slice(0, maxLength)
  // Do not return half of a UTF-16 surrogate pair at the field boundary.
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated
}

function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let index = start + 1; index < html.length; index++) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function findClosingTag(
  html: string,
  lowerHtml: string,
  tagName: string,
  start: number
): { start: number; end: number } | null {
  const prefix = `</${tagName}`
  let closeStart = lowerHtml.indexOf(prefix, start)
  while (closeStart >= 0) {
    const boundary = html[closeStart + prefix.length]
    if (boundary && /[\t\n\f\r >]/.test(boundary)) {
      const closeEnd = findTagEnd(html, closeStart)
      return closeEnd >= 0 ? { start: closeStart, end: closeEnd } : null
    }
    closeStart = lowerHtml.indexOf(prefix, closeStart + prefix.length)
  }
  return null
}

/** Parse attributes from one already-bounded start tag. First duplicate wins. */
function parseTagAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>()
  let index = 0
  const isWhitespace = (character: string) => /[\t\n\f\r ]/.test(character)

  while (index < source.length) {
    while (index < source.length && isWhitespace(source[index])) index++
    if (index >= source.length || (source[index] === '/' && index === source.length - 1)) break

    const nameStart = index
    while (index < source.length && !/[\t\n\f\r /=>]/.test(source[index])) index++
    if (index === nameStart) return null
    const name = source.slice(nameStart, index).toLowerCase()

    while (index < source.length && isWhitespace(source[index])) index++
    let value = ''
    if (source[index] === '=') {
      index++
      while (index < source.length && isWhitespace(source[index])) index++
      if (index >= source.length) return null

      const quote = source[index]
      if (quote === '"' || quote === "'") {
        const valueStart = ++index
        while (index < source.length && source[index] !== quote) index++
        if (index >= source.length) return null
        value = source.slice(valueStart, index)
        index++
      } else {
        const valueStart = index
        while (index < source.length && !/[\t\n\f\r "'`=<>]/.test(source[index])) index++
        if (index === valueStart) return null
        value = source.slice(valueStart, index)
      }
    }

    if (!attributes.has(name)) attributes.set(name, value)
  }

  return attributes
}

/**
 * Extract a deliberately small metadata subset without executing HTML. Every
 * attribute parse is bounded to a single quote-aware tag; malformed tags never
 * borrow attributes from a later tag.
 */
function extractMetaTags(html: string) {
  let documentTitle = ''
  let fallbackDescription = ''
  let ogTitle = ''
  let ogDescription = ''
  let ogImage = ''
  const lowerHtml = html.toLowerCase()

  for (let cursor = 0; cursor < html.length; ) {
    const tagStart = html.indexOf('<', cursor)
    if (tagStart < 0) break
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4)
      if (commentEnd < 0) break
      cursor = commentEnd + 3
      continue
    }
    const nameMatch = /^([a-z][a-z0-9:-]*)/i.exec(html.slice(tagStart + 1, tagStart + 32))
    if (!nameMatch) {
      cursor = tagStart + 1
      continue
    }

    const tagName = nameMatch[1].toLowerCase()
    const afterName = tagStart + 1 + nameMatch[1].length
    if (afterName < html.length && !/[\t\n\f\r />]/.test(html[afterName])) {
      cursor = afterName
      continue
    }
    if (tagName === 'script' || tagName === 'style') {
      const tagEnd = findTagEnd(html, tagStart)
      if (tagEnd < 0) break
      const closingTag = findClosingTag(html, lowerHtml, tagName, tagEnd + 1)
      if (!closingTag) break
      cursor = closingTag.end + 1
      continue
    }
    if (tagName !== 'meta' && tagName !== 'title') {
      const tagEnd = findTagEnd(html, tagStart)
      if (tagEnd < 0) break
      cursor = tagEnd + 1
      continue
    }
    const tagEnd = findTagEnd(html, tagStart)
    if (tagEnd < 0) break

    if (tagName === 'title') {
      const closingTag = findClosingTag(html, lowerHtml, tagName, tagEnd + 1)
      if (!closingTag) break
      if (!documentTitle) {
        documentTitle = boundedMetadataValue(
          html.slice(tagEnd + 1, closingTag.start),
          MAX_TITLE_LENGTH
        )
      }
      cursor = closingTag.end + 1
      continue
    }

    const attributes = parseTagAttributes(html.slice(afterName, tagEnd))
    cursor = tagEnd + 1
    if (!attributes) continue
    const content = attributes.get('content')
    if (content === undefined) continue
    const key = decodeHtmlEntities(attributes.get('property') ?? attributes.get('name') ?? '')
      .trim()
      .toLowerCase()

    if (key === 'og:title' && !ogTitle) {
      ogTitle = boundedMetadataValue(content, MAX_TITLE_LENGTH)
    } else if (key === 'og:description' && !ogDescription) {
      ogDescription = boundedMetadataValue(content, MAX_DESCRIPTION_LENGTH)
    } else if (key === 'og:image' && !ogImage) {
      ogImage = boundedMetadataValue(content, MAX_IMAGE_LENGTH)
    } else if (key === 'description' && !fallbackDescription) {
      fallbackDescription = boundedMetadataValue(content, MAX_DESCRIPTION_LENGTH)
    }
  }

  return {
    title: ogTitle || documentTitle,
    description: ogDescription || fallbackDescription,
    image: ogImage,
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

const NON_PUBLIC_IPV4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4')
}
const NON_PUBLIC_IPV6 = new BlockList()
for (const [network, prefix] of [
  // Deprecated IPv4-compatible, IPv4-mapped, and IPv4-translatable forms.
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  // NAT64 well-known and local-use translation prefixes.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  // 6to4 embeds an IPv4 destination beyond this process's address check.
  ['2002::', 16],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6')
}

/** Reject IPv4 / IPv6 literals that point at private, loopback, link-local, or cloud-metadata ranges. */
function isPrivateOrReservedIP(ip: string): boolean {
  const address = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(address)
  if (family === 0) return true
  return family === 4
    ? NON_PUBLIC_IPV4.check(address, 'ipv4')
    : NON_PUBLIC_IPV6.check(address, 'ipv6')
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
  // Return the first address to the custom connector, which uses the literal
  // IP as its socket destination and prevents a second DNS lookup/rebinding.
  return records[0].address
}

/** Validate a URL is OK to fetch (protocol, hostname allowlist, no private IPs). */
async function validateUrl(rawUrl: string): Promise<ValidatedUrl> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL format')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not allowed')
  }
  const hostname = parsed.hostname.toLowerCase()
  const addressHost = hostname.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL not allowed')
  }
  // Resolve hostname → IP and reject if any resolved IP is private/reserved.
  // Bind the resolved IP to this hop's custom connector to defeat rebinding.
  const pinnedIp = await resolveAndPin(hostname)
  return {
    logicalUrl: parsed,
    pinnedIp,
    tlsServername: parsed.protocol === 'https:' && isIP(addressHost) === 0 ? hostname : null,
  }
}

/** Fetch with size cap. Streams the response and rejects past MAX_BODY_BYTES. */
async function fetchWithBodyCap(
  target: ValidatedUrl
): Promise<{ ok: boolean; status: number; body: string; redirect?: string }> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'text/html,application/xhtml+xml',
  }
  // Fetch keeps the logical URL so Undici emits the correct Host header. The
  // connector changes only the socket destination to the already-validated IP
  // and explicitly retains the logical DNS name for TLS SNI/cert verification.
  const connect = buildConnector({})
  const dispatcher = new Agent({
    connect(options, callback) {
      connect(
        {
          ...options,
          hostname: target.pinnedIp,
          servername: target.tlsServername ?? undefined,
        },
        callback
      )
    },
  })

  try {
    const response = await undiciFetch(target.logicalUrl.href, {
      headers,
      dispatcher,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    })

    // Surface 3xx Location for caller-side redirect handling.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location') || ''
      await response.body?.cancel()
      return { ok: false, status: response.status, body: '', redirect: location }
    }

    // Reject obvious oversize responses via Content-Length when available.
    const contentLength = safeParseInt(response.headers.get('Content-Length'), 0)
    if (contentLength > MAX_BODY_BYTES) {
      await response.body?.cancel()
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
          try {
            await reader.cancel()
          } catch (err) {
            logger.debug(
              'Non-critical error cancelling reader:',
              err instanceof Error ? err.message : String(err)
            )
          }
          return { ok: false, status: 413, body: '' }
        }
        chunks.push(value)
      }
    }
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const body =
      chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
    return { ok: response.ok, status: response.status, body }
  } finally {
    await dispatcher.close()
  }
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
    let validUrl: ValidatedUrl | null = null
    let finalLogicalUrl: URL | null = null
    let body = ''
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        validUrl = await validateUrl(currentUrl)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'URL validation failed' },
          { status: 400 }
        )
      }

      const result = await fetchWithBodyCap(validUrl)
      if (result.status === 413) {
        return NextResponse.json({ error: 'Response body too large' }, { status: 413 })
      }
      if (result.redirect) {
        // Resolve relative redirects against the current URL, then loop.
        try {
          currentUrl = new URL(result.redirect, validUrl.logicalUrl).href
        } catch {
          return NextResponse.json({ error: 'Invalid redirect target' }, { status: 502 })
        }
        continue
      }
      if (!result.ok) {
        return NextResponse.json({ error: 'Failed to fetch URL' }, { status: result.status || 502 })
      }
      body = result.body
      finalLogicalUrl = validUrl.logicalUrl
      break
    }
    if (!validUrl || !finalLogicalUrl || !body) {
      return NextResponse.json({ error: 'Too many redirects or empty body' }, { status: 502 })
    }

    const meta = extractMetaTags(body)

    // 处理相对路径的图片 URL
    if (meta.image) {
      try {
        const imageUrl = new URL(meta.image, finalLogicalUrl)
        meta.image =
          ['http:', 'https:'].includes(imageUrl.protocol) &&
          imageUrl.href.length <= MAX_IMAGE_LENGTH
            ? imageUrl.href
            : ''
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
    return NextResponse.json({ error: 'Failed to fetch link preview' }, { status: 500 })
  }
}
