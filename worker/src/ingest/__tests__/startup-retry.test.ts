import { isTransientDependencyError, retryTransientStartup } from '../startup-retry'

describe('ingest startup retry', () => {
  it('recognizes transient dependency failures without hiding schema errors', () => {
    expect(
      isTransientDependencyError(
        new Error('scheduler initialization failed', {
          cause: new Error('Connection terminated unexpectedly'),
        })
      )
    ).toBe(true)
    expect(
      isTransientDependencyError(
        new Error(
          '(ECIRCUITBREAKER) failed to retrieve database credentials; new connections are temporarily blocked'
        )
      )
    ).toBe(true)
    expect(
      isTransientDependencyError(
        new Error('(EAUTHQUERY) authentication query failed: connection to database not available')
      )
    ).toBe(true)
    expect(isTransientDependencyError(new Error('column arena.sources.foo does not exist'))).toBe(
      false
    )
  })

  it('retries transient failures with capped exponential delays', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('HTTP 522'))
      .mockResolvedValue('ready')
    const sleep = jest.fn().mockResolvedValue(undefined)

    await expect(
      retryTransientStartup(operation, { baseDelayMs: 10, maxDelayMs: 15, sleep })
    ).resolves.toBe('ready')
    expect(sleep).toHaveBeenNthCalledWith(1, 10)
    expect(sleep).toHaveBeenNthCalledWith(2, 15)
  })

  it('fails immediately for configuration and schema errors', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined)
    const error = new Error('relation arena.sources does not exist')

    await expect(retryTransientStartup(async () => Promise.reject(error), { sleep })).rejects.toBe(
      error
    )
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops retrying when startup is aborted', async () => {
    const controller = new AbortController()
    const sleep = jest.fn(async () => controller.abort(new Error('shutdown requested')))

    await expect(
      retryTransientStartup(async () => Promise.reject(new Error('ETIMEDOUT')), {
        signal: controller.signal,
        sleep,
      })
    ).rejects.toThrow('shutdown requested')
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
