const mockRedisInstance = {
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
}
const mockRedisConstructor = jest.fn(() => mockRedisInstance)
const mockNodeRequire = jest.fn(() => ({ default: mockRedisConstructor }))

jest.mock('node:module', () => ({
  createRequire: () => mockNodeRequire,
}))

// Exercise the historical connection hygiene under an explicit test-only GO.
// V1 production source remains fixed-off.
jest.mock('@/lib/ingest/v1-execution-publication', () => ({
  isV1IngestExecutionPublished: jest.fn(() => true),
  assertV1IngestExecutionPublished: jest.fn(),
}))

// Require only after the mock backing values initialize. Static ESM imports are
// hoisted ahead of those values by Jest and would invoke createRequire too soon.
const { closeConnection, getConnection } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../connection') as typeof import('../../connection')

describe('worker Redis connection logging', () => {
  test('an error event never logs the credential-bearing client message', async () => {
    const originalUrl = process.env.REDIS_URL
    const secretUrl = 'rediss://user:super-secret@redis.example:6379'
    process.env.REDIS_URL = secretUrl
    mockRedisInstance.on.mockClear()
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      getConnection()
      const registration = mockRedisInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'error'
      )
      expect(registration).toBeDefined()
      const listener = registration[1] as (failure: Error) => void
      listener(new Error(`AUTH failed for ${secretUrl}`))

      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith('[worker] Redis connection error')
      const output = error.mock.calls.flat().join(' ')
      expect(output).not.toContain('rediss://')
      expect(output).not.toContain('super-secret')
    } finally {
      await closeConnection()
      error.mockRestore()
      if (originalUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalUrl
    }
  })
})
