/**
 * Feature flags for Arena
 *
 * Controls feature visibility across the platform.
 * Set via environment variables (e.g. NEXT_PUBLIC_FEATURE_SOCIAL=true).
 */
export const features = {
  /** Social features: groups, posts, comments, feed, messaging, user follows */
  social: process.env.NEXT_PUBLIC_FEATURE_SOCIAL === 'true',
}
