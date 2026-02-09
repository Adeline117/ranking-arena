import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: Request) {
  try {
    const supabase = getSupabase()
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: '认证失败' }, { status: 401 })
    }

    const body = await req.json()
    const { tier, platform, platform_handle, follower_count, description, proof_url } = body

    if (!tier || !['tier1', 'tier2', 'tier3'].includes(tier)) {
      return NextResponse.json({ error: '请选择有效的等级' }, { status: 400 })
    }

    // Check for existing pending application
    const { data: existing } = await supabase
      .from('kol_applications')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: '你已有一个待审核的申请' }, { status: 409 })
    }

    const { data, error } = await supabase
      .from('kol_applications')
      .insert({
        user_id: user.id,
        tier,
        platform: platform || null,
        platform_handle: platform_handle || null,
        follower_count: follower_count ? parseInt(follower_count) : null,
        description: description || null,
        proof_url: proof_url || null,
      })
      .select()
      .single()

    if (error) {
      logger.error('KOL application error:', error)
      return NextResponse.json({ error: '提交失败，请稍后重试' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logger.error('KOL apply error:', err)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
