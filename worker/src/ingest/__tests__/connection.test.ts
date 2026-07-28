jest.mock('ioredis', () => {
  const instance = {
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  }
  const constructor = jest.fn(() => instance)
  return {
    __esModule: true,
    default: constructor,
    __mocks: { constructor, instance },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mocks } = require('ioredis')

import { closeConnection, getConnection } from '../../connection'

describe('worker Redis connection logging', () => {
  test('an error event never logs the credential-bearing client message', async () => {
    const originalUrl = process.env.REDIS_URL
    const secretUrl = 'rediss://user:super-secret@redis.example:6379'
    process.env.REDIS_URL = secretUrl
    __mocks.instance.on.mockClear()
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      getConnection()
      const registration = __mocks.instance.on.mock.calls.find(
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
