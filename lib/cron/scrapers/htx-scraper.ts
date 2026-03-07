/**
 * HTX Leaderboard Scraper — Playwright-based scraper for HTX copy trading
 * 
 * HTX API is less strict than Bybit/MEXC, but browser-based scraping
 * provides more reliability and can handle any future WAF changes.
 */

import { createBrowser, createStealthContext, navigateStealth } from './playwright-scraper'
import { logger } from '@/lib/logger'

const WINDOW_DAYS: Record<string, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

export interface HtxTrader {
  userSign?: string
  uid?: number
  nickName?: string
  imgUrl?: string
  copyUserNum?: number
  winRate?: number
  profitRate90?: number
  profit90?: number
  mdd?: number
  aum?: string | number
  profitList?: number[]
}

export interface HtxApiResponse {
  code?: number
  data?: {
    itemList?: HtxTrader[]
  }
}

/**
 * Scrape HTX leaderboard
 */
export async function scrapeHtxLeaderboard(
  pageNo: number = 1,
  pageSize: number = 50
): Promise<HtxApiResponse | null> {
  const browser = await createBrowser({ headless: true })
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // Intercept API responses
    const responses: Array<{ url: string; body: any }> = []
    
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copytrading/rank') || url.includes('copytrading')) {
        try {
          const body = await response.json()
          responses.push({ url, body })
          logger.info(`[htx-scraper] Intercepted: ${url}`)
        } catch (_err) {
          /* non-JSON response, skip */
        }
      }
    })
    
    // Navigate to leaderboard page
    const baseUrl = 'https://futures.htx.com/en-us/copytrading/futures'
    await navigateStealth(page, baseUrl, { timeout: 45000 })
    
    // Wait for data load
    await page.waitForTimeout(5000)
    
    // Wait for API responses
    const deadline = Date.now() + 15000
    while (responses.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(1000)
    }
    
    await context.close()
    
    if (responses.length > 0) {
      // Find response with itemList
      for (const resp of responses) {
        if (resp.body?.data?.itemList) {
          return resp.body as HtxApiResponse
        }
      }
      // Return first response anyway
      return responses[0].body as HtxApiResponse
    }
    
    logger.warn('[htx-scraper] No API responses intercepted')
    return null
    
  } catch (err) {
    logger.error(`[htx-scraper] Scraping failed: ${err instanceof Error ? err.message : err}`)
    return null
  } finally {
    await browser.close()
  }
}

/**
 * Batch scrape (HTX doesn't have multiple period tabs, so this just gets the default data)
 */
export async function scrapeHtxBatch(): Promise<HtxApiResponse | null> {
  // HTX only returns 90D data by default, no period selector needed
  return scrapeHtxLeaderboard(1, 50)
}
