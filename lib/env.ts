/**
 * Environment Variable Validation
 * Ensures all required environment variables are set at startup
 * Prevents runtime errors from missing configuration
 */

import { z } from 'zod'

/**
 * Environment variable schema
 * Define all required and optional environment variables
 */
const envSchema = z.object({
  // Supabase (REQUIRED)
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('Invalid Supabase URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'Supabase anon key required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'Supabase service role key required'),

  // Application
  NEXT_PUBLIC_APP_URL: z.string().url('Invalid app URL').default('http://localhost:3000'),

  // Stripe (REQUIRED for payment features)
  STRIPE_SECRET_KEY: z.string().min(1, 'Stripe secret key required'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'Stripe webhook secret required'),
  STRIPE_PRO_MONTHLY_PRICE_ID: z.string().min(1, 'Stripe monthly price ID required'),
  STRIPE_PRO_YEARLY_PRICE_ID: z.string().min(1, 'Stripe yearly price ID required'),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1, 'Stripe publishable key required'),

  // Upstash Redis (optional - falls back to in-memory cache)
  UPSTASH_REDIS_REST_URL: z.string().url('Invalid Upstash URL').optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Sentry (optional)
  NEXT_PUBLIC_SENTRY_DSN: z.string().url('Invalid Sentry DSN').optional(),
  SENTRY_DSN: z.string().url('Invalid Sentry DSN').optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),

  // Cron Jobs
  CRON_SECRET: z.string().min(32, 'Cron secret must be at least 32 characters').optional(),

  // Admin Emails (comma-separated)
  ADMIN_EMAILS: z.string().optional(),

  // Cloudflare Proxy (optional)
  CLOUDFLARE_PROXY_URL: z.string().url('Invalid Cloudflare proxy URL').optional(),
  CLOUDFLARE_PROXY_SECRET: z.string().optional(),

  // Dune Analytics (optional)
  DUNE_API_KEY: z.string().optional(),
  DUNE_GMX_QUERY_ID: z.string().optional(),
  DUNE_HYPERLIQUID_QUERY_ID: z.string().optional(),
  DUNE_UNISWAP_QUERY_ID: z.string().optional(),

  // The Graph Network (optional)
  THEGRAPH_API_KEY: z.string().optional(),

  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

/**
 * Validate environment variables
 * @throws {Error} If validation fails
 */
export function validateEnv() {
  try {
    const parsed = envSchema.parse({
      // Supabase
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

      // Application
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,

      // Stripe
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_PRO_MONTHLY_PRICE_ID: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
      STRIPE_PRO_YEARLY_PRICE_ID: process.env.STRIPE_PRO_YEARLY_PRICE_ID,
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,

      // Upstash
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

      // Sentry
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,

      // Cron
      CRON_SECRET: process.env.CRON_SECRET,

      // Admin
      ADMIN_EMAILS: process.env.ADMIN_EMAILS,

      // Cloudflare
      CLOUDFLARE_PROXY_URL: process.env.CLOUDFLARE_PROXY_URL,
      CLOUDFLARE_PROXY_SECRET: process.env.CLOUDFLARE_PROXY_SECRET,

      // Dune
      DUNE_API_KEY: process.env.DUNE_API_KEY,
      DUNE_GMX_QUERY_ID: process.env.DUNE_GMX_QUERY_ID,
      DUNE_HYPERLIQUID_QUERY_ID: process.env.DUNE_HYPERLIQUID_QUERY_ID,
      DUNE_UNISWAP_QUERY_ID: process.env.DUNE_UNISWAP_QUERY_ID,

      // The Graph
      THEGRAPH_API_KEY: process.env.THEGRAPH_API_KEY,

      // Node
      NODE_ENV: process.env.NODE_ENV,
    })

    return parsed
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n')

      throw new Error(
        `Environment validation failed:\n${missingVars}\n\nPlease check your .env.local file and ensure all required variables are set.`
      )
    }
    throw error
  }
}

/**
 * Safe environment variable getter with type safety
 */
export const env = {
  // Supabase
  get supabaseUrl() {
    return process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  },
  get supabaseAnonKey() {
    return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  },
  get supabaseServiceKey() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  },

  // Application
  get appUrl() {
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  },

  // Stripe
  get stripeSecretKey() {
    return process.env.STRIPE_SECRET_KEY || ''
  },
  get stripeWebhookSecret() {
    return process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  get stripeProMonthlyPriceId() {
    return process.env.STRIPE_PRO_MONTHLY_PRICE_ID || ''
  },
  get stripeProYearlyPriceId() {
    return process.env.STRIPE_PRO_YEARLY_PRICE_ID || ''
  },
  get stripePublishableKey() {
    return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''
  },

  // Upstash
  get upstashRedisUrl() {
    return process.env.UPSTASH_REDIS_REST_URL
  },
  get upstashRedisToken() {
    return process.env.UPSTASH_REDIS_REST_TOKEN
  },

  // Sentry
  get sentryDsn() {
    return process.env.NEXT_PUBLIC_SENTRY_DSN
  },

  // Cron
  get cronSecret() {
    return process.env.CRON_SECRET
  },

  // Admin
  get adminEmails() {
    return process.env.ADMIN_EMAILS?.split(',').map((e) => e.trim()) || []
  },

  // Environment
  get isDevelopment() {
    return process.env.NODE_ENV === 'development'
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production'
  },
  get isTest() {
    return process.env.NODE_ENV === 'test'
  },
}

/**
 * Validate environment on server startup (development only)
 * In production, validation failures should be caught during build
 */
if (typeof window === 'undefined' && process.env.NODE_ENV === 'development') {
  try {
    validateEnv()
    console.log('✅ Environment variables validated successfully')
  } catch (error) {
    console.error('❌ Environment validation failed:')
    console.error(error instanceof Error ? error.message : String(error))
    // Don't exit in development - allow app to start with warnings
  }
}
