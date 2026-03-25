/**
 * Determines if an avatar URL needs the /api/avatar proxy.
 * Domains without CORS/Referrer restrictions are served directly — no proxy overhead.
 * Exchange CDN domains (Binance, Bybit, Bitget, etc.) require the proxy.
 */

// Domains that serve images without CORS/Referrer restrictions — bypass proxy entirely.
// All of these are in next.config.ts remotePatterns (or are data: URIs) so next/image handles them.
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
  'etoro-cdn.etorostatic.com',
  'public.bscdnweb.com',
  's1.bycsi.com',
  'a.static-global.com',
  'static.phemex.com',
  'img.meimaobing.top',
  'public.mocortech.com',
])

export function avatarSrc(url: string | null | undefined): string {
  if (!url) return ''
  // data: URIs (local identicons/blockies) — always direct, zero latency
  if (url.startsWith('data:') || url.startsWith('/')) return url
  try {
    const hostname = new URL(url).hostname
    if (DIRECT_DOMAINS.has(hostname)) return url
    if (hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.in')) return url
    if (hostname.endsWith('.googleusercontent.com')) return url
  } catch {
    // Invalid URL — proxy it
  }
  return `/api/avatar?url=${encodeURIComponent(url)}`
}
