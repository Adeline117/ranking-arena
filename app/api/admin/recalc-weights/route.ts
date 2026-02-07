import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
  try {
    const cookieStore = cookies()
    const supabase = createClient(cookieStore)

    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    // Parse request body to check for specific options
    const body = await request.json().catch(() => ({}))
    const { userIds, force = false } = body

    let result
    let affectedCount = 0

    if (userIds && Array.isArray(userIds)) {
      // Recalculate specific users
      const promises = userIds.map(async (userId: string) => {
        const { data, error } = await supabase
          .rpc('calculate_user_weight', { p_user_id: userId })
        
        if (error) {
          console.error(`Error calculating weight for user ${userId}:`, error)
          return null
        }
        return { userId, weight: data }
      })

      const results = await Promise.all(promises)
      const successful = results.filter(r => r !== null)
      affectedCount = successful.length

      result = {
        message: `Recalculated weights for ${affectedCount} users`,
        users: successful,
        errors: userIds.length - affectedCount
      }
    } else {
      // Recalculate all users
      const { data, error } = await supabase.rpc('recalculate_all_user_weights')
      
      if (error) {
        console.error('Error recalculating all weights:', error)
        return NextResponse.json(
          { error: 'Failed to recalculate weights', details: error.message },
          { status: 500 }
        )
      }

      affectedCount = data?.length || 0
      
      result = {
        message: `Successfully recalculated weights for ${affectedCount} users`,
        count: affectedCount,
        sample: data?.slice(0, 10) // Show first 10 results as sample
      }
    }

    // Log the action
    console.log(`[ADMIN] User ${user.id} triggered weight recalculation. Affected: ${affectedCount} users`)

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Weight recalculation error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// GET endpoint to check current weight statistics
export async function GET(request: NextRequest) {
  try {
    const cookieStore = cookies()
    const supabase = createClient(cookieStore)

    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    // Get weight statistics
    const { data: stats, error: statsError } = await supabase
      .from('user_profiles')
      .select('weight')
      .not('weight', 'is', null)

    if (statsError) {
      return NextResponse.json(
        { error: 'Failed to fetch weight statistics' },
        { status: 500 }
      )
    }

    const weights = stats.map(s => s.weight)
    const totalUsers = weights.length
    const avgWeight = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0
    const maxWeight = Math.max(...weights, 0)
    const minWeight = Math.min(...weights, 100)
    
    // Weight distribution
    const distributions = {
      '0-20': weights.filter(w => w >= 0 && w <= 20).length,
      '21-40': weights.filter(w => w >= 21 && w <= 40).length,
      '41-60': weights.filter(w => w >= 41 && w <= 60).length,
      '61-80': weights.filter(w => w >= 61 && w <= 80).length,
      '81-100': weights.filter(w => w >= 81 && w <= 100).length,
    }

    // Top 10 users by weight
    const { data: topUsers, error: topError } = await supabase
      .from('user_profiles')
      .select('id, handle, weight, subscription_tier, created_at')
      .order('weight', { ascending: false })
      .limit(10)

    return NextResponse.json({
      statistics: {
        totalUsers,
        averageWeight: Math.round(avgWeight * 100) / 100,
        maxWeight,
        minWeight,
        distributions
      },
      topUsers: topUsers || [],
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Weight statistics error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}