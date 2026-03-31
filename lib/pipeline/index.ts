/**
 * Arena Data Pipeline
 *
 * 四层架构的统一入口
 *
 * 使用示例:
 * ```typescript
 * import { runPipeline, PipelineRunner } from '@/lib/pipeline'
 *
 * // 方式 1: 快速运行
 * const result = await runPipeline(supabase, 'binance_futures', ['7d', '30d', '90d'])
 *
 * // 方式 2: 完整控制
 * const runner = new PipelineRunner(supabase)
 * const result = await runner.run({
 *   platforms: ['binance_futures', 'hyperliquid'],
 *   windows: ['7d', '30d', '90d'],
 *   skipStorage: false
 * })
 * ```
 */

// Types
export * from './types'

// Capabilities
export * from './capabilities'

// Layers
export { PipelineNormalizer, getNormalizer } from './normalizer'
export { PipelineCalculator, getCalculator, quickArenaScore } from './calculator'
export { PipelineStorage, getStorage } from './storage'

// Runner
export { PipelineRunner, runPipeline, getScraper } from './runner'
