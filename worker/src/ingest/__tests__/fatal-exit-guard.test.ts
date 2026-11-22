import { createFatalExitGuard, FATAL_EXIT_DEADLINE_MS } from '../fatal-exit-guard'

function harness() {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const exit = jest.fn()
  const log = jest.fn()
  const guard = createFatalExitGuard({
    exit,
    log,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  })
  return { guard, scheduled, exit, log }
}

describe('fatal exit guard', () => {
  it('does nothing until a fatal shutdown is reported', () => {
    const { guard, scheduled, exit } = harness()
    expect(guard.armed).toBe(false)
    expect(scheduled).toHaveLength(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits non-zero when the process outlives the deadline after a fatal shutdown', () => {
    const { guard, scheduled, exit, log } = harness()
    guard.arm('authority_lost')

    expect(guard.armed).toBe(true)
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([FATAL_EXIT_DEADLINE_MS])
    // Cleanup still has the whole deadline: nothing exits before it elapses.
    expect(exit).not.toHaveBeenCalled()

    scheduled[0].callback()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('authority_lost'))
  })

  it('starts one countdown however many fatal codes follow', () => {
    const { guard, scheduled } = harness()
    guard.arm('authority_lost')
    guard.arm('regional_stop_failed')
    guard.arm('redis_close_failed')
    expect(scheduled).toHaveLength(1)
  })

  it('with its own timer, exits at the deadline and not before', () => {
    jest.useFakeTimers()
    try {
      const exit = jest.fn()
      createFatalExitGuard({ exit, deadlineMs: 1_000 }).arm('consumer_failed')
      jest.advanceTimersByTime(999)
      expect(exit).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
