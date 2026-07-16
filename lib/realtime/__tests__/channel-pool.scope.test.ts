jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}))

import { supabase } from '@/lib/supabase/client'
import { RealtimeChannelPool } from '../channel-pool'

const mockChannel = supabase.channel as jest.Mock

function makeChannel() {
  const channel = {
    on: jest.fn(),
    subscribe: jest.fn(),
  }
  channel.on.mockReturnValue(channel)
  return channel
}

describe('RealtimeChannelPool viewer scope', () => {
  let pool: RealtimeChannelPool

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockChannel.mockImplementation(() => makeChannel())
    pool = new RealtimeChannelPool()
  })

  afterEach(() => {
    pool.cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('does not reuse a physical channel across viewer sessions', () => {
    const config = {
      schema: 'public',
      table: 'comments',
      event: '*' as const,
      filter: 'post_id=eq.post-1',
    }

    const unsubscribeA = pool.subscribe({ ...config, scopeKey: 'user:a:1' }, {})
    const unsubscribeB = pool.subscribe({ ...config, scopeKey: 'user:b:2' }, {})

    expect(mockChannel).toHaveBeenCalledTimes(2)
    expect(pool.getSubscriberCount('public', 'comments', '*', config.filter, 'user:a:1')).toBe(1)
    expect(pool.getSubscriberCount('public', 'comments', '*', config.filter, 'user:b:2')).toBe(1)

    unsubscribeA()
    jest.advanceTimersByTime(5000)

    expect(pool.hasChannel('public', 'comments', '*', config.filter, 'user:a:1')).toBe(false)
    expect(pool.hasChannel('public', 'comments', '*', config.filter, 'user:b:2')).toBe(true)
    expect(pool.getSubscriberCount('public', 'comments', '*', config.filter, 'user:b:2')).toBe(1)

    unsubscribeB()
  })

  it('still reuses a channel inside the same viewer session', () => {
    const config = {
      table: 'posts',
      event: '*' as const,
      scopeKey: 'user:a:1',
    }

    const unsubscribeFirst = pool.subscribe(config, {})
    const unsubscribeSecond = pool.subscribe(config, {})

    expect(mockChannel).toHaveBeenCalledTimes(1)
    expect(pool.getSubscriberCount('public', 'posts', '*', undefined, 'user:a:1')).toBe(2)

    unsubscribeFirst()
    unsubscribeSecond()
  })
})
