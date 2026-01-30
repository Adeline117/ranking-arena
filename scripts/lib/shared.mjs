/**
 * 脚本共享工具库
 *
 * 为所有 import/fetch 脚本提供统一的工具函数
 * 避免代码重复，确保逻辑一致性
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ============================================
// 环境变量和 Supabase 客户端
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

/**
 * 验证环境变量并返回 Supabase 客户端
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    console.error('   Please check your .env file or environment variables')
    process.exit(1)
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

// ============================================
// Arena Score 计算逻辑
// 与 lib/utils/arena-score.ts 保持同步
// ============================================

const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
  PNL_THRESHOLD: {
    '7D': 200,    // 降低门槛以显示更多交易员
    '30D': 500,   // 从$1000降到$500
    '90D': 1000,  // 从$3000降到$1000
  },
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  WIN_RATE_BASELINE: 45,
  // 排行榜稳定性参数
  GRACE_PERIOD_HOURS: 24,
  CONFIDENCE_DEBOUNCE_HOURS: 8,
  PNL_RAMP: {
    SOFT_FLOOR_FACTOR: 0.5,
    FULL_QUALIFY_FACTOR: 1.5,
  },
}

export { ARENA_CONFIG }

/**
 * 将值限制在 [min, max] 范围内
 */
export const clip = (v, min, max) => Math.max(min, Math.min(max, v))

/**
 * 安全的 ln(1+x)
 */
export const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

/**
 * 获取时间段天数
 */
export const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

/**
 * 标准化胜率（处理小数/百分比格式）
 */
export function normalizeWinRate(winRate) {
  if (winRate === null || winRate === undefined) return null
  // 如果 <= 1，假设是小数格式，转换为百分比
  return winRate <= 1 ? winRate * 100 : winRate
}

/**
 * 计算 PnL Score (0-15)
 * 使用 log-tanh 压缩：小 PnL 快速增长，大 PnL 趋于饱和
 *
 * @param {number|null} pnl 已实现盈亏（USD）
 * @param {'7D'|'30D'|'90D'} period 时间段
 * @returns {number}
 */
export function calculatePnlScore(pnl, period) {
  if (pnl === null || pnl === undefined || pnl <= 0) return 0
  const params = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D']
  const logArg = 1 + pnl / params.base
  if (logArg <= 0) return 0
  const score = ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(params.coeff * Math.log(logArg))
  return clip(score, 0, ARENA_CONFIG.MAX_PNL_SCORE)
}

/**
 * 计算 Arena Score V2
 * Return(0-70) + PnL(0-15) + Drawdown(0-8) + Stability(0-7) = 100
 *
 * @param {number} roi ROI 百分比（如 25 表示 25%）
 * @param {number|null} pnl 已实现盈亏（USD）
 * @param {number|null} maxDrawdown 最大回撤百分比
 * @param {number|null} winRate 胜率（百分比或小数）
 * @param {'7D'|'30D'|'90D'} period 时间段
 * @returns {{totalScore: number, returnScore: number, pnlScore: number, drawdownScore: number, stabilityScore: number}}
 */
export function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)

  // 标准化胜率
  const wr = normalizeWinRate(winRate)

  // 计算收益强度
  const intensity = (365 / days) * safeLog1p(roi / 100)

  // 收益分 (0-70)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0
    ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE)
    : 0

  // PnL分 (0-15)
  const pnlScore = calculatePnlScore(pnl, period)

  // 回撤分 (0-8)
  const drawdownScore = maxDrawdown !== null && maxDrawdown !== undefined
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4  // 无数据时给中等分

  // 稳定分 (0-7)
  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - ARENA_CONFIG.WIN_RATE_BASELINE) / (params.winRateCap - ARENA_CONFIG.WIN_RATE_BASELINE), 0, 1), 0, 7)
    : 3.5  // 无数据时给中等分

  const totalScore = Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100

  return {
    totalScore,
    returnScore: Math.round(returnScore * 100) / 100,
    pnlScore: Math.round(pnlScore * 100) / 100,
    drawdownScore: Math.round(drawdownScore * 100) / 100,
    stabilityScore: Math.round(stabilityScore * 100) / 100,
  }
}

/**
 * 计算 PnL 软门槛系数 (0~1)
 * softFloor → 0, fullQualify → 1, between → linear interpolation
 */
export function calculatePnlQualifier(pnl, period) {
  const threshold = ARENA_CONFIG.PNL_THRESHOLD[period] || 1000
  const softFloor = threshold * ARENA_CONFIG.PNL_RAMP.SOFT_FLOOR_FACTOR
  const fullQualify = threshold * ARENA_CONFIG.PNL_RAMP.FULL_QUALIFY_FACTOR

  if (pnl >= fullQualify) return 1.0
  if (pnl > softFloor) return (pnl - softFloor) / (fullQualify - softFloor)
  return 0
}

/**
 * 检查是否达到入榜 PnL 门槛（软门槛：pnl > softFloor）
 */
export function meetsThreshold(pnl, period) {
  const threshold = ARENA_CONFIG.PNL_THRESHOLD[period] || 1000
  const softFloor = threshold * ARENA_CONFIG.PNL_RAMP.SOFT_FLOOR_FACTOR
  return pnl > softFloor
}

/**
 * 检查是否达到硬门槛（原始行为）
 */
export function meetsHardThreshold(pnl, period) {
  const threshold = ARENA_CONFIG.PNL_THRESHOLD[period] || 1000
  return pnl > threshold
}

/**
 * 检查是否在保留窗口内（Grace Period）
 */
export function isWithinGracePeriod(lastQualifiedAt, gracePeriodHours = ARENA_CONFIG.GRACE_PERIOD_HOURS) {
  if (!lastQualifiedAt) return false
  const elapsed = Date.now() - new Date(lastQualifiedAt).getTime()
  return elapsed < gracePeriodHours * 3600 * 1000
}

// ============================================
// 通用工具函数
// ============================================

/**
 * 延迟执行
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 随机延迟（防止被检测）
 */
export function randomDelay(min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min)) + min
  return sleep(delay)
}

/**
 * 解析命令行参数获取目标时间段
 * @returns {string[]}
 */
export function getTargetPeriods(defaultPeriods = ['7D', '30D', '90D']) {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return defaultPeriods
}

/**
 * 解析命令行参数获取并发数
 */
export function getConcurrency(defaultValue = 5, maxValue = 10) {
  const arg = process.argv.find(a => a.startsWith('--concurrency='))
  if (arg) {
    const val = parseInt(arg.split('=')[1])
    if (val >= 1 && val <= maxValue) return val
  }
  return defaultValue
}

/**
 * 格式化数字（带千分位）
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return '-'
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * 重试包装器
 */
export async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastError
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      console.warn(`⚠️ Attempt ${i + 1}/${maxRetries} failed:`, error.message)
      if (i < maxRetries - 1) {
        await sleep(delayMs * (i + 1))  // 指数退避
      }
    }
  }
  throw lastError
}

/**
 * 批量处理数组
 */
export async function processBatch(items, batchSize, processor) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await processor(batch, i)
    results.push(...(Array.isArray(batchResults) ? batchResults : [batchResults]))
  }
  return results
}

// ============================================
// 日志工具
// ============================================

export const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  progress: (current, total, msg = '') => {
    const pct = Math.round((current / total) * 100)
    console.log(`📊 [${current}/${total}] ${pct}% ${msg}`)
  },
}
