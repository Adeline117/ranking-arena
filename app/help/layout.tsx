import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Help Center | ArenaFi',
  description:
    'Get help with Arena — FAQs about subscriptions, features, account settings, trading data, and more.',
  alternates: {
    canonical: `${baseUrl}/help`,
  },
  openGraph: {
    title: 'Help Center | ArenaFi',
    description: 'FAQs and support for ArenaFi platform.',
    url: `${baseUrl}/help`,
    siteName: 'ArenaFi',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Help Center | ArenaFi',
    description: 'FAQs and support for ArenaFi platform.',
  },
}

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
