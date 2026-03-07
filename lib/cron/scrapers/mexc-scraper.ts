/**
 * MEXC Leaderboard Scraper — Playwright-based scraper for MEXC copy trading
 * 
 * MEXC has Akamai WAF protection that blocks direct API access.
 * This scraper intercepts API responses from the browser.
 */

import { createBrowser, createStealthContext, navigateStealth } from './playwright-scraper'
import { logger } from '@/lib/logger'

const PERIOD_MAP: Record<string, number> = {
  '7D': 1,
  '30D': 2,
  '90D': 3,
}

export interface MexcTrader {
  traderId?: string | number
  uid?: string | number
  nickName?: string
  avatar?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  mdd?: number | string
  followerCount?: number | string
}

export interface MexcApiResponse {
  code?: number
  data?: {
    resultList?: MexcTrader[]
    list?: MexcTrader[]
    comprehensives?: MexcTrader[]
  } | MexcTrader[]
}

/**
 * Scrape MEXC leaderboard
 */
export async function scrapeMexcLeaderboard(
  periodType: number = 2,
  pageSize: number = 50
): Promise<MexcApiResponse | null> {
  const browser = await createBrowser({ headless: true })
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // Intercept API responses
    const responses: Array<{ url: string; body: any }> = []
    
    page.on('response', async (response) => {
      const url = response.url()
      // Look for any copy-trade related API calls
      if (
        url.includes('copy-trade') ||
        url.includes('copyTrade') ||
        url.includes('copyFutures')
      ) {
        try {
          const body = await response.json()
          responses.push({ url, body })
          logger.info(`[mexc-scraper] Intercepted: ${url}`)
        } catch (_err) {
          // Non-JSON response
        }
      }
    })
    
    // Navigate to leaderboard page
    const baseUrl = 'https://www.mexc.com/futures/copyTrade/home'
    await navigateStealth(page, baseUrl, { timeout: 45000 })
    
    // Wait for initial data load
    await page.waitForTimeout(5000)
    
    // Try to interact with period selector
    try {
      // MEXC might have period tabs like "7天", "30天", "90天"
      const periodButtons = {
        1: '7天',
        2: '30天',
        3: '90天',
      }
      const periodText = periodButtons[periodType as keyof typeof periodButtons] || '30天'
      await page.click(`text=${periodText}`, { timeout: 3000 })
      await page.waitForTimeout(2000)
    } catch (selectorErr) {
      // Period selector not found or different layout
    }
    
    // Wait for API responses
    const deadline = Date.now() + 15000
    while (responses.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(1000)
    }
    
    await context.close()
    
    if (responses.length > 0) {
      // Find the response with trader data
      for (const resp of responses) {
        const data = resp.body
        if (
          data?.data?.resultList ||
          data?.data?.list ||
          data?.data?.comprehensives ||
          Array.isArray(data?.data)
        ) {
          return data as MexcApiResponse
        }
      }
    }
    
    logger.warn('[mexc-scraper] No valid API responses found')
    return null
    
  } catch (err) {
    logger.error(`[mexc-scraper] Scraping failed: ${err instanceof Error ? err.message : err}`)
    return null
  } finally {
    await browser.close()
  }
}

/**
 * Batch scrape multiple periods
 */
export async function scrapeMexcBatch(
  periods: string[] = ['7D', '30D', '90D']
): Promise<Record<string, MexcApiResponse>> {
  const browser = await createBrowser({ headless: true })
  const results: Record<string, MexcApiResponse> = {}
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // Navigate once
    await navigateStealth(page, 'https://www.mexc.com/futures/copyTrade/home', { timeout: 45000 })
    await page.waitForTimeout(3000)
    
    // For each period
    for (const period of periods) {
      const periodType = PERIOD_MAP[period] || 2
      const responses: Array<{ url: string; body: any }> = []
      
      page.on('response', async (response) => {
        const url = response.url()
        if (
          url.includes('copy-trade') ||
          url.includes('copyTrade') ||
          url.includes('copyFutures')
        ) {
          try {
            const body = await response.json()
            responses.push({ url, body })
          } catch (_err) {
            /* non-JSON response, skip */
          }
        }
      })
      
      // Click period button
      try {
        const periodButtons: Record<number, string> = {
          1: '7天',
          2: '30天',
          3: '90天',
        }
        const periodText = periodButtons[periodType] || '30天'
        await page.click(`text=${periodText}`, { timeout: 5000 })
        await page.waitForTimeout(3000)
        
        // Find response with trader data
        for (const resp of responses) {
          const data = resp.body
          if (
            data?.data?.resultList ||
            data?.data?.list ||
            data?.data?.comprehensives
          ) {
            results[period] = data as MexcApiResponse
            logger.info(`[mexc-scraper] Got data for ${period}`)
            break
          }
        }
      } catch (err) {
        logger.warn(`[mexc-scraper] Failed to get ${period}: ${err instanceof Error ? err.message : err}`)
      }
    }
    
    await context.close()
    
  } catch (err) {
    logger.error(`[mexc-scraper] Batch scraping failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    await browser.close()
  }
  
  return results
}
