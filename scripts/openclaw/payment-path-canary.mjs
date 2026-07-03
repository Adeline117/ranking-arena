#!/usr/bin/env node
/**
 * 支付路径金丝雀 — 揪出被 PRO_FREE_PROMO 掩盖的静默失败（差距 #2 / 2026-07）。
 *
 * 血泪背景：整个 Stripe 订阅 webhook 同步曾长期静默崩溃——RPC
 * `update_subscription_and_profile` 写 `subscriptions.plan`/`cancel_at_period_end`
 * 这些生产不存在的列 → RPC 500、fallback 500 → 每个 subscription 事件都无法对账。
 * **没人发现，因为 PRO_FREE_PROMO 让所有人都是 Pro，掩盖了同步失效。** 一旦 promo 关，
 * 付费用户的 Pro 状态就同步不了。
 *
 * 对策：一个掩盖性开关（PRO_FREE_PROMO）必须配一个金丝雀，定期**真跑一遍被掩盖的
 * 底层路径**，坏了立刻告警——这样"关掉 promo 会不会爆"永远是已知的。
 *
 * 本金丝雀（只读+自清理，用 QA 账号）验证：
 *   1. 支付对账列存在：user_profiles.stripe_customer_id（webhook .eq 查用户靠它）。
 *   2. 订阅写路径通：调 update_subscription_and_profile RPC（QA 用户）→ 校验落库 → 清理。
 * 任一失败 → Telegram 告警。exit 0 健康 / 1 失败 / 2 金丝雀自身跑不起来（盲了≠正常）。
 *
 * 调度：openclaw-sentinels.yml 每日。需 DATABASE_URL + TELEGRAM_*。
 */
import { config } from 'dotenv'
import pg from 'pg'

config({ path: new URL('../../.env.local', import.meta.url).pathname })

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID
const DATABASE_URL = process.env.DATABASE_URL
const QA_USER_ID = '1c533890-01e8-4c34-a895-657f389ab4b2' // qa.button.test@arenafi.org

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram disabled]', text)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    })
  } catch (err) {
    console.error('[payment-canary] telegram send failed:', err.message)
  }
}

async function main() {
  if (!DATABASE_URL) {
    console.error('[payment-canary] Missing DATABASE_URL — canary CANNOT run')
    await sendTelegram('⚠️ *支付金丝雀无法运行*：DATABASE_URL 缺失（金丝雀盲了 ≠ 支付正常）')
    process.exit(2)
  }
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  const failures = []
  try {
    // 1) 对账列存在（webhook invoice/refund .eq('stripe_customer_id') 靠它找用户）
    const { rows: col } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='user_profiles' AND column_name='stripe_customer_id'`
    )
    if (!col.length)
      failures.push('user_profiles.stripe_customer_id 缺失 → 所有 Stripe webhook 对账 500')

    // 2) 订阅写路径 RPC 冒烟（自清理）
    try {
      await client.query(
        `SELECT update_subscription_and_profile($1,'pro','active','sub_canary','cus_canary','monthly',now(),now()+interval '30 days',false)`,
        [QA_USER_ID]
      )
      const { rows: sub } = await client.query(
        `SELECT tier, status, plan FROM subscriptions WHERE user_id=$1 AND stripe_subscription_id='sub_canary'`,
        [QA_USER_ID]
      )
      if (!sub.length || sub[0].tier !== 'pro' || sub[0].plan !== 'monthly') {
        failures.push(`订阅 RPC 落库异常: ${JSON.stringify(sub[0] || null)}`)
      }
    } catch (e) {
      failures.push(`订阅写路径 RPC 失败(修前的故障态): ${String(e.message).slice(0, 160)}`)
    } finally {
      // 自清理：删测试订阅行 + 复位 profile
      await client
        .query(
          `DELETE FROM subscriptions WHERE user_id=$1 AND stripe_subscription_id='sub_canary'`,
          [QA_USER_ID]
        )
        .catch(() => {})
      await client
        .query(`UPDATE user_profiles SET subscription_tier='free' WHERE id=$1`, [QA_USER_ID])
        .catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }

  const promoOn = process.env.PRO_FREE_PROMO !== 'false'
  if (failures.length) {
    const msg =
      `🔴 *支付路径金丝雀失败* — ${failures.length} 项${promoOn ? '（PRO_FREE_PROMO 开启，用户看不到，但 promo 一关就爆）' : ''}\n` +
      failures.map((f) => `• ${f}`).join('\n')
    console.error(msg)
    await sendTelegram(msg)
    process.exit(1)
  }
  console.log('✅ payment-path-canary: 对账列存在 + 订阅写路径 RPC 通（已自清理）')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[payment-canary] crashed:', e)
  await sendTelegram(`⚠️ *支付金丝雀崩溃*：${String(e.message).slice(0, 200)}`)
  process.exit(2)
})
