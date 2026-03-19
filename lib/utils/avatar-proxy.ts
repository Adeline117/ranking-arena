/**
 * Determines if an avatar URL needs the /api/avatar proxy.
 * Whitelisted domains (in next.config remotePatterns) are served directly.
 */

const DIRECT_DOMAINS = new Set([
  'api.dicebear.com', 'robohash.org', 'i.pravatar.cc', 'randomuser.me',
  'gavatar.staticimgs.com', 'static.okx.com', 'etoro-cdn.etorostatic.com',
  'public.bscdnweb.com', 's1.bycsi.com', 'a.static-global.com',
  'static.phemex.com', 'www.arenafi.org', 'cdn.arenafi.org',
  'img.meimaobing.top', 'public.mocortech.com',
])

export function avatarSrc(url: string | null | undefined): string {
  if (!url) return ''
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
