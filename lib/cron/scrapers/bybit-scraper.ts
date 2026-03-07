/**
 * Bybit Leaderboard Scraper — Playwright-based scraper for Bybit copy trading
 * 
 * Endpoints:
 * - https://www.bybit.com/copyTrade/trade/leader-list (WAF-protected)
 * - bybitglobal.com variant (less strict WAF)
 * 
 * Strategy: Intercept API responses from the page instead of direct API calls
 */

import { createBrowser, createStealthContext, navigateStealth, interceptApiResponses } from './playwright-scraper'
import { logger } from '@/lib/logger'

const PERIOD_MAP: Record<string, string> = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

export interface BybitLeaderDetail {
  leaderUserId?: string
  leaderMark?: string
  nickName?: string
  profilePhoto?: string
  currentFollowerCount?: number | string
  metricValues?: string[] // [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
}

export interface BybitApiResponse {
  retCode?: number
  result?: {
    leaderDetails?: BybitLeaderDetail[]
  }
}

/**
 * Scrape Bybit leaderboard using browser automation
 */
export async function scrapeBybitLeaderboard(
  pageNo: number = 1,
  pageSize: number = 50,
  duration: string = 'DATA_DURATION_THIRTY_DAY'
): Promise<BybitApiResponse | null> {
  const browser = await createBrowser({ headless: true })
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // Intercept API responses
    const apiPattern = '/fapi/beehive/public/v1/common/dynamic-leader-list'
    const responses: Array<{ url: string; body: any }> = []
    
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes(apiPattern)) {
        try {
          const body = await response.json()
          responses.push({ url, body })
          logger.info(`[bybit-scraper] Intercepted API response: ${url}`)
        } catch (err) {
          logger.warn(`[bybit-scraper] Failed to parse response: ${err instanceof Error ? err.message : err}`)
        }
      }
    })
    
    // Navigate to leaderboard page (use bybitglobal.com for less strict WAF)
    const baseUrl = 'https://www.bybitglobal.com/en/copy-trading/leader-list'
    await navigateStealth(page, baseUrl, { timeout: 45000 })
    
    // Wait for page to load and make API calls
    await page.waitForTimeout(5000)
    
    // Try to trigger the API by interacting with the page
    // Click on period selector if available
    try {
      await page.click('text=30D', { timeout: 3000 })
      await page.waitForTimeout(2000)
    } catch {
      // Period selector not found, page might have already loaded with default
    }
    
    // Wait for API responses
    const deadline = Date.now() + 15000
    while (responses.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(1000)
    }
    
    await context.close()
    
    if (responses.length > 0) {
      // Return the first matching response
      return responses[0].body as BybitApiResponse
    }
    
    logger.warn('[bybit-scraper] No API responses intercepted')
    return null
    
  } catch (err) {
    logger.error(`[bybit-scraper] Scraping failed: ${err instanceof Error ? err.message : err}`)
    return null
  } finally {
    await browser.close()
  }
}

/**
 * Batch scrape multiple periods in a single browser session (much faster)
 * 
 * Strategy: Navigate to each period's direct URL instead of clicking tabs
 */
export async function scrapeBybitBatch(
  periods: string[] = ['7D', '30D', '90D'],
  pageSize: number = 50
): Promise<Record<string, BybitApiResponse>> {
  const browser = await createBrowser({ headless: true })
  const results: Record<string, BybitApiResponse> = {}
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // For each period, navigate directly with URL params
    for (const period of periods) {
      const duration = PERIOD_MAP[period] || PERIOD_MAP['30D']
      const responses: Array<{ url: string; body: any }> = []
      
      // Set up response interceptor
      const responseHandler = async (response: any) => {
        const url = response.url()
        if (url.includes('dynamic-leader-list')) {
          try {
            const body = await response.json()
            // Check if this response matches our duration
            if (url.includes(duration) || !responses.some(r => r.url.includes(duration))) {
              responses.push({ url, body })
              logger.info(`[bybit-scraper] Intercepted API for ${period}: ${body?.result?.leaderDetails?.length || 0} traders`)
            }
          } catch {}
        }
      }
      
      page.on('response', responseHandler)
      
      // Navigate to leaderboard (the page will auto-load default period)
      const baseUrl = 'https://www.bybitglobal.com/en/copy-trading/leader-list'
      await navigateStealth(page, baseUrl, { timeout: 45000 })
      
      // Wait for initial API response (page loads 30D by default usually)
      await page.waitForTimeout(5000)
      
      // Try to change period via URL hash or query params if available
      try {
        // Try clicking period selector with different selectors
        const selectors = [
          `button:has-text("${period}")`,
          `div:has-text("${period}")`,
          `[data-period="${period}"]`,
          `text=${period}`,
        ]
        
        for (const selector of selectors) {
          try {
            await page.click(selector, { timeout: 2000 })
            await page.waitForTimeout(3000)
            if (responses.length > 0) break
          } catch {
            continue
          }
        }
      } catch {}
      
      // Remove handler to avoid duplicates
      page.off('response', responseHandler)
      
      if (responses.length > 0) {
        // Use the most recent response
        const bestResponse = responses[responses.length - 1]
        results[duration] = bestResponse.body as BybitApiResponse
      } else {
        logger.warn(`[bybit-scraper] No responses for ${period}`)
      }
    }
    
    await context.close()
    
  } catch (err) {
    logger.error(`[bybit-scraper] Batch scraping failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    await browser.close()
  }
  
  return results
}
