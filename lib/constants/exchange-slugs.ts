/**
 * Canonical list of exchange landing-page slugs (/exchange/<slug>).
 *
 * Single source of truth shared by the route's generateStaticParams and the
 * sitemap generator — keeping them in sync so every prerendered exchange page
 * is also discoverable by crawlers.
 *
 * Retired sources (lib/constants/retired-sources.ts) must not be listed: their
 * landing pages have no data and are 404 — a test enforces this.
 */
export const TOP_EXCHANGE_SLUGS = [
  'binance-futures',
  'hyperliquid',
  'okx-futures',
  'bybit',
  'bitget-futures',
  'gmx',
  'mexc',
  'drift',
  'htx-futures',
  'gateio',
  'coinex',
] as const
