import { NotificationPreferenceQueue } from '../notification-preference-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('NotificationPreferenceQueue', () => {
  it('serializes rapid clicks and persists the latest value last', async () => {
    const first = deferred<'saved'>()
    const second = deferred<'saved'>()
    const write = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const setter = jest.fn()
    const persisted = jest.fn()
    const saved = jest.fn()
    const queue = new NotificationPreferenceQueue({
      write,
      onPersisted: persisted,
      onFailed: jest.fn(),
      onSaved: saved,
    })

    const task = queue.enqueue('notify_follow', false, true, setter, { token: 'a' })
    queue.enqueue('notify_follow', true, false, setter, { token: 'b' })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenNthCalledWith(1, 'notify_follow', false, { token: 'a' })
    first.resolve('saved')
    await Promise.resolve()
    expect(write).toHaveBeenNthCalledWith(2, 'notify_follow', true, { token: 'b' })
    second.resolve('saved')
    await task

    expect(persisted.mock.calls).toEqual([
      ['notify_follow', false],
      ['notify_follow', true],
    ])
    expect(saved).toHaveBeenCalledTimes(1)
    expect(setter).not.toHaveBeenCalled()
  })

  it('rolls the UI back to the last confirmed value on failure', async () => {
    const setter = jest.fn()
    const failed = jest.fn()
    const queue = new NotificationPreferenceQueue({
      write: jest.fn().mockResolvedValue('failed'),
      onPersisted: jest.fn(),
      onFailed: failed,
      onSaved: jest.fn(),
    })

    await queue.enqueue('notify_like', false, true, setter, null)

    expect(setter).toHaveBeenCalledWith(true)
    expect(failed).toHaveBeenCalledWith('notify_like')
  })

  it('does not write an obsolete intermediate value again when the latest click restores persistence', async () => {
    const pending = deferred<'failed'>()
    const write = jest.fn().mockReturnValue(pending.promise)
    const setter = jest.fn()
    const failed = jest.fn()
    const queue = new NotificationPreferenceQueue({
      write,
      onPersisted: jest.fn(),
      onFailed: failed,
      onSaved: jest.fn(),
    })

    const task = queue.enqueue('notify_comment', false, true, setter, null)
    queue.enqueue('notify_comment', true, false, setter, null)
    pending.resolve('failed')
    await task

    expect(write).toHaveBeenCalledTimes(1)
    expect(setter).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })

  it('suppresses callbacks from an invalidated viewer', async () => {
    const pending = deferred<'saved'>()
    const setter = jest.fn()
    const persisted = jest.fn()
    const saved = jest.fn()
    const queue = new NotificationPreferenceQueue({
      write: jest.fn().mockReturnValue(pending.promise),
      onPersisted: persisted,
      onFailed: jest.fn(),
      onSaved: saved,
    })

    const task = queue.enqueue('notify_message', false, true, setter, null)
    queue.invalidate()
    pending.resolve('saved')
    await task

    expect(persisted).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(setter).not.toHaveBeenCalled()
  })
})
