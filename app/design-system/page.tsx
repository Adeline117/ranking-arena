import type { Metadata } from 'next'
import LeaderboardRedesignPreview from './LeaderboardRedesignPreview'

export const metadata: Metadata = {
  title: 'Design System — Leaderboard Redesign Prototype',
  robots: { index: false, follow: false },
}

/**
 * Internal design-system sandbox. Hosts visual prototypes for review before
 * porting winning ideas into live components. Not linked from navigation.
 */
export default function DesignSystemPage() {
  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <LeaderboardRedesignPreview />
    </main>
  )
}
