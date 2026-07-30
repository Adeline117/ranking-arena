/**
 * Canonical sources covered by the daily Vercel avatar backfill.
 *
 * Every entry must remain an active source with a concrete fetcher in route.ts.
 * The schedule contract test keeps this list, vercel.json, and the exchange
 * lifecycle registries from drifting apart again.
 */
export const AVATAR_BACKFILL_SCHEDULE_PLATFORMS = [
  'binance_futures',
  'bybit',
  'bitget_futures',
  'okx_futures',
  'mexc',
  'htx_futures',
  'coinex',
  'bingx',
  'xt',
  'blofin',
  'kucoin',
  'phemex',
] as const
