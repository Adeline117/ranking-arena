/**
 * 基础导入器 - 统一的交易员数据导入逻辑
 *
 * 使用方法:
 *   import { BaseImporter } from '../lib/base-importer.mjs'
 *
 *   const importer = new BaseImporter('binance_futures')
 *   await importer.run(['7D', '30D', '90D'])
 */

import pLimit from 'p-limit'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  randomDelay,
  withRetry,
  log,
  getTargetPeriods,
  getConcurrency,
} from './shared.mjs'
import { getPlatformConfig } from './platform-config.mjs'

const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

/**
 * 代理感知的 fetch
 */
async function proxyFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
    if (res.ok || !PROXY_URL) return res
    if (res.status === 451 || res.status === 403) {
      log.warn('直连被封，尝试代理...')
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    return res
  } catch (e) {
    if (PROXY_URL) {
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    throw e
  }
}

/**
 * 基础导入器类
 */
export class BaseImporter {
  constructor(source, options = {}) {
    this.config = getPlatformConfig(source)
    if (!this.config) {
      throw new Error(`Unknown platform: ${source}`)
    }

    this.source = source
    this.supabase = getSupabaseClient()
    // 优先级: 命令行参数 > 平台配置 > 默认值
    this.concurrency = options.concurrency || this.config.concurrency || getConcurrency(5, 10)
    this.targetCount = options.targetCount || this.config.targetCount || 500

    log.info(`初始化 ${this.config.name} 导入器`)
    log.info(`并发数: ${this.concurrency}, 目标数量: ${this.targetCount}`)
  }

  /**
   * 运行导入
   */
  async run(periods = ['7D', '30D', '90D']) {
    const startTime = Date.now()
    log.info(`\n${'='.repeat(50)}`)
    log.info(`开始导入 ${this.config.name}`)
    log.info(`时间段: ${periods.join(', ')}`)
    log.info(`${'='.repeat(50)}\n`)

    const results = {}

    for (const period of periods) {
      try {
        const count = await this.importPeriod(period)
        results[period] = { success: true, count }
        log.success(`${period}: 导入 ${count} 条数据`)
      } catch (error) {
        results[period] = { success: false, error: error.message }
        log.error(`${period}: ${error.message}`)
      }

      // 时间段之间休息
      if (periods.indexOf(period) < periods.length - 1) {
        await sleep(2000)
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    log.info(`\n${'='.repeat(50)}`)
    log.info(`导入完成，耗时 ${elapsed}s`)
    log.info(`${'='.repeat(50)}\n`)

    return results
  }

  /**
   * 导入单个时间段
   */
  async importPeriod(period) {
    log.info(`\n📋 获取 ${period} 排行榜...`)

    // 根据类型选择抓取方法
    let traders
    switch (this.config.type) {
      case 'api':
        traders = await this.fetchViaAPI(period)
        break
      case 'puppeteer':
        traders = await this.fetchViaPuppeteer(period)
        break
      case 'playwright':
        traders = await this.fetchViaPlaywright(period)
        break
      default:
        throw new Error(`Unknown fetch type: ${this.config.type}`)
    }

    if (!traders || traders.length === 0) {
      log.warn('未获取到数据')
      return 0
    }

    log.info(`获取到 ${traders.length} 个交易员`)

    // 计算 Arena Score
    const tradersWithScore = traders.map((t, idx) => {
      const scores = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period)
      return {
        ...t,
        rank: idx + 1,
        arenaScore: scores.totalScore,
        returnScore: scores.returnScore,
        pnlScore: scores.pnlScore,
        drawdownScore: scores.drawdownScore,
        stabilityScore: scores.stabilityScore,
      }
    })

    // 保存到数据库
    return await this.saveToDatabase(tradersWithScore, period)
  }

  /**
   * 通过 API 获取数据
   */
  async fetchViaAPI(period) {
    const { api, extractors } = this.config
    if (!api || !api.list) {
      throw new Error('API configuration missing')
    }

    const traders = new Map()
    let pageNum = 1
    const perPage = 20

    while (traders.size < this.targetCount && pageNum <= 25) {
      try {
        const url = `${api.base}${api.list}`
        const periodKey = api.periodMap?.[period] || period

        const response = await proxyFetch(url, {
          method: 'POST',
          headers: api.headers || {},
          body: JSON.stringify({
            pageNumber: pageNum,
            pageSize: perPage,
            timeRange: periodKey,
            dataType: 'ROI',
            order: 'DESC',
          }),
        })

        if (!response.ok) {
          if (response.status === 429) {
            log.warn('限流，等待 3 秒...')
            await sleep(3000)
            continue
          }
          break
        }

        const data = await response.json()
        const list = data.data?.list || data.result?.list || data.list || []

        if (list.length === 0) break

        for (const item of list) {
          const traderId = extractors.traderId(item)
          if (!traderId || traders.has(traderId)) continue

          traders.set(traderId, {
            traderId: String(traderId),
            nickname: extractors.nickname?.(item) || null,
            avatar: extractors.avatar?.(item) || null,
            roi: extractors.roi?.(item) || 0,
            pnl: extractors.pnl?.(item) || null,
            winRate: extractors.winRate?.(item) || null,
            maxDrawdown: extractors.maxDrawdown?.(item) || null,
            followers: extractors.followers?.(item) || 0,
          })
        }

        log.progress(traders.size, this.targetCount, `第 ${pageNum} 页`)
        pageNum++
        await randomDelay(500, 1000)

      } catch (error) {
        log.warn(`第 ${pageNum} 页失败: ${error.message}`)
        pageNum++
      }
    }

    return Array.from(traders.values())
  }

  /**
   * Extract trader data from API response item
   */
  extractTraderData(item, extractors) {
    const traderId = extractors.traderId?.(item) || item.uid || item.id
    if (!traderId) return null

    return {
      traderId: String(traderId),
      nickname: extractors.nickname?.(item) || item.nickName || null,
      avatar: extractors.avatar?.(item) || item.avatar || null,
      roi: extractors.roi?.(item) || 0,
      pnl: extractors.pnl?.(item) || null,
      winRate: extractors.winRate?.(item) || null,
      maxDrawdown: extractors.maxDrawdown?.(item) || null,
      followers: extractors.followers?.(item) || 0,
    }
  }

  /**
   * Create response handler for browser-based scraping
   */
  createResponseHandler(traders, extractors, apiPatterns) {
    return async (response) => {
      const url = response.url()
      const matchesPattern = apiPatterns.some(p => url.includes(p))
      if (!matchesPattern) return

      try {
        const json = await response.json()
        const list = json.result?.list || json.data?.list || json.result || []
        if (!Array.isArray(list) || list.length === 0) return

        log.info(`拦截到 API 数据: ${list.length} 条`)

        for (const item of list) {
          const trader = this.extractTraderData(item, extractors)
          if (trader && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        }
      } catch {}
    }
  }

  /**
   * 通过 Puppeteer 获取数据
   */
  async fetchViaPuppeteer(period) {
    const { default: puppeteer } = await import('puppeteer-extra')
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth')
    puppeteer.use(StealthPlugin())

    const traders = new Map()
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      timeout: 60000,
    })

    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1920, height: 1080 })
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

      const { apiPatterns = [], extractors = {} } = this.config
      page.on('response', this.createResponseHandler(traders, extractors, apiPatterns))

      log.info('访问页面...')
      await page.goto(this.config.url, { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(3000)

      let scrollCount = 0
      while (traders.size < this.targetCount && scrollCount < 20) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
        scrollCount++
        log.progress(traders.size, this.targetCount, `滚动 ${scrollCount} 次`)
      }
    } finally {
      await browser.close()
    }

    return Array.from(traders.values())
  }

  /**
   * 通过 Playwright 获取数据
   */
  async fetchViaPlaywright(period) {
    const { chromium } = await import('playwright')

    const traders = new Map()
    const browser = await chromium.launch({ headless: true })

    try {
      const page = await browser.newPage()
      const { apiPatterns = [], extractors = {} } = this.config
      page.on('response', this.createResponseHandler(traders, extractors, apiPatterns))

      await page.goto(this.config.url, { waitUntil: 'networkidle' })
      await sleep(5000)
    } finally {
      await browser.close()
    }

    return Array.from(traders.values())
  }

  /**
   * 保存到数据库
   */
  async saveToDatabase(traders, period) {
    const now = new Date().toISOString()
    const limit = pLimit(5)

    // 1. 更新 trader_sources
    log.info('保存交易员信息...')
    const sourceUpserts = traders.map(t => ({
      source: this.source,
      source_trader_id: t.traderId,
      handle: t.nickname || t.traderId,
      avatar_url: t.avatar || null,
      market_type: this.config.marketType || 'futures',
      is_active: true,
    }))

    for (let i = 0; i < sourceUpserts.length; i += 50) {
      const batch = sourceUpserts.slice(i, i + 50)
      await this.supabase.from('trader_sources').upsert(batch, {
        onConflict: 'source,source_trader_id',
      })
    }

    // 2. 更新 trader_snapshots
    log.info('保存快照数据...')
    const snapshotUpserts = traders.map(t => ({
      source: this.source,
      source_trader_id: t.traderId,
      season_id: period,
      rank: t.rank,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: t.maxDrawdown,
      trades_count: t.tradesCount || null,
      followers: t.followers,
      arena_score: t.arenaScore,
      return_score: t.returnScore,
      pnl_score: t.pnlScore,
      drawdown_score: t.drawdownScore,
      stability_score: t.stabilityScore,
      captured_at: now,
    }))

    let saved = 0
    for (let i = 0; i < snapshotUpserts.length; i += 30) {
      const batch = snapshotUpserts.slice(i, i + 30)
      const { error } = await this.supabase.from('trader_snapshots').upsert(batch, {
        onConflict: 'source,source_trader_id,season_id',
      })
      if (!error) saved += batch.length
    }

    log.success(`保存 ${saved}/${traders.length} 条快照`)
    return saved
  }
}

/**
 * CLI 入口
 */
export async function runImporter(source) {
  const periods = getTargetPeriods()
  const concurrency = getConcurrency()

  const importer = new BaseImporter(source, { concurrency })
  return await importer.run(periods)
}
