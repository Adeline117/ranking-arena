/**
 * Arena Worker 主入口
 * 用于定时任务或 HTTP 触发
 */

import 'dotenv/config'
import { logger } from './logger.js'
import { getScraperForSource, getAvailableSources } from './scrapers/index.js'
import { saveTraders, logScrapeResult } from './db.js'
import type { DataSource, TimeRange, ScrapeResult } from './types.js'

export { logger } from './logger.js'
export { getScraperForSource, getAvailableSources } from './scrapers/index.js'
export { saveTraders, logScrapeResult } from './db.js'
export type { DataSource, TimeRange, TraderData, ScrapeResult } from './types.js'

const TIME_RANGES: TimeRange[] = ['7D', '30D', '90D']

/**
 * 执行单个数据源的抓取
 */
export async function scrapeSource(
  source: DataSource,
  timeRanges: TimeRange[] = TIME_RANGES
): Promise<ScrapeResult[]> {
  const scraper = getScraperForSource(source)
  if (!scraper) {
    logger.error('Unknown source', new Error(`No scraper for source: ${source}`), { source })
    return []
  }

  const results: ScrapeResult[] = []

  for (const timeRange of timeRanges) {
    logger.info('Starting scrape job', { source, timeRange })

    const result = await scraper.scrape(timeRange)
    results.push(result)

    if (result.success && result.traders.length > 0) {
      const { saved, errors } = await saveTraders(result.traders, source, timeRange)

      logger.info('Scrape job completed', {
        source,
        timeRange,
        tradersScraped: result.traders.length,
        saved,
        errors,
        duration: result.duration,
      })

      await logScrapeResult(source, timeRange, true, {
        tradersCount: result.traders.length,
        duration: result.duration,
      })
    } else {
      logger.error('Scrape job failed', new Error(result.error || 'Unknown error'), {
        source,
        timeRange,
        duration: result.duration,
      })

      await logScrapeResult(source, timeRange, false, {
        tradersCount: 0,
        duration: result.duration,
        error: result.error,
      })
    }
  }

  return results
}

/**
 * 执行所有数据源的抓取
 */
export async function scrapeAll(): Promise<Map<DataSource, ScrapeResult[]>> {
  const sources = getAvailableSources()
  const allResults = new Map<DataSource, ScrapeResult[]>()

  logger.info('Starting full scrape', { sources, timeRanges: TIME_RANGES })

  for (const source of sources) {
    const results = await scrapeSource(source, TIME_RANGES)
    allResults.set(source, results)
  }

  logger.info('Full scrape completed', {
    totalSources: sources.length,
    totalJobs: sources.length * TIME_RANGES.length,
  })

  return allResults
}

// 如果直接运行此文件，执行完整抓取
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeAll()
    .then(() => {
      logger.info('Worker completed')
      process.exit(0)
    })
    .catch((error) => {
      logger.error('Worker failed', error)
      process.exit(1)
    })
}
