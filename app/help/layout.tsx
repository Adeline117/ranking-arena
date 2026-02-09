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
    title: '帮助中心',
    description: 'FAQs and support for Arena platform.',
    url: `${baseUrl}/help`,
    siteName: 'Arena',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: '帮助中心',
    description: 'FAQs and support for Arena platform.',
  },
}

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
