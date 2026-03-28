/**
 * Arena Data Pipeline - Runner
 *
 * 统一的管道执行器，串联四层架构
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  RawFetchResult,
  StandardTraderData,
  EnrichedTraderData,
  PipelineRunResult,
  PipelineStepResult,
  TimeWindow,
} from './types'
import { PipelineNormalizer, getNormalizer } from './normalizer'
import { PipelineCalculator, getCalculator } from './calculator'
import { PipelineStorage, getStorage } from './storage'
import { getPlatformCapabilities, getSupportedWindows } from './capabilities'

// =============================================================================
// Scraper Interface (采集层接口)
// =============================================================================

/**
 * 平台采集器接口
 * 每个平台需要实现这个接口
 */
export interface PlatformScraper {
  platform: string
  fetch(windows: TimeWindow[]): Promise<RawFetchResult[]>
}

// =============================================================================
// Scraper Registry (采集器注册表)
// =============================================================================

const scraperRegistry = new Map<string, () => Promise<PlatformScraper>>()

/**
 * 注册平台采集器
 */
export function registerScraper(
  platform: string,
  factory: () => Promise<PlatformScraper>
): void {
  scraperRegistry.set(platform, factory)
}

/**
 * 获取平台采集器
 */
export async function getScraper(platform: string): Promise<PlatformScraper | null> {
  const factory = scraperRegistry.get(platform)
  if (!factory) return null
  return factory()
}

// =============================================================================
// Pipeline Runner
// =============================================================================

export interface PipelineRunOptions {
  platforms: string[]
  windows?: TimeWindow[]
  skipStorage?: boolean
  maxConcurrency?: number
}

export class PipelineRunner {
  private supabase: SupabaseClient
  private normalizer: PipelineNormalizer
  private calculator: PipelineCalculator
  private storage: PipelineStorage

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase
    this.normalizer = getNormalizer()
    this.calculator = getCalculator()
    this.storage = getStorage()
  }

  /**
   * 运行完整管道
   */
  async run(options: PipelineRunOptions): Promise<PipelineRunResult> {
    const startedAt = new Date()
    const runId = `run_${Date.now()}`
    const steps: PipelineStepResult[] = []

    const windows = options.windows ?? ['7d', '30d', '90d']

    // 串行处理每个平台（避免并发问题）
    for (const platform of options.platforms) {
      const stepStart = Date.now()

      try {
        const result = await this.runPlatform(platform, windows, options.skipStorage)
        steps.push({
          platform,
          status: 'success',
          traders_count: result.tradersCount,
          upserted: result.upserted,
          duration_ms: Date.now() - stepStart,
        })
      } catch (error) {
        steps.push({
          platform,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - stepStart,
        })
      }
    }

    // 统计
    const successful = steps.filter((s) => s.status === 'success').length
    const failed = steps.filter((s) => s.status === 'error').length
    const totalTraders = steps.reduce((sum, s) => sum + (s.traders_count ?? 0), 0)
    const totalUpserted = steps.reduce((sum, s) => sum + (s.upserted ?? 0), 0)

    return {
      run_id: runId,
      started_at: startedAt,
      finished_at: new Date(),
      steps,
      summary: {
        total_platforms: options.platforms.length,
        successful,
        failed,
        total_traders: totalTraders,
        total_upserted: totalUpserted,
      },
    }
  }

  /**
   * 运行单个平台
   */
  private async runPlatform(
    platform: string,
    windows: TimeWindow[],
    skipStorage?: boolean
  ): Promise<{ tradersCount: number; upserted: number }> {
    // 1. 获取采集器
    const scraper = await getScraper(platform)
    if (!scraper) {
      throw new Error(`No scraper registered for platform: ${platform}`)
    }

    // 2. 过滤支持的窗口
    const supportedWindows = getSupportedWindows(platform)
    const validWindows = windows.filter((w) =>
      supportedWindows.includes(w) || supportedWindows.includes('all_time')
    )

    if (validWindows.length === 0) {
      console.warn(`[Pipeline] No valid windows for ${platform}`)
      return { tradersCount: 0, upserted: 0 }
    }

    // 3. 采集 (Layer 1)
    const rawResults = await scraper.fetch(validWindows)

    // 4. 标准化 (Layer 2)
    const allNormalized: StandardTraderData[] = []
    for (const raw of rawResults) {
      const normalized = this.normalizer.normalize(raw)
      allNormalized.push(...normalized)
    }

    // 5. 计算 (Layer 3)
    const enriched = this.calculator.enrich(allNormalized)

    // 6. 存储 (Layer 4)
    let upserted = 0
    if (!skipStorage) {
      const result = await this.storage.persist(this.supabase, enriched)
      upserted = result.upserted
    }

    return {
      tradersCount: enriched.length,
      upserted,
    }
  }

  /**
   * 直接处理原始数据（用于已有 connector 的迁移）
   */
  async processRawData(
    rawResults: RawFetchResult[],
    skipStorage?: boolean
  ): Promise<EnrichedTraderData[]> {
    // 标准化
    const allNormalized: StandardTraderData[] = []
    for (const raw of rawResults) {
      const normalized = this.normalizer.normalize(raw)
      allNormalized.push(...normalized)
    }

    // 计算
    const enriched = this.calculator.enrich(allNormalized)

    // 存储
    if (!skipStorage) {
      await this.storage.persist(this.supabase, enriched)
    }

    return enriched
  }
}

// =============================================================================
// Quick Run Function
// =============================================================================

/**
 * 快速运行管道
 */
export async function runPipeline(
  supabase: SupabaseClient,
  platform: string,
  windows: TimeWindow[] = ['7d', '30d', '90d']
): Promise<PipelineRunResult> {
  const runner = new PipelineRunner(supabase)
  return runner.run({ platforms: [platform], windows })
}

// =============================================================================
// Legacy Connector Adapter
// =============================================================================

/**
 * 将旧 connector 的输出转换为 RawFetchResult
 * 用于渐进式迁移
 */
export function adaptLegacyConnectorOutput(
  platform: string,
  marketType: 'futures' | 'perp' | 'spot',
  window: TimeWindow,
  traders: Array<{ id: string; data: Record<string, unknown> }>
): RawFetchResult {
  return {
    platform,
    market_type: marketType,
    window,
    raw_traders: traders.map((t) => ({
      trader_id: t.id,
      raw_data: t.data,
    })),
    total_available: traders.length,
    fetched_at: new Date(),
    api_latency_ms: 0,
  }
}
