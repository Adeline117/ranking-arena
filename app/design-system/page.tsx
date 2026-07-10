import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LeaderboardRedesignPreview from './LeaderboardRedesignPreview'

export const metadata: Metadata = {
  title: 'Design System — Leaderboard Redesign Prototype',
  robots: { index: false, follow: false },
}

// Force per-request rendering so the gate below runs at RUNTIME, not at
// build-time static prerender. This is the crux of U12-10: a bare
// `if (NODE_ENV==='production') notFound()` on a statically-prerendered page
// never re-evaluates at request time, so it leaked at 200 (verified live).
export const dynamic = 'force-dynamic'

/**
 * Internal design-system sandbox. Hosts visual prototypes for review before
 * porting winning ideas into live components. Not linked from navigation.
 *
 * U12-10: hard-404 anywhere that isn't local dev. NODE_ENV is the only signal
 * that's reliably present at runtime here — this project disabled Vercel
 * system-env injection (VERCEL_ENV undefined) and sits behind Cloudflare→Vercel
 * so the Host header isn't the public domain (both verified live). At Vercel
 * runtime NODE_ENV==='production' (prod AND preview), so this 404s both; only a
 * local `next dev` (NODE_ENV==='development') opens it for design review.
 */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <LeaderboardRedesignPreview />
    </main>
  )
}
