import { clearInterval as clearNodeInterval, setInterval as setNodeInterval } from 'node:timers'

import type { RegionConsumerRuntime, RegionConsumerRuntimeState } from '../region-consumer-runtime'
import { startNativeIngestServing } from '../startup-gate'

function nativeStartupHarness() {
  const events: string[] = []
  const authorityAbort = new AbortController()
  let authorityState: 'active' | 'lost' = 'active'
  let runtimeState: RegionConsumerRuntimeState = 'prepared'

  const heartbeatTimer = setNodeInterval(() => undefined, 60_000)
  const reconcileTimer = setNodeInterval(() => undefined, 60_000)
  heartbeatTimer.unref()
  reconcileTimer.unref()
  const clearServingTimer = jest.fn((timer: NodeJS.Timeout) => {
    events.push(`clear:${timer === heartbeatTimer ? 'heartbeat' : 'reconcile'}`)
    clearNodeInterval(timer)
  })
  const startHeartbeat = jest.fn(async () => {
    events.push('heartbeat')
    return heartbeatTimer
  })
  const reconcileSchedulers = jest.fn(async () => {
    events.push('reconcile')
  })
  const startReconcileTimer = jest.fn(() => {
    events.push('timer')
    return reconcileTimer
  })
  const markReady = jest.fn(() => {
    events.push('ready')
  })
  const start = jest.fn(async () => {
    events.push('start')
    runtimeState = 'running'
  })
  const stop = jest.fn(async () => {
    events.push('stop')
    runtimeState = 'stopped'
  })

  const lifecycle = {
    fence: {
      isActive: () => authorityState === 'active' && !authorityAbort.signal.aborted,
      signal: authorityAbort.signal,
    },
    get state() {
      return authorityState
    },
  }
  const runtime = {
    get failure() {
      return undefined
    },
    get state() {
      return runtimeState
    },
    start,
    stop,
  } as RegionConsumerRuntime

  const steps = {
    clearServingTimer,
    lifecycle,
    markReady,
    reconcileSchedulers,
    runtime,
    startHeartbeat,
    startReconcileTimer,
  }

  return {
    clearServingTimer,
    events,
    heartbeatTimer,
    loseAuthority: () => {
      authorityState = 'lost'
      authorityAbort.abort()
    },
    markReady,
    reconcileSchedulers,
    reconcileTimer,
    runtime,
    setRuntimeState: (state: RegionConsumerRuntimeState) => {
      runtimeState = state
    },
    start,
    startHeartbeat,
    startReconcileTimer,
    steps,
    stop,
  }
}

describe('native ingest serving startup boundary', () => {
  it('opens consumers before emitting ready and owns idempotent timer cleanup', async () => {
    const harness = nativeStartupHarness()

    const serving = await startNativeIngestServing(harness.steps)

    expect(harness.events).toEqual(['heartbeat', 'reconcile', 'timer', 'start', 'ready'])
    expect(harness.runtime.state).toBe('running')
    expect(serving.heartbeatTimer).toBe(harness.heartbeatTimer)
    expect(serving.reconcileTimer).toBe(harness.reconcileTimer)

    serving.stopServingTimers()
    serving.stopServingTimers()
    expect(harness.events.slice(-2)).toEqual(['clear:reconcile', 'clear:heartbeat'])
    expect(harness.clearServingTimer).toHaveBeenCalledTimes(2)
    expect(harness.stop).not.toHaveBeenCalled()
  })

  it('rejects an inactive authority before starting any serving prerequisite', async () => {
    const harness = nativeStartupHarness()
    harness.loseAuthority()

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'authority_lost',
    })

    expect(harness.events).toEqual(['stop'])
    expect(harness.stop).toHaveBeenCalledWith('startup_failed')
  })

  it('rejects a runtime that is not prepared before starting any serving prerequisite', async () => {
    const harness = nativeStartupHarness()
    harness.setRuntimeState('running')

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'invalid_runtime',
    })

    expect(harness.events).toEqual(['stop'])
    expect(harness.startHeartbeat).not.toHaveBeenCalled()
    expect(harness.stop).toHaveBeenCalledWith('startup_failed')
  })

  it('rolls back without leaking secrets when the first heartbeat fails', async () => {
    const harness = nativeStartupHarness()
    const secret = 'rediss://operator-secret@example.invalid'
    harness.startHeartbeat.mockImplementationOnce(async () => {
      harness.events.push('heartbeat')
      throw new Error(secret)
    })

    let failure: unknown
    try {
      await startNativeIngestServing(harness.steps)
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'startup_failed' })
    expect((failure as Error).message).not.toContain(secret)
    expect(harness.events).toEqual(['heartbeat', 'stop'])
    expect(harness.reconcileSchedulers).not.toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.markReady).not.toHaveBeenCalled()
  })

  it('clears heartbeat and rolls back when initial reconciliation fails', async () => {
    const harness = nativeStartupHarness()
    harness.reconcileSchedulers.mockImplementationOnce(async () => {
      harness.events.push('reconcile')
      throw new Error('postgres://operator-secret')
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'startup_failed',
    })

    expect(harness.events).toEqual(['heartbeat', 'reconcile', 'clear:heartbeat', 'stop'])
    expect(harness.startReconcileTimer).not.toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.markReady).not.toHaveBeenCalled()
  })

  it('clears heartbeat when reconcile timer creation fails', async () => {
    const harness = nativeStartupHarness()
    harness.startReconcileTimer.mockImplementationOnce(() => {
      harness.events.push('timer')
      throw new Error('timer secret')
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'startup_failed',
    })

    expect(harness.events).toEqual(['heartbeat', 'reconcile', 'timer', 'clear:heartbeat', 'stop'])
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.markReady).not.toHaveBeenCalled()
  })

  it('clears every started timer when consumer startup fails', async () => {
    const harness = nativeStartupHarness()
    harness.start.mockImplementationOnce(async () => {
      harness.events.push('start')
      throw new Error('consumer failure with secret')
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'startup_failed',
    })

    expect(harness.events).toEqual([
      'heartbeat',
      'reconcile',
      'timer',
      'start',
      'clear:reconcile',
      'clear:heartbeat',
      'stop',
    ])
    expect(harness.markReady).not.toHaveBeenCalled()
  })

  it('detects authority loss after an asynchronous prerequisite', async () => {
    const harness = nativeStartupHarness()
    harness.reconcileSchedulers.mockImplementationOnce(async () => {
      harness.events.push('reconcile')
      harness.loseAuthority()
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'authority_lost',
    })

    expect(harness.events).toEqual(['heartbeat', 'reconcile', 'clear:heartbeat', 'stop'])
    expect(harness.startReconcileTimer).not.toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.markReady).not.toHaveBeenCalled()
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('ready secret')
      },
      'startup_failed',
    ],
    ['returns a promise', () => Promise.reject(new Error('late ready secret')), 'invalid_runtime'],
  ])('rolls back a ready callback that %s', async (_label, readyCallback, expectedCode) => {
    const harness = nativeStartupHarness()
    harness.markReady.mockImplementationOnce(() => {
      harness.events.push('ready')
      return readyCallback()
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: expectedCode,
    })

    expect(harness.events).toEqual([
      'heartbeat',
      'reconcile',
      'timer',
      'start',
      'ready',
      'clear:reconcile',
      'clear:heartbeat',
      'stop',
    ])
  })

  it('surfaces a sanitized rollback failure without masking cleanup attempts', async () => {
    const harness = nativeStartupHarness()
    harness.reconcileSchedulers.mockRejectedValueOnce(new Error('primary secret'))
    harness.stop.mockRejectedValueOnce(new Error('rollback secret'))

    let failure: unknown
    try {
      await startNativeIngestServing(harness.steps)
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'rollback_failed' })
    expect((failure as Error).message).not.toMatch(/primary secret|rollback secret/)
    expect(harness.clearServingTimer).toHaveBeenCalledWith(harness.heartbeatTimer)
    expect(harness.stop).toHaveBeenCalledWith('startup_failed')
  })

  it('attempts every rollback action when one timer cleanup throws', async () => {
    const harness = nativeStartupHarness()
    harness.start.mockRejectedValueOnce(new Error('startup secret'))
    harness.clearServingTimer.mockImplementation((timer: NodeJS.Timeout) => {
      harness.events.push(`clear:${timer === harness.heartbeatTimer ? 'heartbeat' : 'reconcile'}`)
      if (timer === harness.reconcileTimer) throw new Error('timer cleanup secret')
      clearNodeInterval(timer)
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'rollback_failed',
    })

    expect(harness.clearServingTimer).toHaveBeenCalledTimes(2)
    expect(harness.stop).toHaveBeenCalledWith('startup_failed')
  })

  it('rejects a runtime that resolves start without entering running state', async () => {
    const harness = nativeStartupHarness()
    harness.start.mockImplementationOnce(async () => {
      harness.events.push('start')
      harness.setRuntimeState('starting')
    })

    await expect(startNativeIngestServing(harness.steps)).rejects.toMatchObject({
      code: 'invalid_runtime',
    })
    expect(harness.markReady).not.toHaveBeenCalled()
    expect(harness.stop).toHaveBeenCalledWith('startup_failed')
  })
})
