import { PENDING_DELETION_BAN_DURATION } from '../deletion-ban'

describe('PENDING_DELETION_BAN_DURATION', () => {
  it('outlives the 30-day deletion grace period by a wide margin', () => {
    const match = /^(\d+)h$/.exec(PENDING_DELETION_BAN_DURATION)
    expect(match).not.toBeNull()
    const hours = Number(match![1])
    // A purge that is late (or unscheduled) must never reopen sign-in.
    expect(hours).toBeGreaterThan(30 * 24 * 10)
  })
})
