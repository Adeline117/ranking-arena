/**
 * 打赏 Checkout API
 * POST /api/tip/checkout - 创建打赏支付会话
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

function getStripe(): Stripe {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: '2026-03-25.dahlia',
  })
}

// 打赏金额选项（美分）
const _TIP_AMOUNTS = [100, 300, 500, 1000, 2000, 5000] // $1, $3, $5, $10, $20, $50

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const supabase = getSupabaseAdmin()
    
    // 验证用户
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Please log in first' },
        { status: 401 }
      )
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Session expired, please log in again' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { post_id, amount_cents, message } = body

    // 验证参数
    if (!post_id) {
      return NextResponse.json(
        { error: 'Missing post_id parameter' },
        { status: 400 }
      )
    }

    const amount = Number(amount_cents)
    if (!amount || amount < 100 || amount > 50000) {
      return NextResponse.json(
        { error: 'Invalid tip amount ($1 - $500)' },
        { status: 400 }
      )
    }

    // Idempotency check: prevent duplicate tips within 60 seconds
    const { data: recentPendingTip } = await supabase
      .from('tips')
      .select('id')
      .eq('from_user_id', user.id)
      .eq('post_id', post_id)
      .eq('amount_cents', amount)
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 60000).toISOString())
      .maybeSingle()

    if (recentPendingTip) {
      return NextResponse.json(
        { error: 'Duplicate tip detected, please try again later' },
        { status: 429 }
      )
    }

    // 获取帖子信息
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('id, title, author_id, author_handle')
      .eq('id', post_id)
      .maybeSingle()

    if (postError || !post) {
      return NextResponse.json(
        { error: 'Post not found' },
        { status: 404 }
      )
    }

    // 不能给自己打赏
    if (post.author_id === user.id) {
      return NextResponse.json(
        { error: 'Cannot tip your own post' },
        { status: 400 }
      )
    }

    const stripe = getStripe()

    // 检查或创建 Stripe 客户
    const { data: existingTip } = await supabase
      .from('tips')
      .select('stripe_checkout_session_id')
      .eq('from_user_id', user.id)
      .not('stripe_checkout_session_id', 'is', null)
      .limit(1)
      .maybeSingle()

    let customerId: string | undefined

    if (existingTip?.stripe_checkout_session_id) {
      try {
        const session = await stripe.checkout.sessions.retrieve(existingTip.stripe_checkout_session_id)
        if (session.customer && typeof session.customer === 'string') {
          customerId = session.customer
        }
      } catch {
        // Intentionally swallowed: existing Stripe session lookup failed, will create new customer below
      }
    }

    // 创建打赏记录（pending 状态）
    const { data: tip, error: tipError } = await supabase
      .from('tips')
      .insert({
        post_id,
        from_user_id: user.id,
        to_user_id: post.author_id,
        amount_cents: amount,
        message: message?.slice(0, 200) || null,
        status: 'pending',
      })
      .select('id')
      .single()

    if (tipError) {
      logger.error('[Tip Checkout] Insert error:', tipError)
      return NextResponse.json(
        { error: 'Failed to create tip record' },
        { status: 500 }
      )
    }

    // 创建 Stripe Checkout Session（一次性支付）
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Tip @${post.author_handle || 'user'}`,
              description: post.title ? `Post: ${post.title.slice(0, 50)}` : 'Thank the creator',
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      success_url: `${env.NEXT_PUBLIC_APP_URL}/tip/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.NEXT_PUBLIC_APP_URL}/groups/${post_id}?tip_canceled=true`,
      metadata: {
        type: 'tip',
        tip_id: tip.id,
        post_id,
        from_user_id: user.id,
        to_user_id: post.author_id || '',
        amount_cents: String(amount),
      },
    })

    // 更新打赏记录的 session ID
    await supabase
      .from('tips')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', tip.id)

    return NextResponse.json({
      sessionId: session.id,
      url: session.url,
    })
  } catch (error: unknown) {
    logger.error('[Tip Checkout] Error:', error)
    
    const message = error instanceof Error ? error.message : 'Internal server error'
    
    if (message.includes('STRIPE_SECRET_KEY')) {
      return NextResponse.json(
        { error: 'Payment system not configured, please contact admin' },
        { status: 503 }
      )
    }
    
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}
