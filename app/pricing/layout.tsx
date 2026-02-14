import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Pro 会员',
  description:
    'Upgrade to Arena Pro for trader alerts, comparison tools, advanced filters, data export, and 1-year historical data. From $8.25/month.',
  alternates: {
    canonical: `${baseUrl}/pricing`,
  },
  keywords: [
    'Arena Pro',
    'crypto trader tools',
    'copy trading premium',
    'trader alerts',
    'trader comparison',
    'Arena pricing',
  ],
  openGraph: {
    title: 'Pro 会员',
    description:
      'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons. Starting at $8.25/month.',
    url: `${baseUrl}/pricing`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Pro' }],
  },
  twitter: {
    card: 'summary',
    title: 'Pro 会员',
    description: 'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons. Starting at $8.25/month.',
    creator: '@arenafi',
  },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
