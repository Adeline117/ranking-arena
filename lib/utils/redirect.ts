/**
 * Full-page navigation to an absolute URL (e.g. a Stripe Checkout session).
 * Kept in its own module so tests can observe the destination: jsdom does not
 * allow redefining window.location.
 */
export function redirectTo(url: string): void {
  window.location.href = url
}
