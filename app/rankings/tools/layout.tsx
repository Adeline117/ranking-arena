import type { Metadata } from 'next'
import { JsonLd } from '@/app/components/Providers/JsonLd'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Best Crypto Trading Tools & Bots — Community Rankings | Arena',
  description:
    'Discover and rate 190+ crypto trading tools: trading bots (3Commas, Pionex), analytics (Glassnode, Nansen, Coinglass), on-chain dashboards (Dune, DefiLlama), quant platforms, portfolio trackers, and more.',
  keywords: 'crypto trading tools, best crypto bots, crypto analytics, glassnode, nansen, coinglass, 3commas, dune analytics, defi tools',
  alternates: {
    canonical: `${baseUrl}/rankings/tools`,
  },
  openGraph: {
    title: 'Best Crypto Trading Tools & Bots — Community Rankings | Arena',
    description: 'Discover 190+ crypto trading tools rated by the community — bots, analytics, on-chain dashboards, quant platforms.',
    url: `${baseUrl}/rankings/tools`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Trading Tools Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Best Crypto Trading Tools | Arena',
    description: '190+ crypto tools ranked by community — bots, analytics, quant platforms.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Crypto Trading Tools Rankings',
  description: 'Community ratings and rankings for 190+ crypto trading tools including bots, analytics platforms, on-chain dashboards, and quant platforms.',
  url: `${baseUrl}/rankings/tools`,
  provider: { '@type': 'Organization', name: 'Arena', url: baseUrl },
}

export default function ToolRankingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={jsonLd} />
      {children}
    </>
  )
}
