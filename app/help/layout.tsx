import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '帮助中心',
  description:
    'Get help with Arena — FAQs about subscriptions, features, account settings, trading data, and more.',
  alternates: {
    canonical: `${baseUrl}/help`,
  },
  openGraph: {
    title: '帮助中心 | Arena',
    description: 'FAQs and support for Arena platform.',
    url: `${baseUrl}/help`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Help Center' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '帮助中心 | Arena',
    description: 'FAQs and support for Arena platform.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
