/**
 * Canonical list of exchange landing-page slugs (/exchange/<slug>).
 *
 * Single source of truth shared by the route's generateStaticParams and the
 * sitemap generator — keeping them in sync so every prerendered exchange page
 * is also discoverable by crawlers.
 */
export const TOP_EXCHANGE_SLUGS = [
  'binance-futures',
  'hyperliquid',
  'okx-futures',
  'bybit',
  'bitget-futures',
  'gmx',
  'dydx',
  'mexc',
  'drift',
  'htx-futures',
  'gateio',
  'jupiter-perps',
  'aevo',
  'coinex',
  'etoro',
] as const
