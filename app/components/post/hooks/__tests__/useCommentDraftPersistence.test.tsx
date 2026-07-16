import { useLayoutEffect } from 'react'
import { act, renderHook } from '@testing-library/react'
import { useCommentDraftPersistence } from '../useCommentDraftPersistence'

const draftKey = (postId: string, viewerKey = 'anon') => `comment-draft-v2:${viewerKey}:${postId}`

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
    expect(localStorage.getItem(draftKey('post-a'))).toBeNull()

    rerender({ postId: 'post-b' })

    expect(localStorage.getItem(draftKey('post-a'))).toBe('draft for A')
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

    expect(localStorage.getItem(draftKey('post-a'))).toBe('draft for A')
    expect(localStorage.getItem(draftKey('post-b'))).toBe('draft for B')
  })

  it('flushes a pending draft on unmount', () => {
    const { result, unmount } = renderHook(() => useCommentDraftPersistence('post-a'))

    act(() => result.current.setDraft('survive close'))
    unmount()

    expect(localStorage.getItem(draftKey('post-a'))).toBe('survive close')
  })

  it('cancels a pending write when a submitted draft is cleared', () => {
    const { result } = renderHook(() => useCommentDraftPersistence('post-a'))

    act(() => result.current.setDraft('already submitted'))
    act(() => result.current.clearDraft('post-a'))
    act(() => jest.advanceTimersByTime(500))

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem(draftKey('post-a'))).toBeNull()
  })

  it('can restore a failed submission to its original post without changing the visible post', () => {
    const { result, rerender } = renderHook(
      ({ postId }: { postId: string }) => useCommentDraftPersistence(postId),
      { initialProps: { postId: 'post-a' } }
    )

    rerender({ postId: 'post-b' })
    act(() => result.current.saveDraft('post-a', 'retry A'))

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem(draftKey('post-a'))).toBe('retry A')
  })

  it('isolates the same post draft across anonymous, A, and B viewers', () => {
    const { result, rerender } = renderHook(
      ({ viewerKey }: { viewerKey: string }) => useCommentDraftPersistence('post-a', viewerKey),
      { initialProps: { viewerKey: 'anon' } }
    )

    act(() => result.current.setDraft('anonymous text'))
    rerender({ viewerKey: 'user:a' })
    expect(result.current.draft).toBe('')

    act(() => result.current.setDraft('A text'))
    rerender({ viewerKey: 'user:b' })
    expect(result.current.draft).toBe('')

    rerender({ viewerKey: 'user:a' })
    expect(result.current.draft).toBe('A text')
    expect(localStorage.getItem(draftKey('post-a', 'anon'))).toBe('anonymous text')
    expect(localStorage.getItem(draftKey('post-a', 'user:a'))).toBe('A text')
  })

  it('binds input after a B render but before passive owner handoff to B', () => {
    const { result, rerender } = renderHook(
      ({ viewerKey, layoutDraft }: { viewerKey: string; layoutDraft: string | null }) => {
        const persistence = useCommentDraftPersistence('post-a', viewerKey)
        useLayoutEffect(() => {
          if (layoutDraft !== null) persistence.setDraft(layoutDraft)
        }, [layoutDraft, persistence.setDraft])
        return persistence
      },
      { initialProps: { viewerKey: 'user:a', layoutDraft: null } }
    )

    act(() => result.current.setDraft('A text'))
    rerender({ viewerKey: 'user:b', layoutDraft: 'B typed before passive effect' })
    act(() => jest.advanceTimersByTime(500))

    expect(result.current.draft).toBe('B typed before passive effect')
    expect(localStorage.getItem(draftKey('post-a', 'user:a'))).toBe('A text')
    expect(localStorage.getItem(draftKey('post-a', 'user:b'))).toBe('B typed before passive effect')
  })

  it('does not clear the same text after the visible post changes', () => {
    const { result, rerender } = renderHook(
      ({ postId }: { postId: string }) => useCommentDraftPersistence(postId, 'user:a'),
      { initialProps: { postId: 'post-a' } }
    )

    act(() => result.current.setDraft('same text'))
    const submittedA = result.current.captureDraftSnapshot('post-a')

    rerender({ postId: 'post-b' })
    act(() => result.current.setDraft('same text'))

    expect(result.current.clearDraftIfUnchanged(submittedA)).toBe(false)
    expect(result.current.draft).toBe('same text')
  })

  it('migrates one unowned v1 draft only after the viewer resolves', () => {
    localStorage.setItem('comment-draft-post-a', 'legacy text')
    const { result, rerender } = renderHook(
      ({ viewerKey }: { viewerKey: string }) => useCommentDraftPersistence('post-a', viewerKey),
      { initialProps: { viewerKey: 'pending' } }
    )

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem('comment-draft-post-a')).toBe('legacy text')

    rerender({ viewerKey: 'user:a' })

    expect(result.current.draft).toBe('legacy text')
    expect(localStorage.getItem(draftKey('post-a', 'user:a'))).toBe('legacy text')
    expect(localStorage.getItem('comment-draft-post-a')).toBeNull()
  })
})
