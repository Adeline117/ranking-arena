import { NextRequest, NextResponse } from 'next/server'
import { getCorsOrigin } from '@/lib/utils/cors'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import logger from '@/lib/logger'
import { safeFetch, readBodyCapped, SafeFetchError } from '@/lib/utils/safe-fetch'

/**
 * Proxy for PDF/EPUB files to handle CORS and CSP restrictions.
 * Usage: /api/cdn-proxy?url=https://cdn.arenafi.org/papers/xxx.pdf
 *        /api/cdn-proxy?url=https://arxiv.org/pdf/1234.5678
 */

// Allowlist of trusted domains that can be proxied
const ALLOWED_PREFIXES = [
  'https://cdn.arenafi.org/',
  'https://arxiv.org/pdf/',
  'https://arxiv.org/abs/',
  'https://arxiv.org/e-print/',
]

// SECURITY (audit P1-3, 2026-04-09): coerce upstream Content-Type to a
// strict whitelist. Previously the proxy passed through whatever the
// upstream returned — including text/html or image/svg+xml with embedded
// scripts — giving an attacker who controls one of the allowed prefixes
// (or who finds a content-injection on arxiv) a same-origin script
// execution path on arenafi.org. Combined with dangerouslyAllowSVG=true
// this materially widens the XSS surface.
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/epub+zip',
  'application/octet-stream', // arxiv occasionally serves this for PDFs
])
const DEFAULT_CONTENT_TYPE = 'application/pdf'

function safeContentType(upstream: string | null): string {
  if (!upstream) return DEFAULT_CONTENT_TYPE
  // Strip charset/boundary parameters, lowercase, trim
  const base = upstream.split(';')[0].trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.has(base) ? base : DEFAULT_CONTENT_TYPE
}

// Reject responses larger than 50 MB to prevent memory abuse. Enforced while
// streaming, so chunked responses without Content-Length are capped too.
const MAX_BODY_SIZE = 50 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

function isAllowedUrl(url: string): boolean {
  // Normalise first so the prefix check runs on the canonical href
  // (e.g. defeats userinfo / backslash tricks in the raw string).
  let normalized: string
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
    normalized = parsed.href
  } catch {
    return false
  }
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export async function GET(request: NextRequest) {
  // Rate limit: prevent bandwidth abuse via proxy
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const url = request.nextUrl.searchParams.get('url')
  if (!url || !isAllowedUrl(url)) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    // redirect:'manual' + per-hop allowlist/private-IP revalidation (safeFetch).
    const { response: resp } = await safeFetch(url, {
      isAllowed: (u) => isAllowedUrl(u.href),
      init: () => ({
        headers: {
          // Pass a reasonable user-agent so arxiv doesn't block server-side fetches
          'User-Agent': 'Mozilla/5.0 (compatible; Arena/1.0; +https://www.arenafi.org)',
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!resp.ok) {
      try {
        await resp.body?.cancel()
      } catch {
        /* already closed */
      }
      return NextResponse.json({ error: `Upstream ${resp.status}` }, { status: resp.status })
    }

    const buffer = await readBodyCapped(resp, MAX_BODY_SIZE)
    const origin = request.headers.get('Origin')
    return new NextResponse(buffer, {
      headers: {
        // SECURITY: coerce to whitelist (PDF/EPUB only); never reflect
        // attacker-controlled Content-Type back to the browser.
        'Content-Type': safeContentType(resp.headers.get('Content-Type')),
        'Content-Disposition': 'inline; filename="document.pdf"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        'Access-Control-Allow-Origin': getCorsOrigin(origin),
      },
    })
  } catch (error: unknown) {
    if (error instanceof SafeFetchError) {
      if (error.code === 'too_large') {
        return NextResponse.json({ error: 'Response too large' }, { status: 413 })
      }
      logger.warn('cdn-proxy rejected upstream', { code: error.code, reason: error.message })
      return NextResponse.json({ error: 'Upstream not allowed' }, { status: 502 })
    }
    logger.warn('cdn-proxy fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Fetch failed' }, { status: 502 })
  }
}
