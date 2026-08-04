/**
 * Tests for PipelineLogger (lib/services/pipeline-logger.ts)
 * ~12 tests covering start/success/error/timeout lifecycle, no-op fallback, healthcheck mapping
 */

// Mock dependencies before importing the module under test
const mockSupabaseFrom = jest.fn()
const mockSupabaseRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: mockSupabaseFrom,
    rpc: mockSupabaseRpc,
  }),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
  sendRateLimitedAlert: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/analytics/dual-write', () => ({
  syncPipelineLog: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/utils/healthcheck', () => ({
  pingHealthcheck: jest.fn().mockResolvedValue(undefined),
}))

import { PipelineLogger } from '../pipeline-logger'
import { pingHealthcheck } from '@/lib/utils/healthcheck'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

// ============================================
// Helpers
// ============================================

function mockInsertSuccess(logId: number) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: logId }, error: null }),
  }
  mockSupabaseFrom.mockReturnValue({
    insert: jest.fn().mockReturnValue(chain),
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      }),
    }),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: [], error: null }),
  })
}

function mockInsertFailure() {
  const chain = {
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: { message: 'insert failed' } }),
  }
  mockSupabaseFrom.mockReturnValue({
    insert: jest.fn().mockReturnValue(chain),
  })
}

// ============================================
// Tests
// ============================================

describe('PipelineLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('start', () => {
    it('should insert a running log entry and return a handle with an id', async () => {
      mockInsertSuccess(42)
      const handle = await PipelineLogger.start('batch-5min')
      expect(handle.id).toBe(42)
    })

    it('should ping healthcheck start for monitored jobs', async () => {
      mockInsertSuccess(1)
      await PipelineLogger.start('compute-leaderboard')

      // Wait for async catch
      await new Promise((r) => setTimeout(r, 10))
      expect(pingHealthcheck).toHaveBeenCalledWith('compute-leaderboard', 'start')
    })

    it('should match prefix for source-suffixed jobs', async () => {
      mockInsertSuccess(2)
      await PipelineLogger.start('backfill-avatars-binance')

      await new Promise((r) => setTimeout(r, 10))
      expect(pingHealthcheck).toHaveBeenCalledWith('backfill-avatars', 'start')
    })

    it('should not revive retired pipeline healthchecks', async () => {
      mockInsertSuccess(3)
      await PipelineLogger.start('batch-fetch-traders-a')

      await new Promise((r) => setTimeout(r, 10))
      expect(pingHealthcheck).not.toHaveBeenCalled()
    })

    it('should not ping healthcheck for unmonitored jobs', async () => {
      mockInsertSuccess(4)
      await PipelineLogger.start('some-custom-job-xyz')

      await new Promise((r) => setTimeout(r, 10))
      expect(pingHealthcheck).not.toHaveBeenCalled()
    })

    it('should return a no-op handle when insert fails', async () => {
      mockInsertFailure()
      const handle = await PipelineLogger.start('failing-job')
      expect(handle.id).toBe(-1)

      // No-op handle methods should not throw
      await handle.success(10)
      await handle.error(new Error('test'))
      await handle.partialSuccess(5, ['item1'])
      await handle.timeout()
    })
  })

  describe('handle.success', () => {
    it('should update the log entry with success status', async () => {
      mockInsertSuccess(10)
      const handle = await PipelineLogger.start('test-job')

      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await handle.success(100, { extra: 'data' })
      expect(mockUpdate).toHaveBeenCalled()
      const updateArg = mockUpdate.mock.calls[0][0]
      expect(updateArg.status).toBe('success')
      expect(updateArg.records_processed).toBe(100)
    })
  })

  describe('handle.partialSuccess', () => {
    it('treats a resolved PostgREST error as a failed write and falls back to error', async () => {
      mockInsertSuccess(15)
      const handle = await PipelineLogger.start('test-job')
      const responses = [
        { data: null, error: { message: 'pipeline_logs_status_check violated' } },
        { data: null, error: null },
      ]
      const mockUpdate = jest.fn().mockImplementation(() => ({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(responses.shift()).then(resolve),
        }),
      }))
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await expect(handle.partialSuccess(5, ['binance:timeout'])).resolves.toBeUndefined()

      expect(mockUpdate).toHaveBeenCalledTimes(2)
      expect(mockUpdate.mock.calls[0][0]).toMatchObject({
        status: 'partial_success',
        records_processed: 5,
      })
      expect(mockUpdate.mock.calls[1][0]).toMatchObject({
        status: 'error',
        records_processed: 5,
        metadata: expect.objectContaining({
          intended_status: 'partial_success',
          finalization_fallback: true,
        }),
      })
      expect(mockUpdate.mock.calls[1][0].error_message).toContain(
        'partial_success finalization fallback'
      )
      expect(sendRateLimitedAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'PipelineLogger DB write failed: test-job:partial',
        }),
        'plog-db-write-failure',
        5 * 60 * 1000
      )
    })

    it('does not fall back when the partial_success update succeeds', async () => {
      mockInsertSuccess(16)
      const handle = await PipelineLogger.start('test-job')
      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await handle.partialSuccess(2, ['one'])

      expect(mockUpdate).toHaveBeenCalledTimes(1)
      expect(mockUpdate.mock.calls[0][0].status).toBe('partial_success')
    })

    it('does not reject the business task when both finalization writes fail', async () => {
      mockInsertSuccess(17)
      const handle = await PipelineLogger.start('test-job')
      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'database unavailable' } }).then(
              resolve
            ),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await expect(handle.partialSuccess(0, [])).resolves.toBeUndefined()
      expect(mockUpdate).toHaveBeenCalledTimes(2)
    })
  })

  describe('handle.error', () => {
    it('should update the log entry with error status and message', async () => {
      mockInsertSuccess(11)
      const handle = await PipelineLogger.start('test-job')

      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await handle.error(new Error('something broke'))
      const updateArg = mockUpdate.mock.calls[0][0]
      expect(updateArg.status).toBe('error')
      expect(updateArg.error_message).toBe('something broke')
    })

    it('should handle non-Error error values', async () => {
      mockInsertSuccess(12)
      const handle = await PipelineLogger.start('test-job')

      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await handle.error('string error')
      const updateArg = mockUpdate.mock.calls[0][0]
      expect(updateArg.error_message).toBe('string error')
    })

    it('should truncate long error messages to 2000 chars', async () => {
      mockInsertSuccess(13)
      const handle = await PipelineLogger.start('test-job')

      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      const longMessage = 'x'.repeat(3000)
      await handle.error(new Error(longMessage))
      const updateArg = mockUpdate.mock.calls[0][0]
      expect(updateArg.error_message.length).toBeLessThanOrEqual(2000)
    })
  })

  describe('handle.timeout', () => {
    it('should update the log entry with timeout status', async () => {
      mockInsertSuccess(14)
      const handle = await PipelineLogger.start('test-job')

      const mockUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      })
      mockSupabaseFrom.mockReturnValue({ update: mockUpdate })

      await handle.timeout()
      const updateArg = mockUpdate.mock.calls[0][0]
      expect(updateArg.status).toBe('timeout')
    })
  })

  describe('getJobStatuses', () => {
    it('should call RPC and return results', async () => {
      const mockData = [
        {
          job_name: 'test',
          started_at: '2024-01-01',
          status: 'success',
          records_processed: 10,
          error_message: null,
          health_status: 'healthy',
        },
      ]
      mockSupabaseRpc.mockResolvedValue({ data: mockData, error: null })

      const statuses = await PipelineLogger.getJobStatuses()
      expect(statuses).toEqual(mockData)
      expect(mockSupabaseRpc).toHaveBeenCalledWith('get_pipeline_job_statuses_recent')
    })

    it('should return empty array on RPC error', async () => {
      mockSupabaseRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
      const statuses = await PipelineLogger.getJobStatuses()
      expect(statuses).toEqual([])
    })

    it('passes an abort signal to health aggregation RPCs', async () => {
      const statusAbortSignal = jest.fn().mockResolvedValue({ data: [], error: null })
      const statsAbortSignal = jest.fn().mockResolvedValue({ data: [], error: null })
      mockSupabaseRpc
        .mockReturnValueOnce({ abortSignal: statusAbortSignal })
        .mockReturnValueOnce({ abortSignal: statsAbortSignal })
      const signal = new AbortController().signal

      await PipelineLogger.getJobStatuses(signal)
      await PipelineLogger.getJobStats(signal)

      expect(statusAbortSignal).toHaveBeenCalledWith(signal)
      expect(statsAbortSignal).toHaveBeenCalledWith(signal)
    })

    it('passes an abort signal to the recent failures query', async () => {
      const abortSignal = jest.fn().mockResolvedValue({ data: [], error: null })
      const chain = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        abortSignal,
      }
      mockSupabaseFrom.mockReturnValueOnce(chain)
      const signal = new AbortController().signal

      await PipelineLogger.getRecentFailures(10, 120, signal)

      expect(abortSignal).toHaveBeenCalledWith(signal)
    })

    it('can fail closed when recent failures are a required health authority', async () => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'private database endpoint rejected the query' },
        }),
      }
      mockSupabaseFrom.mockReturnValueOnce(chain)

      await expect(PipelineLogger.getRecentFailures(10, 120, undefined, true)).rejects.toThrow(
        'Pipeline recent-failures authority is unavailable'
      )
    })
  })

  describe('getConsecutiveFailures', () => {
    it('should count consecutive failures from recent logs', async () => {
      const mockData = [
        { status: 'error' },
        { status: 'timeout' },
        { status: 'success' },
        { status: 'error' },
      ]
      mockSupabaseFrom.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: mockData, error: null }),
      })

      const count = await PipelineLogger.getConsecutiveFailures('test-job')
      expect(count).toBe(2) // first 2 are error/timeout, then success breaks the streak
    })

    it('should return 0 when no failures', async () => {
      mockSupabaseFrom.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [{ status: 'success' }], error: null }),
      })

      const count = await PipelineLogger.getConsecutiveFailures('test-job')
      expect(count).toBe(0)
    })
  })
})
