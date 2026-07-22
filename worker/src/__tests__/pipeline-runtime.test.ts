import { PIPELINE_WORKER_CONCURRENCY } from '../pipeline-runtime'

describe('pipeline worker runtime', () => {
  it('serializes overdue score seasons after an offline interval', () => {
    expect(PIPELINE_WORKER_CONCURRENCY).toBe(1)
  })
})
