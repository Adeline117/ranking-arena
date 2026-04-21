import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import TokenRankingClient from './TokenRankingClient'
import { BASE_URL } from '@/lib/constants/urls'
const CURRENT_YEAR = new Date().getFullYear()

// Only allow 1-20 uppercase alphanumeric characters (valid crypto token symbols)
const VALID_TOKEN_RE = /^[A-Z0-9]{1,20}$/

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
      canonical: `${BASE_URL}/rankings/tokens/${token}`,
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
      url: `${BASE_URL}/rankings/tokens/${token}`,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: `Arena ${token} Rankings` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${BASE_URL}/og-image.png`],
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

  // Reject malformed token symbols (SQL injection, XSS, garbage URLs)
  if (!VALID_TOKEN_RE.test(token)) {
    notFound()
  }

  return <TokenRankingClient token={token} />
}
