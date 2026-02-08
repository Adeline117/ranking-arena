/**
 * Hook for fetching data freshness status from /api/monitoring/freshness
 */

import useSWR from 'swr'

interface PlatformStatus {
  source: string
  status: 'healthy' | 'warning' | 'critical' | 'no_data'
  lastUpdate: string | null
  ageHours: number | null
  threshold: number
  total: number
  fieldCoverage: {
    roi: number
    winRate: number
    maxDrawdown: number
  }
}

interface FreshnessData {
  timestamp: string
  summary: {
    totalPlatforms: number
    healthy: number
    warning: number
    critical: number
    noData: number
  }
  platforms: PlatformStatus[]
}

const fetcher = async (url: string): Promise<FreshnessData> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch freshness data')
  return res.json()
}

export function useDataFreshness() {
  const { data, error, isLoading, mutate } = useSWR<FreshnessData>(
    '/api/monitoring/freshness',
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // Refresh every 5 minutes
      revalidateOnFocus: false,
      dedupingInterval: 60 * 1000, // Dedupe requests within 1 minute
    }
  )

  return {
    data,
    error,
    isLoading,
    refresh: mutate,
  }
}

// Helper to get status for a specific platform
export function getPlatformFreshness(
  data: FreshnessData | undefined,
  platform: string
): PlatformStatus | null {
  if (!data) return null
  return data.platforms.find(p => p.source === platform) || null
}

// Helper to get overall health summary
export function getOverallHealth(data: FreshnessData | undefined): {
  status: 'healthy' | 'warning' | 'critical'
  message: string
} {
  if (!data) {
    return { status: 'healthy', message: '' }
  }

  const { healthy, warning, critical } = data.summary
  
  if (critical > 0) {
    return {
      status: 'critical',
      message: `${critical} platform${critical > 1 ? 's' : ''} critically outdated`,
    }
  }
  
  if (warning > 0) {
    return {
      status: 'warning',
      message: `${warning} platform${warning > 1 ? 's' : ''} need attention`,
    }
  }
  
  return {
    status: 'healthy',
    message: `All ${healthy} platforms up to date`,
  }
}
