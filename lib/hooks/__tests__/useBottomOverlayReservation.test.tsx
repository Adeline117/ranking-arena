import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import {
  PAGE_BOTTOM_OVERLAY_OFFSET,
  useBottomOverlayReservation,
} from '../useBottomOverlayReservation'

type ResizeCallback = ConstructorParameters<typeof ResizeObserver>[0]

function Overlay({ height }: { height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useBottomOverlayReservation(ref, true)

  return <div ref={ref} data-reservation-height={height} />
}

describe('useBottomOverlayReservation', () => {
  const originalResizeObserver = global.ResizeObserver
  const originalMatchMedia = window.matchMedia
  const resizeCallbacks: ResizeCallback[] = []
  const disconnect = jest.fn()

  beforeEach(() => {
    resizeCallbacks.length = 0
    disconnect.mockClear()
    window.matchMedia = jest.fn().mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(),
        }) satisfies MediaQueryList
    )
    global.ResizeObserver = class {
      constructor(callback: ResizeCallback) {
        resizeCallbacks.push(callback)
      }

      observe() {}
      unobserve() {}
      disconnect = disconnect
    }
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = Number(this.dataset.reservationHeight ?? 0)
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 320,
        bottom: height,
        left: 0,
        width: 320,
        height,
        toJSON: () => ({}),
      }
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    global.ResizeObserver = originalResizeObserver
    window.matchMedia = originalMatchMedia
    document.documentElement.style.removeProperty(PAGE_BOTTOM_OVERLAY_OFFSET)
  })

  it('adds independent reservations and removes only the overlay that unmounts', () => {
    const view = render(
      <>
        <Overlay height={88} />
        <Overlay height={44} />
      </>
    )

    expect(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_OVERLAY_OFFSET)).toBe(
      '132px'
    )

    view.rerender(<Overlay height={88} />)
    expect(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_OVERLAY_OFFSET)).toBe('88px')

    view.unmount()
    expect(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_OVERLAY_OFFSET)).toBe('')
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('republishes the measured height when ResizeObserver reports reflow', () => {
    const view = render(<Overlay height={72} />)
    const overlay = view.container.firstElementChild as HTMLElement

    expect(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_OVERLAY_OFFSET)).toBe('72px')

    overlay.dataset.reservationHeight = '105'
    act(() => {
      resizeCallbacks[0]([], {} as ResizeObserver)
    })

    expect(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_OVERLAY_OFFSET)).toBe(
      '105px'
    )

    view.unmount()
  })
})
