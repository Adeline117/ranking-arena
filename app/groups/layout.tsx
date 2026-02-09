import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '交易小组',
  description:
    '加入 ArenaFi 交易小组，讨论交易策略，分享见解，与交易员建立联系。',
  alternates: {
    canonical: `${baseUrl}/groups`,
  },
  openGraph: {
    title: '交易小组 | ArenaFi',
    description: '加入交易小组，讨论策略，分享见解。',
    url: `${baseUrl}/groups`,
    siteName: 'ArenaFi',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'ArenaFi 交易小组' }],
  },
  twitter: {
    card: 'summary',
    title: '交易小组 | ArenaFi',
    description: '加入交易小组，讨论策略，分享见解。',
  },
}

export default function GroupsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
