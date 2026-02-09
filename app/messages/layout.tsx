import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Messages',
  description: 'Direct messages with other traders on ArenaFi.',
}

export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
