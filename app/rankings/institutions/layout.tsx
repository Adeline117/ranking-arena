import type { Metadata } from 'next'
import { JsonLd } from '@/app/components/Providers/JsonLd'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Top Crypto Institutions & Hedge Funds — Community Rankings',
  description:
    'Browse and rate 600+ crypto institutions: exchanges (Binance, OKX, Bybit), venture capital (a16z, Paradigm, Multicoin), hedge funds (Jump Trading, Alameda), DeFi protocols, and more. Community-rated rankings.',
  keywords: 'crypto institutions, crypto hedge funds, crypto VC, binance, okx, a16z, paradigm, jump trading, crypto exchanges ranking',
  alternates: {
    canonical: `${baseUrl}/rankings/institutions`,
  },
  openGraph: {
    title: 'Top Crypto Institutions & Hedge Funds — Community Rankings',
    description: 'Browse 600+ crypto institutions rated by the community — exchanges, VCs, hedge funds, DeFi protocols, and trading firms.',
    url: `${baseUrl}/rankings/institutions`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Institution Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Top Crypto Institutions',
    description: '600+ crypto institutions ranked by community — exchanges, VCs, hedge funds.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Crypto Institution Rankings',
  description: 'Community ratings and rankings for 600+ crypto institutions including exchanges, venture capital, hedge funds, and DeFi protocols.',
  url: `${baseUrl}/rankings/institutions`,
  provider: { '@type': 'Organization', name: 'Arena', url: baseUrl },
}

export default function InstitutionRankingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={jsonLd} />
      {children}
    </>
  )
}
