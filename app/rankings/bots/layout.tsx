import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Crypto Trading Bot Rankings | AI Agents, DeFi Vaults & TG Bots',
  description:
    'Discover and compare top-performing crypto trading bots, AI agents, and on-chain vaults. Rankings by ROI, AUM, TVL, and Arena Score across Telegram bots, DeFi vaults, and AI trading agents. Updated daily.',
  alternates: {
    canonical: `${baseUrl}/rankings/bots`,
  },
  openGraph: {
    title: 'Crypto Trading Bot Rankings | AI Agents, DeFi Vaults & TG Bots',
    description: 'Top-performing crypto trading bots, AI agents, and on-chain vaults ranked by ROI, AUM, and Arena Score. Compare performance metrics across platforms.',
    url: `${baseUrl}/rankings/bots`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Bot Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crypto Trading Bot Rankings',
    description: 'Top-performing crypto trading bots, AI agents, and on-chain vaults ranked by ROI and AUM.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function BotRankingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
