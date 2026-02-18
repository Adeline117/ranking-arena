import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Bot Rankings - Arena',
  description:
    'Discover top-performing crypto trading bots, AI agents, and on-chain vaults. Compare ROI, AUM, and risk metrics across TG bots, DeFi vaults, and AI trading agents.',
  alternates: {
    canonical: `${baseUrl}/rankings/bots`,
  },
  openGraph: {
    title: 'Bot Rankings | Arena',
    description: 'Top-performing crypto trading bots, AI agents, and on-chain vaults ranked by ROI and AUM.',
    url: `${baseUrl}/rankings/bots`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Bot Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Bot Rankings | Arena',
    description: 'Top-performing crypto trading bots, AI agents, and on-chain vaults.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export default function BotRankingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
