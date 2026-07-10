import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LeaderboardRedesignPreview from './LeaderboardRedesignPreview'

export const metadata: Metadata = {
  title: 'Design System — Leaderboard Redesign Prototype',
  robots: { index: false, follow: false },
}

/**
 * Internal design-system sandbox. Hosts visual prototypes for review before
 * porting winning ideas into live components. Not linked from navigation.
 *
 * U12-10: noindex alone left this internal prototype publicly reachable in
 * production (no middleware gate). Hard-404 it in prod so only dev/preview
 * can open it; the page still works locally for design review.
 */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <LeaderboardRedesignPreview />
    </main>
  )
}
