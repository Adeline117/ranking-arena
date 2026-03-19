import type { Metadata } from 'next'
import TokensIndexClient from './TokensIndexClient'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Token Rankings — Who Trades BTC Best? | Arena',
  description:
    'Discover the best traders for every token. See who profits most trading BTC, ETH, SOL, and 50+ tokens across 27 exchanges.',
  alternates: {
    canonical: `${baseUrl}/rankings/tokens`,
  },
  openGraph: {
    title: 'Token Rankings — Who Trades BTC Best?',
    description:
      'Token-level trader rankings across 27+ exchanges. Find the best BTC, ETH, SOL traders by PnL.',
    url: `${baseUrl}/rankings/tokens`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Token Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Token Rankings — Who Trades BTC Best?',
    description: 'Token-level trader rankings. Find the best BTC, ETH, SOL traders.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function TokensPage() {
  return <TokensIndexClient />
}
