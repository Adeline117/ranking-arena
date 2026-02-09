import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'View your notifications - new followers, mentions, and activity updates on ArenaFi.',
}

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
