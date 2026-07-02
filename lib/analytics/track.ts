/**
 * Custom event tracking utility — dual-emits to Plausible AND PostHog.
 *
 * Safe to call anywhere: no-ops for whichever provider is not loaded. Both are
 * key-gated (Plausible via its script tag, PostHog via NEXT_PUBLIC_POSTHOG_KEY),
 * so with no keys set this is a silent no-op. The moment the owner adds a
 * PostHog key, every trackEvent call already sprinkled through the app starts
 * flowing into PostHog funnels with zero further code changes.
 */

type EventProps = Record<string, string | number | boolean>

interface PlausibleFn {
  (name: string, opts?: { props: Record<string, string | number | boolean> }): void
}

interface PostHogLike {
  capture: (name: string, props?: Record<string, unknown>) => void
}

export function trackEvent(name: string, props?: EventProps) {
  if (typeof window === 'undefined') return

  // Plausible
  const plausible = (window as unknown as { plausible?: PlausibleFn }).plausible
  if (plausible) {
    plausible(name, { props: props ?? {} })
  }

  // PostHog (posthog-js attaches itself to window.posthog after init)
  const posthog = (window as unknown as { posthog?: PostHogLike }).posthog
  if (posthog && typeof posthog.capture === 'function') {
    posthog.capture(name, props)
  }
}
