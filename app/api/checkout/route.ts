/**
 * Stripe Checkout Session API
 * 创建支付会话并重定向到 Stripe 支付页面
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

// 初始化 Stripe（延迟初始化，避免环境变量缺失时报错）
function getStripe(): Stripe {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: '2026-02-25.clover',
  })
}

// 订阅计划配置 - 只有 Pro 会员
const PLANS: Record<string, { priceId: string; name: string }> = {
  pro: {
    priceId: process.env.STRIPE_PRO_PRICE_ID || env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
    name: 'Pro',
  },
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    // 获取请求体
    const body = await request.json()
    const { plan, billingCycle: _billingCycle = 'monthly' } = body

    if (!plan || !PLANS[plan]) {
      return NextResponse.json(
        { error: 'Invalid plan. Valid option: pro' },
        { status: 400 }
      )
    }

    // 获取当前用户
    const supabase = getSupabaseAdmin()
    const authHeader = request.headers.get('authorization')
    
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      )
    }

    const stripe = getStripe()
    const planConfig = PLANS[plan]

    // 检查是否已有 Stripe 客户
    const { data: existingSubscription } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    let customerId = existingSubscription?.stripe_customer_id

    // 如果没有 Stripe 客户，创建一个
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          supabase_user_id: user.id,
        },
      })
      customerId = customer.id
    }

    // 创建 Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: planConfig.priceId,
          quantity: 1,
        },
      ],
      success_url: `${env.NEXT_PUBLIC_APP_URL}/settings?tab=subscription&success=true`,
      cancel_url: `${env.NEXT_PUBLIC_APP_URL}/settings?tab=subscription&canceled=true`,
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          plan,
        },
      },
      metadata: {
        supabase_user_id: user.id,
        plan,
      },
    })

    return NextResponse.json({
      sessionId: session.id,
      url: session.url,
    })
  } catch (error: unknown) {
    logger.error('[Checkout] Error:', error)

    // SECURITY: Never leak internal error details to client
    const internalMessage = error instanceof Error ? error.message : 'Unknown error'

    // 特殊处理 Stripe 未配置的情况
    if (internalMessage.includes('STRIPE_SECRET_KEY')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { error: 'An error occurred during checkout. Please try again.' },
      { status: 500 }
    )
  }
}
