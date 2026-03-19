/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// binance_spot: RE-ENABLED 2026-03-19 — added 30s per-page + 4min total timeout
// bitget_futures: PERMANENTLY DISABLED 2026-03-19 (8th stuck >44min)
//   - VPS scraper repeatedly hangs despite timeout protection
//   - Blacklist bypassed by accidental re-enable in commit 713c5f94
export const DISABLED_PLATFORMS = ['bitget_spot', 'bitget_futures'] as const
export type DisabledPlatform = typeof DISABLED_PLATFORMS[number]

export function isPlatformDisabled(platform: string): boolean {
  return DISABLED_PLATFORMS.includes(platform as DisabledPlatform)
}

export function validatePlatform(platform: string): void {
  if (isPlatformDisabled(platform)) {
    throw new Error(`❌ Platform ${platform} is permanently disabled (see DISABLED_PLATFORMS blacklist)`)
  }
}
