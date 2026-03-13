/**
 * Scraper Configuration — Centralized settings for VPS scraper integration
 * 
 * This file defines timeout, retry, and fallback strategies for platforms
 * that require browser-based scraping due to WAF protection.
 */

export const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
export const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

/**
 * Scraper configurations per platform
 */
export const SCRAPER_CONFIGS = {
  bybit: {
    vpsEndpoint: '/bybit/leaderboard-batch',
    vpsBatchEndpoint: '/bybit/leaderboard-batch',
    timeout: 90_000, // 90s (measured: ~65s)
    retries: 2,
    // Fall back to single-page scraper if batch fails
    fallbackToSinglePage: true,
    // Periods to fetch in batch mode
    batchPeriods: ['7D', '30D', '90D'],
  },
  mexc: {
    vpsEndpoint: '/mexc/leaderboard',
    timeout: 120_000, // 120s (measured: >120s, needs improvement)
    retries: 1, // Only 1 retry due to slow performance
    // MEXC scraper is slow, consider using API fallbacks first
    preferApiOverScraper: true,
  },
  htx: {
    // HTX API is accessible without scraper in most regions
    vpsEndpoint: null,
    timeout: 15_000,
    retries: 3,
    // HTX doesn't need VPS scraper for most requests
    scraperRequired: false,
  },
} as const

export type Platform = keyof typeof SCRAPER_CONFIGS

/**
 * Get scraper config for a platform
 */
export function getScraperConfig(platform: Platform) {
  return SCRAPER_CONFIGS[platform]
}

/**
 * Check if VPS scraper is available
 */
export async function isVpsScraperAvailable(): Promise<boolean> {
  if (!VPS_SCRAPER_KEY) {
    return false
  }
  
  try {
    const res = await fetch(`${VPS_SCRAPER_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const data: { ok?: boolean } = await res.json()
    return data.ok === true
  } catch {
    return false
  }
}

/**
 * Call VPS scraper with retry logic
 */
export async function callVpsScraper<T = any>(
  endpoint: string,
  params: Record<string, any> = {},
  timeoutMs: number = 60_000
): Promise<T | null> {
  if (!VPS_SCRAPER_KEY) {
    throw new Error('VPS_SCRAPER_KEY not configured')
  }
  
  const queryString = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString()
  
  const url = `${VPS_SCRAPER_URL}${endpoint}${queryString ? `?${queryString}` : ''}`
  
  try {
    const res = await fetch(url, {
      headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
      signal: AbortSignal.timeout(timeoutMs),
    })
    
    if (!res.ok) {
      throw new Error(`VPS scraper returned HTTP ${res.status}`)
    }
    
    return (await res.json()) as T
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    throw new Error(`VPS scraper call failed: ${error.message}`)
  }
}

/**
 * Call VPS scraper with automatic retry
 */
export async function callVpsScraperWithRetry<T = any>(
  endpoint: string,
  params: Record<string, any> = {},
  config: { retries: number; timeout: number }
): Promise<T | null> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await callVpsScraper<T>(endpoint, params, config.timeout)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      
      if (attempt < config.retries) {
        // Wait before retry (exponential backoff)
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 10_000)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
  }
  
  throw lastError || new Error('VPS scraper failed with unknown error')
}
