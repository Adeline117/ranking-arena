import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import PricingPageClient from './PricingPageClient'

export const metadata: Metadata = {
  title: 'Pricing | Arena',
  description: 'Arena Pro membership plans - unlock advanced trading analytics, alerts, and exclusive features.',
}

export const dynamic = 'force-dynamic'

async function getLifetimeMemberCount(): Promise<number> {
  try {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !serviceKey) return 0

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    })

    // Query user_profiles for lifetime plan members
    // NOTE: subscriptions table does not have a plan column; pro_plan is stored in user_profiles
    const { count, error } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('pro_plan', 'lifetime')

    if (error) {
      console.error('[pricing] Failed to fetch lifetime count:', error.message)
      return 0
    }

    return count ?? 0
  } catch (err) {
    console.error('[pricing] Unexpected error fetching lifetime count:', err)
    return 0
  }
}

export default async function PricingPage() {
  const lifetimeCount = await getLifetimeMemberCount()

  return <PricingPageClient lifetimeCount={lifetimeCount} />
}
