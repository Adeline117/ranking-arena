/**
 * Pipeline Checkpoint — resume from failure point instead of restarting entire batch.
 *
 * Based on Anthropic's harness design: "checkpoint-resume for context, not compute."
 * Each batch-fetch or batch-enrich run creates a checkpoint. On crash/timeout,
 * the next run detects the incomplete checkpoint and resumes from where it left off.
 *
 * Storage: `pipeline_state` table (same as dead counters, offset rotation).
 * Key format: `checkpoint:{jobType}:{group}` → CheckpointData
 */

import { PipelineState } from '@/lib/services/pipeline-state'
import { logger } from '@/lib/logger'
import { randomUUID } from 'crypto'

// ── Types ────────────────────────────────────────────────────────

export interface CheckpointData {
  trace_id: string
  job_type: 'fetch' | 'enrich'
  group: string
  started_at: string
  last_checkpoint_at: string
  completed_platforms: string[]
  failed_platforms: Array<{ platform: string; error: string }>
  current_platform: string | null
  records_processed: number
  /** For enrichment: current offset per platform:period */
  offsets?: Record<string, number>
}

export interface TraceMetadata {
  trace_id: string
  source: string
  platforms_updated: string[]
  records_written: number
  duration_ms: number
  failed_platforms: string[]
}

// ── Checkpoint Manager ───────────────────────────────────────────

const CHECKPOINT_PREFIX = 'checkpoint:'
/** Max age before a checkpoint is considered abandoned (e.g., function crashed) */
const CHECKPOINT_MAX_AGE_MS = 20 * 60 * 1000 // 20 min (Vercel max is 300s, but add buffer for retries)

export class PipelineCheckpoint {
  /**
   * Start or resume a checkpoint for a job.
   * If an incomplete checkpoint exists (from a prior crash), resume it.
   * Otherwise, create a fresh one.
   */
  static async startOrResume(jobType: 'fetch' | 'enrich', group: string): Promise<CheckpointData> {
    const key = `${CHECKPOINT_PREFIX}${jobType}:${group}`
    const existing = await PipelineState.get<CheckpointData>(key)

    if (existing && existing.current_platform !== null) {
      // Incomplete checkpoint found — check if it's stale
      const age = Date.now() - new Date(existing.last_checkpoint_at).getTime()
      if (age < CHECKPOINT_MAX_AGE_MS) {
        logger.info(
          `[checkpoint] Resuming ${jobType}:${group} (trace=${existing.trace_id}, ` +
          `completed=${existing.completed_platforms.length}, age=${Math.round(age / 1000)}s)`
        )
        // Mark current_platform as failed (it was in-progress when crash happened)
        if (existing.current_platform) {
          existing.failed_platforms.push({
            platform: existing.current_platform,
            error: 'Interrupted: previous run did not complete',
          })
          existing.current_platform = null
          await PipelineState.set(key, existing)
        }
        return existing
      }
      // Stale checkpoint — log and create fresh
      logger.warn(
        `[checkpoint] Discarding stale checkpoint for ${jobType}:${group} ` +
        `(age=${Math.round(age / 60000)}min, trace=${existing.trace_id})`
      )
    }

    // Create fresh checkpoint
    const checkpoint: CheckpointData = {
      trace_id: randomUUID(),
      job_type: jobType,
      group,
      started_at: new Date().toISOString(),
      last_checkpoint_at: new Date().toISOString(),
      completed_platforms: [],
      failed_platforms: [],
      current_platform: null,
      records_processed: 0,
    }

    await PipelineState.set(key, checkpoint)
    logger.info(`[checkpoint] Created new checkpoint for ${jobType}:${group} (trace=${checkpoint.trace_id})`)
    return checkpoint
  }

  /**
   * Mark a platform as "in progress" — saved before starting execution.
   * If the function crashes, the next run will see this and skip/retry.
   */
  static async markInProgress(checkpoint: CheckpointData, platform: string): Promise<void> {
    const key = `${CHECKPOINT_PREFIX}${checkpoint.job_type}:${checkpoint.group}`
    checkpoint.current_platform = platform
    checkpoint.last_checkpoint_at = new Date().toISOString()
    await PipelineState.set(key, checkpoint)
  }

  /**
   * Mark a platform as completed successfully.
   */
  static async markCompleted(
    checkpoint: CheckpointData,
    platform: string,
    recordCount: number
  ): Promise<void> {
    const key = `${CHECKPOINT_PREFIX}${checkpoint.job_type}:${checkpoint.group}`
    checkpoint.completed_platforms.push(platform)
    checkpoint.current_platform = null
    checkpoint.records_processed += recordCount
    checkpoint.last_checkpoint_at = new Date().toISOString()
    await PipelineState.set(key, checkpoint)
  }

  /**
   * Mark a platform as failed (non-fatal — continue with next platform).
   */
  static async markFailed(
    checkpoint: CheckpointData,
    platform: string,
    error: string
  ): Promise<void> {
    const key = `${CHECKPOINT_PREFIX}${checkpoint.job_type}:${checkpoint.group}`
    checkpoint.failed_platforms.push({ platform, error })
    checkpoint.current_platform = null
    checkpoint.last_checkpoint_at = new Date().toISOString()
    await PipelineState.set(key, checkpoint)
  }

  /**
   * Finalize: mark the checkpoint as done (delete it).
   * Returns TraceMetadata for downstream handoff.
   */
  static async finalize(checkpoint: CheckpointData, totalDurationMs: number): Promise<TraceMetadata> {
    const key = `${CHECKPOINT_PREFIX}${checkpoint.job_type}:${checkpoint.group}`

    const metadata: TraceMetadata = {
      trace_id: checkpoint.trace_id,
      source: `${checkpoint.job_type}-${checkpoint.group}`,
      platforms_updated: checkpoint.completed_platforms,
      records_written: checkpoint.records_processed,
      duration_ms: totalDurationMs,
      failed_platforms: checkpoint.failed_platforms.map(f => f.platform),
    }

    // Delete checkpoint (job completed, no need to resume)
    await PipelineState.del(key)
    logger.info(
      `[checkpoint] Finalized ${checkpoint.job_type}:${checkpoint.group} ` +
      `(trace=${checkpoint.trace_id}, platforms=${checkpoint.completed_platforms.length}/${
        checkpoint.completed_platforms.length + checkpoint.failed_platforms.length
      }, records=${checkpoint.records_processed}, duration=${totalDurationMs}ms)`
    )

    return metadata
  }

  /**
   * Check if a platform was already completed in this checkpoint.
   * Used to skip platforms on resume.
   */
  static isCompleted(checkpoint: CheckpointData, platform: string): boolean {
    return checkpoint.completed_platforms.includes(platform)
  }

  /**
   * Get all active (incomplete) checkpoints — useful for monitoring.
   */
  static async getActiveCheckpoints(): Promise<CheckpointData[]> {
    const entries = await PipelineState.getByPrefix(CHECKPOINT_PREFIX)
    return entries
      .map(e => e.value as CheckpointData)
      .filter(c => c.current_platform !== null || c.completed_platforms.length > 0)
  }
}
