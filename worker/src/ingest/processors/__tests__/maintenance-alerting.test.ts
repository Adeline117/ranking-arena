/**
 * @jest-environment node
 */
import type { Job } from 'bullmq'

const alertMock = jest.fn()
const ensurePartitionsMock = jest.fn()
const okStep = jest.fn(async () => 0)

jest.mock('../../../connection', () => ({ getConnection: () => ({}) }))
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: async () => ({ rowCount: 0 }) }),
}))
jest.mock('@/lib/ingest/raw', () => ({ cleanupRawObjects: () => okStep() }))
jest.mock('@/lib/ingest/raw-retention', () => ({ runRawRetention: () => okStep() }))
jest.mock('@/lib/ingest/serving/series', () => ({
  ensurePartitions: () => ensurePartitionsMock(),
  downsampleOldSeries: () => okStep(),
  downsampleSnapshotEntries: () => okStep(),
  pruneLeaderboardSnapshots: () => okStep(),
  pruneLongTailHistories: () => okStep(),
}))
jest.mock('@/lib/ingest/alerting', () => ({
  alert: (...args: unknown[]) => alertMock(...args),
}))

import { processMaintenance } from '../maintenance'

const job = {} as Job

beforeEach(() => {
  alertMock.mockReset().mockResolvedValue(undefined)
  ensurePartitionsMock.mockReset()
  okStep.mockClear()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

describe('maintenance alerting', () => {
  it('pages when partition maintenance fails and still runs the other steps', async () => {
    ensurePartitionsMock.mockRejectedValue(new Error('no month partition'))
    const report = await processMaintenance(job)
    expect(report.partitions).toBe('ERROR: no month partition')
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock.mock.calls[0][1]).toMatchObject({ tier: 'maint', page: true })
    expect(okStep).toHaveBeenCalledTimes(6)
  })

  it('keeps other step failures in the digest only', async () => {
    ensurePartitionsMock.mockResolvedValue(0)
    okStep.mockRejectedValueOnce(new Error('raw cleanup down'))
    await processMaintenance(job)
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock.mock.calls[0][1]).toMatchObject({ page: false })
  })

  it('fails the job after the remaining steps when the page reached no channel', async () => {
    ensurePartitionsMock.mockRejectedValue(new Error('no month partition'))
    const undelivered = new Error('page not delivered')
    alertMock.mockRejectedValueOnce(undelivered)
    await expect(processMaintenance(job)).rejects.toBe(undelivered)
    expect(okStep).toHaveBeenCalledTimes(6)
  })
})
