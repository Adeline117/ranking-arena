/** Resolves a browser-safe avatar source while V1 proxy acquisition is held. */

import { canonicalizeLocalExchangeLogoPath } from './exchange-logo-path'
import { isV1AvatarProxyPath } from '@/lib/security/v1-avatar-proxy-publication'

/**
 * Fixed inline bitmap-free placeholder for remote avatar sources that formerly
 * required the retired proxy. It contains no caller-controlled data and never
 * schedules a request.
 */
export const V1_AVATAR_PROXY_FALLBACK_SRC =
  'data:image/svg+xml,%3Csvg xmlns=%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2232%22 fill=%22%2327293d%22%2F%3E%3Ccircle cx=%2232%22 cy=%2225%22 r=%2211%22 fill=%22%237c83a8%22%2F%3E%3Cpath d=%22M12 58c2-12 11-19 20-19s18 7 20 19%22 fill=%22%237c83a8%22%2F%3E%3C%2Fsvg%3E'

// Domains that serve images without CORS/Referrer restrictions — bypass proxy entirely.
// Bitmap sources here are in next.config.ts remotePatterns, so /_next/image optimizes them.
// NOTE: SVG sources (dicebear `/svg` endpoints, `*.svg` paths) are NOT handled by the
// optimizer — next.config.ts sets `dangerouslyAllowSVG: false`, so /_next/image rejects
// them with 400 INVALID_IMAGE_OPTIMIZE_REQUEST. Render those with `unoptimized` on
// <Image> (see isSvgAvatarSource below). Direct <img> loading is safe: CSP img-src
// allows https:, and SVG scripts never execute in an <img> context.
const DIRECT_DOMAINS = new Set([
  // Avatar generators — public, no restrictions
  'api.dicebear.com',
  'robohash.org',
  'i.pravatar.cc',
  'randomuser.me',
  'ui-avatars.com',
  // Our own infra
  'www.arenafi.org',
  'cdn.arenafi.org',
  // GitHub / Google
  'avatars.githubusercontent.com',
  // Exchange CDN subdomains that don't have Referrer checks (confirmed working)
  'gavatar.staticimgs.com',
  'static.okx.com',
  'etoro-cdn.etorostatic.com', // New URL format /avatars/150X150/{id}/1.jpg works direct (old format was 403)
  // public.bscdnweb.com — REMOVED: returns 424, must go through proxy
  's1.bycsi.com',
  'a.static-global.com',
  'static.phemex.com',
  'img.meimaobing.top',
  'public.mocortech.com',
])

// Avatar-generator hosts whose endpoints serve SVG (dicebear URLs are
// `/7.x/<style>/svg?seed=...`). Kept separate from DIRECT_DOMAINS because
// membership here changes *how* the URL is rendered, not *where* it loads from.
const SVG_AVATAR_HOSTS = new Set(['api.dicebear.com'])

/**
 * True when the avatar URL points at an SVG source that must bypass the
 * Next.js image optimizer (`unoptimized` on <Image>): /_next/image returns
 * 400 for any SVG because `dangerouslyAllowSVG` is disabled.
 */
export function isSvgAvatarSource(url: string | null | undefined): boolean {
  if (!url) return false
  if (url.startsWith('data:')) return url.startsWith('data:image/svg')
  try {
    const parsed = new URL(url, 'https://www.arenafi.org')
    if (SVG_AVATAR_HOSTS.has(parsed.hostname)) return true
    const pathname = parsed.pathname.toLowerCase()
    // robohash & friends serve SVG only on explicit `.svg` / `/svg` paths
    return pathname.endsWith('.svg') || pathname.endsWith('/svg')
  } catch (_err) {
    return false
  }
}

export function avatarSrc(url: string | null | undefined): string {
  if (!url) return ''
  const normalizedUrl = canonicalizeLocalExchangeLogoPath(url.trim())
  if (!normalizedUrl) return ''
  if (isV1AvatarProxyPath(normalizedUrl)) return V1_AVATAR_PROXY_FALLBACK_SRC
  // data: URIs (local identicons/blockies) — always direct, zero latency
  if (normalizedUrl.startsWith('data:') || normalizedUrl.startsWith('/')) return normalizedUrl
  try {
    const hostname = new URL(normalizedUrl).hostname
    if (DIRECT_DOMAINS.has(hostname)) return normalizedUrl
    if (hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.in')) {
      return normalizedUrl
    }
    if (hostname.endsWith('.googleusercontent.com')) return normalizedUrl
  } catch (_err) {
    /* invalid URL — use the fixed local fallback */
  }
  // The checked-in V1 hold deliberately has no reactivation branch here. A
  // future publication needs a separately reviewed rendering contract.
  return V1_AVATAR_PROXY_FALLBACK_SRC
}
