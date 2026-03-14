import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'System Status',
  description: 'Arena platform system status - database, Redis, and data freshness monitoring.',
  openGraph: {
    title: 'System Status',
    description: 'Arena platform system status - database, Redis, and data freshness monitoring.',
    url: 'https://www.arenafi.org/status',
    siteName: 'Arena',
    type: 'website',
  },
}

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children
}
