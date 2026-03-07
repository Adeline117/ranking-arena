/**
 * Exchange Scrapers - Unified entry point
 * 
 * This module provides browser-based scrapers for exchanges that block API access.
 * All scrapers use Playwright with stealth mode to bypass WAF protection.
 */

export { 
  scrapeBybitLeaderboard, 
  scrapeBybitBatch,
  type BybitLeaderDetail,
  type BybitApiResponse,
} from './bybit-scraper'

export {
  scrapeMexcLeaderboard,
  scrapeMexcBatch,
  type MexcTrader,
  type MexcApiResponse,
} from './mexc-scraper'

export {
  scrapeHtxLeaderboard,
  scrapeHtxBatch,
  type HtxTrader,
  type HtxApiResponse,
} from './htx-scraper'

export {
  createBrowser,
  createStealthContext,
  navigateStealth,
  interceptApiResponses,
  BrowserPool,
  type ScraperOptions,
} from './playwright-scraper'
