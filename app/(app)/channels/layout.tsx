import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Channels',
  description: 'Group chat channels',
  robots: { index: false, follow: false },
}

export default function ChannelsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
