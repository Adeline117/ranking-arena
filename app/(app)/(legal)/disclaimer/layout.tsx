import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Risk Disclaimer',
  description: 'Arena risk disclaimer — important information about crypto trading risks, data accuracy, and no-financial-advice notices.',
  alternates: {
    canonical: `${BASE_URL}/disclaimer`,
  },
  openGraph: {
    title: 'Risk Disclaimer',
    description: 'Important information about crypto trading risks, data accuracy, and no-financial-advice notices.',
    url: `${BASE_URL}/disclaimer`,
    siteName: 'Arena',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Risk Disclaimer',
    creator: '@arenafi',
    site: '@arenafi',
  },
}

export default function DisclaimerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
