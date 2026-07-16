import { applyViewerOwnedStateAction } from '../viewer-owned-state'
import { act, renderHook } from '@testing-library/react'
import { useViewerOwnedState } from '../viewer-owned-state'
import { StrictMode, createElement, type ReactNode } from 'react'

describe('applyViewerOwnedStateAction', () => {
  it('rejects an A action when its deferred updater executes under B', () => {
    const action = (previous: string[]) => [...previous, 'A payload']

    expect(
      applyViewerOwnedStateAction({
        action,
        previous: ['B state'],
        empty: [],
        ownerScopeKey: 'user:b\u00002',
        invocationScopeKey: 'user:a\u00001',
        currentScopeKey: 'user:b\u00002',
      })
    ).toEqual({ accepted: false, value: ['B state'] })
  })

  it('starts from fail-empty state when the accepted invocation claims a new owner', () => {
    expect(
      applyViewerOwnedStateAction({
        action: (previous: string[]) => [...previous, 'B payload'],
        previous: ['A state'],
        empty: [],
        ownerScopeKey: 'user:a\u00001',
        invocationScopeKey: 'user:b\u00002',
        currentScopeKey: 'user:b\u00002',
      })
    ).toEqual({ accepted: true, value: ['B payload'] })
  })

  it('lets a B async completion claim state after an A-to-B render', async () => {
    const hook = renderHook(
      ({ scopeKey }: { scopeKey: string }) =>
        useViewerOwnedState<string | null>(null, () => null, scopeKey),
      { initialProps: { scopeKey: 'A' } }
    )
    hook.rerender({ scopeKey: 'B' })

    await act(async () => {
      await Promise.resolve()
      hook.result.current[1]('B value')
    })

    expect(hook.result.current[0]).toBe('B value')
  })

  it('keeps a new owner fail-empty when Strict Mode repeats a functional updater', () => {
    const hook = renderHook(
      ({ scopeKey }: { scopeKey: string }) =>
        useViewerOwnedState<string[]>(['A private'], () => [], scopeKey),
      {
        initialProps: { scopeKey: 'A' },
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(StrictMode, null, children),
      }
    )

    hook.rerender({ scopeKey: 'B' })
    act(() => hook.result.current[1]((previous) => [...previous, 'B value']))

    expect(hook.result.current[0]).toEqual(['B value'])
  })
})
