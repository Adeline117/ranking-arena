import type { Metadata } from 'next'

export const revalidate = 0 // Auth-walled: no cache

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'View your notifications - new followers, mentions, and activity updates on Arena.',
  robots: { index: false, follow: false },
}

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
