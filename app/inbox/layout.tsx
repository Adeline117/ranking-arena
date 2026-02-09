import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Inbox',
  description: 'Your Arena inbox - notifications, mentions, and activity updates.',
  robots: { index: false, follow: false },
}

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
