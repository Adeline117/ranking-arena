import { act, renderHook } from '@testing-library/react'
import { useViewerSlotState } from '../use-viewer-slot-state'

describe('useViewerSlotState', () => {
  it('keeps a late old-viewer setter out of the current viewer slot', () => {
    const hook = renderHook(
      ({ ownerKey }: { ownerKey: string }) => useViewerSlotState(ownerKey, [] as string[]),
      { initialProps: { ownerKey: 'user:a:1' } }
    )

    const setViewerA = hook.result.current[1]
    act(() => setViewerA(['a-ready']))
    expect(hook.result.current[0]).toEqual(['a-ready'])

    hook.rerender({ ownerKey: 'user:b:2' })
    const setViewerB = hook.result.current[1]
    expect(hook.result.current[0]).toEqual([])
    act(() => setViewerB(['b-ready']))
    expect(hook.result.current[0]).toEqual(['b-ready'])

    act(() => setViewerA((previous) => [...previous, 'late-a']))
    expect(hook.result.current[0]).toEqual(['b-ready'])

    hook.rerender({ ownerKey: 'user:a:1' })
    expect(hook.result.current[0]).toEqual(['a-ready', 'late-a'])
  })

  it('treats a new generation for the same actor as a separate slot', () => {
    const hook = renderHook(
      ({ ownerKey }: { ownerKey: string }) => useViewerSlotState(ownerKey, false),
      { initialProps: { ownerKey: 'user:a:4' } }
    )
    const setGenerationFour = hook.result.current[1]

    act(() => setGenerationFour(true))
    hook.rerender({ ownerKey: 'user:a:5' })
    expect(hook.result.current[0]).toBe(false)
    const setGenerationFive = hook.result.current[1]
    act(() => setGenerationFive(true))

    act(() => setGenerationFour(false))
    expect(hook.result.current[0]).toBe(true)
  })

  it('keeps the setter stable until ownership changes', () => {
    const hook = renderHook(
      ({ ownerKey }: { ownerKey: string }) => useViewerSlotState(ownerKey, [] as string[]),
      { initialProps: { ownerKey: 'user:a:1' } }
    )
    const firstSetter = hook.result.current[1]

    hook.rerender({ ownerKey: 'user:a:1' })
    expect(hook.result.current[1]).toBe(firstSetter)

    hook.rerender({ ownerKey: 'user:b:2' })
    expect(hook.result.current[1]).not.toBe(firstSetter)
  })

  it('uses the old owner initial after eviction instead of the current owner initial', () => {
    const hook = renderHook(
      ({ initialValue, ownerKey }: { initialValue: string[]; ownerKey: string }) =>
        useViewerSlotState(ownerKey, initialValue),
      { initialProps: { ownerKey: 'owner:a', initialValue: ['a-default'] } }
    )
    const setOwnerA = hook.result.current[1]

    for (const ownerKey of [
      'owner:b',
      'owner:c',
      'owner:d',
      'owner:e',
      'owner:f',
      'owner:g',
      'owner:h',
      'owner:i',
    ]) {
      hook.rerender({ ownerKey, initialValue: [`${ownerKey}-default`] })
      act(() => hook.result.current[1]([`${ownerKey}-ready`]))
    }

    act(() => setOwnerA((previous) => [...previous, 'late-a']))
    hook.rerender({ ownerKey: 'owner:a', initialValue: ['new-a-default'] })

    expect(hook.result.current[0]).toEqual(['a-default', 'late-a'])
  })
})
