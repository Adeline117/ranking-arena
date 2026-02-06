/**
 * Worker Scheduler
 * Manages job scheduling and execution with parallel workers
 * Features:
 * - Configurable concurrency
 * - Priority queue
 * - Automatic retries
 * - Platform-specific rate limiting
 */

import { EventEmitter } from 'events'
import type {
  Job,
  JobResult,
  JobStatus,
  SchedulerConfig,
  SchedulerState,
  PlatformConfig,
} from '../types.js'
import { ProxyPoolManager, proxyPool } from '../proxy-pool/index.js'

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrency: 4,
  jobTimeoutMs: 120000, // 2 minutes
  retryDelayMs: 5000,
  maxRetries: 3,
  pollingIntervalMs: 1000,
}

type JobExecutor = (job: Job) => Promise<JobResult>

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
  private startedAt?: Date

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
      console.log('[Scheduler] Already running')
      return
    }

    console.log('[Scheduler] Starting scheduler...')
    this.running = true
    this.startedAt = new Date()

    // Initialize proxy pool
    await this.proxyPool.initialize()

    // Start processing loop
    this.processTimer = setInterval(
      () => this.processQueue(),
      this.config.pollingIntervalMs
    )

    this.emit('scheduler:started', { timestamp: this.startedAt })
    console.log('[Scheduler] Scheduler started')
  }

  async stop(): Promise<void> {
    if (!this.running) return

    console.log('[Scheduler] Stopping scheduler...')
    this.running = false

    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }

    // Wait for active jobs to complete (with timeout)
    const waitStart = Date.now()
    while (this.activeJobs.size > 0 && Date.now() - waitStart < 30000) {
      await new Promise((r) => setTimeout(r, 500))
    }

    await this.proxyPool.shutdown()
    this.emit('scheduler:stopped', { timestamp: new Date() })
    console.log('[Scheduler] Scheduler stopped')
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

    console.log(`[Scheduler] Enqueued job ${newJob.id} for ${newJob.platform} (priority: ${newJob.priority})`)
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

  // ============================================
  // Queue Processing
  // ============================================

  private async processQueue(): Promise<void> {
    if (!this.running) return
    if (!this.executor) {
      console.warn('[Scheduler] No executor set, skipping queue processing')
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
        console.error(`[Scheduler] Unexpected error executing job ${job.id}:`, err)
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
    console.log(`[Scheduler] Starting job ${job.id} for ${job.platform}`)

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(job)
      
      job.status = 'completed'
      job.completedAt = new Date()
      job.result = result

      this.activeJobs.delete(job.id)
      this.completedJobs.set(job.id, job)

      // Record success for proxy
      if (job.proxyId) {
        this.proxyPool.recordRequest(job.proxyId, true)
      }

      this.emit('job:completed', { job, result })
      console.log(
        `[Scheduler] Job ${job.id} completed in ${result.duration}ms - ` +
          `${Object.values(result.periods).reduce((a, p) => a + p.saved, 0)} records saved`
      )
    } catch (err) {
      // Record failure for proxy
      if (job.proxyId) {
        this.proxyPool.recordRequest(job.proxyId, false)
      }

      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Scheduler] Job ${job.id} failed: ${errorMsg}`)

      // Check if we should retry
      if (job.retryCount < job.maxRetries) {
        job.retryCount++
        job.status = 'pending'
        job.error = errorMsg

        // Re-enqueue with delay
        setTimeout(() => {
          if (this.running) {
            const insertIndex = this.findInsertIndex(job)
            this.jobQueue.splice(insertIndex, 0, job)
            this.emit('job:retry', { job, attempt: job.retryCount })
            console.log(
              `[Scheduler] Retrying job ${job.id} (attempt ${job.retryCount}/${job.maxRetries})`
            )
          }
        }, this.config.retryDelayMs * job.retryCount)

        this.activeJobs.delete(job.id)
      } else {
        job.status = 'failed'
        job.completedAt = new Date()
        job.error = errorMsg

        this.activeJobs.delete(job.id)
        this.failedJobs.set(job.id, job)

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
