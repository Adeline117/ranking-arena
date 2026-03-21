/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// bitget_futures: RE-ENABLED for leaderboard fetch only, enrichment skipped (hangs on detail API)
// 2026-03-21: Temporarily disable binance_futures enrichment (5x 46-77min hangs in 18h)
// All timeout fixes failed (CF Worker, multi-layer, emergency, "permanent")
// Re-enable after deep VPS proxy + AbortSignal investigation
export const DISABLED_PLATFORMS = ['bitget_spot', 'binance_futures'] as const
export type DisabledPlatform = typeof DISABLED_PLATFORMS[number]

export function isPlatformDisabled(platform: string): boolean {
  return DISABLED_PLATFORMS.includes(platform as DisabledPlatform)
}

export function validatePlatform(platform: string): void {
  if (isPlatformDisabled(platform)) {
    throw new Error(`❌ Platform ${platform} is permanently disabled (see DISABLED_PLATFORMS blacklist)`)
  }
}
