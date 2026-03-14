import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Help Center — Arena | FAQs & Support',
  description:
    'Get help with Arena — Find answers to frequently asked questions about subscriptions, platform features, account settings, trading data, rankings methodology, and more. Complete support documentation.',
  alternates: {
    canonical: `${baseUrl}/help`,
  },
  openGraph: {
    title: 'Help Center — Arena | FAQs & Support',
    description: 'Find answers to frequently asked questions about Arena — subscriptions, features, account settings, trading data, and rankings methodology.',
    url: `${baseUrl}/help`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Help Center' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Help Center — Arena | FAQs & Support',
    description: 'Find answers to frequently asked questions about Arena platform features and account settings.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
