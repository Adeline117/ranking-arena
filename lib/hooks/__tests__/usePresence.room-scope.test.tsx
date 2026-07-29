import { act, renderHook, waitFor } from '@testing-library/react'
import type { RealtimeChannelOptions } from '@supabase/realtime-js'

type MockPresence = Record<string, Array<Record<string, unknown>>>

type MockChannel = {
  topic: string
  options?: RealtimeChannelOptions
  events: Record<string, () => void>
  state: MockPresence
  status?: (status: string) => void
  on: jest.Mock
  subscribe: jest.Mock
  presenceState: jest.Mock
  track: jest.Mock
  teardown: jest.Mock
  unsubscribe: jest.Mock
}

const mockChannels: MockChannel[] = []
const mockRegistry: MockChannel[] = []
const mockIn = jest.fn()
const mockSelect = jest.fn(() => ({ in: mockIn }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))
const removeChannelNormally = async (channel: MockChannel) => {
  await channel.unsubscribe()
  channel.teardown()
  return 'ok'
}
const mockRemoveChannel = jest.fn(removeChannelNormally)

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    channel: jest.fn((topic: string, options?: RealtimeChannelOptions) => {
      const existing = mockRegistry.find((channel) => channel.topic === topic)
      if (existing) return existing

      const channel = {
        topic,
        options,
        events: {},
        state: {},
      } as MockChannel
      channel.on = jest.fn(
        (_kind: string, config: { event: string }, callback: () => void): MockChannel => {
          channel.events[config.event] = callback
          return channel
        }
      )
      channel.subscribe = jest.fn((callback?: (status: string) => void): MockChannel => {
        channel.status = callback
        return channel
      })
      channel.presenceState = jest.fn(() => channel.state)
      channel.track = jest.fn().mockResolvedValue('ok')
      channel.teardown = jest.fn()
      channel.unsubscribe = jest.fn().mockResolvedValue('ok')
      mockChannels.push(channel)
      mockRegistry.push(channel)
      return channel
    }),
    getChannels: jest.fn(() => mockRegistry),
    removeChannel: (...args: [MockChannel]) => mockRemoveChannel(...args),
    from: (...args: [string]) => mockFrom(...args),
  },
}))

import { usePresence } from '../usePresence'

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

describe('usePresence room and viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockChannels.length = 0
    mockRegistry.length = 0
    mockIn.mockResolvedValue({ data: null })
    mockRemoveChannel.mockImplementation(removeChannelNormally)
  })

  it('joins the shared conversation room and receives peer online/typing state', async () => {
    const { result } = renderHook(() =>
      usePresence('user-a', ['user-b'], { kind: 'conversation', id: 'conversation-1' })
    )
    const channel = mockChannels[0]

    expect(channel.topic).toBe('presence:conversation:conversation-1')
    expect(channel.options).toEqual({
      config: { presence: { key: 'user-a' } },
    })

    act(() => channel.status?.('SUBSCRIBED'))
    expect(channel.track).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-a',
        typing_in: null,
      })
    )

    channel.state = {
      'user-b': [{ typing_in: 'conversation-1' }],
    }
    act(() => channel.events.sync())

    expect(result.current.getUserPresence('user-b').isOnline).toBe(true)
    expect(result.current.isUserTyping('user-b', 'conversation-1')).toBe(true)
    expect(result.current.isUserTyping('user-b', 'another-room')).toBe(false)
    await waitFor(() => expect(mockIn).toHaveBeenCalledWith('id', ['user-b']))
  })

  it('uses distinct exact topics for conversation and channel rooms with the same id', () => {
    const conversation = renderHook(() =>
      usePresence('user-a', ['peer'], { kind: 'conversation', id: 'shared-id' })
    )
    const channel = renderHook(() =>
      usePresence('user-a', ['peer'], { kind: 'channel', id: 'shared-id' })
    )

    expect(mockChannels.map((candidate) => candidate.topic)).toEqual([
      'presence:conversation:shared-id',
      'presence:channel:shared-id',
    ])

    mockChannels[0].state = { peer: [{ typing_in: 'shared-id' }] }
    act(() => mockChannels[0].events.sync())
    expect(conversation.result.current.getUserPresence('peer').isOnline).toBe(true)
    expect(channel.result.current.getUserPresence('peer').isOnline).toBe(false)

    conversation.unmount()
    channel.unmount()
  })

  it('keeps a multi-tab user online until the room state loses its final presence', () => {
    const { result } = renderHook(() =>
      usePresence('user-a', ['user-b'], { kind: 'channel', id: 'channel-1' })
    )
    const channel = mockChannels[0]

    channel.state = {
      'user-b': [{ phx_ref: 'tab-1' }, { phx_ref: 'tab-2' }],
    }
    act(() => channel.events.sync())
    expect(result.current.getUserPresence('user-b').isOnline).toBe(true)

    channel.state = {
      'user-b': [{ phx_ref: 'tab-2' }],
    }
    act(() => channel.events.leave())
    expect(result.current.getUserPresence('user-b').isOnline).toBe(true)

    channel.state = {}
    act(() => channel.events.leave())
    expect(result.current.getUserPresence('user-b').isOnline).toBe(false)
  })

  it('bounds the durable is_online fallback by the heartbeat grace window', async () => {
    const now = Date.now()
    mockIn.mockResolvedValue({
      data: [
        { id: 'fresh', is_online: true, last_seen_at: new Date(now - 30_000).toISOString() },
        { id: 'stale', is_online: true, last_seen_at: new Date(now - 90_001).toISOString() },
        {
          id: 'allowed-future-skew',
          is_online: true,
          last_seen_at: new Date(now + 60_000).toISOString(),
        },
        {
          id: 'impossible-future',
          is_online: true,
          last_seen_at: new Date(now + 120_000).toISOString(),
        },
        {
          id: 'explicit-offline',
          is_online: false,
          last_seen_at: new Date(now - 10_000).toISOString(),
        },
      ],
    })

    const { result } = renderHook(() =>
      usePresence(
        'user-a',
        ['stale', 'fresh', 'explicit-offline', 'allowed-future-skew', 'impossible-future'],
        {
          kind: 'channel',
          id: 'channel-1',
        }
      )
    )

    await waitFor(() => expect(result.current.getUserPresence('fresh').lastSeenAt).not.toBeNull())
    expect(result.current.getUserPresence('fresh').isOnline).toBe(true)
    expect(result.current.getUserPresence('stale').isOnline).toBe(false)
    expect(result.current.getUserPresence('allowed-future-skew').isOnline).toBe(true)
    expect(result.current.getUserPresence('impossible-future').isOnline).toBe(false)
    expect(result.current.getUserPresence('explicit-offline').isOnline).toBe(false)
  })

  it('keeps a successful room sync authoritative over a late fresh DB row', async () => {
    let resolveRows!: (value: {
      data: Array<{ id: string; is_online: boolean; last_seen_at: string }>
    }) => void
    mockIn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRows = resolve
      })
    )
    const { result } = renderHook(() =>
      usePresence('user-a', ['user-b'], { kind: 'conversation', id: 'conversation-1' })
    )
    const channel = mockChannels[0]

    channel.state = {}
    act(() => channel.events.sync())
    expect(result.current.getUserPresence('user-b').isOnline).toBe(false)

    await act(async () => {
      resolveRows({
        data: [{ id: 'user-b', is_online: true, last_seen_at: iso(5_000) }],
      })
      await Promise.resolve()
    })

    expect(result.current.getUserPresence('user-b').isOnline).toBe(false)
  })

  it('fails empty on a room/viewer switch and rejects late A realtime, DB, and typing work', async () => {
    let resolveViewerA!: (value: {
      data: Array<{ id: string; is_online: boolean; last_seen_at: string }>
    }) => void
    mockIn
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveViewerA = resolve
        })
      )
      .mockResolvedValueOnce({ data: null })

    const hook = renderHook(
      ({ userId, roomId }: { userId: string; roomId: string }) =>
        usePresence(userId, ['peer'], { kind: 'conversation', id: roomId }),
      {
        initialProps: { userId: 'user-a', roomId: 'conversation-a' },
      }
    )
    const channelA = mockChannels[0]
    channelA.state = { peer: [{ typing_in: 'conversation-a' }] }
    act(() => channelA.events.sync())
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(true)
    const staleSetTyping = hook.result.current.setTyping

    hook.rerender({ userId: 'user-b', roomId: 'conversation-b' })
    const channelB = mockChannels[1]

    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)
    expect(hook.result.current.isUserTyping('peer', 'conversation-a')).toBe(false)
    expect(mockRemoveChannel).toHaveBeenCalledWith(channelA)

    channelA.state = { peer: [{ typing_in: 'conversation-a' }] }
    act(() => {
      channelA.events.sync()
      staleSetTyping('conversation-a', true)
    })
    expect(channelB.track).not.toHaveBeenCalled()
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)

    await act(async () => {
      resolveViewerA({
        data: [{ id: 'peer', is_online: true, last_seen_at: iso(1_000) }],
      })
      await Promise.resolve()
    })
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)

    act(() => hook.result.current.setTyping('conversation-b', true))
    expect(channelB.track).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-b', typing_in: 'conversation-b' })
    )
  })

  it('fails empty without a complete viewer/room scope', async () => {
    const hook = renderHook(
      ({ userId, room }: { userId: string | null; room: Parameters<typeof usePresence>[2] }) =>
        usePresence(userId, ['peer'], room),
      {
        initialProps: { userId: null, room: { kind: 'conversation' as const, id: 'room-1' } },
      }
    )

    expect(mockChannels).toHaveLength(0)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)

    hook.rerender({ userId: 'user-a', room: null })
    expect(mockChannels).toHaveLength(0)
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)

    hook.rerender({ userId: 'user-a', room: { kind: 'conversation', id: '   ' } })
    expect(mockChannels).toHaveLength(0)
    expect(hook.result.current.getUserPresence('peer').isOnline).toBe(false)
  })

  it('keeps setup, tracking, and cleanup transport failures non-fatal', async () => {
    const setupFailure = new Error('subscribe failed')
    const originalChannelFactory = jest.requireMock('@/lib/supabase/client').supabase
      .channel as jest.Mock
    originalChannelFactory.mockImplementationOnce(
      (topic: string, options?: RealtimeChannelOptions) => {
        const channel = {
          topic,
          options,
          events: {},
          state: {},
          on: jest.fn(function (
            this: MockChannel,
            _kind: string,
            config: { event: string },
            callback: () => void
          ) {
            this.events[config.event] = callback
            return this
          }),
          subscribe: jest.fn(() => {
            throw setupFailure
          }),
          presenceState: jest.fn(() => ({})),
          track: jest.fn(),
          teardown: jest.fn(),
          unsubscribe: jest.fn().mockResolvedValue('ok'),
        } as unknown as MockChannel
        mockRegistry.push(channel)
        mockChannels.push(channel)
        return channel
      }
    )

    let brokenSetup!: ReturnType<typeof renderHook<ReturnType<typeof usePresence>, unknown>>
    expect(() => {
      brokenSetup = renderHook(() =>
        usePresence('user-a', ['peer'], { kind: 'conversation', id: 'setup-failure' })
      )
    }).not.toThrow()
    expect(brokenSetup.result.current.getUserPresence('peer').isOnline).toBe(false)
    await waitFor(() => expect(mockRegistry).toHaveLength(0))
    brokenSetup.unmount()

    const healthy = renderHook(() =>
      usePresence('user-a', ['peer'], { kind: 'conversation', id: 'transport-failure' })
    )
    const channel = mockChannels.at(-1)!
    channel.track.mockImplementation(() => {
      throw new Error('track failed')
    })

    expect(() => act(() => channel.status?.('SUBSCRIBED'))).not.toThrow()
    expect(() =>
      act(() => healthy.result.current.setTyping('transport-failure', true))
    ).not.toThrow()

    mockRemoveChannel.mockRejectedValueOnce(new Error('remove failed'))
    expect(() => healthy.unmount()).not.toThrow()
    await waitFor(() => expect(channel.teardown).toHaveBeenCalled())
  })
})
