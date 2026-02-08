/**
 * NetworkStatusBanner 组件测试
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'
import NetworkStatusBanner from '../NetworkStatusBanner'

describe('NetworkStatusBanner', () => {
  let originalNavigator: boolean

  beforeEach(() => {
    originalNavigator = window.navigator.onLine
  })

  afterEach(() => {
    Object.defineProperty(window.navigator, 'onLine', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    })
  })

  it('should not render when online', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    const { container } = render(<NetworkStatusBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('should show offline banner when starting offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
    render(<NetworkStatusBanner />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('网络连接已断开')).toBeInTheDocument()
  })

  it('should show offline banner on offline event', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    render(<NetworkStatusBanner />)

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('网络连接已断开')).toBeInTheDocument()
  })

  it('should show reconnected message on online event after offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    render(<NetworkStatusBanner />)

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByText('网络连接已断开')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.getByText('网络已恢复')).toBeInTheDocument()
  })

  it('should have role="alert" and aria-live="assertive"', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
    render(<NetworkStatusBanner />)
    
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('aria-live', 'assertive')
  })

  it('should clean up event listeners on unmount', () => {
    const removeSpy = jest.spyOn(window, 'removeEventListener')
    const { unmount } = render(<NetworkStatusBanner />)
    unmount()

    const removedEvents = removeSpy.mock.calls.map(c => c[0])
    expect(removedEvents).toContain('offline')
    expect(removedEvents).toContain('online')
    removeSpy.mockRestore()
  })
})
