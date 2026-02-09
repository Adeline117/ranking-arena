import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

const VALID_TYPES = ['post', 'comment', 'profile']
const VALID_REASONS = ['spam', 'scam', 'harassment', 'misinformation', 'nsfw', 'other']

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

    const { content_type, content_id, reason, description } = await req.json()

    if (!VALID_TYPES.includes(content_type)) {
      return NextResponse.json({ error: '无效的内容类型' }, { status: 400 })
    }
    if (!VALID_REASONS.includes(reason)) {
      return NextResponse.json({ error: '无效的举报原因' }, { status: 400 })
    }
    if (!content_id) {
      return NextResponse.json({ error: '缺少内容ID' }, { status: 400 })
    }

    // Check duplicate report
    const { data: existing } = await supabase
      .from('content_reports')
      .select('id')
      .eq('reporter_id', user.id)
      .eq('content_type', content_type)
      .eq('content_id', content_id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: '你已举报过该内容' }, { status: 409 })
    }

    const { error } = await supabase
      .from('content_reports')
      .insert({
        reporter_id: user.id,
        content_type,
        content_id,
        reason,
        description: description || null,
      })

    if (error) {
      return NextResponse.json({ error: '提交失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (_err) {
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
