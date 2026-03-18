import type { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import PricingPageClient from './PricingPageClient'

const logger = createLogger('pricing-page')

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Arena Pro membership plans - unlock advanced trading analytics, alerts, and exclusive features.',
  alternates: {
    canonical: `${baseUrl}/pricing`,
  },
  openGraph: {
    title: 'Pricing — Arena Pro',
    description: 'Unlock advanced trading analytics, alerts, and exclusive features with Arena Pro membership.',
    url: `${baseUrl}/pricing`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Pro Pricing' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pricing — Arena Pro',
    description: 'Unlock advanced trading analytics, alerts, and exclusive features with Arena Pro membership.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export const revalidate = 3600 // ISR: refresh lifetime count every hour

async function getLifetimeMemberCount(): Promise<number> {
  try {
    const supabase = getSupabaseAdmin()

    // Query user_profiles for lifetime plan members
    // NOTE: subscriptions table does not have a plan column; pro_plan is stored in user_profiles
    const { count, error } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('pro_plan', 'lifetime')

    if (error) {
      logger.error('[pricing] Failed to fetch lifetime count:', error.message)
      return 0
    }

    return count ?? 0
  } catch (err) {
    logger.error('[pricing] Unexpected error fetching lifetime count:', err)
    return 0
  }
}

export default async function PricingPage() {
  const lifetimeCount = await getLifetimeMemberCount()

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Arena Pro',
    description: 'Professional crypto trader analytics and ranking platform with advanced filters, alerts, and score breakdowns.',
    url: `${baseUrl}/pricing`,
    brand: {
      '@type': 'Organization',
      name: 'Arena',
      url: baseUrl,
    },
    offers: [
      {
        '@type': 'Offer',
        name: 'Monthly',
        price: '4.99',
        priceCurrency: 'USD',
        priceValidUntil: new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
        availability: 'https://schema.org/InStock',
        url: `${baseUrl}/pricing`,
      },
      {
        '@type': 'Offer',
        name: 'Yearly',
        price: '29.99',
        priceCurrency: 'USD',
        priceValidUntil: new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
        availability: 'https://schema.org/InStock',
        url: `${baseUrl}/pricing`,
      },
      {
        '@type': 'Offer',
        name: 'Lifetime (Founding Member)',
        price: '49.99',
        priceCurrency: 'USD',
        priceValidUntil: new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
        availability: 'https://schema.org/LimitedAvailability',
        url: `${baseUrl}/pricing`,
      },
    ],
  }

  return (
    <>
      <JsonLd data={jsonLd} />
      <PricingPageClient lifetimeCount={lifetimeCount} />
    </>
  )
}
