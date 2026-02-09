import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Pro Pricing | ArenaFi',
  description:
    'Upgrade to Arena Pro for trader alerts, comparison tools, advanced filters, data export, and 1-year historical data. From $9.90/month.',
  alternates: {
    canonical: `${baseUrl}/pricing`,
  },
  keywords: [
    'ArenaFi Pro',
    'crypto trader tools',
    'copy trading premium',
    'trader alerts',
    'trader comparison',
    'ArenaFi pricing',
  ],
  openGraph: {
    title: 'Pro Pricing | ArenaFi',
    description:
      'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons. Starting at $9.90/month.',
    url: `${baseUrl}/pricing`,
    siteName: 'ArenaFi',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'ArenaFi Pro' }],
  },
  twitter: {
    card: 'summary',
    title: 'Pro Pricing | ArenaFi',
    description: 'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons.',
    creator: '@arenafi',
  },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
