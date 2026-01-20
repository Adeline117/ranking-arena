/**
 * 验证 Stripe Checkout Session 并同步订阅状态
 * 用于本地开发或 webhook 失败时的备用方案
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// 懒加载 Stripe 客户端
function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: '2025-12-15.clover',
  })
}

// 懒加载 Supabase Admin 客户端
function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// 从价格 ID 获取订阅等级
function getTierFromPriceId(priceId: string): 'free' | 'pro' | 'elite' {
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) {
    return 'pro'
  }
  if (priceId === process.env.STRIPE_ELITE_PRICE_ID) {
    return 'elite'
  }
  return 'free'
}

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json()

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session ID' }, { status: 400 })
    }

    const stripe = getStripe()
    const supabaseAdmin = getSupabaseAdmin()

    // 获取 Checkout Session
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    })

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 400 })
    }

    const userId = session.metadata?.supabase_user_id || session.metadata?.userId
    const customerId = session.customer as string
    const subscription = session.subscription as Stripe.Subscription | null

    if (!userId) {
      return NextResponse.json({ error: 'User ID not found in session' }, { status: 400 })
    }

    // 获取订阅详情
    let tier: 'free' | 'pro' | 'elite' = 'pro'
    let subscriptionId = ''
    let periodStart: string | null = null
    let periodEnd: string | null = null

    if (subscription) {
      subscriptionId = subscription.id
      const priceId = subscription.items.data[0]?.price.id || ''
      tier = getTierFromPriceId(priceId)
      
      // 获取周期信息
      const subAny = subscription as unknown as { current_period_start?: number; current_period_end?: number }
      if (subAny.current_period_start) {
        periodStart = new Date(subAny.current_period_start * 1000).toISOString()
      }
      if (subAny.current_period_end) {
        periodEnd = new Date(subAny.current_period_end * 1000).toISOString()
      }
    }

    // 更新订阅记录
    const { error } = await supabaseAdmin
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        tier,
        status: 'active',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })

    if (error) {
      console.error('Failed to update subscription:', error)
      return NextResponse.json({ error: 'Failed to update subscription' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      tier,
      status: 'active',
    })

  } catch (error) {
    console.error('Verify session error:', error)
    return NextResponse.json({ error: 'Failed to verify session' }, { status: 500 })
  }
}
