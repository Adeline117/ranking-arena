jest.mock('pg', () => {
  const Pool = jest.fn(() => ({ on: jest.fn(), end: jest.fn() }))
  return {
    Pool,
    types: {
      builtins: { NUMERIC: 1700, INT8: 20 },
      setTypeParser: jest.fn(),
    },
  }
})

import { Pool } from 'pg'

import {
  getIngestPool,
  INGEST_DB_KEEPALIVE_INITIAL_DELAY_MS,
  INGEST_DB_LOCK_TIMEOUT_MS,
  INGEST_DB_QUERY_TIMEOUT_MS,
  INGEST_DB_STATEMENT_TIMEOUT_MS,
} from '../db'

const mockPool = jest.mocked(Pool)

describe('ingest database deadlines', () => {
  const previousUrl = process.env.INGEST_DATABASE_URL

  beforeAll(() => {
    process.env.INGEST_DATABASE_URL = 'postgresql://localhost:5432/arena'
  })

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.INGEST_DATABASE_URL
    else process.env.INGEST_DATABASE_URL = previousUrl
  })

  it('bounds server work and silent client reads on every pooled connection', () => {
    getIngestPool()

    expect(mockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        statement_timeout: INGEST_DB_STATEMENT_TIMEOUT_MS,
        query_timeout: INGEST_DB_QUERY_TIMEOUT_MS,
        lock_timeout: INGEST_DB_LOCK_TIMEOUT_MS,
        keepAlive: true,
        keepAliveInitialDelayMillis: INGEST_DB_KEEPALIVE_INITIAL_DELAY_MS,
      })
    )
    expect(INGEST_DB_STATEMENT_TIMEOUT_MS).toBeLessThan(INGEST_DB_QUERY_TIMEOUT_MS)
    expect(INGEST_DB_QUERY_TIMEOUT_MS).toBe(5 * 60_000)
  })
})
