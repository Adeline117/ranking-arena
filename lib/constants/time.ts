/**
 * 时间相关常量（毫秒）
 *
 * 统一管理项目中重复出现的时间间隔，避免 magic numbers。
 */

/** 1 秒 (ms) */
export const ONE_SECOND_MS = 1_000

/** 1 分钟 (ms) */
export const ONE_MINUTE_MS = 60 * 1_000

/** 5 分钟 (ms) */
export const FIVE_MINUTES_MS = 5 * 60 * 1_000

/** 10 分钟 (ms) */
export const TEN_MINUTES_MS = 10 * 60 * 1_000

/** 30 分钟 (ms) */
export const THIRTY_MINUTES_MS = 30 * 60 * 1_000

/** 1 小时 (ms) */
export const ONE_HOUR_MS = 60 * 60 * 1_000

/** 1 天 (ms) */
export const ONE_DAY_MS = 24 * 60 * 60 * 1_000

/** 7 天 (ms) */
export const SEVEN_DAYS_MS = 7 * ONE_DAY_MS

/** 1 小时 (秒) */
export const ONE_HOUR_SECONDS = 3_600

/** 1 天 (秒) */
export const ONE_DAY_SECONDS = 86_400

/**
 * 默认刷新间隔配置
 */
export const REFRESH_INTERVALS = {
  /** 实时数据刷新 (1 分钟) */
  REALTIME: ONE_MINUTE_MS,
  /** 标准数据刷新 (5 分钟) */
  STANDARD: FIVE_MINUTES_MS,
  /** 缓存 TTL (5 分钟) */
  CACHE_TTL: FIVE_MINUTES_MS,
  /** 数据过期阈值 (5 分钟) */
  STALE_THRESHOLD: FIVE_MINUTES_MS,
} as const
