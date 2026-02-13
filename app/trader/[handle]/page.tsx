import { redirect, notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'

// Pre-render top 50 trader pages at build time for instant TTFB
export async function generateStaticParams() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    if (!supabaseUrl || !supabaseKey) return []
    
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data } = await supabase
      .from('trader_sources')
      .select('handle')
      .not('handle', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50)
    
    return (data || [])
      .filter((t: { handle: string | null }) => t.handle)
      .map((t: { handle: string }) => ({ handle: encodeURIComponent(t.handle) }))
  } catch {
    return []
  }
}

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  return createClient(supabaseUrl, supabaseKey)
}

// Find the user profile associated with this trader handle
async function findUserProfileByTraderHandle(traderHandle: string): Promise<string | null> {
  try {
    const supabase = getSupabase()
    
    const { data: trader } = await supabase
      .from('traders')
      .select('id')
      .eq('handle', traderHandle)
      .maybeSingle()
    
    if (!trader?.id) return null
    
    const { data: auth } = await supabase
      .from('trader_authorizations')
      .select('user_id')
      .eq('trader_id', trader.id)
      .eq('status', 'active')
      .maybeSingle()
    
    if (!auth?.user_id) return null
    
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', auth.user_id)
      .maybeSingle()
    
    return profile?.handle || null
  } catch {
    return null
  }
}

// Fetch unregistered trader data from trader_sources + leaderboard_ranks
async function fetchUnregisteredTrader(handle: string): Promise<UnregisteredTraderData | null> {
  try {
    const supabase = getSupabase()
    
    // Find trader_sources by handle (case-insensitive)
    const { data: traderSource } = await supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .ilike('handle', handle)
      .limit(1)
      .maybeSingle()
    
    if (!traderSource) return null
    
    // Get leaderboard_ranks data
    const { data: rankData } = await supabase
      .from('leaderboard_ranks')
      .select('rank, arena_score, roi, pnl, win_rate, max_drawdown, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trading_style, avg_holding_hours, profitability_score, risk_control_score, execution_score')
      .eq('source', traderSource.source)
      .eq('source_trader_id', traderSource.source_trader_id)
      .maybeSingle()
    
    return {
      handle: traderSource.handle || handle,
      avatar_url: traderSource.avatar_url,
      source: traderSource.source,
      source_trader_id: traderSource.source_trader_id,
      ...(rankData || {}),
    }
  } catch {
    return null
  }
}

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // keep original if decode fails
  }

  // 1. Try to find the associated user profile → redirect to /u/[handle]
  const userHandle = await findUserProfileByTraderHandle(decodedHandle)
  if (userHandle) {
    redirect(`/u/${encodeURIComponent(userHandle)}`)
  }

  // 2. Try to fetch unregistered trader data
  const traderData = await fetchUnregisteredTrader(decodedHandle)
  if (traderData) {
    return <TraderProfileClient data={traderData} />
  }

  // 3. Not found
  notFound()
}
