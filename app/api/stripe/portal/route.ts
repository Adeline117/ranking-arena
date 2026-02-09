import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createPortalSession } from '@/lib/stripe'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

export async function POST(request: NextRequest) {
  // 敏感操作限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  try {
    // 前置校验：确保 Stripe 环境变量已配置
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      )
    }

    const { returnUrl } = await request.json()

    // 获取当前用户 - 优先从 Authorization header，回退到 cookie
    const authHeader = request.headers.get('authorization')
    let user = null
    let authError = null

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7)
      const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
      const { data, error } = await supabaseAdmin.auth.getUser(token)
      user = data?.user
      authError = error
    } else {
      const cookieHeader = request.headers.get('cookie') || ''
      const supabaseClient = createClient(
        supabaseUrl,
        anonKey,
        {
          global: { headers: { cookie: cookieHeader } },
          auth: { persistSession: false, detectSessionInUrl: false },
        }
      )
      const { data, error } = await supabaseClient.auth.getUser()
      user = data?.user
      authError = error
    }

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Alias for backward compat
    const session = { user }

    // 获取用户的 Stripe Customer ID
    const supabase = createClient(
      supabaseUrl,
      serviceKey
    )

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', session.user.id)
      .single()

    if (!profile?.stripe_customer_id) {
      // Fallback: redirect to pricing page when no customer exists
      return NextResponse.json(
        { redirect: '/pricing' },
        { status: 200 }
      )
    }

    // 创建客户门户会话
    const portalSession = await createPortalSession(
      profile.stripe_customer_id,
      returnUrl || `${process.env.NEXT_PUBLIC_APP_URL}/settings`
    )

    return NextResponse.json({
      url: portalSession.url,
    })

  } catch (error: unknown) {
    logger.error('Portal session error:', error)
    const message = error instanceof Error ? error.message : ''
    if (message.includes('STRIPE_SECRET_KEY') || message.includes('not configured')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to create portal session' },
      { status: 500 }
    )
  }
}
