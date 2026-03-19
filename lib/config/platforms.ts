/**
 * Centralized platform configuration
 * Single source of truth for disabled/blocked platforms
 */

// 🚨 DISABLED PLATFORMS - permanently blocked due to repeated failures/hangs
// bitget_futures: RE-ENABLED for leaderboard fetch only, enrichment skipped (hangs on detail API)
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
