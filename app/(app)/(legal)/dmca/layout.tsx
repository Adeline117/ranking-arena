import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'DMCA & Copyright Policy',
  description: 'Arena DMCA policy — copyright infringement notices and counter-notification process.',
  alternates: {
    canonical: `${BASE_URL}/dmca`,
  },
  openGraph: {
    title: 'DMCA & Copyright Policy',
    description: 'Copyright infringement notices and counter-notification process for Arena.',
    url: `${BASE_URL}/dmca`,
    siteName: 'Arena',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'DMCA & Copyright Policy',
    creator: '@arenafi',
    site: '@arenafi',
  },
}

export default function DmcaLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
