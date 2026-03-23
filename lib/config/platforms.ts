/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// 2026-03-22: RE-ENABLED binance_futures, bybit, kucoin, weex, okx_web3
// Root cause: AbortSignal.timeout() doesn't reliably kill stuck TCP connections.
// Fix: raceWithTimeout() hard deadline via Promise.race at per-trader + per-platform level.
// Also added hard deadlines to CF Worker proxy + VPS proxy calls in enrichment-types.ts.
export const DISABLED_PLATFORMS = ['bitget_spot'] as const
export type DisabledPlatform = typeof DISABLED_PLATFORMS[number]

export function isPlatformDisabled(platform: string): boolean {
  return DISABLED_PLATFORMS.includes(platform as DisabledPlatform)
}

export function validatePlatform(platform: string): void {
  if (isPlatformDisabled(platform)) {
    throw new Error(`❌ Platform ${platform} is permanently disabled (see DISABLED_PLATFORMS blacklist)`)
  }
}
