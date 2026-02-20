import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Pro 会员',
  description:
    'Upgrade to Arena Pro for trader alerts, comparison tools, advanced filters, and 1-year historical data. From $4.99/month. Founding Member Lifetime access at $49.99.',
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
      'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons. Starting at $4.99/month.',
    url: `${baseUrl}/pricing`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Pro' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pro 会员 | Arena',
    description: 'Upgrade to Arena Pro — trader alerts, advanced analytics, unlimited comparisons. Starting at $4.99/month.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
