/**
 * 打赏 Checkout API
 * POST /api/tip/checkout - 创建打赏支付会话
 */

import { type NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, notFound, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'
import { createOneTimePaymentSession } from '@/lib/stripe'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'
import { sanitizeInput } from '@/lib/utils/sanitize'
import { isTipCheckoutEnabled } from '@/lib/security/tip-checkout-cutover'

const logger = createLogger('tip-checkout')

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const authenticatedPost = withAuth(
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
    if (typeof post_id !== 'string' || !UUID_PATTERN.test(post_id)) {
      return badRequest('Invalid post_id parameter')
    }

    const amount = Number(amount_cents)
    if (!Number.isInteger(amount) || amount < 100 || amount > 50000) {
      return badRequest('Invalid tip amount ($1 - $500)')
    }

    // withAuth supplies a service-role client, so posts RLS does not protect
    // this route. Deny missing, private, blocked, deleted, and expired paid
    // group posts through the same canonical audience decision as post reads.
    if (!(await canServiceActorReadPost(supabase, post_id, user.id))) {
      return notFound('Post not found')
    }

    // Idempotency check: prevent duplicate tips within 60 seconds
    const { data: recentPendingTip, error: recentTipError } = await supabase
      .from('tips')
      .select('id')
      .eq('from_user_id', user.id)
      .eq('post_id', post_id)
      .eq('amount_cents', amount)
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 60000).toISOString())
      .maybeSingle()

    if (recentTipError) {
      logger.error('[Tip Checkout] Idempotency lookup failed:', recentTipError)
      return serverError('Failed to validate tip request')
    }

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
      return notFound('Post not found')
    }

    // 不能给自己打赏
    if (post.author_id === user.id) {
      return badRequest('Cannot tip your own post')
    }

    const { data: recipient, error: recipientError } = await supabase
      .from('public_user_profiles')
      .select('id')
      .eq('id', post.author_id)
      .maybeSingle()
    if (recipientError) {
      logger.error('[Tip Checkout] Recipient lookup failed:', recipientError)
      return serverError('Failed to validate tip recipient')
    }
    if (!recipient?.id) {
      return notFound('Post not found')
    }

    // Reuse existing Stripe customer ID from user_profiles (persists across session expirations)
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle()

    const customerId: string | undefined = profile?.stripe_customer_id || undefined

    // 创建打赏记录（pending 状态）
    const { data: tip, error: tipError } = await supabase
      .from('tips')
      .insert({
        post_id,
        from_user_id: user.id,
        to_user_id: post.author_id,
        amount_cents: amount,
        message:
          typeof message === 'string' && message.trim()
            ? sanitizeInput(message.trim(), { maxLength: 200 })
            : null,
        status: 'pending',
      })
      .select('id')
      .single()

    if (tipError) {
      logger.error('[Tip Checkout] Insert error:', tipError)
      return serverError('Failed to create tip record')
    }

    // Shared one-time payment session — idempotency + metadata enforced automatically
    const session = await createOneTimePaymentSession({
      customerId,
      customerEmail: user.email,
      userId: user.id,
      discriminator: `tip_${post_id}_${amount}`,
      lineItems: [
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
      successUrl: `${env.NEXT_PUBLIC_APP_URL}/tip/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/post/${post_id}?tip_canceled=true`,
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
    const { error: sessionUpdateError } = await supabase
      .from('tips')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', tip.id)
    if (sessionUpdateError) {
      logger.error('[Tip Checkout] Failed to persist checkout session:', sessionUpdateError)
    }

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

export async function POST(request: NextRequest) {
  // Fail closed before authentication, database access, or Stripe work during
  // the atomic Tip checkout cutover. Do not depend on Vercel system variables:
  // every runtime must opt in explicitly so missing deployment metadata cannot
  // silently reopen payments. Preview and local canaries set the flag to true.
  if (!isTipCheckoutEnabled()) {
    return NextResponse.json(
      {
        error: 'Tip checkout is temporarily unavailable.',
        code: 'TIP_CHECKOUT_UNAVAILABLE',
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': '300',
        },
      }
    )
  }

  return authenticatedPost(request)
}
