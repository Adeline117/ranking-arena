/**
 * Worker Scheduler
 * Manages job scheduling and execution with parallel workers
 * Features:
 * - Configurable concurrency
 * - Priority queue
 * - Automatic retries
 * - Platform-specific rate limiting
 * - Memory-safe job history (automatic cleanup)
 */

import { EventEmitter } from 'events'
import { logger } from '../logger.js'
import type {
  Job,
  JobResult,
  JobStatus,
  SchedulerConfig,
  SchedulerState,
  PlatformConfig,
} from '../types.js'
import { ProxyPoolManager, proxyPool } from '../proxy-pool/index.js'

// ============================================
// Configuration
// ============================================

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrency: 4,
  jobTimeoutMs: 120000, // 2 minutes
  retryDelayMs: 5000,
  maxRetries: 3,
  pollingIntervalMs: 1000,
}

// Memory management configuration
const MEMORY_CONFIG = {
  maxCompletedJobs: 100,    // Keep last 100 completed jobs
  maxFailedJobs: 50,        // Keep last 50 failed jobs
  cleanupInterval: 60000,   // Run cleanup every 60 seconds
  cleanupThreshold: 10,     // Trigger cleanup when exceeding limit by this amount
}

type JobExecutor = (job: Job) => Promise<JobResult>

// ============================================
// Scheduler Stats
// ============================================

interface SchedulerStats {
  totalJobsProcessed: number
  totalJobsFailed: number
  totalRetries: number
  averageJobDuration: number
  memoryUsage: {
    completedJobs: number
    failedJobs: number
    activeJobs: number
    queuedJobs: number
  }
  uptime: number
}

// ============================================
// Scheduler Class
// ============================================

export class Scheduler extends EventEmitter {
  private config: SchedulerConfig
  private proxyPool: ProxyPoolManager
  private executor: JobExecutor | null = null

  private jobQueue: Job[] = []
  private activeJobs: Map<string, Job> = new Map()
  private completedJobs: Map<string, Job> = new Map()
  private failedJobs: Map<string, Job> = new Map()

  private running = false
  private processTimer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private startedAt?: Date

  // Statistics tracking
  private stats = {
    totalJobsProcessed: 0,
    totalJobsFailed: 0,
    totalRetries: 0,
    totalDuration: 0,
  }

  constructor(config?: Partial<SchedulerConfig>, proxyPoolInstance?: ProxyPoolManager) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.proxyPool = proxyPoolInstance || proxyPool
  }

  // ============================================
  // Lifecycle
  // ============================================

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.info('[Scheduler] Already running')
      return
    }

    logger.info('[Scheduler] Starting scheduler...')
    this.running = true
    this.startedAt = new Date()

    // Initialize proxy pool
    await this.proxyPool.initialize()

    // Start processing loop
    this.processTimer = setInterval(
      () => this.processQueue(),
      this.config.pollingIntervalMs
    )

    // Start cleanup timer for memory management
    this.cleanupTimer = setInterval(
      () => this.cleanupJobMaps(),
      MEMORY_CONFIG.cleanupInterval
    )

    this.emit('scheduler:started', { timestamp: this.startedAt })
    logger.info('[Scheduler] Scheduler started')
  }

  async stop(): Promise<void> {
    if (!this.running) return

    logger.info('[Scheduler] Stopping scheduler...')
    this.running = false

    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Wait for active jobs to complete (with timeout)
    const waitStart = Date.now()
    while (this.activeJobs.size > 0 && Date.now() - waitStart < 30000) {
      await new Promise((r) => setTimeout(r, 500))
    }

    await this.proxyPool.shutdown()
    this.emit('scheduler:stopped', { timestamp: new Date() })
    logger.info('[Scheduler] Scheduler stopped')
  }

  getState(): SchedulerState {
    return {
      running: this.running,
      activeJobs: this.activeJobs.size,
      pendingJobs: this.jobQueue.length,
      completedJobs: this.completedJobs.size,
      failedJobs: this.failedJobs.size,
      startedAt: this.startedAt,
    }
  }

  /**
   * Get detailed scheduler statistics
   */
  getStats(): SchedulerStats {
    const avgDuration = this.stats.totalJobsProcessed > 0
      ? this.stats.totalDuration / this.stats.totalJobsProcessed
      : 0

    return {
      totalJobsProcessed: this.stats.totalJobsProcessed,
      totalJobsFailed: this.stats.totalJobsFailed,
      totalRetries: this.stats.totalRetries,
      averageJobDuration: Math.round(avgDuration),
      memoryUsage: {
        completedJobs: this.completedJobs.size,
        failedJobs: this.failedJobs.size,
        activeJobs: this.activeJobs.size,
        queuedJobs: this.jobQueue.length,
      },
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
    }
  }

  // ============================================
  // Memory Management
  // ============================================

  /**
   * Clean up old completed and failed jobs to prevent memory leaks
   * Keeps the most recent jobs based on completedAt timestamp
   */
  private cleanupJobMaps(): void {
    const completedSize = this.completedJobs.size
    const failedSize = this.failedJobs.size

    // Clean up completed jobs if exceeding threshold
    if (completedSize > MEMORY_CONFIG.maxCompletedJobs + MEMORY_CONFIG.cleanupThreshold) {
      this.pruneJobMap(
        this.completedJobs,
        MEMORY_CONFIG.maxCompletedJobs,
        'completed'
      )
    }

    // Clean up failed jobs if exceeding threshold
    if (failedSize > MEMORY_CONFIG.maxFailedJobs + MEMORY_CONFIG.cleanupThreshold) {
      this.pruneJobMap(
        this.failedJobs,
        MEMORY_CONFIG.maxFailedJobs,
        'failed'
      )
    }
  }

  /**
   * Prune a job map to keep only the most recent N entries
   */
  private pruneJobMap(
    jobMap: Map<string, Job>,
    maxSize: number,
    type: 'completed' | 'failed'
  ): void {
    const entries = Array.from(jobMap.entries())

    // Sort by completedAt (newest first)
    entries.sort((a, b) => {
      const timeA = a[1].completedAt?.getTime() || 0
      const timeB = b[1].completedAt?.getTime() || 0
      return timeB - timeA
    })

    // Remove old entries
    const toRemove = entries.slice(maxSize)
    for (const [id] of toRemove) {
      jobMap.delete(id)
    }

    if (toRemove.length > 0) {
      logger.info(
        `[Scheduler] Cleaned up ${toRemove.length} old ${type} jobs ` +
        `(kept ${jobMap.size}/${maxSize})`
      )
    }
  }

  /**
   * Force cleanup of all job history (for manual memory management)
   */
  clearHistory(): void {
    const completedCount = this.completedJobs.size
    const failedCount = this.failedJobs.size

    this.completedJobs.clear()
    this.failedJobs.clear()

    logger.info(
      `[Scheduler] Cleared job history: ${completedCount} completed, ${failedCount} failed`
    )
  }

  // ============================================
  // Job Management
  // ============================================

  enqueue(job: Omit<Job, 'id' | 'createdAt' | 'status' | 'retryCount'>): Job {
    const newJob: Job = {
      ...job,
      id: this.generateJobId(),
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
      maxRetries: job.maxRetries ?? this.config.maxRetries,
    }

    // Insert by priority
    const insertIndex = this.findInsertIndex(newJob)
    this.jobQueue.splice(insertIndex, 0, newJob)

    logger.info(`[Scheduler] Enqueued job ${newJob.id} for ${newJob.platform} (priority: ${newJob.priority})`)
    return newJob
  }

  enqueuePlatform(platformConfig: PlatformConfig): Job {
    return this.enqueue({
      platform: platformConfig.id,
      periods: platformConfig.periods,
      priority: 'normal',
      maxRetries: platformConfig.maxRetries,
    })
  }

  enqueueBatch(platforms: PlatformConfig[]): Job[] {
    return platforms.map((p) => this.enqueuePlatform(p))
  }

  getJob(jobId: string): Job | undefined {
    // Check all job stores
    return (
      this.activeJobs.get(jobId) ||
      this.completedJobs.get(jobId) ||
      this.failedJobs.get(jobId) ||
      this.jobQueue.find((j) => j.id === jobId)
    )
  }

  getQueuedJobs(): Job[] {
    return [...this.jobQueue]
  }

  getActiveJobs(): Job[] {
    return Array.from(this.activeJobs.values())
  }

  getRecentCompletedJobs(limit: number = 10): Job[] {
    return Array.from(this.completedJobs.values())
      .sort((a, b) => {
        const timeA = a.completedAt?.getTime() || 0
        const timeB = b.completedAt?.getTime() || 0
        return timeB - timeA
      })
      .slice(0, limit)
  }

  getRecentFailedJobs(limit: number = 10): Job[] {
    return Array.from(this.failedJobs.values())
      .sort((a, b) => {
        const timeA = a.completedAt?.getTime() || 0
        const timeB = b.completedAt?.getTime() || 0
        return timeB - timeA
      })
      .slice(0, limit)
  }

  // ============================================
  // Queue Processing
  // ============================================

  private async processQueue(): Promise<void> {
    if (!this.running) return
    if (!this.executor) {
      logger.warn('[Scheduler] No executor set, skipping queue processing')
      return
    }

    // Check if we can start more jobs
    while (
      this.activeJobs.size < this.config.maxConcurrency &&
      this.jobQueue.length > 0
    ) {
      const job = this.jobQueue.shift()
      if (!job) break

      // Start job execution (don't await - run in parallel)
      this.executeJob(job).catch((err) => {
        logger.error(`[Scheduler] Unexpected error executing job ${job.id}`, err instanceof Error ? err : new Error(String(err)))
      })
    }
  }

  private async executeJob(job: Job): Promise<void> {
    if (!this.executor) return

    job.status = 'running'
    job.startedAt = new Date()
    this.activeJobs.set(job.id, job)

    // Assign proxy if needed
    const proxy = await this.proxyPool.selectBestProxy()
    if (proxy) {
      job.proxyId = proxy.id
      await this.proxyPool.switchProxy(proxy.id)
    }

    this.emit('job:started', { job })
    logger.info(`[Scheduler] Starting job ${job.id} for ${job.platform}`)

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(job)

      job.status = 'completed'
      job.completedAt = new Date()
      job.result = result

      this.activeJobs.delete(job.id)
      this.completedJobs.set(job.id, job)

      // Update stats
      this.stats.totalJobsProcessed++
      this.stats.totalDuration += result.duration

      // Record success for proxy
      if (job.proxyId) {
        this.proxyPool.recordRequest(job.proxyId, true)
      }

      this.emit('job:completed', { job, result })
      logger.info(
        `[Scheduler] Job ${job.id} completed in ${result.duration}ms - ` +
          `${Object.values(result.periods).reduce((a, p) => a + p.saved, 0)} records saved`
      )

      // Check if cleanup is needed (every 10 completed jobs)
      if (this.stats.totalJobsProcessed % 10 === 0) {
        this.cleanupJobMaps()
      }
    } catch (err) {
      // Record failure for proxy
      if (job.proxyId) {
        this.proxyPool.recordRequest(job.proxyId, false)
      }

      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[Scheduler] Job ${job.id} failed: ${errorMsg}`, err instanceof Error ? err : new Error(String(err)))

      // Check if we should retry
      if (job.retryCount < job.maxRetries) {
        job.retryCount++
        job.status = 'pending'
        job.error = errorMsg

        // Update retry stats
        this.stats.totalRetries++

        // Calculate retry delay with exponential backoff and jitter
        // This prevents thundering herd when multiple jobs fail simultaneously
        const baseDelay = this.config.retryDelayMs * Math.pow(2, job.retryCount - 1)
        const jitter = Math.random() * baseDelay * 0.3 // 30% jitter
        const retryDelay = Math.min(baseDelay + jitter, 60000) // Max 60 seconds

        // Re-enqueue with delay
        setTimeout(() => {
          if (this.running) {
            const insertIndex = this.findInsertIndex(job)
            this.jobQueue.splice(insertIndex, 0, job)
            this.emit('job:retry', { job, attempt: job.retryCount })
            logger.info(
              `[Scheduler] Retrying job ${job.id} (attempt ${job.retryCount}/${job.maxRetries}) in ${Math.round(retryDelay)}ms`
            )
          }
        }, retryDelay)

        this.activeJobs.delete(job.id)
      } else {
        job.status = 'failed'
        job.completedAt = new Date()
        job.error = errorMsg

        this.activeJobs.delete(job.id)
        this.failedJobs.set(job.id, job)

        // Update failure stats
        this.stats.totalJobsFailed++

        this.emit('job:failed', { job, error: errorMsg })
      }
    }
  }

  private async executeWithTimeout(job: Job): Promise<JobResult> {
    if (!this.executor) {
      throw new Error('No executor set')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Job timed out after ${this.config.jobTimeoutMs}ms`))
      }, this.config.jobTimeoutMs)

      this.executor!(job)
        .then((result) => {
          clearTimeout(timeout)
          resolve(result)
        })
        .catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
    })
  }

  // ============================================
  // Helpers
  // ============================================

  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private findInsertIndex(job: Job): number {
    const priorityOrder = { high: 0, normal: 1, low: 2 }
    const jobPriority = priorityOrder[job.priority]

    for (let i = 0; i < this.jobQueue.length; i++) {
      const queuedPriority = priorityOrder[this.jobQueue[i].priority]
      if (jobPriority < queuedPriority) {
        return i
      }
    }

    return this.jobQueue.length
  }
}

export const scheduler = new Scheduler()
