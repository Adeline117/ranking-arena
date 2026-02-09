/**
 * AI辅助审核 - Layer 2
 * 基于关键词+规则引擎的内容分类（不调用外部API）
 */

export type RiskLevel = 'normal' | 'suspicious' | 'high_risk'

export interface ReviewResult {
  level: RiskLevel
  reasons: string[]
  autoHide: boolean  // high_risk时自动隐藏
  score: number      // 0-100 风险分数
}

// 高风险关键词（命中即标记high_risk）
const HIGH_RISK_KEYWORDS = [
  '保证收益', '稳赚不赔', '百分百盈利', '零风险',
  '内部消息', '庄家拉盘', '全仓梭哈',
  'connect wallet', 'claim reward', 'verify your wallet',
  '代投', '私募基金', '传销',
]

// 可疑关键词（累积计分）
const SUSPICIOUS_KEYWORDS = [
  { keyword: '跟单', weight: 15 },
  { keyword: '带单', weight: 15 },
  { keyword: '喊单', weight: 15 },
  { keyword: '加微信', weight: 20 },
  { keyword: '加群', weight: 10 },
  { keyword: '私聊', weight: 10 },
  { keyword: '翻倍', weight: 10 },
  { keyword: '暴富', weight: 10 },
  { keyword: '日赚', weight: 15 },
  { keyword: '月入', weight: 15 },
  { keyword: '免费', weight: 5 },
  { keyword: '限时', weight: 5 },
  { keyword: 'airdrop', weight: 15 },
  { keyword: 'giveaway', weight: 10 },
]

// 格式异常检测
function checkFormatAnomalies(content: string): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  // 过多大写字母
  const upperRatio = (content.match(/[A-Z]/g) || []).length / Math.max(content.length, 1)
  if (upperRatio > 0.5 && content.length > 20) {
    score += 15
    reasons.push('大量大写字母')
  }

  // 过多感叹号
  const exclamationCount = (content.match(/!/g) || []).length
  if (exclamationCount > 5) {
    score += 10
    reasons.push('过多感叹号')
  }

  // 过多链接
  const linkCount = (content.match(/https?:\/\//g) || []).length
  if (linkCount > 3) {
    score += 20
    reasons.push('包含多个链接')
  }

  // 内容过短但包含链接
  if (content.length < 50 && linkCount > 0) {
    score += 10
    reasons.push('短文本配链接')
  }

  return { score, reasons }
}

/**
 * AI辅助内容审核
 */
export function reviewContent(content: string): ReviewResult {
  const lower = content.toLowerCase()
  const reasons: string[] = []
  let score = 0

  // 高风险检测
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return {
        level: 'high_risk',
        reasons: [`命中高风险关键词: ${kw}`],
        autoHide: true,
        score: 100,
      }
    }
  }

  // 可疑关键词计分
  for (const { keyword, weight } of SUSPICIOUS_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      score += weight
      reasons.push(`包含可疑词: ${keyword}`)
    }
  }

  // 格式异常
  const formatCheck = checkFormatAnomalies(content)
  score += formatCheck.score
  reasons.push(...formatCheck.reasons)

  // 判定风险等级
  if (score >= 60) {
    return { level: 'high_risk', reasons, autoHide: true, score }
  }
  if (score >= 30) {
    return { level: 'suspicious', reasons, autoHide: false, score }
  }

  return { level: 'normal', reasons: [], autoHide: false, score }
}

/**
 * 信用分规则
 */
export interface CreditAction {
  type: 'violation' | 'severe_violation'
  currentScore: number
}

export interface CreditResult {
  newScore: number
  action: 'none' | 'restrict_posting' | 'mute_7days' | 'ban'
}

export function applyCreditPenalty(config: CreditAction): CreditResult {
  const penalty = config.type === 'severe_violation' ? 50 : 20
  const newScore = config.currentScore - penalty

  if (newScore <= 0) {
    return { newScore: Math.max(newScore, 0), action: 'ban' }
  }
  if (newScore < 30) {
    return { newScore, action: 'mute_7days' }
  }
  if (newScore < 60) {
    return { newScore, action: 'restrict_posting' }
  }

  return { newScore, action: 'none' }
}
