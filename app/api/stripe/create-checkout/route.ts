import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { 
  stripe, 
  STRIPE_PRICE_IDS, 
  getOrCreateStripeCustomer,
  createCheckoutSession 
} from '@/lib/stripe'

// 创建服务端 Supabase 客户端（用于写入操作）
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { plan, successUrl, cancelUrl } = await request.json()

    // 优先从 Authorization header 获取 token
    const authHeader = request.headers.get('authorization')
    let user = null
    let userError = null

    if (authHeader?.startsWith('Bearer ')) {
      // 使用 token 验证
      const token = authHeader.substring(7)
      const { data, error } = await supabaseAdmin.auth.getUser(token)
      user = data?.user
      userError = error
    } else {
      // 回退到 cookie 验证
      const cookieHeader = request.headers.get('cookie') || ''
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          global: {
            headers: {
              cookie: cookieHeader,
            },
          },
          auth: {
            persistSession: false,
            detectSessionInUrl: false,
          },
        }
      )
      const { data, error } = await supabase.auth.getUser()
      user = data?.user
      userError = error
    }
    
    if (userError || !user) {
      console.log('Auth error:', userError)
      return NextResponse.json(
        { error: 'Unauthorized - Please login first' },
        { status: 401 }
      )
    }

    // 验证计划类型
    if (!['monthly', 'yearly'].includes(plan)) {
      return NextResponse.json(
        { error: 'Invalid plan type' },
        { status: 400 }
      )
    }

    // 获取或创建 Stripe 客户
    const customerId = await getOrCreateStripeCustomer(
      user.id,
      user.email!,
      { 
        source: 'ranking-arena',
        plan: plan,
      }
    )

    // 更新用户的 Stripe 客户 ID
    await supabaseAdmin
      .from('user_profiles')
      .upsert({
        id: user.id,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      })

    // 获取价格 ID
    const priceId = STRIPE_PRICE_IDS[plan as 'monthly' | 'yearly']

    // 创建 Checkout Session
    const checkoutSession = await createCheckoutSession({
      customerId,
      priceId,
      successUrl: successUrl || `${process.env.NEXT_PUBLIC_APP_URL}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: cancelUrl || `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
      metadata: {
        supabase_user_id: user.id,  // 与 webhook 期望的键名一致
        userId: user.id,
        plan: plan,
      },
    })

    return NextResponse.json({
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    })

  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    )
  }
}
