/**
 * Environment Variable Validation
 *
 * Validates all required environment variables at startup.
 * Import this file early (e.g. in instrumentation.ts or layout.tsx) to fail fast.
 *
 * Usage:
 *   import { env } from '@/lib/env'
 *   env.SUPABASE_URL // typed, guaranteed to exist
 */

import { z } from 'zod'
import { logger } from '@/lib/logger'

// ─── Zod Schema (critical vars) ─────────────────────────────────────────────
//
// Validates the most critical environment variables at import time.
// Other vars are validated by the getEnv() helpers below.

const CriticalEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required').optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  CRON_SECRET: z.string().min(1, 'CRON_SECRET is required').optional(),
  // Redis / Upstash
  UPSTASH_REDIS_REST_URL: z.string().url('UPSTASH_REDIS_REST_URL must be a valid URL').optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  // Meilisearch
  MEILISEARCH_URL: z.string().url('MEILISEARCH_URL must be a valid URL').optional(),
  MEILISEARCH_ADMIN_KEY: z.string().min(1).optional(),
  MEILISEARCH_SEARCH_KEY: z.string().min(1).optional(),
  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // ClickHouse
  CLICKHOUSE_URL: z.string().url('CLICKHOUSE_URL must be a valid URL').optional(),
})

/** Parsed & typed critical environment variables */
export type CriticalEnv = z.infer<typeof CriticalEnvSchema>

// Validate critical vars immediately (fail fast)
const criticalResult = CriticalEnvSchema.safeParse(process.env)
if (!criticalResult.success) {
  // Only throw in server context — skip during client-side bundling
  if (typeof window === 'undefined') {
    const formatted = criticalResult.error.format()
    const messages = Object.entries(formatted)
      .filter(([k]) => k !== '_errors')
      .map(([k, v]) => `  - ${k}: ${(v as { _errors?: string[] })?._errors?.join(', ') ?? 'invalid'}`)
      .join('\n')
    logger.error(`[env] Critical environment validation failed:\n${messages}`)
    // Do not throw in test/dev to avoid breaking HMR; throw in production
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Critical environment validation failed:\n${messages}`)
    }
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function getEnv(key: string, required: true): string
function getEnv(key: string, required: false, fallback?: string): string | undefined
function getEnv(key: string, required: boolean, fallback?: string): string | undefined {
  const value = process.env[key]
  if (value) return value
  if (!required) return fallback
  throw new Error(
    `❌ Missing required environment variable: ${key}\n` +
    `   → Add it to .env.local (see .env.example for reference)`
  )
}

function getEnvBool(key: string, fallback = false): boolean {
  const v = process.env[key]
  if (!v) return fallback
  return v === 'true' || v === '1'
}

function getEnvNumber(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

// ─── Validation (runs on import) ──────────────────────────────────────────────

// Only validate server-side required vars when running on the server
const isServer = typeof window === 'undefined'

// Core — always required
const NEXT_PUBLIC_SUPABASE_URL = getEnv('NEXT_PUBLIC_SUPABASE_URL', true)
const NEXT_PUBLIC_SUPABASE_ANON_KEY = getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', true)

// Server-only — required in production, optional in dev
const SUPABASE_URL = isServer
  ? (process.env.NODE_ENV === 'production' ? getEnv('SUPABASE_URL', true) : getEnv('SUPABASE_URL', false))
  : undefined
const SUPABASE_SERVICE_ROLE_KEY = isServer
  ? (process.env.NODE_ENV === 'production' ? getEnv('SUPABASE_SERVICE_ROLE_KEY', true) : getEnv('SUPABASE_SERVICE_ROLE_KEY', false))
  : undefined
const DATABASE_URL = isServer ? getEnv('DATABASE_URL', false) : undefined

// Redis / Upstash
const UPSTASH_REDIS_REST_URL = isServer ? getEnv('UPSTASH_REDIS_REST_URL', false) : undefined
const UPSTASH_REDIS_REST_TOKEN = isServer ? getEnv('UPSTASH_REDIS_REST_TOKEN', false) : undefined

// Auth
const ADMIN_SECRET = isServer ? getEnv('ADMIN_SECRET', false) : undefined
const INVITE_SECRET = isServer ? getEnv('INVITE_SECRET', false) : undefined

// Stripe
const STRIPE_SECRET_KEY = isServer ? getEnv('STRIPE_SECRET_KEY', false) : undefined
const STRIPE_WEBHOOK_SECRET = isServer ? getEnv('STRIPE_WEBHOOK_SECRET', false) : undefined

// Cron / Workers
const CRON_SECRET = isServer ? getEnv('CRON_SECRET', false) : undefined
const WORKER_SECRET = isServer ? getEnv('WORKER_SECRET', false) : undefined

// ─── Export typed env object ──────────────────────────────────────────────────

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',

  // ── Core (public) ──
  NEXT_PUBLIC_APP_URL: getEnv('NEXT_PUBLIC_APP_URL', false, 'http://localhost:3000')!,
  NEXT_PUBLIC_SITE_URL: getEnv('NEXT_PUBLIC_SITE_URL', false, 'http://localhost:3000')!,
  NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY,

  // ── Supabase (server) ──
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DATABASE_URL,

  // ── Redis / Upstash ──
  REDIS_URL: getEnv('REDIS_URL', false),
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,

  // ── Auth ──
  ADMIN_EMAILS: getEnv('ADMIN_EMAILS', false),
  // NEXT_PUBLIC_ADMIN_EMAILS is deprecated - use database role check instead
  ADMIN_SECRET,
  INVITE_SECRET,

  // ── Encryption ──
  ENCRYPTION_KEY: isServer ? getEnv('ENCRYPTION_KEY', false) : undefined,
  ENCRYPTION_KEY_PART: isServer ? getEnv('ENCRYPTION_KEY_PART', false) : undefined,
  ENCRYPTION_SALT: isServer ? getEnv('ENCRYPTION_SALT', false) : undefined,

  // ── Stripe ──
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: getEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', false),
  STRIPE_PRO_MONTHLY_PRICE_ID: getEnv('STRIPE_PRO_MONTHLY_PRICE_ID', false),
  STRIPE_PRO_YEARLY_PRICE_ID: getEnv('STRIPE_PRO_YEARLY_PRICE_ID', false),
  STRIPE_ELITE_PRICE_ID: getEnv('STRIPE_ELITE_PRICE_ID', false),

  // ── OpenAI ──
  OPENAI_API_KEY: isServer ? getEnv('OPENAI_API_KEY', false) : undefined,

  // ── Email ──
  RESEND_API_KEY: isServer ? getEnv('RESEND_API_KEY', false) : undefined,
  RESEND_FROM_EMAIL: getEnv('RESEND_FROM_EMAIL', false, 'noreply@arenafi.org'),

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: isServer ? getEnv('TELEGRAM_BOT_TOKEN', false) : undefined,
  TELEGRAM_ALERT_CHAT_ID: getEnv('TELEGRAM_ALERT_CHAT_ID', false),

  // ── Web3 ──
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: getEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', false),
  ARBITRUM_RPC_URL: getEnv('ARBITRUM_RPC_URL', false),
  BASE_RPC_URL: getEnv('BASE_RPC_URL', false),
  OPTIMISM_RPC_URL: getEnv('OPTIMISM_RPC_URL', false),
  POLYGON_RPC_URL: getEnv('POLYGON_RPC_URL', false),

  // ── Cloudflare R2 ──
  R2_ACCOUNT_ID: isServer ? getEnv('R2_ACCOUNT_ID', false) : undefined,
  R2_ACCESS_KEY_ID: isServer ? getEnv('R2_ACCESS_KEY_ID', false) : undefined,
  R2_SECRET_ACCESS_KEY: isServer ? getEnv('R2_SECRET_ACCESS_KEY', false) : undefined,
  R2_BUCKET: getEnv('R2_BUCKET', false),
  R2_PUBLIC_URL: getEnv('R2_PUBLIC_URL', false),

  // ── Cron / Workers ──
  CRON_SECRET,
  WORKER_SECRET,
  WORKER_URL: getEnv('WORKER_URL', false, 'http://localhost:3000'),
  WORKER_BATCH_SIZE: getEnvNumber('WORKER_BATCH_SIZE', 10),
  WORKER_POLL_INTERVAL: getEnvNumber('WORKER_POLL_INTERVAL', 60000),

  // ── QStash ──
  QSTASH_TOKEN: isServer ? getEnv('QSTASH_TOKEN', false) : undefined,
  QSTASH_CURRENT_SIGNING_KEY: isServer ? getEnv('QSTASH_CURRENT_SIGNING_KEY', false) : undefined,
  QSTASH_NEXT_SIGNING_KEY: isServer ? getEnv('QSTASH_NEXT_SIGNING_KEY', false) : undefined,

  // ── Cloudflare Proxy ──
  CLOUDFLARE_PROXY_URL: getEnv('CLOUDFLARE_PROXY_URL', false),
  CLOUDFLARE_PROXY_SECRET: isServer ? getEnv('CLOUDFLARE_PROXY_SECRET', false) : undefined,

  // ── Feature Flags ──
  ENABLE_SMART_SCHEDULER: getEnvBool('ENABLE_SMART_SCHEDULER', false),
  ENABLE_ANOMALY_DETECTION: getEnvBool('ENABLE_ANOMALY_DETECTION', false),

  // ── Smart Scheduler Config ──
  SMART_SCHEDULER_HOT_INTERVAL_MINUTES: getEnvNumber('SMART_SCHEDULER_HOT_INTERVAL_MINUTES', 30),
  SMART_SCHEDULER_ACTIVE_INTERVAL_MINUTES: getEnvNumber('SMART_SCHEDULER_ACTIVE_INTERVAL_MINUTES', 60),
  SMART_SCHEDULER_NORMAL_INTERVAL_MINUTES: getEnvNumber('SMART_SCHEDULER_NORMAL_INTERVAL_MINUTES', 240),
  SMART_SCHEDULER_DORMANT_INTERVAL_MINUTES: getEnvNumber('SMART_SCHEDULER_DORMANT_INTERVAL_MINUTES', 720),
  SMART_SCHEDULER_MAX_BATCH_SIZE: getEnvNumber('SMART_SCHEDULER_MAX_BATCH_SIZE', 50),

  // ── Meilisearch ──
  MEILISEARCH_URL: isServer ? getEnv('MEILISEARCH_URL', false) : undefined,
  MEILISEARCH_ADMIN_KEY: isServer ? getEnv('MEILISEARCH_ADMIN_KEY', false) : undefined,
  MEILISEARCH_SEARCH_KEY: isServer ? getEnv('MEILISEARCH_SEARCH_KEY', false) : undefined,

  // ── ClickHouse ──
  CLICKHOUSE_URL: isServer ? getEnv('CLICKHOUSE_URL', false) : undefined,

  // ── Sentry ──
  NEXT_PUBLIC_SENTRY_DSN: getEnv('NEXT_PUBLIC_SENTRY_DSN', false),

  // ── Analytics ──
  NEXT_PUBLIC_ANALYTICS_ENDPOINT: getEnv('NEXT_PUBLIC_ANALYTICS_ENDPOINT', false),
} as const

export type Env = typeof env
