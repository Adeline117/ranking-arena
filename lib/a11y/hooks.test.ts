/**
 * Accessibility Hooks Tests
 * 测试可访问性 React Hooks
 */

import { renderHook, act } from '@testing-library/react'
import {
  useAccessibleDescription,
  useFocusTrap,
  useAriaLive,
  useSkipLink,
  useFocusVisible,
  useExpandable,
  useTabs,
  useLoadingState,
  getFocusableElements,
  isFocusable,
  generateAriaId,
} from './hooks'

// Mock functions
const mockFocus = jest.fn()
const mockScrollIntoView = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('useAccessibleDescription', () => {
  test('should return describedBy and descriptionProps', () => {
    const { result } = renderHook(() =>
      useAccessibleDescription({ description: 'Test description' })
    )

    expect(result.current.describedBy['aria-describedby']).toBeDefined()
    expect(result.current.descriptionProps.id).toBeDefined()
    expect(result.current.descriptionProps.children).toBe('Test description')
    expect(result.current.descriptionProps.style).toEqual({ display: 'none' })
  })

  test('should use provided id', () => {
    const { result } = renderHook(() =>
      useAccessibleDescription({ description: 'Test', id: 'custom-id' })
    )

    expect(result.current.describedBy['aria-describedby']).toBe('custom-id')
    expect(result.current.descriptionProps.id).toBe('custom-id')
  })

  test('should generate unique id when not provided', () => {
    const { result: result1 } = renderHook(() =>
      useAccessibleDescription({ description: 'Test 1' })
    )
    const { result: result2 } = renderHook(() =>
      useAccessibleDescription({ description: 'Test 2' })
    )

    expect(result1.current.describedBy['aria-describedby']).not.toBe(
      result2.current.describedBy['aria-describedby']
    )
  })
})

describe('useFocusTrap', () => {
  test('should return a ref', () => {
    const { result } = renderHook(() => useFocusTrap({ enabled: false }))
    expect(result.current).toHaveProperty('current')
  })

  test('should respect enabled option', () => {
    const { result } = renderHook(() => useFocusTrap({ enabled: false }))
    expect(result.current.current).toBeNull()
  })
})

describe('useAriaLive', () => {
  test('should return announce function and props', () => {
    const { result } = renderHook(() => useAriaLive())

    expect(typeof result.current.announce).toBe('function')
    expect(result.current.announcerProps).toBeDefined()
    expect(result.current.announcerProps.role).toBe('status')
    expect(result.current.announcerProps['aria-live']).toBe('polite')
  })

  test('should set message on announce', () => {
    const { result } = renderHook(() => useAriaLive())

    act(() => {
      result.current.announce('Test announcement')
    })

    // Message is cleared first, then set after timeout
    expect(result.current.message).toBe('')

    act(() => {
      jest.advanceTimersByTime(100)
    })

    expect(result.current.message).toBe('Test announcement')
  })

  test('should use assertive when specified', () => {
    const { result } = renderHook(() => useAriaLive({ ariaLive: 'assertive' }))
    expect(result.current.announcerProps['aria-live']).toBe('assertive')
  })

  test('should set aria-atomic correctly', () => {
    const { result } = renderHook(() => useAriaLive({ atomic: false }))
    expect(result.current.announcerProps['aria-atomic']).toBe(false)
  })

  test('announcer props should have correct styling for screen readers', () => {
    const { result } = renderHook(() => useAriaLive())
    const style = result.current.announcerProps.style

    expect(style.position).toBe('absolute')
    expect(style.width).toBe(1)
    expect(style.height).toBe(1)
    expect(style.overflow).toBe('hidden')
  })
})

describe('useSkipLink', () => {
  test('should return onClick, onKeyDown, and href', () => {
    const { result } = renderHook(() => useSkipLink())

    expect(typeof result.current.onClick).toBe('function')
    expect(typeof result.current.onKeyDown).toBe('function')
    expect(result.current.href).toBe('#main-content')
  })

  test('should use custom target id', () => {
    const { result } = renderHook(() => useSkipLink('custom-target'))
    expect(result.current.href).toBe('#custom-target')
  })

  test('onClick should try to focus target element', () => {
    const mockElement = {
      tabIndex: 0,
      focus: mockFocus,
      scrollIntoView: mockScrollIntoView,
    }
    jest.spyOn(document, 'getElementById').mockReturnValue(mockElement as any)

    const { result } = renderHook(() => useSkipLink('test-target'))

    act(() => {
      result.current.onClick({
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent)
    })

    expect(document.getElementById).toHaveBeenCalledWith('test-target')
    expect(mockFocus).toHaveBeenCalled()
    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  test('onKeyDown should trigger on Enter', () => {
    const mockElement = {
      tabIndex: 0,
      focus: mockFocus,
      scrollIntoView: mockScrollIntoView,
    }
    jest.spyOn(document, 'getElementById').mockReturnValue(mockElement as any)

    const { result } = renderHook(() => useSkipLink())

    act(() => {
      result.current.onKeyDown({
        key: 'Enter',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent)
    })

    expect(mockFocus).toHaveBeenCalled()
  })

  test('onKeyDown should trigger on Space', () => {
    const mockElement = {
      tabIndex: 0,
      focus: mockFocus,
      scrollIntoView: mockScrollIntoView,
    }
    jest.spyOn(document, 'getElementById').mockReturnValue(mockElement as any)

    const { result } = renderHook(() => useSkipLink())

    act(() => {
      result.current.onKeyDown({
        key: ' ',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent)
    })

    expect(mockFocus).toHaveBeenCalled()
  })
})

describe('useFocusVisible', () => {
  test('should return focusVisible state and focusProps', () => {
    const { result } = renderHook(() => useFocusVisible())

    expect(typeof result.current.focusVisible).toBe('boolean')
    expect(result.current.focusVisible).toBe(false)
    expect(result.current.focusProps).toBeDefined()
    expect(typeof result.current.focusProps.onFocus).toBe('function')
    expect(typeof result.current.focusProps.onBlur).toBe('function')
  })
})

describe('useExpandable', () => {
  test('should start collapsed by default', () => {
    const { result } = renderHook(() => useExpandable())

    expect(result.current.expanded).toBe(false)
  })

  test('should start expanded when defaultExpanded is true', () => {
    const { result } = renderHook(() => useExpandable(true))

    expect(result.current.expanded).toBe(true)
  })

  test('should toggle expanded state', () => {
    const { result } = renderHook(() => useExpandable())

    expect(result.current.expanded).toBe(false)

    act(() => {
      result.current.toggle()
    })

    expect(result.current.expanded).toBe(true)

    act(() => {
      result.current.toggle()
    })

    expect(result.current.expanded).toBe(false)
  })

  test('should return correct trigger props', () => {
    const { result } = renderHook(() => useExpandable())

    expect(result.current.triggerProps['aria-expanded']).toBe(false)
    expect(result.current.triggerProps['aria-controls']).toBeDefined()
    expect(typeof result.current.triggerProps.onClick).toBe('function')
    expect(typeof result.current.triggerProps.onKeyDown).toBe('function')
  })

  test('should return correct content props', () => {
    const { result } = renderHook(() => useExpandable())

    expect(result.current.contentProps.id).toBeDefined()
    expect(result.current.contentProps.role).toBe('region')
    expect(result.current.contentProps.hidden).toBe(true)
    expect(result.current.contentProps['aria-hidden']).toBe(true)
  })

  test('trigger and content ids should match', () => {
    const { result } = renderHook(() => useExpandable())

    expect(result.current.triggerProps['aria-controls']).toBe(
      result.current.contentProps.id
    )
  })

  test('onKeyDown should toggle on Enter', () => {
    const { result } = renderHook(() => useExpandable())

    act(() => {
      result.current.triggerProps.onKeyDown({
        key: 'Enter',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent)
    })

    expect(result.current.expanded).toBe(true)
  })

  test('onKeyDown should toggle on Space', () => {
    const { result } = renderHook(() => useExpandable())

    act(() => {
      result.current.triggerProps.onKeyDown({
        key: ' ',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent)
    })

    expect(result.current.expanded).toBe(true)
  })

  test('setExpanded should set state directly', () => {
    const { result } = renderHook(() => useExpandable())

    act(() => {
      result.current.setExpanded(true)
    })

    expect(result.current.expanded).toBe(true)
  })
})

describe('useTabs', () => {
  const tabs = ['tab1', 'tab2', 'tab3'] as const

  test('should initialize with first tab', () => {
    const { result } = renderHook(() => useTabs([...tabs]))

    expect(result.current.activeTab).toBe('tab1')
  })

  test('should initialize with default tab', () => {
    const { result } = renderHook(() => useTabs([...tabs], 'tab2'))

    expect(result.current.activeTab).toBe('tab2')
  })

  test('should change tab on setActiveTab', () => {
    const { result } = renderHook(() => useTabs([...tabs]))

    act(() => {
      result.current.setActiveTab('tab3')
    })

    expect(result.current.activeTab).toBe('tab3')
  })

  test('getTabListProps should return correct props', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabListProps()

    expect(props.role).toBe('tablist')
    expect(props['aria-orientation']).toBe('horizontal')
  })

  test('getTabProps should return correct props for active tab', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabProps('tab1')

    expect(props.role).toBe('tab')
    expect(props.id).toBe('tab-tab1')
    expect(props['aria-selected']).toBe(true)
    expect(props['aria-controls']).toBe('tabpanel-tab1')
    expect(props.tabIndex).toBe(0)
  })

  test('getTabProps should return correct props for inactive tab', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabProps('tab2')

    expect(props['aria-selected']).toBe(false)
    expect(props.tabIndex).toBe(-1)
  })

  test('getTabPanelProps should return correct props', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabPanelProps('tab1')

    expect(props.role).toBe('tabpanel')
    expect(props.id).toBe('tabpanel-tab1')
    expect(props['aria-labelledby']).toBe('tab-tab1')
    expect(props.hidden).toBe(false)
  })

  test('getTabPanelProps should hide inactive panel', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabPanelProps('tab2')

    expect(props.hidden).toBe(true)
  })

  test('tab onClick should change active tab', () => {
    const { result } = renderHook(() => useTabs([...tabs]))
    const props = result.current.getTabProps('tab2')

    act(() => {
      props.onClick()
    })

    expect(result.current.activeTab).toBe('tab2')
  })
})

describe('useLoadingState', () => {
  test('should return loading props', () => {
    const { result } = renderHook(() => useLoadingState(false))

    expect(result.current.loadingProps['aria-busy']).toBe(false)
    expect(result.current.loadingProps['aria-live']).toBe('polite')
  })

  test('should set aria-busy when loading', () => {
    const { result } = renderHook(() => useLoadingState(true))

    expect(result.current.loadingProps['aria-busy']).toBe(true)
  })

  test('should return announcer props', () => {
    const { result } = renderHook(() => useLoadingState(false))

    expect(result.current.announcerProps).toBeDefined()
    expect(result.current.announcerProps.role).toBe('status')
  })
})

describe('getFocusableElements', () => {
  test('should query focusable elements', () => {
    const mockElements = [
      document.createElement('button'),
      document.createElement('input'),
    ]
    const container = document.createElement('div')
    jest.spyOn(container, 'querySelectorAll').mockReturnValue(mockElements as any)

    const elements = getFocusableElements(container)

    expect(container.querySelectorAll).toHaveBeenCalled()
    expect(elements).toEqual(mockElements)
  })
})

describe('isFocusable', () => {
  test('should return true for focusable element', () => {
    const button = document.createElement('button')
    expect(isFocusable(button)).toBe(true)
  })

  test('should return false for non-focusable element', () => {
    const div = document.createElement('div')
    expect(isFocusable(div)).toBe(false)
  })
})

describe('generateAriaId', () => {
  test('should generate id with default prefix', () => {
    const id = generateAriaId()

    expect(id).toMatch(/^aria-[a-z0-9]+$/)
  })

  test('should generate id with custom prefix', () => {
    const id = generateAriaId('custom')

    expect(id).toMatch(/^custom-[a-z0-9]+$/)
  })

  test('should generate unique ids', () => {
    const id1 = generateAriaId()
    const id2 = generateAriaId()

    expect(id1).not.toBe(id2)
  })
})
