import { act, renderHook } from '@testing-library/react'

type MockChannel = {
  name: string
  change?: (payload: { eventType: string; new: unknown; old: unknown }) => void
  status?: (status: string) => void
  on: jest.Mock
  subscribe: jest.Mock
}

const mockChannels: MockChannel[] = []
const mockRemoveChannel = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    channel: jest.fn((name: string) => {
      const channel = {} as MockChannel
      channel.name = name
      channel.on = jest.fn(
        (
          _kind: string,
          _config: unknown,
          callback: (payload: { eventType: string; new: unknown; old: unknown }) => void
        ) => {
          channel.change = callback
          return channel
        }
      )
      channel.subscribe = jest.fn((callback: (status: string) => void) => {
        channel.status = callback
        return channel
      })
      mockChannels.push(channel)
      return channel
    }),
    removeChannel: (...args: unknown[]) => mockRemoveChannel(...args),
  },
}))
jest.mock('@/lib/realtime/channel-pool', () => ({
  channelPool: {
    subscribe: jest.fn(() => jest.fn()),
    hasChannel: jest.fn(() => false),
  },
}))
jest.mock('@/lib/utils/logger', () => ({
  realtimeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { useRealtime } from '../useRealtime'

describe('useRealtime direct viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockChannels.length = 0
  })

  it('reconnects on scope change and rejects late A status and row callbacks', () => {
    const onInsert = jest.fn()
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) =>
        useRealtime({
          table: 'comments',
          event: '*',
          scopeKey,
          usePool: false,
          autoReconnect: false,
          onInsert,
        }),
      { initialProps: { scopeKey: 'user:a:1' } }
    )
    const channelA = mockChannels[0]
    act(() => channelA.status?.('SUBSCRIBED'))
    expect(result.current.status).toBe('connected')

    rerender({ scopeKey: 'user:b:2' })
    const channelB = mockChannels[1]
    expect(mockRemoveChannel).toHaveBeenCalledWith(channelA)
    expect(channelB.name).toContain('user%3Ab%3A2')
    expect(result.current.status).toBe('connecting')

    act(() => {
      channelA.status?.('SUBSCRIBED')
      channelA.change?.({ eventType: 'INSERT', new: { id: 'late-a' }, old: {} })
    })
    expect(result.current.status).toBe('connecting')
    expect(onInsert).not.toHaveBeenCalled()

    act(() => {
      channelB.status?.('SUBSCRIBED')
      channelB.change?.({ eventType: 'INSERT', new: { id: 'row-b' }, old: {} })
    })
    expect(result.current.status).toBe('connected')
    expect(onInsert).toHaveBeenCalledWith({ id: 'row-b' })
  })
})
