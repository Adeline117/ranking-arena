import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '群聊',
  description: 'Group chat channels',
}

export default function ChannelsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
