/**
 * Quiz layout — ultra-lightweight, zero Providers overhead.
 *
 * Quiz is a standalone viral experience accessed via QR/social links.
 * First-time visitors on mobile need the fastest possible load.
 *
 * What's NOT loaded (vs the main (app) layout):
 * - QueryClientProvider (quiz doesn't fetch with React Query)
 * - PrivyClientProvider (no wallet)
 * - PremiumProvider (no subscriptions)
 * - LanguageProvider (quiz has its own t() function)
 * - MobileBottomNav (hidden on quiz anyway)
 * - DeferredLayoutWidgets (Sentry, ScrollToTop, etc.)
 * - GlobalProgress
 * - Analytics (Vercel, Plausible)
 *
 * Result: quiz JS bundle is ~70% smaller than a regular page.
 */
export default function QuizLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <main id="main-content" tabIndex={-1}>
      {children}
    </main>
  )
}
