import type { Metadata } from 'next'

export const revalidate = 0 // Auth-walled: no cache

export const metadata: Metadata = {
  title: 'Messages',
  description: 'Direct messages with other traders on Arena.',
  robots: { index: false, follow: false },
}

export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
