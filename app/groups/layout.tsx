import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Groups · Arena',
  description:
    'Join crypto trading groups on Arena. Discuss strategies, share insights, and connect with fellow traders.',
  alternates: {
    canonical: `${baseUrl}/groups`,
  },
  openGraph: {
    title: 'Groups · Arena',
    description: 'Join crypto trading groups — discuss strategies and share insights.',
    url: `${baseUrl}/groups`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Groups' }],
  },
  twitter: {
    card: 'summary',
    title: 'Groups · Arena',
    description: 'Join crypto trading groups on Arena.',
  },
}

export default function GroupsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
