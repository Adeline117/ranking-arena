/**
 * Feature flags for Arena
 *
 * Two layers:
 * 1. Build-time flags via NEXT_PUBLIC_FEATURE_* env vars (default behavior)
 * 2. Runtime flags via Redis cache (checked on API requests, 60s TTL)
 *
 * Build-time flags are used by client components (must be NEXT_PUBLIC_*).
 * Runtime flags allow toggling features without redeployment.
 *
 * Inspired by dub.co Edge Config and cal.com feature flag patterns.
 */

import { NextResponse } from 'next/server'

// Build-time flags (available in client + server)
export const features = {
  /** Social features: groups, posts, comments, feed, messaging, user follows */
  social: process.env.NEXT_PUBLIC_FEATURE_SOCIAL !== 'false',
}

// Runtime flags with Redis cache (server-side only)
let runtimeFlagsCache: { flags: Record<string, boolean>; ts: number } | null = null
const RUNTIME_FLAGS_TTL = 60_000 // 60s

/**
 * Get runtime feature flags (server-side only).
 * Falls back to build-time flags if Redis is unavailable.
 */
export async function getRuntimeFlags(): Promise<Record<string, boolean>> {
  if (runtimeFlagsCache && Date.now() - runtimeFlagsCache.ts < RUNTIME_FLAGS_TTL) {
    return runtimeFlagsCache.flags
  }

  try {
    const { get } = await import('@/lib/cache')
    const cached = await get<Record<string, boolean>>('runtime-feature-flags')
    if (cached) {
      runtimeFlagsCache = { flags: cached, ts: Date.now() }
      return cached
    }
  } catch {
    // Redis unavailable — fall back to build-time flags
  }

  // Default: use build-time flags
  const defaults: Record<string, boolean> = { ...features }
  runtimeFlagsCache = { flags: defaults, ts: Date.now() }
  return defaults
}

/**
 * Check if a specific feature is enabled (server-side, supports runtime override).
 */
export async function isFeatureEnabled(flag: keyof typeof features): Promise<boolean> {
  const flags = await getRuntimeFlags()
  return flags[flag] ?? features[flag] ?? false
}

/**
 * Guard for social API routes. Returns a 404 response when social features are disabled.
 * Usage: `const guard = socialFeatureGuard(); if (guard) return guard;`
 */
export function socialFeatureGuard() {
  if (!features.social) {
    return NextResponse.json({ error: 'Feature not available' }, { status: 404 })
  }
  return null
}
