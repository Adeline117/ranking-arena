import { act, renderHook } from '@testing-library/react'
import { useCommentDraftPersistence } from '../useCommentDraftPersistence'

describe('useCommentDraftPersistence', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('flushes the old post before switching and restores an empty target without leaking text', () => {
    const { result, rerender } = renderHook(
      ({ postId }: { postId: string }) => useCommentDraftPersistence(postId),
      { initialProps: { postId: 'post-a' } }
    )

    act(() => result.current.setDraft('draft for A'))
    expect(localStorage.getItem('comment-draft-post-a')).toBeNull()

    rerender({ postId: 'post-b' })

    expect(localStorage.getItem('comment-draft-post-a')).toBe('draft for A')
    expect(result.current.draft).toBe('')
  })

  it('keeps each post draft intact when users type again before 500ms', () => {
    const { result, rerender } = renderHook(
      ({ postId }: { postId: string }) => useCommentDraftPersistence(postId),
      { initialProps: { postId: 'post-a' } }
    )

    act(() => result.current.setDraft('draft for A'))
    rerender({ postId: 'post-b' })
    act(() => result.current.setDraft('draft for B'))

    act(() => jest.advanceTimersByTime(500))

    expect(localStorage.getItem('comment-draft-post-a')).toBe('draft for A')
    expect(localStorage.getItem('comment-draft-post-b')).toBe('draft for B')
  })

  it('flushes a pending draft on unmount', () => {
    const { result, unmount } = renderHook(() => useCommentDraftPersistence('post-a'))

    act(() => result.current.setDraft('survive close'))
    unmount()

    expect(localStorage.getItem('comment-draft-post-a')).toBe('survive close')
  })

  it('cancels a pending write when a submitted draft is cleared', () => {
    const { result } = renderHook(() => useCommentDraftPersistence('post-a'))

    act(() => result.current.setDraft('already submitted'))
    act(() => result.current.clearDraft('post-a'))
    act(() => jest.advanceTimersByTime(500))

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem('comment-draft-post-a')).toBeNull()
  })

  it('can restore a failed submission to its original post without changing the visible post', () => {
    const { result, rerender } = renderHook(
      ({ postId }: { postId: string }) => useCommentDraftPersistence(postId),
      { initialProps: { postId: 'post-a' } }
    )

    rerender({ postId: 'post-b' })
    act(() => result.current.saveDraft('post-a', 'retry A'))

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem('comment-draft-post-a')).toBe('retry A')
  })
})
