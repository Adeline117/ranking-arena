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
  kucoin:         { routes: ['direct', 'vps_sg'],             notes: 'POST /_api/ct-copy-trade leaderboard API works from any IP' },
  kwenta:         { routes: ['direct'],                       notes: 'TheGraph subgraph' },

  // ─── GEO_BLOCKED (VPS proxy required) ────────────────────────
  binance_futures: { routes: ['vps_sg', 'vps_jp'],            notes: 'Direct 451 geo-blocked. VPS SG works via /friendly/ API.' },
  binance_spot:    { routes: ['vps_sg', 'vps_jp'],            notes: 'Same as futures — geo-blocked, /friendly/ spot-copy-trade API.' },
  okx_futures:     { routes: ['direct', 'vps_sg', 'vps_jp'],  notes: 'v5 public API, direct works. VPS SG fallback for geo-blocked regions.' },

  crypto_com:      { routes: ['scraper_sg'],                   notes: 'Cloudflare JS challenge. VPS Playwright scraper only.' },

  // ─── WAF_PROTECTED (need Playwright) ─────────────────────────
  bybit:           { routes: ['scraper_sg', 'vps_jp'],        notes: 'Akamai WAF blocks all HTTP proxy. bybitglobal.com scraper.' },
  bybit_spot:      { routes: ['scraper_sg', 'vps_jp'],        notes: 'Same as bybit futures — Akamai WAF, scraper required.' },
  bitget_futures:  { routes: ['direct', 'vps_sg', 'scraper_sg'], notes: 'Direct API works sometimes; VPS proxy faster than Playwright. Scraper as last resort.' },
  bitget_spot:     { routes: ['direct', 'vps_sg', 'scraper_sg'], notes: 'Same as bitget futures — direct first, VPS fallback, scraper last resort.' },
  bingx:           { routes: ['scraper_sg'],                   notes: 'CloudFlare JS challenge. waitForResponse multi-rank.' },
  mexc:            { routes: ['direct'],                        notes: 'Mobile UA bypass (MEXC/1.0 iPhone) works from any IP. No VPS/scraper needed.' },
  gateio:          { routes: ['direct', 'scraper_sg'],         notes: 'Direct works from Mac, Vercel may get WAF-blocked.' },

  // ─── BROWSER_ONLY (no public JSON API) ───────────────────────
  toobit:          { routes: ['scraper_sg'],                   notes: 'VPS scraper works (65 traders). Direct returns HTML.' },
  blofin:          { routes: ['scraper_sg'],                   notes: 'openapi 401 (needs API key). Scraper handler added but needs tuning.' },
  lbank:           { routes: ['mac_mini'],                     notes: 'VPS scraper fails (no data). Mac Mini only.' },
  phemex:          { routes: ['mac_mini'],                     notes: 'CloudFront geo-blocks SG VPS. Mac Mini only.' },

  // ─── FIXED (2026-03-15) ───────────────────────────────────────
  htx_futures:     { routes: ['direct', 'vps_sg'],             notes: 'Switched to futures.htx.com ranking API (GET)' },
  xt:              { routes: ['scraper_sg'],                    notes: 'API 404 but /fapi/user/v1 works via Playwright page.evaluate' },

  // ─── DEX (special handling) ──────────────────────────────────
  dydx:            { routes: ['direct'],                        notes: 'Uses Copin leaderboard API (indexer 404 since 2026-03)' },

  // ─── RESTORED via VPS Scraper ──────────────────────────────
  weex:            { routes: ['scraper_sg'],                   notes: 'API on janapw.com needs dynamic auth headers. Scraper waitForResponse.' },
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
