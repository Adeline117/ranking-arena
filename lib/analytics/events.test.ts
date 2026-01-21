/**
 * Analytics Events Tests
 * 测试埋点事件定义
 */

import type {
  PageViewEvent,
  TraderClickEvent,
  TimeRangeChangeEvent,
  SearchEvent,
  FollowTraderEvent,
  ShareEvent,
  PostInteractionEvent,
  ChartInteractionEvent,
  ExchangeBindEvent,
  ErrorEvent,
  PerformanceEvent,
  AuthEvent,
  TabChangeEvent,
  TraderViewEvent,
  TrackEvent,
  EventName,
  EventProps,
} from './events'

describe('Event Types', () => {
  test('PageViewEvent should have correct structure', () => {
    const event: PageViewEvent = {
      name: 'page_view',
      props: {
        page: 'home',
        path: '/',
        referrer: 'google.com',
        title: 'Home Page',
      },
    }

    expect(event.name).toBe('page_view')
    expect(event.props.page).toBe('home')
    expect(event.props.path).toBe('/')
  })

  test('TraderClickEvent should have correct structure', () => {
    const event: TraderClickEvent = {
      name: 'trader_click',
      props: {
        trader_id: 'trader123',
        trader_handle: 'testTrader',
        rank: 1,
        source: 'binance',
        from_page: 'ranking',
      },
    }

    expect(event.name).toBe('trader_click')
    expect(event.props.trader_id).toBe('trader123')
    expect(event.props.rank).toBe(1)
  })

  test('TimeRangeChangeEvent should have correct structure', () => {
    const event: TimeRangeChangeEvent = {
      name: 'time_range_change',
      props: {
        from: '7D',
        to: '30D',
        page: 'ranking',
      },
    }

    expect(event.name).toBe('time_range_change')
    expect(event.props.from).toBe('7D')
    expect(event.props.to).toBe('30D')
  })

  test('SearchEvent should have correct structure', () => {
    const event: SearchEvent = {
      name: 'search',
      props: {
        query: 'bitcoin',
        results_count: 10,
        selected_result: 'trader123',
      },
    }

    expect(event.name).toBe('search')
    expect(event.props.query).toBe('bitcoin')
    expect(event.props.results_count).toBe(10)
  })

  test('FollowTraderEvent should have correct structure', () => {
    const event: FollowTraderEvent = {
      name: 'follow_trader',
      props: {
        trader_id: 'trader123',
        trader_handle: 'testTrader',
        action: 'follow',
      },
    }

    expect(event.name).toBe('follow_trader')
    expect(event.props.action).toBe('follow')
  })

  test('ShareEvent should have correct structure', () => {
    const event: ShareEvent = {
      name: 'share',
      props: {
        content_type: 'trader',
        content_id: 'trader123',
        platform: 'twitter',
      },
    }

    expect(event.name).toBe('share')
    expect(event.props.platform).toBe('twitter')
  })

  test('PostInteractionEvent should have correct structure', () => {
    const event: PostInteractionEvent = {
      name: 'post_interaction',
      props: {
        post_id: 'post123',
        action: 'like',
      },
    }

    expect(event.name).toBe('post_interaction')
    expect(event.props.action).toBe('like')
  })

  test('PostInteractionEvent vote should include vote_type', () => {
    const event: PostInteractionEvent = {
      name: 'post_interaction',
      props: {
        post_id: 'post123',
        action: 'vote',
        vote_type: 'bullish',
      },
    }

    expect(event.props.vote_type).toBe('bullish')
  })

  test('ChartInteractionEvent should have correct structure', () => {
    const event: ChartInteractionEvent = {
      name: 'chart_interaction',
      props: {
        chart_type: 'equity',
        trader_id: 'trader123',
        action: 'view',
      },
    }

    expect(event.name).toBe('chart_interaction')
    expect(event.props.chart_type).toBe('equity')
  })

  test('ExchangeBindEvent should have correct structure', () => {
    const event: ExchangeBindEvent = {
      name: 'exchange_bind',
      props: {
        exchange: 'binance',
        action: 'success',
      },
    }

    expect(event.name).toBe('exchange_bind')
    expect(event.props.action).toBe('success')
  })

  test('ExchangeBindEvent fail should include error_code', () => {
    const event: ExchangeBindEvent = {
      name: 'exchange_bind',
      props: {
        exchange: 'binance',
        action: 'fail',
        error_code: 'INVALID_API_KEY',
      },
    }

    expect(event.props.error_code).toBe('INVALID_API_KEY')
  })

  test('ErrorEvent should have correct structure', () => {
    const event: ErrorEvent = {
      name: 'error',
      props: {
        error_type: 'api_error',
        error_message: 'Failed to fetch data',
        page: '/ranking',
        component: 'TraderList',
      },
    }

    expect(event.name).toBe('error')
    expect(event.props.error_type).toBe('api_error')
  })

  test('PerformanceEvent should have correct structure', () => {
    const event: PerformanceEvent = {
      name: 'performance',
      props: {
        metric_name: 'LCP',
        value: 2500,
        page: '/ranking',
      },
    }

    expect(event.name).toBe('performance')
    expect(event.props.metric_name).toBe('LCP')
    expect(event.props.value).toBe(2500)
  })

  test('AuthEvent should have correct structure', () => {
    const event: AuthEvent = {
      name: 'auth',
      props: {
        action: 'login',
        method: 'google',
        success: true,
      },
    }

    expect(event.name).toBe('auth')
    expect(event.props.action).toBe('login')
    expect(event.props.success).toBe(true)
  })

  test('TabChangeEvent should have correct structure', () => {
    const event: TabChangeEvent = {
      name: 'tab_change',
      props: {
        page: '/trader/test',
        from_tab: 'overview',
        to_tab: 'performance',
      },
    }

    expect(event.name).toBe('tab_change')
    expect(event.props.from_tab).toBe('overview')
    expect(event.props.to_tab).toBe('performance')
  })

  test('TraderViewEvent should have correct structure', () => {
    const event: TraderViewEvent = {
      name: 'trader_view',
      props: {
        trader_id: 'trader123',
        trader_handle: 'testTrader',
        source: 'binance',
        referrer: 'ranking',
        section: 'overview',
        timeRange: '30D',
        duration: 30000,
      },
    }

    expect(event.name).toBe('trader_view')
    expect(event.props.trader_id).toBe('trader123')
    expect(event.props.duration).toBe(30000)
  })
})

describe('Event Type Utilities', () => {
  test('EventName should be a union of all event names', () => {
    const eventNames: EventName[] = [
      'page_view',
      'trader_click',
      'time_range_change',
      'search',
      'follow_trader',
      'share',
      'post_interaction',
      'chart_interaction',
      'exchange_bind',
      'error',
      'performance',
      'auth',
      'tab_change',
      'trader_view',
    ]

    expect(eventNames).toHaveLength(14)
  })

  test('EventProps should extract correct props type', () => {
    // This is a compile-time check
    const pageViewProps: EventProps<'page_view'> = {
      page: 'home',
      path: '/',
    }

    const traderClickProps: EventProps<'trader_click'> = {
      trader_id: 'trader123',
      trader_handle: 'test',
      rank: 1,
      source: 'binance',
      from_page: 'ranking',
    }

    expect(pageViewProps.page).toBe('home')
    expect(traderClickProps.trader_id).toBe('trader123')
  })

  test('TrackEvent should be a union of all events', () => {
    const events: TrackEvent[] = [
      { name: 'page_view', props: { page: 'home', path: '/' } },
      { name: 'trader_click', props: { trader_id: '1', trader_handle: 't', rank: 1, source: 'binance', from_page: 'home' } },
      { name: 'search', props: { query: 'test', results_count: 0 } },
    ]

    expect(events).toHaveLength(3)
    expect(events[0].name).toBe('page_view')
  })
})
