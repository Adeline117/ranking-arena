/**
 * Scoring 模块导出
 */

export {
  calculateDataQuality,
  calculateBatchDataQuality,
  applyQualityWeight,
  getPlatformQualityStats,
  isDataStale,
  getDataFreshnessStatus,
  formatDataAge,
  PLATFORM_RELIABILITY,
  DATA_QUALITY_CONFIG,
  type DataQualityInput,
  type DataQualityResult,
  type DataQualityGrade,
} from './data-quality'
