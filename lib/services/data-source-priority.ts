/**
 * Data Source Priority Logic
 * Determines which data source to use based on availability and quality
 */

export enum DataSource {
  AUTHORIZED = 'authorized', // User-authorized API (highest quality)
  OFFICIAL_API = 'api', // Official exchange API
  WEB_SCRAPER = 'scraper', // Web scraping (fallback)
  CACHED = 'cache', // Cached data (last resort)
}

export interface DataSourcePriority {
  source: DataSource
  priority: number // Lower = higher priority
  quality: 'high' | 'medium' | 'low'
  freshness: 'realtime' | 'recent' | 'stale'
  description: string
}

/**
 * Data source priority ranking
 */
export const DATA_SOURCE_PRIORITIES: Record<DataSource, DataSourcePriority> = {
  [DataSource.AUTHORIZED]: {
    source: DataSource.AUTHORIZED,
    priority: 1,
    quality: 'high',
    freshness: 'realtime',
    description: 'User-authorized real trading data',
  },
  [DataSource.OFFICIAL_API]: {
    source: DataSource.OFFICIAL_API,
    priority: 2,
    quality: 'high',
    freshness: 'recent',
    description: 'Official exchange API data',
  },
  [DataSource.WEB_SCRAPER]: {
    source: DataSource.WEB_SCRAPER,
    priority: 3,
    quality: 'medium',
    freshness: 'recent',
    description: 'Web-scraped public data',
  },
  [DataSource.CACHED]: {
    source: DataSource.CACHED,
    priority: 4,
    quality: 'low',
    freshness: 'stale',
    description: 'Cached historical data',
  },
}

/**
 * Compare two data sources and return the higher priority one
 */
export function getHigherPrioritySource(
  source1: DataSource,
  source2: DataSource
): DataSource {
  const priority1 = DATA_SOURCE_PRIORITIES[source1].priority
  const priority2 = DATA_SOURCE_PRIORITIES[source2].priority

  return priority1 <= priority2 ? source1 : source2
}

/**
 * Get data source info
 */
export function getDataSourceInfo(source: DataSource): DataSourcePriority {
  return DATA_SOURCE_PRIORITIES[source]
}

/**
 * Calculate data quality score (0-100)
 * Used for weighting in rankings
 */
export function calculateDataQualityScore(
  source: DataSource,
  isAuthorized: boolean,
  freshness?: number // Minutes since last update
): number {
  let baseScore = 0

  // Base score from source type
  switch (source) {
    case DataSource.AUTHORIZED:
      baseScore = 100
      break
    case DataSource.OFFICIAL_API:
      baseScore = 85
      break
    case DataSource.WEB_SCRAPER:
      baseScore = 60
      break
    case DataSource.CACHED:
      baseScore = 30
      break
  }

  // Bonus for authorized data
  if (isAuthorized) {
    baseScore = Math.min(100, baseScore + 15)
  }

  // Penalty for stale data
  if (freshness !== undefined) {
    if (freshness > 60) {
      // > 1 hour
      baseScore *= 0.9
    }
    if (freshness > 240) {
      // > 4 hours
      baseScore *= 0.8
    }
    if (freshness > 1440) {
      // > 24 hours
      baseScore *= 0.6
    }
  }

  return Math.round(baseScore)
}

/**
 * Apply data source weight to arena score
 * Authorized data gets higher weight in rankings
 */
export function applyDataSourceWeight(
  arenaScore: number,
  source: DataSource,
  isAuthorized: boolean
): number {
  const qualityScore = calculateDataQualityScore(source, isAuthorized)
  const weight = qualityScore / 100

  return arenaScore * weight
}

/**
 * SQL query fragment for ordering by data source priority
 * Use in ORDER BY clause to prioritize authorized data
 */
export function getDataSourceOrderSQL(): string {
  return `
    CASE
      WHEN is_authorized = TRUE THEN 1
      WHEN data_source = 'api' THEN 2
      WHEN data_source = 'scraper' THEN 3
      ELSE 4
    END
  `
}

/**
 * Get badge/indicator for data source
 * Used in UI to show data quality
 */
export function getDataSourceBadge(
  source: DataSource,
  isAuthorized: boolean
): {
  label: string
  color: string
  icon?: string
} {
  if (isAuthorized) {
    return {
      label: 'Verified',
      color: 'var(--color-score-great)', // green
      icon: '[OK]',
    }
  }

  switch (source) {
    case DataSource.OFFICIAL_API:
      return {
        label: 'Official',
        color: 'var(--color-score-profitability)', // blue
        icon: '[+]',
      }
    case DataSource.WEB_SCRAPER:
      return {
        label: 'Public',
        color: 'var(--color-score-legendary)', // purple
        icon: '[-]',
      }
    case DataSource.CACHED:
      return {
        label: 'Cached',
        color: 'var(--color-score-low)', // gray
        icon: '[?]',
      }
    default:
      return {
        label: 'Unknown',
        color: 'var(--color-score-low)',
      }
  }
}

/**
 * Check if data should be refreshed
 */
export function shouldRefreshData(
  source: DataSource,
  lastUpdated: Date,
  syncFrequency: 'realtime' | '5min' | '15min' | '1hour' = 'realtime'
): boolean {
  const now = Date.now()
  const lastUpdateTime = lastUpdated.getTime()
  const minutesSinceUpdate = (now - lastUpdateTime) / (1000 * 60)

  // Authorized data refresh based on sync frequency
  if (source === DataSource.AUTHORIZED) {
    const thresholds = {
      realtime: 5,
      '5min': 5,
      '15min': 15,
      '1hour': 60,
    }
    return minutesSinceUpdate >= thresholds[syncFrequency]
  }

  // Official API: refresh every 15 minutes
  if (source === DataSource.OFFICIAL_API) {
    return minutesSinceUpdate >= 15
  }

  // Scraper: refresh every hour
  if (source === DataSource.WEB_SCRAPER) {
    return minutesSinceUpdate >= 60
  }

  // Cached: refresh every 4 hours
  return minutesSinceUpdate >= 240
}
