/**
 * 自动内容过滤 - Layer 1
 * 敏感词检测、重复内容检测、频率限制
 */

// 敏感词库
const SPAM_KEYWORDS = [
  // 广告/营销
  '加微信', '加群', '免费领取', '限时优惠', '点击链接',
  '私聊我', '代理', '招商', '日赚', '月入',
  // 诈骗/钓鱼
  '保证收益', '稳赚不赔', '百分百盈利', '零风险',
  '内部消息', '内幕', '庄家拉盘', '翻倍', '暴富',
  // 喊单带单
  '跟单', '带单', '喊单', '包赚', '全仓梭哈',
  '稳定盈利', '日化', '私募', '基金代投',
  // 钓鱼
  'airdrop claim', 'connect wallet', 'verify your wallet',
  'claim reward', 'click here to claim',
]

// 高风险链接模式
const SUSPICIOUS_LINK_PATTERNS = [
  /bit\.ly/i, /tinyurl\.com/i, /t\.co/i,
  /dex-[a-z]+\.com/i, /swap-[a-z]+\.com/i,
  /claim-[a-z]+\.com/i, /airdrop-[a-z]+\.com/i,
]

export interface FilterResult {
  passed: boolean
  reason?: string
  severity?: 'low' | 'medium' | 'high'
  matchedKeywords?: string[]
}

/**
 * 检查内容是否包含敏感词
 */
export function checkKeywords(content: string): FilterResult {
  const lower = content.toLowerCase()
  const matched = SPAM_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()))

  if (matched.length >= 3) {
    return { passed: false, reason: '内容包含多个敏感词', severity: 'high', matchedKeywords: matched }
  }
  if (matched.length > 0) {
    return { passed: false, reason: '内容包含敏感词', severity: 'medium', matchedKeywords: matched }
  }

  return { passed: true }
}

/**
 * 检查链接是否可疑
 */
export function checkLinks(content: string): FilterResult {
  for (const pattern of SUSPICIOUS_LINK_PATTERNS) {
    if (pattern.test(content)) {
      return { passed: false, reason: '内容包含可疑链接', severity: 'high' }
    }
  }
  return { passed: true }
}

/**
 * 简单相似度检测（Jaccard系数）
 */
function textSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(''))
  const setB = new Set(b.split(''))
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return intersection.size / union.size
}

/**
 * 检查重复内容（同用户24h内）
 */
export function checkDuplicate(content: string, recentPosts: string[]): FilterResult {
  for (const post of recentPosts) {
    if (textSimilarity(content, post) > 0.8) {
      return { passed: false, reason: '与最近发布的内容过于相似', severity: 'medium' }
    }
  }
  return { passed: true }
}

/**
 * 频率限制规则
 */
export interface RateLimitConfig {
  userLevel: number
  postsInLast24h: number
}

export function checkRateLimit(config: RateLimitConfig): FilterResult {
  const { userLevel, postsInLast24h } = config

  // Lv1: 3帖/天, Lv2: 10帖/天, Lv3+: 30帖/天
  let limit = 3
  if (userLevel >= 3) limit = 30
  else if (userLevel >= 2) limit = 10

  if (postsInLast24h >= limit) {
    return { passed: false, reason: `已达到每日发帖上限(${limit}帖/天)`, severity: 'low' }
  }

  return { passed: true }
}

/**
 * 链接去重检查：同一链接24h只能发1次
 */
export function checkLinkDuplicate(content: string, recentLinks: string[]): FilterResult {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi
  const urls = content.match(urlRegex) || []

  for (const url of urls) {
    if (recentLinks.includes(url)) {
      return { passed: false, reason: '该链接已在24小时内发布过', severity: 'low' }
    }
  }

  return { passed: true }
}

/**
 * 综合过滤检查
 */
export function runAutoFilter(
  content: string,
  options: {
    recentPosts?: string[]
    recentLinks?: string[]
    userLevel?: number
    postsInLast24h?: number
  } = {}
): FilterResult {
  // 1. 敏感词检查
  const keywordResult = checkKeywords(content)
  if (!keywordResult.passed && keywordResult.severity === 'high') return keywordResult

  // 2. 链接检查
  const linkResult = checkLinks(content)
  if (!linkResult.passed) return linkResult

  // 3. 重复内容检查
  if (options.recentPosts) {
    const dupResult = checkDuplicate(content, options.recentPosts)
    if (!dupResult.passed) return dupResult
  }

  // 4. 链接去重检查
  if (options.recentLinks) {
    const linkDupResult = checkLinkDuplicate(content, options.recentLinks)
    if (!linkDupResult.passed) return linkDupResult
  }

  // 5. 频率限制
  if (options.userLevel !== undefined && options.postsInLast24h !== undefined) {
    const rateResult = checkRateLimit({
      userLevel: options.userLevel,
      postsInLast24h: options.postsInLast24h,
    })
    if (!rateResult.passed) return rateResult
  }

  // 返回中等敏感词（不阻止但标记）
  if (!keywordResult.passed) return keywordResult

  return { passed: true }
}
