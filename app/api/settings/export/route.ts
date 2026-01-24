/**
 * Data Export API
 * POST: Export all user data as JSON
 * Rate limited to 1 export per 24 hours
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

interface UserProfile {
  id: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  created_at: string
  updated_at: string | null
  last_export_at: string | null
}

interface ExportData {
  exportedAt: string
  profile: UserProfile | null
  posts: unknown[]
  comments: unknown[]
  follows: {
    following: unknown[]
    followers: unknown[]
  }
  tips: {
    sent: unknown[]
    received: unknown[]
  }
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const token = authHeader.substring(7)
    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check rate limit: 1 export per 24 hours
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, handle, display_name, avatar_url, bio, created_at, updated_at, last_export_at')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      console.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    const typedProfile = profile as UserProfile

    if (typedProfile.last_export_at) {
      const lastExport = new Date(typedProfile.last_export_at).getTime()
      const now = Date.now()
      if (now - lastExport < EXPORT_COOLDOWN_MS) {
        const nextAvailable = new Date(lastExport + EXPORT_COOLDOWN_MS).toISOString()
        return NextResponse.json(
          { error: 'Export rate limit exceeded. Try again after: ' + nextAvailable },
          { status: 429 }
        )
      }
    }

    // Collect user data in parallel
    const [postsResult, commentsResult, followingResult, followersResult, tipsSentResult, tipsReceivedResult] = await Promise.all([
      supabase
        .from('posts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('comments')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('user_follows')
        .select('*')
        .eq('follower_id', user.id),
      supabase
        .from('user_follows')
        .select('*')
        .eq('following_id', user.id),
      supabase
        .from('tips')
        .select('*')
        .eq('sender_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('tips')
        .select('*')
        .eq('receiver_id', user.id)
        .order('created_at', { ascending: false }),
    ])

    // Update last export timestamp
    await supabase
      .from('user_profiles')
      .update({ last_export_at: new Date().toISOString() })
      .eq('id', user.id)

    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      profile: typedProfile,
      posts: postsResult.data ?? [],
      comments: commentsResult.data ?? [],
      follows: {
        following: followingResult.data ?? [],
        followers: followersResult.data ?? [],
      },
      tips: {
        sent: tipsSentResult.data ?? [],
        received: tipsReceivedResult.data ?? [],
      },
    }

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ranking-arena-export-${user.id}.json"`,
      },
    })
  } catch (error) {
    console.error('[Export] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
