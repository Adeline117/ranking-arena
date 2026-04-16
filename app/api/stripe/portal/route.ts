import { NextRequest, NextResponse } from 'next/server'
import { type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createPortalSession } from '@/lib/stripe'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'

export async function POST(request: NextRequest) {
  // 敏感操作限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  try {
    // 前置校验：确保 Stripe 环境变量已配置
    if (!env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    let rawReturnUrl: string | undefined
    try {
      const body = await request.json()
      rawReturnUrl = body.returnUrl
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    // Validate returnUrl to prevent open redirect
    let returnUrl: string | undefined
    if (rawReturnUrl && typeof rawReturnUrl === 'string') {
      try {
        const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
        const parsed = new URL(rawReturnUrl, appOrigin)
        if (parsed.origin === appOrigin) {
          returnUrl = parsed.href
        }
      } catch {
        // Invalid URL — use default
      }
    }

    // 获取当前用户
    const { user, error: authError } = await extractUserFromRequest(request)

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Alias for backward compat
    const session = { user }

    // 获取用户的 Stripe Customer ID
    const { data: profile } = await (getSupabaseAdmin() as SupabaseClient)
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
      returnUrl || `${env.NEXT_PUBLIC_APP_URL}/settings`
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
