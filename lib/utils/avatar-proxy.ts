/**
 * Determines if an avatar URL needs the /api/avatar proxy.
 * Domains without CORS/Referrer restrictions are served directly — no proxy overhead.
 * Exchange CDN domains (Binance, Bybit, Bitget, etc.) require the proxy.
 */

import { canonicalizeLocalExchangeLogoPath } from './exchange-logo-path'

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
 * Do NOT route these through /api/avatar either — the proxy deliberately
 * rejects image/svg+xml (audit P1-3) and forces content-type to png.
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
    /* invalid URL — proxy it */
  }
  return `/api/avatar?url=${encodeURIComponent(normalizedUrl)}`
}
