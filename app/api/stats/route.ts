import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Cache stats for 5 minutes
export const revalidate = 300

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({
      traderCount: 31000,
      exchangeCount: 16,
    })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    const [tradersResult, sourcesResult] = await Promise.all([
      supabase
        .from('trader_snapshots')
        .select('id', { count: 'exact', head: true }),
      supabase
        .from('trader_snapshots')
        .select('source')
        .limit(10000),
    ])

    const traderCount = tradersResult.count ?? 31000
    const uniqueSources = new Set(sourcesResult.data?.map(r => {
      // Extract exchange name from source key (e.g. "binance_futures" -> "binance")
      const parts = r.source.split('_')
      // Handle multi-word exchange names like "gate.io"
      if (r.source.startsWith('gateio')) return 'gateio'
      return parts[0]
    }) ?? [])
    const exchangeCount = uniqueSources.size || 16

    return NextResponse.json({
      traderCount,
      exchangeCount,
    })
  } catch {
    return NextResponse.json({
      traderCount: 31000,
      exchangeCount: 16,
    })
  }
}
