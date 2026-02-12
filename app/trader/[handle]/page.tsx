import { redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'

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

// Find the user profile associated with this trader handle
async function findUserProfileByTraderHandle(traderHandle: string): Promise<string | null> {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    if (!supabaseUrl || !supabaseKey) return null
    
    const supabase = createClient(supabaseUrl, supabaseKey)
    
    // First, find the trader ID by handle
    const { data: trader } = await supabase
      .from('traders')
      .select('id')
      .eq('handle', traderHandle)
      .maybeSingle()
    
    if (!trader?.id) return null
    
    // Then find the user who has authorized this trader
    const { data: auth } = await supabase
      .from('trader_authorizations')
      .select('user_id')
      .eq('trader_id', trader.id)
      .eq('status', 'active')
      .maybeSingle()
    
    if (!auth?.user_id) return null
    
    // Finally, get the user's handle
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

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  // Decode handle the same way the client used to
  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // keep original if decode fails
  }

  // Try to find the associated user profile
  const userHandle = await findUserProfileByTraderHandle(decodedHandle)
  
  if (userHandle) {
    // Redirect to the unified user profile page
    redirect(`/u/${encodeURIComponent(userHandle)}`)
  } else {
    // If no user profile found, redirect to user page with trader handle
    // This will show "user not registered" state
    redirect(`/u/${encodeURIComponent(decodedHandle)}`)
  }
}
