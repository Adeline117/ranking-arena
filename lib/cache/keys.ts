/**
 * 缓存键常量
 * 统一管理所有 Redis 缓存键，便于维护和避免键名冲突
 */

// ============================================
// 缓存键前缀
// ============================================

export const CACHE_PREFIX = {
  TRADERS: 'traders',
  TRADER: 'trader',
  POSTS: 'posts',
  POST: 'post',
  COMMENTS: 'comments',
  USER: 'user',
  MARKET: 'market',
  SEARCH: 'search',
  GROUPS: 'groups',
  NOTIFICATIONS: 'notifications',
} as const

// ============================================
// TTL 配置（秒）
// ============================================

export const CACHE_TTL = {
  /** 排行榜缓存：5 分钟 (hot — refreshed by cron every 5 min) */
  TRADERS_LIST: 300,
  /** 交易员详情：3 分钟 (warm — detail pages, moderate traffic) */
  TRADER_DETAIL: 180,
  /** 交易员性能数据：15 分钟 (cold — historical, changes slowly) */
  TRADER_PERFORMANCE: 900,
  /** 帖子列表：2 分钟 */
  POSTS_LIST: 120,
  /** 单个帖子：2 分钟 */
  POST_DETAIL: 120,
  /** 评论列表：1 分钟 */
  COMMENTS_LIST: 60,
  /** 用户资料：5 分钟 */
  USER_PROFILE: 300,
  /** 市场数据：10 秒 (hot — prices change rapidly, ISR + SWR also active) */
  MARKET_DATA: 10,
  /** 搜索结果：2 分钟 */
  SEARCH_RESULTS: 120,
  /** 小组列表：5 分钟 */
  GROUPS_LIST: 300,
  /** 通知列表：30 秒 */
  NOTIFICATIONS_LIST: 30,
} as const

// ============================================
// 缓存键生成函数
// ============================================

export const CacheKey = {
  // 交易员相关
  traders: {
    /** 排行榜列表 */
    list: (params: { timeRange: string; exchange?: string; limit?: number; page?: number }) => {
      const { timeRange, exchange = 'all', limit = 20, page = 0 } = params
      return `${CACHE_PREFIX.TRADERS}:list:${exchange}:${timeRange.toUpperCase()}:${limit}:${page}`
    },
    /** 交易员详情 */
    detail: (handle: string) => `${CACHE_PREFIX.TRADER}:detail:${handle}`,
    /** 交易员性能数据 */
    performance: (handle: string, period: string) =>
      `${CACHE_PREFIX.TRADER}:performance:${handle}:${period.toUpperCase()}`,
    /** 交易员资金曲线 */
    equity: (handle: string) => `${CACHE_PREFIX.TRADER}:equity:${handle}`,
    /** 交易员持仓 */
    positions: (handle: string) => `${CACHE_PREFIX.TRADER}:positions:${handle}`,
    /** 类似交易员推荐 */
    similar: (handle: string) => `${CACHE_PREFIX.TRADER}:similar:${handle}`,
  },

  // 帖子相关
  posts: {
    /** 帖子列表 */
    list: (params: { groupId?: string; sortBy?: string; page?: number }) => {
      const { groupId = 'all', sortBy = 'created_at', page = 0 } = params
      return `${CACHE_PREFIX.POSTS}:list:${groupId}:${sortBy}:${page}`
    },
    /** 热门帖子 */
    hot: (page?: number) => `${CACHE_PREFIX.POSTS}:hot:${page || 0}`,
    /** 单个帖子 */
    detail: (postId: string) => `${CACHE_PREFIX.POST}:detail:${postId}`,
    /** 用户帖子列表 */
    byUser: (userId: string, page?: number) => 
      `${CACHE_PREFIX.POSTS}:user:${userId}:${page || 0}`,
  },

  // 评论相关
  comments: {
    /** 帖子评论列表 */
    byPost: (postId: string, page?: number) => 
      `${CACHE_PREFIX.COMMENTS}:post:${postId}:${page || 0}`,
  },

  // 用户相关
  user: {
    /** 用户资料 */
    profile: (userId: string) => `${CACHE_PREFIX.USER}:profile:${userId}`,
    /** 用户收藏夹 */
    bookmarks: (userId: string) => `${CACHE_PREFIX.USER}:bookmarks:${userId}`,
    /** 用户关注列表 */
    following: (userId: string) => `${CACHE_PREFIX.USER}:following:${userId}`,
    /** 用户通知 */
    notifications: (userId: string) => `${CACHE_PREFIX.USER}:notifications:${userId}`,
  },

  // 市场相关
  market: {
    /** 市场价格数据 */
    prices: () => `${CACHE_PREFIX.MARKET}:prices`,
    /** 市场趋势 */
    trends: () => `${CACHE_PREFIX.MARKET}:trends`,
  },

  // 搜索相关
  search: {
    /** 搜索结果 */
    results: (query: string, type: string) => 
      `${CACHE_PREFIX.SEARCH}:results:${type}:${encodeURIComponent(query)}`,
    /** 热门搜索 */
    trending: () => `${CACHE_PREFIX.SEARCH}:trending`,
  },

  // 小组相关
  groups: {
    /** 小组列表 */
    list: (page?: number) => `${CACHE_PREFIX.GROUPS}:list:${page || 0}`,
    /** 单个小组 */
    detail: (groupId: string) => `${CACHE_PREFIX.GROUPS}:detail:${groupId}`,
  },
}

// ============================================
// 缓存失效模式（用于批量删除）
// ============================================

export const CachePattern = {
  /** 所有交易员缓存 */
  allTraders: () => `${CACHE_PREFIX.TRADERS}:*`,
  /** 特定交易员的所有缓存 */
  trader: (handle: string) => `${CACHE_PREFIX.TRADER}:*:${handle}*`,
  /** 所有帖子缓存 */
  allPosts: () => `${CACHE_PREFIX.POSTS}:*`,
  /** 特定用户的所有缓存 */
  user: (userId: string) => `${CACHE_PREFIX.USER}:*:${userId}*`,
  /** 所有市场数据缓存 */
  market: () => `${CACHE_PREFIX.MARKET}:*`,
  /** 所有搜索缓存 */
  search: () => `${CACHE_PREFIX.SEARCH}:*`,
}

export type CacheKeyType = typeof CacheKey
export type CachePatternType = typeof CachePattern
