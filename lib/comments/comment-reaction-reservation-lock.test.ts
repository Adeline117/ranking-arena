import { withCommentReactionReservationLock } from './comment-reaction-reservation-lock'

const SCOPE = {
  actorId: '11111111-1111-4111-8111-111111111111',
  postId: '22222222-2222-4222-8222-222222222222',
  commentId: '33333333-3333-4333-8333-333333333333',
}

describe('withCommentReactionReservationLock', () => {
  const originalLocks = navigator.locks

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: originalLocks,
    })
  })

  it('falls back to the server reservation order when Web Locks is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const reserve = jest.fn().mockResolvedValue('ticket')

    await expect(
      withCommentReactionReservationLock(SCOPE, new AbortController().signal, reserve)
    ).resolves.toBe('ticket')

    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('holds one actor/post/comment exclusive lock for the complete reserve callback', async () => {
    const request = jest.fn(
      async (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>
      ) => callback({ name, mode: 'exclusive' })
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    const controller = new AbortController()
    const reserve = jest.fn().mockResolvedValue({ sequence: '7' })

    await expect(
      withCommentReactionReservationLock(SCOPE, controller.signal, reserve)
    ).resolves.toEqual({ sequence: '7' })

    expect(request).toHaveBeenCalledWith(
      `ranking-arena-comment-reaction-reserve-v1:${SCOPE.actorId}:${SCOPE.postId}:${SCOPE.commentId}`,
      { mode: 'exclusive', signal: controller.signal },
      expect.any(Function)
    )
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('does not reserve after the queued operation is aborted', async () => {
    const request = jest.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>
      ) => callback(null)
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    const controller = new AbortController()
    controller.abort(new Error('viewer changed'))
    const reserve = jest.fn().mockResolvedValue('ticket')

    await expect(
      withCommentReactionReservationLock(SCOPE, controller.signal, reserve)
    ).rejects.toThrow('viewer changed')
    expect(reserve).not.toHaveBeenCalled()
  })
})
