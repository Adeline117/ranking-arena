/**
 * Feature flags for Arena
 *
 * Flags are deployment-time NEXT_PUBLIC_FEATURE_* environment contracts so
 * server and client surfaces agree. Changing one requires a rebuild/redeploy.
 */

import { NextResponse } from 'next/server'

// Build-time flags (available in client + server)
export const features = {
  /** Social features: groups, posts, comments, feed, messaging, user follows */
  social: process.env.NEXT_PUBLIC_FEATURE_SOCIAL !== 'false',
}

/**
 * Routes where the authenticated social create-post FAB can appear.
 * Layout widgets use this even before auth is known so they always reserve
 * the same slot as FloatingActionButton.
 */
export function isFloatingActionRoute(pathname: string): boolean {
  if (!features.social) return false
  return pathname === '/' || pathname === '/groups' || pathname.startsWith('/groups/')
}

/**
 * Critical forms should not be covered by the global feedback control on a
 * narrow viewport. These routes retain the footer feedback entry.
 */
export function isFeedbackSuppressedRoute(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/register' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname === '/pricing' ||
    pathname.startsWith('/pricing/')
  )
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
