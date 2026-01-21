/**
 * Zod 类型定义
 * 用于前后端类型同步和运行时验证
 */

import { z } from 'zod'

// ============================================
// 基础类型
// ============================================

/** UUID 格式验证 */
export const UUIDSchema = z.string().uuid()

/** 交易所类型 */
export const ExchangeSchema = z.enum([
  'binance',
  'binance_web3',
  'bybit',
  'bitget',
  'okx',
  'kucoin',
  'gate',
  'mexc',
  'coinex',
])

/** 时间范围 */
export const TimeRangeSchema = z.enum(['7D', '30D', '90D', '1Y', '2Y', 'All'])

/** 排序方向 */
export const SortOrderSchema = z.enum(['asc', 'desc'])

// ============================================
// 交易员相关
// ============================================

/** 交易员基本信息 */
export const TraderProfileSchema = z.object({
  id: z.string(),
  handle: z.string(),
  bio: z.string().optional(),
  followers: z.number().int().nonnegative().optional(),
  following: z.number().int().nonnegative().optional(),
  copiers: z.number().int().nonnegative().optional(),
  avatar_url: z.string().url().optional().nullable(),
  isRegistered: z.boolean().optional(),
  source: ExchangeSchema.optional(),
})

/** 交易员绩效数据 */
export const TraderPerformanceSchema = z.object({
  roi_7d: z.number().optional(),
  roi_30d: z.number().optional(),
  roi_90d: z.number().optional(),
  roi_1y: z.number().optional(),
  roi_2y: z.number().optional(),
  return_ytd: z.number().optional(),
  return_2y: z.number().optional(),
  pnl: z.number().optional(),
  win_rate: z.number().min(0).max(100).optional(),
  max_drawdown: z.number().optional(),
  pnl_7d: z.number().optional(),
  pnl_30d: z.number().optional(),
  win_rate_7d: z.number().optional(),
  win_rate_30d: z.number().optional(),
  max_drawdown_7d: z.number().optional(),
  max_drawdown_30d: z.number().optional(),
  risk_score_last_7d: z.number().optional(),
  profitable_weeks: z.number().int().nonnegative().optional(),
})

/** 排行榜交易员数据 */
export const RankedTraderSchema = z.object({
  id: z.string(),
  handle: z.string(),
  roi: z.number(),
  pnl: z.number().optional(),
  win_rate: z.number().optional(),
  max_drawdown: z.number().nullable().optional(),
  trades_count: z.number().int().nonnegative().nullable().optional(),
  followers: z.number().int().nonnegative().default(0),
  source: ExchangeSchema,
  avatar_url: z.string().url().nullable().optional(),
  risk_adjusted_score: z.number().optional(),
  stability_score: z.number().optional(),
  is_suspicious: z.boolean().optional(),
})

/** 交易员统计数据 */
export const TraderStatsSchema = z.object({
  trading: z.object({
    totalTrades12M: z.number().int().nonnegative(),
    avgProfit: z.number(),
    avgLoss: z.number(),
    profitableTradesPct: z.number().min(0).max(100),
  }).optional(),
  frequentlyTraded: z.array(z.object({
    symbol: z.string(),
    weightPct: z.number(),
    count: z.number().int().nonnegative(),
    avgProfit: z.number(),
    avgLoss: z.number(),
    profitablePct: z.number().min(0).max(100),
  })).optional(),
  additionalStats: z.object({
    tradesPerWeek: z.number().optional(),
    avgHoldingTime: z.string().optional(),
    activeSince: z.string().optional(),
    profitableWeeksPct: z.number().optional(),
    riskScore: z.number().optional(),
    volume90d: z.number().optional(),
    maxDrawdown: z.number().optional(),
    sharpeRatio: z.number().optional(),
  }).optional(),
})

// ============================================
// 帖子相关
// ============================================

/** 帖子基本信息 */
export const PostSchema = z.object({
  id: UUIDSchema,
  title: z.string().min(1).max(200),
  content: z.string().max(10000).optional().nullable(),
  author_id: UUIDSchema,
  author_handle: z.string().optional().nullable(),
  group_id: UUIDSchema.optional().nullable(),
  images: z.array(z.string().url()).optional().nullable(),
  poll_id: UUIDSchema.optional().nullable(),
  view_count: z.number().int().nonnegative().default(0),
  like_count: z.number().int().nonnegative().default(0),
  comment_count: z.number().int().nonnegative().default(0),
  repost_count: z.number().int().nonnegative().default(0),
  is_pinned: z.boolean().default(false),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional().nullable(),
})

/** 创建帖子输入 */
export const CreatePostInputSchema = z.object({
  title: z.string()
    .min(1, '标题不能为空')
    .max(200, '标题不能超过200个字符')
    .transform(s => s.trim()),
  content: z.string()
    .max(10000, '内容不能超过10000个字符')
    .optional()
    .nullable()
    .transform(s => s?.trim() || null),
  group_id: UUIDSchema.optional().nullable(),
  images: z.array(z.string().url('图片链接格式无效'))
    .max(9, '最多上传9张图片')
    .optional()
    .nullable(),
  poll_options: z.array(z.string().min(1).max(100))
    .min(2, '投票至少需要2个选项')
    .max(10, '投票最多10个选项')
    .optional()
    .nullable(),
})

/** 帖子列表查询参数 */
export const PostListOptionsSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
  group_id: UUIDSchema.optional(),
  author_handle: z.string().optional(),
  sort_by: z.enum(['created_at', 'like_count', 'view_count', 'comment_count']).default('created_at'),
  sort_order: SortOrderSchema.default('desc'),
})

// ============================================
// 评论相关
// ============================================

/** 评论 */
export const CommentSchema = z.object({
  id: UUIDSchema,
  post_id: UUIDSchema,
  author_id: UUIDSchema,
  content: z.string().min(1).max(2000),
  parent_id: UUIDSchema.optional().nullable(),
  like_count: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime(),
})

/** 创建评论输入 */
export const CreateCommentInputSchema = z.object({
  post_id: UUIDSchema,
  content: z.string()
    .min(1, '评论内容不能为空')
    .max(2000, '评论内容不能超过2000个字符')
    .transform(s => s.trim()),
  parent_id: UUIDSchema.optional().nullable(),
})

// ============================================
// API 响应相关
// ============================================

/** 分页信息 */
export const PaginationSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  total: z.number().int().nonnegative().optional(),
})

/** API 成功响应 */
export function createSuccessResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: z.object({
      pagination: PaginationSchema.optional(),
      timestamp: z.string().datetime().optional(),
    }).optional(),
  })
}

/** API 错误响应 */
export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.string().datetime(),
  }),
})

// ============================================
// 风险指标相关
// ============================================

/** 风险指标 */
export const RiskMetricsSchema = z.object({
  sharpeRatio: z.number().nullable(),
  sortinoRatio: z.number().nullable(),
  calmarRatio: z.number().nullable(),
  volatility: z.number().nullable(),
  downwardVolatility: z.number().nullable(),
  maxDrawdown: z.number().nullable(),
  maxDrawdownDuration: z.number().int().nonnegative().nullable(),
  maxConsecutiveLosses: z.number().int().nonnegative().nullable(),
  maxConsecutiveWins: z.number().int().nonnegative().nullable(),
  profitLossRatio: z.number().nullable(),
  rewardRiskRatio: z.number().nullable(),
  riskLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  riskLevelDescription: z.string(),
})

// ============================================
// 用户相关
// ============================================

/** 用户资料 */
export const UserProfileSchema = z.object({
  id: UUIDSchema,
  uid: z.number().int().positive().optional().nullable(), // 数字用户编号
  handle: z.string().min(3).max(30),
  display_name: z.string().max(50).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  avatar_url: z.string().url().optional().nullable(),
  created_at: z.string().datetime(),
})

/** 更新用户资料输入 */
export const UpdateProfileInputSchema = z.object({
  display_name: z.string().max(50).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  avatar_url: z.string().url().optional().nullable(),
})

// ============================================
// 类型导出
// ============================================

export type Exchange = z.infer<typeof ExchangeSchema>
export type TimeRange = z.infer<typeof TimeRangeSchema>
export type SortOrder = z.infer<typeof SortOrderSchema>

export type TraderProfile = z.infer<typeof TraderProfileSchema>
export type TraderPerformance = z.infer<typeof TraderPerformanceSchema>
export type RankedTrader = z.infer<typeof RankedTraderSchema>
export type TraderStats = z.infer<typeof TraderStatsSchema>

export type Post = z.infer<typeof PostSchema>
export type CreatePostInput = z.infer<typeof CreatePostInputSchema>
export type PostListOptions = z.infer<typeof PostListOptionsSchema>

export type Comment = z.infer<typeof CommentSchema>
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>

export type Pagination = z.infer<typeof PaginationSchema>
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>

export type RiskMetrics = z.infer<typeof RiskMetricsSchema>

export type UserProfile = z.infer<typeof UserProfileSchema>
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>

// ============================================
// 验证辅助函数
// ============================================

/**
 * 安全解析数据，失败时返回默认值
 */
export function safeParse<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  defaultValue: z.infer<T>
): z.infer<T> {
  const result = schema.safeParse(data)
  return result.success ? result.data : defaultValue
}

/**
 * 验证数据，失败时抛出格式化的错误
 */
export function validate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  context?: string
): z.infer<T> {
  const result = schema.safeParse(data)
  if (!result.success) {
    // Zod v4 使用 issues，v3 使用 errors
    const issues = (result.error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? []
    const errors = issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    throw new Error(context ? `[${context}] 验证失败: ${errors}` : `验证失败: ${errors}`)
  }
  return result.data
}

/**
 * 创建类型安全的 API 响应验证器
 */
export function createResponseValidator<T extends z.ZodTypeAny>(dataSchema: T) {
  const responseSchema = createSuccessResponseSchema(dataSchema)
  
  return (data: unknown) => {
    // 先检查是否是错误响应
    const errorResult = ApiErrorResponseSchema.safeParse(data)
    if (errorResult.success) {
      throw new Error(errorResult.data.error.message)
    }
    
    // 验证成功响应
    return validate(responseSchema, data)
  }
}
