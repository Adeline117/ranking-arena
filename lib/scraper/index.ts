/**
 * 抓取系统统一导出
 */

// 配置
export {
  PLATFORM_CONFIGS,
  getPlatformConfig,
  getEnabledPlatforms,
  getPlatformsByPriority,
  getCexPlatforms,
  getDexPlatforms,
  getProxyRequiredPlatforms,
  getRefreshInterval,
  type PlatformConfig,
} from './config'

// 遥测
export {
  recordScrapeMetrics,
  getPlatformStats,
  getAllPlatformStats,
  getSystemHealth,
  getRecentAlerts,
  acquireScrapeLock,
  releaseScrapeLock,
  filterDuplicateTraders,
  scraperTelemetry,
  type ScrapeMetrics,
  type PlatformStats,
  type SystemHealth,
  type HealthAlert,
} from './telemetry'
