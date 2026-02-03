/**
 * Ranking Arena Worker Service - Type Definitions
 */

// ============================================
// Job Types
// ============================================

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type JobPriority = 'high' | 'normal' | 'low'

export interface Job {
  id: string
  platform: string
  periods: string[]
  priority: JobPriority
  status: JobStatus
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  result?: JobResult
  error?: string
  retryCount: number
  maxRetries: number
  proxyId?: string
}

export interface JobResult {
  platform: string
  periods: Record<string, PeriodResult>
  duration: number
  proxyUsed?: string
}

export interface PeriodResult {
  total: number
  saved: number
  error?: string
}

// ============================================
// Platform Types
// ============================================

export type PlatformCategory = 'cex-api' | 'cex-browser' | 'dex-api' | 'dex-subgraph'

export interface PlatformConfig {
  id: string
  name: string
  category: PlatformCategory
  enabled: boolean
  requiresProxy: boolean
  proxyRegions?: string[]
  cronSchedule: string
  periods: string[]
  maxRetries: number
  timeoutMs: number
}

// ============================================
// Proxy Types
// ============================================

export type ProxyStatus = 'active' | 'degraded' | 'down' | 'unknown'

export interface ProxyNode {
  id: string
  name: string
  type: 'clash' | 'http' | 'socks5'
  region?: string
  host: string
  port: number
  status: ProxyStatus
  lastCheck: Date
  successRate: number
  avgLatency: number
  totalRequests: number
  failedRequests: number
}

export interface ProxyPoolConfig {
  clashApiUrl: string
  clashApiSecret?: string
  healthCheckInterval: number
  failoverThreshold: number
  preferredRegions: string[]
}

// ============================================
// Scheduler Types
// ============================================

export interface SchedulerConfig {
  maxConcurrency: number
  jobTimeoutMs: number
  retryDelayMs: number
  maxRetries: number
  pollingIntervalMs: number
}

export interface SchedulerState {
  running: boolean
  activeJobs: number
  pendingJobs: number
  completedJobs: number
  failedJobs: number
  startedAt?: Date
}

// ============================================
// Worker Events
// ============================================

export type WorkerEventType = 
  | 'job:started'
  | 'job:completed'
  | 'job:failed'
  | 'job:retry'
  | 'proxy:switched'
  | 'proxy:health-check'
  | 'scheduler:started'
  | 'scheduler:stopped'

export interface WorkerEvent {
  type: WorkerEventType
  timestamp: Date
  payload: unknown
}
