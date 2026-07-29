#!/usr/bin/env node
/**
 * 支付路径金丝雀 — 只读验证 exact entitlement authority 与异步 worker。
 *
 * 历史版本每天调用 legacy projection writer，再删除测试 subscription 并把
 * QA profile 无条件改成 free。那不是金丝雀，而是生产权益写入器：它既能
 * 制造 authority drift，也可能覆盖账号的真实付款或独立 grant。
 *
 * 当前金丝雀在 PostgreSQL READ ONLY 事务里验证：
 *   1. exact payment/trial/grant schema 与 readiness function 已部署；
 *   2. stripe_paid_launch_readiness_v2 返回精确十键契约且状态为 ready；
 *   3. webhook 没有 failed/stale 事件；
 *   4. entitlement effect worker 在 20 分钟内有成功心跳。
 *
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
const READINESS_KEYS = [
  'status',
  'open_manual_reviews',
  'unfinished_effects',
  'completed_effects_without_external_ref',
  'paid_unbound_payments',
  'unresolved_refund_tombstones',
  'reservation_anomalies',
  'projection_drift',
  'notification_delivery_anomalies',
  'authority_drift',
].sort()

function parseReadiness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (
    keys.length !== READINESS_KEYS.length ||
    keys.some((key, index) => key !== READINESS_KEYS[index])
  ) {
    return null
  }
  if (value.status !== 'ready' && value.status !== 'blocked') return null
  for (const key of READINESS_KEYS) {
    if (key === 'status') continue
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null
  }
  return value
}

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
    await client.query('BEGIN TRANSACTION READ ONLY')

    const { rows: schemaRows } = await client.query(`
      SELECT
        pg_catalog.to_regclass('public.stripe_entitlement_payments') IS NOT NULL
          AS has_payments,
        pg_catalog.to_regclass('public.stripe_trial_entitlements') IS NOT NULL
          AS has_trials,
        pg_catalog.to_regclass('public.pro_entitlement_grants') IS NOT NULL
          AS has_grants,
        pg_catalog.to_regclass('public.stripe_entitlement_effects') IS NOT NULL
          AS has_effects,
        pg_catalog.to_regprocedure('public.stripe_paid_launch_readiness_v2()') IS NOT NULL
          AS has_readiness,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'subscriptions'
            AND column_name = 'entitlement_payment_id'
        ) AS has_payment_binding,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'subscriptions'
            AND column_name = 'entitlement_trial_id'
        ) AS has_trial_binding
    `)
    const schema = schemaRows[0]
    const missingContracts = Object.entries(schema || {})
      .filter(([, present]) => present !== true)
      .map(([name]) => name)
    if (missingContracts.length > 0) {
      failures.push(`exact entitlement schema 缺失: ${missingContracts.join(', ')}`)
    } else {
      const { rows: readinessRows } = await client.query(
        'SELECT public.stripe_paid_launch_readiness_v2() AS readiness'
      )
      const readiness = parseReadiness(readinessRows[0]?.readiness)
      if (!readiness) {
        failures.push('stripe_paid_launch_readiness_v2 返回契约异常')
      } else if (readiness.status !== 'ready') {
        const blockers = READINESS_KEYS.filter(
          (key) => key !== 'status' && readiness[key] !== 0
        ).map((key) => `${key}=${readiness[key]}`)
        failures.push(`exact entitlement authority blocked: ${blockers.join(', ') || 'unknown'}`)
      }
    }

    const { rows: eventRows } = await client.query(`
      SELECT
        pg_catalog.count(*) FILTER (WHERE status = 'failed')::integer AS failed,
        pg_catalog.count(*) FILTER (
          WHERE status = 'processing'
            AND started_at < pg_catalog.clock_timestamp() - interval '10 minutes'
        )::integer AS stale
      FROM public.stripe_events
    `)
    const eventHealth = eventRows[0]
    if (!eventHealth || eventHealth.failed !== 0 || eventHealth.stale !== 0) {
      failures.push(
        `Stripe webhook backlog: failed=${eventHealth?.failed ?? 'unknown'}, stale=${
          eventHealth?.stale ?? 'unknown'
        }`
      )
    }

    const { rows: heartbeatRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM public.pipeline_logs
        WHERE job_name = 'stripe-entitlement-effects'
          AND status = 'success'
          AND started_at >= pg_catalog.clock_timestamp() - interval '20 minutes'
      ) AS recent
    `)
    if (heartbeatRows[0]?.recent !== true) {
      failures.push('stripe-entitlement-effects 20 分钟内无成功心跳')
    }
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
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
  console.log('✅ payment-path-canary: exact authority/readiness/worker 全部健康（纯只读）')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[payment-canary] crashed:', e)
  await sendTelegram(`⚠️ *支付金丝雀崩溃*：${String(e.message).slice(0, 200)}`)
  process.exit(2)
})
