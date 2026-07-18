import { findStuckCronJobs } from './meta-monitor-policy'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')
const MINUTE_MS = 60_000

describe('findStuckCronJobs', () => {
  it('alerts only after twice the expected interval, not at the exact boundary', () => {
    const expected = { 'check-data-freshness': 180 }

    expect(
      findStuckCronJobs(
        [
          {
            job_name: 'check-data-freshness',
            status: 'success',
            started_at: new Date(NOW - 360 * MINUTE_MS).toISOString(),
          },
        ],
        expected,
        NOW
      )
    ).toEqual([])

    expect(
      findStuckCronJobs(
        [
          {
            job_name: 'check-data-freshness',
            status: 'success',
            started_at: new Date(NOW - 360 * MINUTE_MS - 1).toISOString(),
          },
        ],
        expected,
        NOW
      )
    ).toEqual([
      expect.objectContaining({
        job: 'check-data-freshness',
        expectedMinutes: 180,
      }),
    ])
  })

  it('fails closed when no valid success timestamp exists', () => {
    const stuck = findStuckCronJobs(
      [
        {
          job_name: 'check-data-freshness',
          status: 'success',
          started_at: 'not-a-timestamp',
        },
        {
          job_name: 'check-data-freshness',
          status: 'error',
          started_at: new Date(NOW).toISOString(),
        },
      ],
      { 'check-data-freshness': 180 },
      NOW
    )

    expect(stuck).toEqual([
      {
        job: 'check-data-freshness',
        lastSuccess: 'never',
        expectedMinutes: 180,
        actualMinutes: -1,
      },
    ])
  })

  it('accepts only the bounded five-minute future clock skew', () => {
    const expected = { 'check-data-freshness': 180 }

    expect(
      findStuckCronJobs(
        [
          {
            job_name: 'check-data-freshness',
            status: 'success',
            started_at: new Date(NOW + 5 * MINUTE_MS).toISOString(),
          },
        ],
        expected,
        NOW
      )
    ).toEqual([])

    expect(
      findStuckCronJobs(
        [
          {
            job_name: 'check-data-freshness',
            status: 'success',
            started_at: new Date(NOW + 5 * MINUTE_MS + 1).toISOString(),
          },
        ],
        expected,
        NOW
      )
    ).toEqual([
      {
        job: 'check-data-freshness',
        lastSuccess: 'never',
        expectedMinutes: 180,
        actualMinutes: -1,
      },
    ])
  })

  it('uses the newest successful member of a prefixed job group', () => {
    const stuck = findStuckCronJobs(
      [
        {
          job_name: 'batch-fetch-traders-a',
          status: 'success',
          started_at: new Date(NOW - 800 * MINUTE_MS).toISOString(),
        },
        {
          job_name: 'batch-fetch-traders-b',
          status: 'partial_success',
          started_at: new Date(NOW - 100 * MINUTE_MS).toISOString(),
        },
      ],
      { 'batch-fetch-traders': 360 },
      NOW
    )

    expect(stuck).toEqual([])
  })
})
