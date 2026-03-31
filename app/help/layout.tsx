import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 3600 // ISR: 1 hour (static content)

export const metadata: Metadata = {
  title: 'Help Center | FAQs & Support',
  description:
    'Get help with Arena — Find answers to frequently asked questions about subscriptions, platform features, account settings, trading data, rankings methodology, and more. Complete support documentation.',
  alternates: {
    canonical: `${BASE_URL}/help`,
  },
  openGraph: {
    title: 'Help Center | FAQs & Support',
    description: 'Find answers to frequently asked questions about Arena — subscriptions, features, account settings, trading data, and rankings methodology.',
    url: `${BASE_URL}/help`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Help Center' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Help Center | FAQs & Support',
    description: 'Find answers to frequently asked questions about Arena platform features and account settings.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
