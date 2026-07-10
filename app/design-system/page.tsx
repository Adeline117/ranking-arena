import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LeaderboardRedesignPreview from './LeaderboardRedesignPreview'

export const metadata: Metadata = {
  title: 'Design System — Leaderboard Redesign Prototype',
  robots: { index: false, follow: false },
}

// Render per-request so the prod gate below runs at runtime, not at build-time
// static prerender (where it would be baked wrong / never re-evaluated).
export const dynamic = 'force-dynamic'

/**
 * Internal design-system sandbox. Hosts visual prototypes for review before
 * porting winning ideas into live components. Not linked from navigation.
 *
 * U12-10: noindex alone left this internal prototype publicly reachable in
 * production. Hard-404 it on the PRODUCTION deployment only — gate on
 * VERCEL_ENV (NODE_ENV is 'production' on preview builds too, so it can't
 * tell prod from preview). dev + preview still open it for design review.
 */
export default function DesignSystemPage() {
  if (process.env.VERCEL_ENV === 'production') notFound()

  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <LeaderboardRedesignPreview />
    </main>
  )
}
