/**
 * Route Configuration — smart failover for exchange API access.
 *
 * Records the tested routing strategy per platform based on real-world
 * connectivity testing (2026-03-15). Each platform has an ordered list
 * of routes to try; the connector framework tries them in sequence.
 *
 * Route types:
 * - 'direct'  → Vercel hnd1 (Tokyo) direct to API
 * - 'vps-sg'  → VPS Singapore proxy (45.76.152.169:3456)
 * - 'vps-jp'  → VPS Japan proxy (149.28.27.242:3001)
 * - 'scraper' → VPS Playwright scraper (headless browser)
 * - 'mac'     → Mac Mini local browser (residential IP)
 * - 'dead'    → All routes confirmed dead
 */

export type RouteType = 'direct' | 'vps-sg' | 'vps-jp' | 'scraper' | 'mac' | 'dead'

export interface RouteEntry {
  /** Ordered list of routes to try (first = preferred) */
  routes: RouteType[]
  /** Why this route order was chosen */
  reason: string
  /** When this was last verified */
  testedAt: string
  /** HTTP status from direct access (from Vercel hnd1 / local Mac) */
  directStatus?: number
  /** HTTP status from VPS SG */
  vpsSgStatus?: number
}

/**
 * Per-platform route configuration.
 * Updated: 2026-03-15 based on comprehensive endpoint testing.
 */
export const ROUTE_CONFIG: Record<string, RouteEntry> = {
  // ═══════════════════════════════════════════════════════════════
  // WORKING — direct access from Vercel hnd1
  // ═══════════════════════════════════════════════════════════════
  hyperliquid: {
    routes: ['direct'],
    reason: 'Public on-chain API, no geo-blocking',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  drift: {
    routes: ['direct'],
    reason: 'data.api.drift.trade public, no auth',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  etoro: {
    routes: ['direct'],
    reason: 'sapi/rankings public API, no geo-blocking',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  bitfinex: {
    routes: ['direct'],
    reason: '/v2/rankings public, no blocking',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  btcc: {
    routes: ['direct'],
    reason: 'POST /documentary/trader/page public, no auth',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  jupiter_perps: {
    routes: ['direct'],
    reason: 'perps-api.jup.ag public, no blocking',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  bitunix: {
    routes: ['direct'],
    reason: 'api.bitunix.com public POST, no auth',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  web3_bot: {
    routes: ['direct'],
    reason: 'DeFi Llama + CoinGecko aggregation, public',
    testedAt: '2026-03-15',
    directStatus: 200,
  },

  // ═══════════════════════════════════════════════════════════════
  // WORKING — direct or via VPS proxy
  // ═══════════════════════════════════════════════════════════════
  okx_futures: {
    routes: ['direct', 'vps-sg'],
    reason: 'v5 copytrading API works direct from hnd1; VPS fallback',
    testedAt: '2026-03-15',
    directStatus: 200,
  },
  coinex: {
    routes: ['direct', 'vps-sg'],
    reason: 'Direct API works from some IPs; VPS fallback',
    testedAt: '2026-03-15',
    directStatus: 200,
    vpsSgStatus: 200,
  },
  gmx: {
    routes: ['direct'],
    reason: 'Subgraph API (satsuma-prod.com), no geo-blocking',
    testedAt: '2026-03-15',
    directStatus: 200,
  },

  // ═══════════════════════════════════════════════════════════════
  // VPS PROXY REQUIRED — geo-blocked from Vercel/datacenter IPs
  // ═══════════════════════════════════════════════════════════════
  binance_futures: {
    routes: ['vps-sg', 'vps-jp'],
    reason: 'New /friendly/ API; geo-blocked + AWS WAF from Vercel; VPS SG works',
    testedAt: '2026-03-15',
    directStatus: 451,
    vpsSgStatus: 200,
  },
  binance_spot: {
    routes: ['vps-sg', 'vps-jp'],
    reason: 'Same as binance_futures — /friendly/ spot-copy-trade API via VPS',
    testedAt: '2026-03-15',
    directStatus: 451,
    vpsSgStatus: 200,
  },
  gateio: {
    routes: ['vps-sg'],
    reason: 'Direct 403 (CF); VPS SG proxy works for /apiw/v2/copy/leader/list',
    testedAt: '2026-03-15',
    directStatus: 403,
    vpsSgStatus: 200,
  },
  bybit: {
    routes: ['vps-sg', 'scraper'],
    reason: 'Direct 403 (Akamai WAF); VPS proxy may get blocked too → scraper fallback',
    testedAt: '2026-03-15',
    directStatus: 403,
    vpsSgStatus: 403,
  },
  bitget_futures: {
    routes: ['vps-sg', 'scraper'],
    reason: 'Direct 403 (CF); VPS proxy gets CF challenge → may need scraper',
    testedAt: '2026-03-15',
    directStatus: 403,
    vpsSgStatus: 403,
  },
  mexc: {
    routes: ['vps-sg', 'scraper'],
    reason: 'Direct 403 (Akamai); VPS also blocked → scraper needed',
    testedAt: '2026-03-15',
    directStatus: 403,
    vpsSgStatus: 404,
  },
  bingx: {
    routes: ['vps-sg', 'scraper'],
    reason: 'Direct 403 (CF); VPS proxy fallback',
    testedAt: '2026-03-15',
    directStatus: 403,
  },

  // ═══════════════════════════════════════════════════════════════
  // MAC MINI ONLY — all datacenter IPs blocked
  // ═══════════════════════════════════════════════════════════════
  phemex: {
    routes: ['mac'],
    reason: 'CloudFront blocks all VPS IPs; Mac Mini Chrome scraper works',
    testedAt: '2026-03-15',
    directStatus: 403,
    vpsSgStatus: 403,
  },

  // ═══════════════════════════════════════════════════════════════
  // DEAD — API removed, no alternative found
  // ═══════════════════════════════════════════════════════════════
  dydx: {
    routes: ['dead'],
    reason: 'indexer.dydx.trade /v4/leaderboard/pnl returns 404 globally',
    testedAt: '2026-03-15',
    directStatus: 404,
    vpsSgStatus: 404,
  },
}

/**
 * Get the preferred route for a platform.
 * Returns the first route in the ordered list.
 */
export function getPreferredRoute(platform: string): RouteType {
  return ROUTE_CONFIG[platform]?.routes[0] ?? 'direct'
}

/**
 * Check if a platform requires VPS proxy.
 */
export function requiresProxy(platform: string): boolean {
  const routes = ROUTE_CONFIG[platform]?.routes ?? ['direct']
  return routes[0] !== 'direct'
}

/**
 * Check if a platform is confirmed dead.
 */
export function isDead(platform: string): boolean {
  return ROUTE_CONFIG[platform]?.routes[0] === 'dead'
}
