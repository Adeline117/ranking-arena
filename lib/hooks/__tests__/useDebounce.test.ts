import { renderHook, act } from '@testing-library/react'
import { useDebounce } from '../useDebounce'

describe('useDebounce', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('hello', 300))
    expect(result.current).toBe('hello')
  })

  it('debounces value changes', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'hello', delay: 300 } }
    )

    rerender({ value: 'world', delay: 300 })
    expect(result.current).toBe('hello')

    act(() => { jest.advanceTimersByTime(300) })
    expect(result.current).toBe('world')
  })

  it('resets timer on rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'a', delay: 500 } }
    )

    rerender({ value: 'b', delay: 500 })
    act(() => { jest.advanceTimersByTime(200) })
    rerender({ value: 'c', delay: 500 })
    act(() => { jest.advanceTimersByTime(200) })

    // 'b' should NOT have appeared
    expect(result.current).toBe('a')

    act(() => { jest.advanceTimersByTime(300) })
    expect(result.current).toBe('c')
  })
})
