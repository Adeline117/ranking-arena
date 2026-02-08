import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'About',
  description: 'Learn about ArenaFi - the crypto trader leaderboard and community platform aggregating data from 30+ exchanges.',
}

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return children
}
