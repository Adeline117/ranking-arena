import type { Metadata } from 'next'
import TokenRankingClient from './TokenRankingClient'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
const CURRENT_YEAR = new Date().getFullYear()

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  const title = `Best ${token} Traders ${CURRENT_YEAR} — Who Trades ${token} Best? | Arena`
  const description = `Top traders for ${token} ranked by PnL. See who profits most trading ${token} across 27+ crypto exchanges. Updated hourly.`

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/rankings/tokens/${token}`,
    },
    keywords: [
      `best ${token} traders`,
      `top ${token} traders ${CURRENT_YEAR}`,
      `${token} trading leaderboard`,
      `${token} PnL ranking`,
      'crypto trader ranking',
      'Arena',
    ],
    openGraph: {
      title,
      description,
      url: `${baseUrl}/rankings/tokens/${token}`,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: `Arena ${token} Rankings` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${baseUrl}/og-image.png`],
      creator: '@arenafi',
    },
    robots: { index: true, follow: true },
  }
}

export default async function TokenDetailPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  return <TokenRankingClient token={token} />
}
