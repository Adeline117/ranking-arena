import { LatestWriteQueue } from '../latest-write-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('LatestWriteQueue', () => {
  it('serializes string preferences and persists only the latest intent last', async () => {
    const first = deferred<'saved'>()
    const second = deferred<'saved'>()
    const write = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const setter = jest.fn()
    const persisted = jest.fn()
    const queue = new LatestWriteQueue({
      write,
      onPersisted: persisted,
      onFailed: jest.fn(),
      onSaved: jest.fn(),
    })

    const task = queue.enqueue('email_digest', 'daily', 'none', setter, { token: 'a' })
    queue.enqueue('email_digest', 'weekly', 'daily', setter, { token: 'b' })

    first.resolve('saved')
    await Promise.resolve()
    second.resolve('saved')
    await task

    expect(write.mock.calls).toEqual([
      ['email_digest', 'daily', { token: 'a' }],
      ['email_digest', 'weekly', { token: 'b' }],
    ])
    expect(persisted.mock.calls).toEqual([
      ['email_digest', 'daily'],
      ['email_digest', 'weekly'],
    ])
    expect(setter).not.toHaveBeenCalled()
  })

  it('rolls back to the last server-confirmed string value', async () => {
    const setter = jest.fn()
    const failed = jest.fn()
    const queue = new LatestWriteQueue({
      write: jest.fn().mockResolvedValue('failed'),
      onPersisted: jest.fn(),
      onFailed: failed,
      onSaved: jest.fn(),
    })

    await queue.enqueue('email_digest', 'weekly', 'none', setter, null)

    expect(setter).toHaveBeenCalledWith('none')
    expect(failed).toHaveBeenCalledWith('email_digest')
  })

  it('suppresses stale completion callbacks after a viewer invalidation', async () => {
    const pending = deferred<'saved'>()
    const setter = jest.fn()
    const persisted = jest.fn()
    const saved = jest.fn()
    const queue = new LatestWriteQueue({
      write: jest.fn().mockReturnValue(pending.promise),
      onPersisted: persisted,
      onFailed: jest.fn(),
      onSaved: saved,
    })

    const task = queue.enqueue('email_digest', 'daily', 'none', setter, null)
    queue.invalidate()
    pending.resolve('saved')
    await task

    expect(persisted).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(setter).not.toHaveBeenCalled()
  })

  it('drains an intent enqueued synchronously from a saved callback', async () => {
    const write = jest.fn().mockResolvedValue('saved')
    const setter = jest.fn()
    let queue!: LatestWriteQueue<string, string, null>
    const saved = jest.fn(() => {
      if (write.mock.calls.length === 1) {
        void queue.enqueue('email_digest', 'weekly', 'daily', setter, null)
      }
    })
    queue = new LatestWriteQueue({
      write,
      onPersisted: jest.fn(),
      onFailed: jest.fn(),
      onSaved: saved,
    })

    await queue.enqueue('email_digest', 'daily', 'none', setter, null)

    expect(write.mock.calls).toEqual([
      ['email_digest', 'daily', null],
      ['email_digest', 'weekly', null],
    ])
    expect(saved).toHaveBeenCalledTimes(2)
  })

  it('drains a recovery intent enqueued synchronously from a failed callback', async () => {
    const write = jest.fn().mockResolvedValueOnce('failed').mockResolvedValueOnce('saved')
    const setter = jest.fn()
    let queue!: LatestWriteQueue<string, string, null>
    queue = new LatestWriteQueue({
      write,
      onPersisted: jest.fn(),
      onFailed: () => {
        void queue.enqueue('email_digest', 'weekly', 'none', setter, null)
      },
      onSaved: jest.fn(),
    })

    await queue.enqueue('email_digest', 'daily', 'none', setter, null)

    expect(write.mock.calls).toEqual([
      ['email_digest', 'daily', null],
      ['email_digest', 'weekly', null],
    ])
    expect(setter).toHaveBeenCalledWith('none')
  })
})
