/**
 * Business Metrics Tests
 * 测试业务指标追踪
 */

import {
  trackTraderView,
  trackTraderViewDuration,
  trackPostEngagement,
  trackSearch,
  trackConversion,
  trackUserJourney,
  trackPerformance,
  trackFollow,
  trackExchangeConnect,
  trackBusinessError,
  trackWebVital,
  BusinessMetrics,
} from './business-metrics'

// Mock the tracker module
jest.mock('./tracker', () => ({
  track: jest.fn(),
}))

import { track } from './tracker'

describe('trackTraderView', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track trader view with all fields', () => {
    trackTraderView({
      traderId: 'trader123',
      traderHandle: 'testTrader',
      source: 'ranking',
      referrer: 'google',
    })

    expect(track).toHaveBeenCalledWith('trader_view', {
      trader_id: 'trader123',
      trader_handle: 'testTrader',
      source: 'ranking',
      referrer: 'google',
    })
  })

  test('should track trader view with minimal fields', () => {
    trackTraderView({
      traderId: 'trader123',
      traderHandle: 'testTrader',
    })

    expect(track).toHaveBeenCalledWith('trader_view', expect.objectContaining({
      trader_id: 'trader123',
      trader_handle: 'testTrader',
    }))
  })
})

describe('trackTraderViewDuration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track view duration', () => {
    trackTraderViewDuration('trader123', 30000)

    expect(track).toHaveBeenCalledWith('trader_view', {
      trader_id: 'trader123',
      trader_handle: '',
      duration: 30000,
    })
  })
})

describe('trackPostEngagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track post like', () => {
    trackPostEngagement({
      postId: 'post123',
      action: 'like',
    })

    expect(track).toHaveBeenCalledWith('post_interaction', {
      post_id: 'post123',
      action: 'like',
    })
  })

  test('should track post dislike as unlike', () => {
    trackPostEngagement({
      postId: 'post123',
      action: 'dislike',
    })

    expect(track).toHaveBeenCalledWith('post_interaction', {
      post_id: 'post123',
      action: 'unlike',
    })
  })

  test('should track post comment', () => {
    trackPostEngagement({
      postId: 'post123',
      action: 'comment',
    })

    expect(track).toHaveBeenCalledWith('post_interaction', {
      post_id: 'post123',
      action: 'comment',
    })
  })

  test('should track post share as repost', () => {
    trackPostEngagement({
      postId: 'post123',
      action: 'share',
    })

    expect(track).toHaveBeenCalledWith('post_interaction', {
      post_id: 'post123',
      action: 'repost',
    })
  })

  test('should track post vote', () => {
    trackPostEngagement({
      postId: 'post123',
      action: 'vote',
    })

    expect(track).toHaveBeenCalledWith('post_interaction', {
      post_id: 'post123',
      action: 'vote',
    })
  })
})

describe('trackSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track search with results', () => {
    trackSearch({
      query: 'bitcoin trader',
      resultCount: 10,
      searchType: 'trader',
    })

    expect(track).toHaveBeenCalledWith('search', {
      query: 'bitcoin trader',
      results_count: 10,
      selected_result: undefined,
    })
  })

  test('should track search with clicked result', () => {
    trackSearch({
      query: 'bitcoin',
      resultCount: 5,
      searchType: 'all',
      clickedResult: 'trader123',
    })

    expect(track).toHaveBeenCalledWith('search', {
      query: 'bitcoin',
      results_count: 5,
      selected_result: 'trader123',
    })
  })
})

describe('trackConversion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track conversion event', () => {
    trackConversion({
      event: 'signup_complete',
      value: 1,
      source: 'homepage',
    })

    expect(track).toHaveBeenCalledWith('performance', expect.objectContaining({
      metric_name: 'conversion.signup_complete',
      value: 1,
    }))
  })

  test('should track conversion without value', () => {
    trackConversion({
      event: 'button_click',
    })

    expect(track).toHaveBeenCalledWith('performance', expect.objectContaining({
      metric_name: 'conversion.button_click',
      value: 0,
    }))
  })
})

describe('trackUserJourney', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track successful journey step', () => {
    trackUserJourney({
      step: 'profile_complete',
      funnel: 'onboarding',
      success: true,
    })

    expect(track).toHaveBeenCalledWith('performance', expect.objectContaining({
      metric_name: 'funnel.onboarding.profile_complete',
      value: 1,
    }))
  })

  test('should track failed journey step', () => {
    trackUserJourney({
      step: 'payment',
      funnel: 'subscription',
      success: false,
    })

    expect(track).toHaveBeenCalledWith('performance', expect.objectContaining({
      metric_name: 'funnel.subscription.payment',
      value: 0,
    }))
  })
})

describe('trackPerformance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track performance metric', () => {
    trackPerformance({
      name: 'api_response_time',
      duration: 250,
    })

    expect(track).toHaveBeenCalledWith('performance', {
      metric_name: 'api_response_time',
      value: 250,
      page: 'performance',
    })
  })
})

describe('trackFollow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track follow action', () => {
    trackFollow('trader123', 'follow')

    expect(track).toHaveBeenCalledWith('follow_trader', {
      trader_id: 'trader123',
      trader_handle: '',
      action: 'follow',
    })
  })

  test('should track unfollow action', () => {
    trackFollow('trader123', 'unfollow')

    expect(track).toHaveBeenCalledWith('follow_trader', {
      trader_id: 'trader123',
      trader_handle: '',
      action: 'unfollow',
    })
  })
})

describe('trackExchangeConnect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track successful exchange connection', () => {
    trackExchangeConnect('binance', true)

    expect(track).toHaveBeenCalledWith('exchange_bind', {
      exchange: 'binance',
      action: 'success',
    })
  })

  test('should track failed exchange connection', () => {
    trackExchangeConnect('bybit', false)

    expect(track).toHaveBeenCalledWith('exchange_bind', {
      exchange: 'bybit',
      action: 'fail',
    })
  })
})

describe('trackBusinessError', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track business error', () => {
    // Navigate to a test page using history.pushState (works with jsdom)
    window.history.pushState({}, '', '/test-page')

    trackBusinessError('Invalid input')

    expect(track).toHaveBeenCalledWith('error', {
      error_type: 'business',
      error_message: 'Invalid input',
      page: '/test-page',
    })

    // Navigate back to original location
    window.history.pushState({}, '', '/')
  })
})

describe('trackWebVital', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should track LCP metric', () => {
    trackWebVital('LCP', 2500, 'needs-improvement')

    expect(track).toHaveBeenCalledWith('performance', {
      metric_name: 'web_vital.lcp',
      value: 2500,
      page: 'web_vitals',
    })
  })

  test('should track FCP metric', () => {
    trackWebVital('FCP', 1000, 'good')

    expect(track).toHaveBeenCalledWith('performance', {
      metric_name: 'web_vital.fcp',
      value: 1000,
      page: 'web_vitals',
    })
  })

  test('should track CLS metric', () => {
    trackWebVital('CLS', 0.1, 'good')

    expect(track).toHaveBeenCalledWith('performance', {
      metric_name: 'web_vital.cls',
      value: 0.1,
      page: 'web_vitals',
    })
  })
})

describe('BusinessMetrics object', () => {
  test('should export all tracking functions', () => {
    expect(BusinessMetrics.trackTraderView).toBe(trackTraderView)
    expect(BusinessMetrics.trackTraderViewDuration).toBe(trackTraderViewDuration)
    expect(BusinessMetrics.trackPostEngagement).toBe(trackPostEngagement)
    expect(BusinessMetrics.trackSearch).toBe(trackSearch)
    expect(BusinessMetrics.trackConversion).toBe(trackConversion)
    expect(BusinessMetrics.trackUserJourney).toBe(trackUserJourney)
    expect(BusinessMetrics.trackPerformance).toBe(trackPerformance)
    expect(BusinessMetrics.trackFollow).toBe(trackFollow)
    expect(BusinessMetrics.trackExchangeConnect).toBe(trackExchangeConnect)
    expect(BusinessMetrics.trackBusinessError).toBe(trackBusinessError)
    expect(BusinessMetrics.trackWebVital).toBe(trackWebVital)
  })
})
