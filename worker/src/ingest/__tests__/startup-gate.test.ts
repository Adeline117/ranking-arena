import { startHeartbeat } from '../heartbeat'
import { startIngestServingAfterHeartbeat } from '../startup-gate'

describe('ingest serving startup boundary', () => {
  test('a rejected first HSET starts no consumer, scheduler, failover, or ready log', async () => {
    const originalCapture = process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = 'true'
    const secretUrl = 'rediss://user:super-secret@redis.example'
    const hset = jest.fn().mockRejectedValue(new Error(secretUrl))
    const createConsumers = jest.fn()
    const reconcileSchedulers = jest.fn()
    const startReconcileTimer = jest.fn()
    const startFailover = jest.fn()
    const markReady = jest.fn(() => console.log('[ingest-worker] ready'))
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    let failure: unknown
    let emittedServingLog = false
    try {
      await startIngestServingAfterHeartbeat({
        startHeartbeat: () => startHeartbeat({ hset } as never, ['vps_sg']),
        createConsumers,
        reconcileSchedulers,
        startReconcileTimer,
        startFailover,
        markReady,
      })
    } catch (error) {
      failure = error
    } finally {
      emittedServingLog = log.mock.calls.some(([line]) =>
        /redis-hset-committed|\[ingest-worker\] ready/.test(String(line))
      )
      log.mockRestore()
      if (originalCapture === undefined) {
        delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
      } else {
        process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = originalCapture
      }
    }

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toBe('[heartbeat] Redis HSET failed')
    expect(message).not.toContain('rediss://')
    expect(message).not.toContain('super-secret')
    expect(hset).toHaveBeenCalledTimes(1)
    expect(createConsumers).not.toHaveBeenCalled()
    expect(reconcileSchedulers).not.toHaveBeenCalled()
    expect(startReconcileTimer).not.toHaveBeenCalled()
    expect(startFailover).not.toHaveBeenCalled()
    expect(markReady).not.toHaveBeenCalled()
    expect(emittedServingLog).toBe(false)
  })
})
