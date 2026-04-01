/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// bitget_futures: RE-ENABLED with enrichment (concurrency:3, 18s/trader timeout, CF Worker proxy)
// 2026-03-21: Temporarily disable enrichment for repeatedly stuck platforms
// binance_futures: 5x hangs (12:30, 14:30, 01:00, 02:30, 06:30)
// bybit/kucoin/weex/okx_web3: 3x hangs (10:30, 11:00, 22:30) - 45min each
// 2026-03-22: dydx RE-ENABLED with timeout controls (concurrency:3, 15s/trader, 5s API timeouts)
// 2026-03-23 03:40: RE-DISABLED binance_futures/bybit/weex/okx_web3 - catastrophic 75% failure rate after ec2af671
// All timeout fixes failed, cleanup cron not catching them
// Re-enable after deep investigation of timeout root cause
// 2026-03-31: Re-enabled binance_futures and bybit — too critical to leave disabled.
// 2026-03-31: Re-enabled weex (VPS scraper works, server back from 521) and okx_web3 (v5 API confirmed working).
// kucoin stays disabled (copy trading APIs all 404, permanently dead).
// dydx enrichment disabled separately in NO_ENRICHMENT_PLATFORMS.
export const DISABLED_PLATFORMS = ['bitget_spot', 'kucoin'] as const
export type DisabledPlatform = typeof DISABLED_PLATFORMS[number]

export function isPlatformDisabled(platform: string): boolean {
  return DISABLED_PLATFORMS.includes(platform as DisabledPlatform)
}

export function validatePlatform(platform: string): void {
  if (isPlatformDisabled(platform)) {
    throw new Error(`❌ Platform ${platform} is permanently disabled (see DISABLED_PLATFORMS blacklist)`)
  }
}
