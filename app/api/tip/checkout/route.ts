/**
 * 打赏 Checkout API
 * POST /api/tip/checkout - 创建打赏支付会话
 */

import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'

const logger = createLogger('tip-checkout')

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

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { post_id, amount_cents, message } = body as {
      post_id?: string
      amount_cents?: number
      message?: string
    }

    // 验证参数
    if (!post_id) {
      return badRequest('Missing post_id parameter')
    }

    const amount = Number(amount_cents)
    if (!amount || amount < 100 || amount > 50000) {
      return badRequest('Invalid tip amount ($1 - $500)')
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
      return badRequest('Cannot tip your own post')
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
        message: typeof message === 'string' ? message.slice(0, 200) : null,
        status: 'pending',
      })
      .select('id')
      .single()

    if (tipError) {
      logger.error('[Tip Checkout] Insert error:', tipError)
      return serverError('Failed to create tip record')
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
  },
  {
    name: 'tip-checkout',
    rateLimit: 'sensitive',
  }
)
