/**
 * Fetcher Runner
 * Executes platform fetchers within the worker service
 * Bridges the scheduler with existing inline fetchers
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Job, JobResult, PlatformConfig } from '../types'

// Import existing fetchers (copied into worker for standalone builds)
import { INLINE_FETCHERS } from '../lib/fetchers'

// ============================================
// Platform Configurations
// ============================================

export const PLATFORM_CONFIGS: PlatformConfig[] = [
  // CEX - Pure API (stable, no proxy needed for most)
  {
    id: 'okx_futures',
    name: 'OKX Futures',
    category: 'cex-api',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 30000,
  },
  {
    id: 'htx',
    name: 'HTX',
    category: 'cex-api',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 30000,
  },
  {
    id: 'binance_futures',
    name: 'Binance Futures',
    category: 'cex-api',
    enabled: true,
    requiresProxy: true,
    proxyRegions: ['SG', 'JP', 'HK'],
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'binance_spot',
    name: 'Binance Spot',
    category: 'cex-api',
    enabled: true,
    requiresProxy: true,
    proxyRegions: ['SG', 'JP', 'HK'],
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'bybit',
    name: 'Bybit',
    category: 'cex-api',
    enabled: true,
    requiresProxy: true,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 5,
    timeoutMs: 60000,
  },
  {
    id: 'bitget_futures',
    name: 'Bitget Futures',
    category: 'cex-api',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'mexc',
    name: 'MEXC',
    category: 'cex-browser',
    enabled: true,
    requiresProxy: true,
    cronSchedule: '0 */6 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 60000,
  },
  {
    id: 'kucoin',
    name: 'KuCoin',
    category: 'cex-browser',
    enabled: true,
    requiresProxy: true,
    cronSchedule: '0 */6 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 60000,
  },
  {
    id: 'coinex',
    name: 'CoinEx',
    category: 'cex-browser',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */6 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 60000,
  },
  {
    id: 'gateio',
    name: 'Gate.io',
    category: 'cex-api',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 30000,
  },

  // DEX - On-chain / Subgraph (stable)
  {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    category: 'dex-api',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 30000,
  },
  {
    id: 'gmx',
    name: 'GMX',
    category: 'dex-subgraph',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'gains',
    name: 'Gains Network',
    category: 'dex-subgraph',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'kwenta',
    name: 'Kwenta',
    category: 'dex-subgraph',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */6 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'mux',
    name: 'MUX Protocol',
    category: 'dex-subgraph',
    enabled: true,
    requiresProxy: false,
    cronSchedule: '0 */6 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },

  // DeFi Protocols
  {
    id: 'jupiter_perps',
    name: 'Jupiter Perps',
    category: 'dex-api',
    enabled: true, // ✅ Working - has /top-traders API
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'aevo',
    name: 'Aevo',
    category: 'dex-api',
    enabled: true, // ✅ Working - has /leaderboard API
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 30000,
  },
  {
    id: 'synthetix',
    name: 'Synthetix',
    category: 'dex-subgraph',
    enabled: true, // ✅ Working - requires THEGRAPH_API_KEY
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 60000,
  },
  {
    id: 'drift',
    name: 'Drift Protocol',
    category: 'dex-api',
    enabled: false, // ⚠️ Requires DRIFT_API_KEY
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
  {
    id: 'vertex',
    name: 'Vertex Protocol',
    category: 'dex-api',
    enabled: false, // ❌ No public leaderboard API available
    requiresProxy: false,
    cronSchedule: '0 */4 * * *',
    periods: ['7D', '30D', '90D'],
    maxRetries: 3,
    timeoutMs: 45000,
  },
]

// ============================================
// Supabase Client
// ============================================

let supabaseClient: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (supabaseClient) return supabaseClient

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  }

  supabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  return supabaseClient
}

// ============================================
// Job Executor
// ============================================

export async function executeFetcherJob(job: Job): Promise<JobResult> {
  const start = Date.now()
  const platform = job.platform
  const periods = job.periods

  const fetcher = INLINE_FETCHERS[platform]
  if (!fetcher) {
    throw new Error(`Unknown platform: ${platform}`)
  }

  const supabase = getSupabase()

  console.log(`[FetcherRunner] Executing ${platform} for periods: ${periods.join(', ')}`)

  try {
    // Cast to any to handle type mismatch between worker and main app supabase versions
    const result = await fetcher(supabase as any, periods)
    
    return {
      platform,
      periods: result.periods,
      duration: Date.now() - start,
      proxyUsed: job.proxyId,
    }
  } catch (err) {
    console.error(`[FetcherRunner] Error fetching ${platform}:`, err)
    throw err
  }
}

// ============================================
// Platform Helpers
// ============================================

export function getEnabledPlatforms(): PlatformConfig[] {
  return PLATFORM_CONFIGS.filter((p) => p.enabled)
}

export function getPlatformConfig(platformId: string): PlatformConfig | undefined {
  return PLATFORM_CONFIGS.find((p) => p.id === platformId)
}

export function getPlatformsByCategory(
  category: PlatformConfig['category']
): PlatformConfig[] {
  return PLATFORM_CONFIGS.filter((p) => p.category === category && p.enabled)
}

export function getDeFiPlatforms(): PlatformConfig[] {
  return PLATFORM_CONFIGS.filter(
    (p) =>
      (p.category === 'dex-api' || p.category === 'dex-subgraph') && p.enabled
  )
}
