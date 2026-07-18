import { act, renderHook } from '@testing-library/react'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

import { useActiveSection } from '../useActiveSection'

describe('useActiveSection', () => {
  const scrollIntoView = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockSearchParams = new URLSearchParams()
    jest.spyOn(document, 'getElementById').mockImplementation(
      () =>
        ({
          offsetTop: 0,
          scrollIntoView,
        }) as unknown as HTMLElement
    )
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('restores a valid section deep link and scrolls it into view', () => {
    mockSearchParams = new URLSearchParams('section=privacy')

    const { result } = renderHook(() => useActiveSection())

    expect(result.current.activeSection).toBe('privacy')
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('updates the canonical URL when a navigation control selects a section', () => {
    mockSearchParams = new URLSearchParams('source=profile')
    const { result } = renderHook(() => useActiveSection())

    act(() => {
      result.current.scrollToSection('security')
    })

    expect(result.current.activeSection).toBe('security')
    expect(mockReplace).toHaveBeenCalledWith('/settings?source=profile&section=security', {
      scroll: false,
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('does not add a duplicate history update for the current section', () => {
    mockSearchParams = new URLSearchParams('section=wallet')
    const { result } = renderHook(() => useActiveSection())

    act(() => {
      result.current.scrollToSection('wallet')
    })

    expect(mockReplace).not.toHaveBeenCalled()
  })
})
