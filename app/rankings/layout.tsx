import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Trader Rankings | Arena',
  description:
    'Real-time crypto trader leaderboard across Binance, Bybit, Bitget, OKX, MEXC, KuCoin, GMX, Hyperliquid and more. Compare 90-day ROI, win rate, drawdown and Arena Score.',
  alternates: {
    canonical: `${baseUrl}/rankings`,
  },
  keywords: [
    'crypto trader ranking',
    'copy trading leaderboard',
    'ROI ranking',
    'Binance traders',
    'Bybit leaderboard',
    'crypto trading performance',
    'Arena Score',
  ],
  openGraph: {
    title: 'Trader Rankings | Arena',
    description:
      'Real-time crypto trader leaderboard across 22+ exchanges. Compare ROI, win rate, drawdown and Arena Score.',
    url: `${baseUrl}/rankings`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trader Rankings | Arena',
    description:
      'Real-time crypto trader leaderboard across 22+ exchanges.',
    images: [`${baseUrl}/og.png`],
    creator: '@arenafi',
  },
}

export default function RankingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
