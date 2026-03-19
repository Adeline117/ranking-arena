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

// ============================================
// Percentage-based rollout (server-side only)
// ============================================

/**
 * Feature flag configuration supporting percentage-based rollout.
 */
interface FeatureFlagConfig {
  /** Whether the feature is enabled at all */
  enabled: boolean
  /** Rollout percentage (0-100). 100 = fully enabled, 0 = disabled. */
  rolloutPct: number
}

/**
 * Registry of feature flags with rollout configuration.
 * Add new flags here. Defaults to fully enabled.
 */
const FEATURE_FLAGS: Record<string, FeatureFlagConfig> = {
  social: { enabled: features.social, rolloutPct: 100 },
  // Add new flags here:
  // new_ranking_ui: { enabled: true, rolloutPct: 10 },
  // ai_insights: { enabled: true, rolloutPct: 50 },
}

/**
 * Simple deterministic hash for consistent user assignment.
 * Uses FNV-1a-like hash for speed and uniform distribution.
 */
function hashCode(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return hash
}

/**
 * Check if a feature is enabled for a specific user (percentage-based rollout).
 *
 * Deterministic: same userId always gets the same result for the same feature,
 * so users don't see features flicker on/off between requests.
 *
 * Usage:
 *   if (isFeatureEnabledForUser('new_ranking_ui', user.id)) { ... }
 */
export function isFeatureEnabledForUser(feature: string, userId?: string): boolean {
  const config = FEATURE_FLAGS[feature]
  if (!config) return false
  if (!config.enabled) return false
  if (config.rolloutPct >= 100) return true
  if (config.rolloutPct <= 0) return false

  // Without a userId, we can't do consistent hashing
  if (!userId) return false

  // Hash userId + feature name for per-feature consistent assignment
  const hash = hashCode(`${feature}:${userId}`) % 100
  return hash < config.rolloutPct
}
