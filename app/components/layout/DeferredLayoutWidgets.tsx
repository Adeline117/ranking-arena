'use client'

/**
 * DeferredLayoutWidgets — groups all low-priority layout widgets into a
 * single async chunk.
 *
 * Before: app/(app)/layout.tsx had 10 separate dynamic() imports for
 * SentryInit, NetworkStatusBanner, ServiceWorkerRegistration,
 * KeyboardShortcuts, CompareFloatingBar, ScrollToTop, FeedbackWidget,
 * PlausibleAnalytics, ScrollRestoration, CookieConsent. Each produced
 * a separate webpack chunk with its own HTTP round-trip and init cost.
 * On slow 4G this added 100-300ms of chunk negotiation overhead.
 *
 * After: one dynamic() import of this file. Webpack bundles all widgets
 * into one chunk (no code-splitting inside this file). Still deferred
 * from the initial (app) layout bundle via the dynamic() import at the
 * call site.
 */

import SentryInit from '../Providers/SentryInit'
import NetworkStatusBanner from '../ui/NetworkStatusBanner'
import KeyboardShortcuts from '../Providers/KeyboardShortcuts'
import CompareFloatingBar from '../trader/CompareFloatingBar'
import ScrollToTop from '../ui/ScrollToTop'
import FeedbackWidget from '../common/FeedbackWidget'
import PlausibleAnalytics from '../PlausibleAnalytics'
import ScrollRestoration from '../Providers/ScrollRestoration'
import CookieConsent from '../ui/CookieConsent'

// ServiceWorkerRegistration removed — SW is now registered via inline <script>
// in app/layout.tsx <head> so it runs even if React fails to mount (breaks the
// deadlock where a broken old SW prevents JS from loading which prevents React
// from mounting which prevents SW update).

export default function DeferredLayoutWidgets() {
  return (
    <>
      <SentryInit />
      <NetworkStatusBanner />
      <KeyboardShortcuts />
      <CompareFloatingBar />
      <ScrollToTop />
      <FeedbackWidget />
      <PlausibleAnalytics />
      <ScrollRestoration />
      <CookieConsent />
    </>
  )
}
