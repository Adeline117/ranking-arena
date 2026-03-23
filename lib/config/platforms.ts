/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// bitget_futures: RE-ENABLED with enrichment (concurrency:3, 18s/trader timeout, CF Worker proxy)
// 2026-03-21: Temporarily disable enrichment for repeatedly stuck platforms
// binance_futures: 5x hangs (12:30, 14:30, 01:00, 02:30, 06:30)
// bybit/kucoin/weex/okx_web3: 3x hangs (10:30, 11:00, 22:30) - 45min each
// 2026-03-22: dydx: 3x hangs (10:30, 14:30, 18:00) - 31-45min each
// All timeout fixes failed, cleanup cron not catching them
// Re-enable after deep investigation of timeout root cause
export const DISABLED_PLATFORMS = ['bitget_spot', 'binance_futures', 'bybit', 'kucoin', 'weex', 'okx_web3', 'dydx'] as const
export type DisabledPlatform = typeof DISABLED_PLATFORMS[number]

export function isPlatformDisabled(platform: string): boolean {
  return DISABLED_PLATFORMS.includes(platform as DisabledPlatform)
}

export function validatePlatform(platform: string): void {
  if (isPlatformDisabled(platform)) {
    throw new Error(`❌ Platform ${platform} is permanently disabled (see DISABLED_PLATFORMS blacklist)`)
  }
}
