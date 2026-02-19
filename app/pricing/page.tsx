import type { Metadata } from 'next'
import PricingPageClient from './PricingPageClient'

export const metadata: Metadata = {
  title: 'Pricing | Arena',
  description: 'Arena Pro membership plans - unlock advanced trading analytics, alerts, and exclusive features.',
}

export default function PricingPage() {
  return <PricingPageClient />
}
