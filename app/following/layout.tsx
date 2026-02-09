import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Following',
  description: 'View posts and updates from traders you follow on Arena.',
}

export default function FollowingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
