/**
 * 用户等级系统 - 海洋生物主题
 * 仿B站等级体系
 */

export interface LevelDefinition {
  level: number
  name: string
  nameEn: string
  minExp: number
  color: string
  colorHex: string
}

export interface LevelInfo {
  level: number
  name: string
  nameEn: string
  color: string
  colorHex: string
  currentExp: number
  nextExp: number | null
  progress: number // 0-100
}

export const LEVELS: LevelDefinition[] = [
  { level: 1, name: '磷虾', nameEn: 'Krill', minExp: 0, color: 'gray', colorHex: 'var(--color-text-tertiary)' },
  { level: 2, name: '沙丁鱼', nameEn: 'Sardine', minExp: 500, color: 'blue', colorHex: 'var(--color-score-profitability)' },
  { level: 3, name: '海豚', nameEn: 'Dolphin', minExp: 2000, color: 'green', colorHex: 'var(--color-accent-success)' },
  { level: 4, name: '鲨鱼', nameEn: 'Shark', minExp: 10000, color: 'purple', colorHex: 'var(--color-chart-violet)' },
  { level: 5, name: '虎鲸', nameEn: 'Orca', minExp: 50000, color: 'gold', colorHex: 'var(--color-accent-warning)' },
]

export function getLevelInfo(exp: number): LevelInfo {
  let current = LEVELS[0]
  for (const lvl of LEVELS) {
    if (exp >= lvl.minExp) current = lvl
    else break
  }

  const nextLevel = LEVELS.find((l) => l.level === current.level + 1)
  const nextExp = nextLevel?.minExp ?? null
  const progress = nextExp
    ? Math.min(100, Math.floor(((exp - current.minExp) / (nextExp - current.minExp)) * 100))
    : 100

  return {
    level: current.level,
    name: current.name,
    nameEn: current.nameEn,
    color: current.color,
    colorHex: current.colorHex,
    currentExp: exp,
    nextExp,
    progress,
  }
}

// EXP获取规则
export interface ExpAction {
  key: string
  label: string
  exp: number
  dailyLimit: number | null // null = 无限
}

export const EXP_ACTIONS: ExpAction[] = [
  { key: 'login', label: '每日登录', exp: 5, dailyLimit: 5 },
  { key: 'post', label: '发动态', exp: 15, dailyLimit: 60 },
  { key: 'comment', label: '评论', exp: 5, dailyLimit: 30 },
  { key: 'liked', label: '被点赞', exp: 3, dailyLimit: null },
  { key: 'bookmarked', label: '被收藏', exp: 5, dailyLimit: null },
  { key: 'followed', label: '被关注', exp: 10, dailyLimit: null },
  { key: 'read_checkin', label: '阅读打卡', exp: 20, dailyLimit: 20 },
  { key: 'pro_daily', label: 'Pro会员每日', exp: 50, dailyLimit: 50 },
  { key: 'purchase_annual', label: '购买年费', exp: 5000, dailyLimit: null },
]

/**
 * 计算某个action实际能获得的EXP（考虑日上限）
 * @param action action key
 * @param dailyEarned 今日该action已获得的EXP
 * @returns 实际可获得的EXP，0表示已达上限
 */
export function getExpForAction(action: string, dailyEarned: number): number {
  const config = EXP_ACTIONS.find((a) => a.key === action)
  if (!config) return 0

  if (config.dailyLimit === null) return config.exp

  const remaining = config.dailyLimit - dailyEarned
  if (remaining <= 0) return 0

  return Math.min(config.exp, remaining)
}
