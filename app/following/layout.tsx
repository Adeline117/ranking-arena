import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Following',
  description: 'View posts and updates from traders you follow on ArenaFi.',
}

export default function FollowingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
