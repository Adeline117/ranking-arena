/**
 * 埋点事件定义
 * 统一定义所有可追踪的用户行为事件
 */

// 页面浏览事件
export interface PageViewEvent {
  name: 'page_view'
  props: {
    page: string
    path: string
    referrer?: string
    title?: string
  }
}

// 交易员点击事件
export interface TraderClickEvent {
  name: 'trader_click'
  props: {
    trader_id: string
    trader_handle: string
    rank: number
    source: string
    from_page: string
  }
}

// 时间范围切换事件
export interface TimeRangeChangeEvent {
  name: 'time_range_change'
  props: {
    from: string
    to: string
    page: string
  }
}

// 搜索事件
export interface SearchEvent {
  name: 'search'
  props: {
    query: string
    results_count: number
    selected_result?: string
  }
}

// 关注交易员事件
export interface FollowTraderEvent {
  name: 'follow_trader'
  props: {
    trader_id: string
    trader_handle: string
    action: 'follow' | 'unfollow'
  }
}

// 分享事件
export interface ShareEvent {
  name: 'share'
  props: {
    content_type: 'trader' | 'post' | 'group'
    content_id: string
    platform: 'twitter' | 'telegram' | 'copy_link' | 'other'
  }
}

// 帖子互动事件
export interface PostInteractionEvent {
  name: 'post_interaction'
  props: {
    post_id: string
    action: 'like' | 'unlike' | 'comment' | 'bookmark' | 'repost' | 'vote'
    vote_type?: 'bullish' | 'bearish' | 'wait'
  }
}

// 图表交互事件
export interface ChartInteractionEvent {
  name: 'chart_interaction'
  props: {
    chart_type: 'equity' | 'pnl' | 'drawdown'
    trader_id: string
    action: 'view' | 'zoom' | 'hover'
  }
}

// 交易所绑定事件
export interface ExchangeBindEvent {
  name: 'exchange_bind'
  props: {
    exchange: string
    action: 'start' | 'success' | 'fail' | 'disconnect'
    error_code?: string
  }
}

// 错误事件
export interface ErrorEvent {
  name: 'error'
  props: {
    error_type: string
    error_message: string
    page: string
    component?: string
  }
}

// 性能事件
export interface PerformanceEvent {
  name: 'performance'
  props: {
    metric_name: string
    value: number
    page: string
  }
}

// 登录/登出事件
export interface AuthEvent {
  name: 'auth'
  props: {
    action: 'login' | 'logout' | 'signup'
    method?: string
    success: boolean
  }
}

// Tab 切换事件
export interface TabChangeEvent {
  name: 'tab_change'
  props: {
    page: string
    from_tab: string
    to_tab: string
  }
}

// 所有事件类型联合
export type TrackEvent =
  | PageViewEvent
  | TraderClickEvent
  | TimeRangeChangeEvent
  | SearchEvent
  | FollowTraderEvent
  | ShareEvent
  | PostInteractionEvent
  | ChartInteractionEvent
  | ExchangeBindEvent
  | ErrorEvent
  | PerformanceEvent
  | AuthEvent
  | TabChangeEvent

// 事件名称类型
export type EventName = TrackEvent['name']

// 提取特定事件的 props 类型
export type EventProps<T extends EventName> = Extract<TrackEvent, { name: T }>['props']
