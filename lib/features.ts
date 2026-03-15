/**
 * Feature flags for Arena
 *
 * Controls feature visibility across the platform.
 * Set via environment variables (e.g. NEXT_PUBLIC_FEATURE_SOCIAL=true).
 */

import { NextResponse } from 'next/server'

export const features = {
  /** Social features: groups, posts, comments, feed, messaging, user follows */
  social: process.env.NEXT_PUBLIC_FEATURE_SOCIAL !== 'false',
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
