import { track as trackVercelEvent } from '@vercel/analytics'
import { ANALYTICS_EVENTS, trackEvent } from '../track'

jest.mock('@vercel/analytics', () => ({
  track: jest.fn(),
}))

const vercelTrackMock = trackVercelEvent as jest.MockedFunction<typeof trackVercelEvent>

describe('trackEvent', () => {
  afterEach(() => {
    vercelTrackMock.mockClear()
    delete (window as typeof window & { plausible?: unknown }).plausible
    delete (window as typeof window & { posthog?: unknown }).posthog
  })

  it('always emits the canonical event to Vercel Analytics in the browser', () => {
    trackEvent(ANALYTICS_EVENTS.rankingFilter, { period: '30D', mobile: true })

    expect(vercelTrackMock).toHaveBeenCalledWith('ranking_filter', {
      period: '30D',
      mobile: true,
    })
  })

  it('mirrors the event to optional providers when they are loaded', () => {
    const plausible = jest.fn()
    const capture = jest.fn()
    ;(window as typeof window & { plausible: typeof plausible }).plausible = plausible
    ;(window as typeof window & { posthog: { capture: typeof capture } }).posthog = { capture }

    trackEvent(ANALYTICS_EVENTS.saveTrader, { source: 'ranking' })

    expect(plausible).toHaveBeenCalledWith('save_trader', {
      props: { source: 'ranking' },
    })
    expect(capture).toHaveBeenCalledWith('save_trader', { source: 'ranking' })
  })
})
