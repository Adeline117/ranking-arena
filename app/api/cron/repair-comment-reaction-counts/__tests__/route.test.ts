/** @jest-environment node */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'

const mockRepairCommentReactionCounts = jest.fn()
const mockSupabase = { rpc: jest.fn() }

jest.mock('@/lib/api/with-cron', () => ({
  withCron: jest.fn(
    (
      _jobName: string,
      handler: (
        request: NextRequest,
        context: { supabase: typeof mockSupabase }
      ) => Promise<Record<string, unknown>>
    ) =>
      async (request: NextRequest) => {
        try {
          return Response.json({
            ok: true,
            ...(await handler(request, { supabase: mockSupabase })),
          })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 500 }
          )
        }
      }
  ),
}))

jest.mock('@/lib/cron/inline-jobs', () => ({
  repairCommentReactionCountsInline: (...args: unknown[]) =>
    mockRepairCommentReactionCounts(...args),
}))

import { GET, dynamic, maxDuration, runtime } from '../route'
import { withCron } from '@/lib/api/with-cron'

const mockWithCron = withCron as jest.Mock

describe('comment reaction count repair cron', () => {
  beforeEach(() => {
    mockRepairCommentReactionCounts.mockReset()
    mockSupabase.rpc.mockReset()
    mockRepairCommentReactionCounts.mockResolvedValue({
      name: 'repair-comment-reaction-counts',
      status: 'success',
      durationMs: 8,
      detail: {
        rpcCalls: 2,
        selectedCount: 2,
        processedCount: 2,
        repairedCount: 2,
        discardedCount: 0,
        contendedCount: 0,
        hasMore: false,
        remainingCount: 0,
        oldestEnqueuedAt: null,
        oldestAgeMs: null,
        stopReason: 'no-due-work',
      },
    })
  })

  it('uses the bounded cron contract and returns strict repair telemetry', async () => {
    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/repair-comment-reaction-counts')
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      count: 2,
      result: {
        name: 'repair-comment-reaction-counts',
        status: 'success',
        durationMs: 8,
        detail: {
          rpcCalls: 2,
          selectedCount: 2,
          processedCount: 2,
          repairedCount: 2,
          discardedCount: 0,
          contendedCount: 0,
          hasMore: false,
          remainingCount: 0,
          oldestEnqueuedAt: null,
          oldestAgeMs: null,
          stopReason: 'no-due-work',
        },
      },
    })
    expect({ runtime, dynamic, maxDuration }).toEqual({
      runtime: 'nodejs',
      dynamic: 'force-dynamic',
      maxDuration: 90,
    })
    expect(mockWithCron).toHaveBeenCalledWith(
      'repair-comment-reaction-counts',
      expect.any(Function),
      { safetyTimeoutMs: 85_000 }
    )
    expect(mockRepairCommentReactionCounts).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('returns non-2xx when the inline worker fails closed', async () => {
    mockRepairCommentReactionCounts.mockResolvedValue({
      name: 'repair-comment-reaction-counts',
      status: 'error',
      durationMs: 4,
      detail: { backlogExceeded: true, remainingCount: 1_001 },
      error: 'comment reaction repair backlog unhealthy: remaining_count 1001 exceeds 1000',
    })

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/repair-comment-reaction-counts')
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'comment reaction repair backlog unhealthy: remaining_count 1001 exceeds 1000',
    })
  })

  it('fails closed when successful worker telemetry lacks an exact processed count', async () => {
    mockRepairCommentReactionCounts.mockResolvedValue({
      name: 'repair-comment-reaction-counts',
      status: 'success',
      durationMs: 4,
      detail: { processedCount: '2' },
    })

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/repair-comment-reaction-counts')
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'comment reaction count repair returned invalid telemetry',
    })
  })

  it('is scheduled every five minutes and registered in both monitoring authorities', () => {
    const root = process.cwd()
    const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    const pipelineLogger = readFileSync(path.join(root, 'lib/services/pipeline-logger.ts'), 'utf8')
    const metaMonitor = readFileSync(path.join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')

    expect(config.crons).toContainEqual({
      path: '/api/cron/repair-comment-reaction-counts',
      schedule: '*/5 * * * *',
    })
    expect(pipelineLogger).toContain("'repair-comment-reaction-counts',")
    expect(metaMonitor).toContain("'repair-comment-reaction-counts': 10,")
  })
})
