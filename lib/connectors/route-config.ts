/**
 * Smart Route Configuration — per-platform routing priorities.
 *
 * Based on route matrix test results (2026-03-15 v2).
 * Each platform has an ordered list of routes to try.
 * The smart router in BaseConnector tries them in sequence with failover.
 *
 * Route types:
 * - 'direct'     — fetch directly (Vercel hnd1 in prod, Mac Mini locally)
 * - 'vps_sg'     — HTTP proxy through VPS Singapore (45.76.152.169:3456)
 * - 'vps_jp'     — HTTP proxy through VPS Japan (149.28.27.242:3001)
 * - 'scraper_sg' — Playwright browser on VPS SG (named endpoints)
 * - 'mac_mini'   — Mac Mini local scraper (residential IP via VPN)
 *
 * Re-run `npx tsx scripts/test-route-matrix.ts` to refresh.
 * Vercel-side: GET /api/test/route-matrix?platforms=all
 */

export type RouteType = 'direct' | 'vps_sg' | 'vps_jp' | 'scraper_sg' | 'mac_mini'

export interface RouteConfig {
  /** Ordered routes to try (first = preferred) */
  routes: RouteType[]
  /** Why this routing was chosen */
  notes: string
}

/**
 * Per-platform route configuration.
 * Updated: 2026-03-15 from comprehensive endpoint testing.
 *
 * Categories:
 * 1. OPEN — public API, no geo-block, no WAF → direct
 * 2. GEO_BLOCKED — datacenter IPs blocked → VPS proxy
 * 3. WAF_PROTECTED — CloudFlare/Akamai JS challenge → Playwright scraper
 * 4. BROWSER_ONLY — SPA, no public API → scraper only
 * 5. DEAD — API removed/discontinued → empty routes
 */
export const PLATFORM_ROUTES: Record<string, RouteConfig> = {
  // ─── OPEN (direct works) ─────────────────────────────────────
  hyperliquid:    { routes: ['direct'],                       notes: 'Public on-chain API, no restrictions' },
  drift:          { routes: ['direct'],                       notes: 'data.api.drift.trade public, no auth' },
  jupiter_perps:  { routes: ['direct'],                       notes: 'perps-api.jup.ag public' },
  aevo:           { routes: ['direct', 'vps_sg'],             notes: 'Public API, slow (2-3s)' },
  gains:          { routes: ['direct', 'vps_sg'],             notes: 'Public API, reliable' },
  bitfinex:       { routes: ['direct', 'vps_sg'],             notes: 'Public rankings API' },
  coinex:         { routes: ['direct', 'vps_sg'],             notes: 'Public API, no geo-block' },
  bitunix:        { routes: ['direct', 'vps_sg'],             notes: 'Public API, POST required' },
  etoro:          { routes: ['direct', 'vps_sg'],             notes: 'sapi rankings, public' },
  btcc:           { routes: ['direct', 'vps_sg'],             notes: 'POST /documentary/trader/page, public' },
  web3_bot:       { routes: ['direct'],                       notes: 'DeFi Llama + CoinGecko aggregation' },
  binance_web3:   { routes: ['direct', 'vps_sg'],             notes: 'web3.binance.com, usually not blocked' },
  okx_web3:       { routes: ['direct', 'vps_sg'],             notes: 'Same as OKX v5 API' },
  gmx:            { routes: ['direct', 'vps_sg'],             notes: 'Satsuma GraphQL subgraph' },
  kwenta:         { routes: ['direct'],                       notes: 'TheGraph subgraph' },

  // ─── GEO_BLOCKED (VPS proxy required) ────────────────────────
  binance_futures: { routes: ['vps_sg', 'vps_jp'],            notes: 'Direct 451 geo-blocked. VPS SG works via /friendly/ API.' },
  okx_futures:     { routes: ['direct', 'vps_sg', 'vps_jp'],  notes: 'Direct works from hnd1 sometimes, VPS fallback' },

  // ─── WAF_PROTECTED (need Playwright) ─────────────────────────
  bybit:           { routes: ['scraper_sg', 'vps_jp'],        notes: 'Akamai WAF blocks all HTTP proxy. bybitglobal.com scraper.' },
  bitget_futures:  { routes: ['scraper_sg', 'vps_sg'],        notes: 'CloudFlare JS challenge. Scraper intercepts trace API.' },
  bingx:           { routes: ['scraper_sg'],                   notes: 'CloudFlare JS challenge. waitForResponse multi-rank.' },
  mexc:            { routes: ['scraper_sg', 'vps_sg'],         notes: 'API path changed. Scraper intercepts copyFutures.' },
  gateio:          { routes: ['direct', 'scraper_sg'],         notes: 'Direct works from Mac, Vercel may get WAF-blocked.' },

  // ─── BROWSER_ONLY (no public JSON API) ───────────────────────
  toobit:          { routes: ['scraper_sg'],                   notes: 'Returns HTML, needs Playwright' },
  blofin:          { routes: ['scraper_sg', 'direct'],         notes: 'openapi returns 401, scraper intercepts browser API' },
  lbank:           { routes: ['mac_mini'],                     notes: 'Browser crashes on VPS, only Mac Mini works' },
  phemex:          { routes: ['mac_mini'],                     notes: 'CloudFront blocks all cloud IPs. Mac Mini only.' },

  // ─── FIXED (2026-03-15) ───────────────────────────────────────
  htx_futures:     { routes: ['direct', 'vps_sg'],             notes: 'Switched to futures.htx.com ranking API (GET)' },
  xt:              { routes: ['direct', 'vps_sg'],             notes: 'API 404 — endpoint may have moved' },

  // ─── DEX (special handling) ──────────────────────────────────
  dydx:            { routes: ['direct'],                        notes: 'Uses Copin leaderboard API (indexer 404 since 2026-03)' },

  // ─── DEAD ────────────────────────────────────────────────────
  weex:            { routes: [],                               notes: 'DEAD: 521 from all routes' },
}

/**
 * Get route config for a platform. Falls back to ['direct', 'vps_sg'].
 */
export function getRouteConfig(platform: string): RouteConfig {
  return PLATFORM_ROUTES[platform] ?? { routes: ['direct', 'vps_sg'], notes: 'default fallback' }
}

/**
 * Check if a platform requires proxy (first route is not 'direct').
 */
export function requiresProxy(platform: string): boolean {
  const routes = PLATFORM_ROUTES[platform]?.routes ?? ['direct']
  return routes.length > 0 && routes[0] !== 'direct'
}

/**
 * Check if a platform is dead (empty routes).
 */
export function isDead(platform: string): boolean {
  return PLATFORM_ROUTES[platform]?.routes.length === 0
}

/**
 * Environment variable mapping for each route type.
 *
 * VPS SG has TWO services:
 * - Port 3456: HTTP proxy (systemd arena-proxy, POST /proxy with target URL)
 * - Port 3457: Playwright scraper (PM2 arena-scraper, named endpoints like /bybit/leaderboard)
 */
export const ROUTE_ENV_MAP: Record<RouteType, { urlEnv: string; fallbackEnv?: string; keyEnv: string }> = {
  direct:     { urlEnv: '', keyEnv: '' },
  vps_sg:     { urlEnv: 'VPS_PROXY_SG', fallbackEnv: 'VPS_PROXY_URL', keyEnv: 'VPS_PROXY_KEY' },
  vps_jp:     { urlEnv: 'VPS_PROXY_JP', keyEnv: 'VPS_PROXY_KEY' },
  scraper_sg: { urlEnv: 'VPS_SCRAPER_SG', fallbackEnv: 'VPS_SCRAPER_HOST', keyEnv: 'VPS_PROXY_KEY' },
  mac_mini:   { urlEnv: 'MAC_MINI_URL', keyEnv: 'VPS_PROXY_KEY' },
}

/**
 * Resolve the URL for a given route type from environment variables.
 * Returns null if the route is not configured.
 */
export function resolveRouteUrl(route: RouteType): string | null {
  if (route === 'direct') return null // direct doesn't need a proxy URL
  const env = ROUTE_ENV_MAP[route]
  return process.env[env.urlEnv] || (env.fallbackEnv ? process.env[env.fallbackEnv] : null) || null
}

/**
 * Resolve the API key for a given route type.
 */
export function resolveRouteKey(route: RouteType): string {
  if (route === 'direct') return ''
  return process.env[ROUTE_ENV_MAP[route].keyEnv] || ''
}
