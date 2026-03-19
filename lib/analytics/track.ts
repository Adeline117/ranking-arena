/**
 * Plausible custom event tracking utility.
 * Safe to call anywhere — no-op if Plausible is not loaded.
 */
export function trackEvent(name: string, props?: Record<string, string | number>) {
  if (typeof window !== 'undefined' && (window as unknown as { plausible?: (name: string, opts?: { props: Record<string, string | number> }) => void }).plausible) {
    const plausible = (window as unknown as { plausible: (name: string, opts?: { props: Record<string, string | number> }) => void }).plausible
    if (props) {
      plausible(name, { props })
    } else {
      plausible(name, { props: {} })
    }
  }
}
