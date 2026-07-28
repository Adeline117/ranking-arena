import {
  createClient as createSupabaseClient,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js'
import { RealtimeClient, type WebSocketLikeConstructor } from '@supabase/realtime-js'
import React, { StrictMode, useEffect, useId, useRef } from 'react'
import { render } from '@testing-library/react'
import { logger } from '@/lib/logger'
import {
  removeOwnedRealtimeChannels,
  subscribeOwnedRealtimeChannel,
  type OwnedRealtimeClient,
} from '../owned-channel'

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

type FailureStage = 'channel' | 'on' | 'subscribe'
type LeaveMode = 'ack' | 'ignore'
type SentFrame = {
  event: string
  topic: string
}
type TransportLifecycle = {
  closes: number
  opens: number
  sockets: number
}
let supabaseClientSequence = 0

function createControlledTransport(leaveMode: LeaveMode): {
  lifecycle: TransportLifecycle
  sentFrames: SentFrame[]
  transport: WebSocketLikeConstructor
} {
  const lifecycle: TransportLifecycle = { closes: 0, opens: 0, sockets: 0 }
  const sentFrames: SentFrame[] = []

  class ControlledWebSocket {
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readonly protocol = ''
    readonly url: string
    binaryType = 'arraybuffer'
    bufferedAmount = 0
    extensions = ''
    onclose: ((this: ControlledWebSocket, event: CloseEvent) => unknown) | null = null
    onerror: ((this: ControlledWebSocket, event: Event) => unknown) | null = null
    onmessage: ((this: ControlledWebSocket, event: MessageEvent) => unknown) | null = null
    onopen: ((this: ControlledWebSocket, event: Event) => unknown) | null = null
    readyState = this.CONNECTING

    constructor(address: string | URL, _subprotocols?: string | string[]) {
      lifecycle.sockets += 1
      this.url = String(address)
      void Promise.resolve().then(() => {
        if (this.readyState !== this.CONNECTING) return
        this.readyState = this.OPEN
        lifecycle.opens += 1
        this.onopen?.call(this, new Event('open'))
      })
    }

    addEventListener(): void {}

    close(): void {
      if (this.readyState === this.CLOSED) return
      this.readyState = this.CLOSED
      lifecycle.closes += 1
      this.onclose?.call(this, new Event('close') as CloseEvent)
    }

    dispatchEvent(): boolean {
      return true
    }

    removeEventListener(): void {}

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data !== 'string') throw new Error('Expected the default JSON transport encoder')
      const [joinRef, ref, topic, event] = JSON.parse(data) as [
        string | null,
        string | null,
        string,
        string,
        unknown,
      ]
      sentFrames.push({ event, topic })
      if (event !== 'phx_join' && (event !== 'phx_leave' || leaveMode !== 'ack')) return

      void Promise.resolve().then(() => {
        if (this.readyState !== this.OPEN) return
        const response = JSON.stringify([
          joinRef,
          ref,
          topic,
          'phx_reply',
          { response: {}, status: 'ok' },
        ])
        this.onmessage?.call(this, new MessageEvent('message', { data: response }))
      })
    }
  }

  return { lifecycle, sentFrames, transport: ControlledWebSocket }
}

function createLiveClient(leaveMode: LeaveMode = 'ack'): {
  client: RealtimeClient
  lifecycle: TransportLifecycle
  sentFrames: SentFrame[]
} {
  const controlled = createControlledTransport(leaveMode)
  return {
    client: new RealtimeClient('ws://realtime.test/realtime/v1', {
      heartbeatIntervalMs: 60_000,
      params: { apikey: 'owned-channel-test' },
      timeout: 500,
      transport: controlled.transport,
    }),
    lifecycle: controlled.lifecycle,
    sentFrames: controlled.sentFrames,
  }
}

function createLiveSupabaseClient(leaveMode: LeaveMode = 'ack'): {
  client: SupabaseClient
  lifecycle: TransportLifecycle
  sentFrames: SentFrame[]
} {
  const controlled = createControlledTransport(leaveMode)
  return {
    client: createSupabaseClient(
      'https://owned-channel-test.supabase.co',
      'owned-channel-test-anon-key',
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
          storageKey: `owned-channel-test-${++supabaseClientSequence}`,
        },
        realtime: {
          heartbeatIntervalMs: 60_000,
          timeout: 500,
          transport: controlled.transport,
        },
      }
    ),
    lifecycle: controlled.lifecycle,
    sentFrames: controlled.sentFrames,
  }
}

function createClient(failure?: { stage: FailureStage; topicPrefix?: string }): RealtimeClient {
  const client = new RealtimeClient('ws://127.0.0.1:65535/realtime/v1', {
    params: { apikey: 'owned-channel-test' },
  })
  const createChannel = client.channel.bind(client)

  jest.spyOn(client, 'channel').mockImplementation((topic, params) => {
    const channel = createChannel(topic, params)
    const shouldFail =
      failure?.stage && (!failure.topicPrefix || topic.startsWith(failure.topicPrefix))
    const mutable = channel as unknown as {
      on: (...args: unknown[]) => RealtimeChannel
      subscribe: (...args: unknown[]) => RealtimeChannel
    }

    if (shouldFail && failure.stage === 'channel') {
      // Model a dependency that registers first and then throws before the
      // caller can receive its handle.
      throw new Error('channel failed after registration')
    }
    if (shouldFail && failure.stage === 'on') {
      mutable.on = jest.fn(() => {
        throw new Error('on failed')
      })
    }
    mutable.subscribe =
      shouldFail && failure.stage === 'subscribe'
        ? jest.fn(() => {
            throw new Error('subscribe failed')
          })
        : jest.fn(() => channel)
    return channel
  })

  return client
}

function subscribe(client: OwnedRealtimeClient, topic: string): RealtimeChannel | null {
  return subscribeOwnedRealtimeChannel({
    client,
    configure: (channel) => {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        () => {}
      )
    },
    context: `test:${topic}`,
    topic,
  })
}

function addPhysicalSameTopicPeer(
  client: RealtimeClient,
  owned: RealtimeChannel,
  topic: string
): RealtimeChannel {
  const registry = client.getChannels()
  const ownedIndex = registry.indexOf(owned)
  if (ownedIndex === -1) throw new Error('Owned channel is not registered')

  // RealtimeClient.channel intentionally reuses an existing topic. Briefly
  // remove the owned object so the installed client creates a second physical
  // channel, then restore both to model a dependency-level duplicate.
  registry.splice(ownedIndex, 1)
  const peer = subscribe(client, topic)
  if (!peer || peer === owned) throw new Error('Failed to create a physical same-topic peer')
  registry.splice(ownedIndex, 0, owned)
  return peer
}

function addUnsubscribedPhysicalSameTopicPeer(
  client: RealtimeClient,
  owned: RealtimeChannel,
  topic: string
): RealtimeChannel {
  const registry = client.getChannels()
  const ownedIndex = registry.indexOf(owned)
  if (ownedIndex === -1) throw new Error('Owned channel is not registered')

  registry.splice(ownedIndex, 1)
  const peer = client.channel(topic)
  if (peer === owned) throw new Error('Failed to create a physical same-topic peer')
  registry.splice(ownedIndex, 0, owned)
  return peer
}

type PhoenixTestChannel = {
  bindings: unknown[]
  joinPush: {
    timeoutTimer: unknown
  }
  pushBuffer: unknown[]
  socket: {
    channels: PhoenixTestChannel[]
    stateChangeCallbacks: Record<string, Array<[string, (...args: unknown[]) => unknown]>>
  }
  state: string
  stateChangeRefs: string[]
}

function phoenixChannel(channel: RealtimeChannel): PhoenixTestChannel {
  const adapter = Reflect.get(channel, 'channelAdapter')
  return Reflect.apply(Reflect.get(adapter, 'getChannel'), adapter, []) as PhoenixTestChannel
}

function phoenixChannels(client: RealtimeClient): PhoenixTestChannel[] {
  const adapter = Reflect.get(client, 'socketAdapter')
  const socket = Reflect.apply(Reflect.get(adapter, 'getSocket'), adapter, [])
  return Reflect.get(socket, 'channels') as PhoenixTestChannel[]
}

function expectPhoenixChannelTerminated(client: RealtimeClient, channel: RealtimeChannel): void {
  const retired = phoenixChannel(channel)
  expect(channel.bindings).toEqual({})
  expect(phoenixChannels(client)).not.toContain(retired)
  expect(retired.bindings).toHaveLength(0)
  expect(retired.joinPush.timeoutTimer).toBeNull()
  expect(retired.pushBuffer).toHaveLength(0)
  expect(retired.state).toBe('closed')

  const liveStateChangeRefs = Object.values(retired.socket.stateChangeCallbacks)
    .flat()
    .map(([ref]) => ref)
  for (const ref of retired.stateChangeRefs) {
    expect(liveStateChangeRefs).not.toContain(ref)
  }
}

async function flushPromiseHandlers(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

function RealtimeHarness({ client, label }: { client: RealtimeClient; label: string }): null {
  const ownerId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || label
  const attemptRef = useRef(0)

  useEffect(() => {
    const channel = subscribe(client, `${label}:${ownerId}:${++attemptRef.current}`)
    return () => {
      void removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [channel], `${label}:cleanup`)
    }
  }, [client, label, ownerId])

  return null
}

describe('owned realtime channel lifecycle with the installed realtime client', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(logger.warn).mockReset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it.each(['channel', 'on', 'subscribe'] as const)(
    'removes its physical registration after a synchronous %s failure',
    async (failureStage) => {
      const client = createClient({ stage: failureStage })
      const unhandledRejection = jest.fn()
      process.on('unhandledRejection', unhandledRejection)

      try {
        expect(subscribe(client, `fault:${failureStage}`)).toBeNull()
        // Rollback eviction is synchronous even though network leave is
        // deliberately best-effort.
        expect(client.getChannels()).toHaveLength(0)
        await flushPromiseHandlers()
        expect(unhandledRejection).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', unhandledRejection)
      }
    }
  )

  it('runs real subscribe/leave and removes both installed registries on normal cleanup', async () => {
    const { client, sentFrames } = createLiveClient('ack')
    const channel = subscribe(client, 'live-normal-cleanup')
    expect(channel).not.toBeNull()
    expect(jest.isMockFunction(channel!.subscribe)).toBe(false)
    await flushPromiseHandlers()

    expect(channel!.state).toBe('joined')
    expect(client.getChannels()).toEqual([channel])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(channel!)])

    const unsubscribe = jest.spyOn(channel!, 'unsubscribe')
    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:live-normal-cleanup'
    )

    expect(client.getChannels()).toHaveLength(0)
    expect(unsubscribe).toHaveBeenCalledWith(500)
    await flushPromiseHandlers()
    expect(phoenixChannels(client)).toHaveLength(0)
    expectPhoenixChannelTerminated(client, channel!)
    expect(sentFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'phx_join' }),
        expect.objectContaining({ event: 'phx_leave' }),
      ])
    )
  })

  it('disconnects and later reconnects the transport owned by a production SupabaseClient', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const disconnect = jest.spyOn(client.realtime, 'disconnect')
    const channel = subscribe(client, 'supabase-wrapper-last-channel')
    expect(channel).not.toBeNull()
    await flushPromiseHandlers()

    expect(channel!.state).toBe('joined')
    expect(client.getChannels()).toEqual([channel])
    expect(client.realtime.isConnected()).toBe(true)
    expect(lifecycle).toEqual({ closes: 0, opens: 1, sockets: 1 })

    await removeOwnedRealtimeChannels(client, [channel], 'test:supabase-wrapper-last-channel')
    await flushPromiseHandlers()

    expect(client.getChannels()).toHaveLength(0)
    expect(phoenixChannels(client.realtime)).toHaveLength(0)
    expect(client.realtime.isConnected()).toBe(false)
    expect(lifecycle).toEqual({ closes: 1, opens: 1, sockets: 1 })
    expect(disconnect).toHaveBeenCalledTimes(1)

    const opensBeforeResubscribe = lifecycle.opens
    const nextChannel = subscribe(client, 'supabase-wrapper-after-disconnect')
    expect(nextChannel).not.toBeNull()
    await flushPromiseHandlers()

    expect(nextChannel!.state).toBe('joined')
    expect(client.realtime.isConnected()).toBe(true)
    expect(lifecycle.opens).toBe(opensBeforeResubscribe + 1)
    expect(lifecycle.sockets).toBe(2)

    await removeOwnedRealtimeChannels(
      client,
      [nextChannel],
      'test:supabase-wrapper-after-disconnect'
    )
    await flushPromiseHandlers()
    expect(client.realtime.isConnected()).toBe(false)
    expect(lifecycle.closes).toBe(2)
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it.each(['pending', 'reject', 'throw'] as const)(
    'disconnects a production SupabaseClient exactly once after bounded %s leave cleanup',
    async (failureMode) => {
      const { client, lifecycle } = createLiveSupabaseClient('ack')
      const channel = subscribe(client, `supabase-wrapper-leave-${failureMode}`)
      expect(channel).not.toBeNull()
      await flushPromiseHandlers()
      expect(channel!.state).toBe('joined')

      const disconnect = jest.spyOn(client.realtime, 'disconnect')
      if (failureMode === 'pending') {
        jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => new Promise(() => {}))
      } else if (failureMode === 'reject') {
        jest.spyOn(channel!, 'unsubscribe').mockRejectedValue(new Error('unsubscribe rejected'))
      } else {
        jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => {
          throw new Error('unsubscribe threw')
        })
      }

      await removeOwnedRealtimeChannels(
        client,
        [channel],
        `test:supabase-wrapper-leave-${failureMode}`
      )
      expect(client.getChannels()).toHaveLength(0)

      if (failureMode === 'pending') {
        expect(phoenixChannels(client.realtime)).toHaveLength(1)
        expect(client.realtime.isConnected()).toBe(true)
        expect(disconnect).not.toHaveBeenCalled()
        expect(lifecycle.closes).toBe(0)

        jest.advanceTimersByTime(999)
        expect(disconnect).not.toHaveBeenCalled()
        jest.advanceTimersByTime(1)
      }
      await flushPromiseHandlers()

      expect(phoenixChannels(client.realtime)).toHaveLength(0)
      expectPhoenixChannelTerminated(client.realtime, channel!)
      expect(client.realtime.isConnected()).toBe(false)
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(lifecycle.closes).toBe(1)

      jest.advanceTimersByTime(5_000)
      await flushPromiseHandlers()
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(lifecycle.closes).toBe(1)
    }
  )

  it('waits for every owned inner channel before disconnecting a production wrapper', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const normal = subscribe(client, 'supabase-wrapper-batch-normal')
    const pending = subscribe(client, 'supabase-wrapper-batch-pending')
    expect(normal).not.toBeNull()
    expect(pending).not.toBeNull()
    await flushPromiseHandlers()

    jest.spyOn(pending!, 'unsubscribe').mockImplementation(() => new Promise(() => {}))
    const disconnect = jest.spyOn(client.realtime, 'disconnect')
    await removeOwnedRealtimeChannels(client, [normal, pending], 'test:supabase-wrapper-batch')
    await flushPromiseHandlers()

    expect(client.getChannels()).toHaveLength(0)
    expect(phoenixChannels(client.realtime)).toEqual([phoenixChannel(pending!)])
    expect(client.realtime.isConnected()).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
    expect(lifecycle.closes).toBe(0)

    jest.advanceTimersByTime(999)
    expect(disconnect).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    await flushPromiseHandlers()

    expect(phoenixChannels(client.realtime)).toHaveLength(0)
    expect(client.realtime.isConnected()).toBe(false)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle.closes).toBe(1)
  })

  it('does not disconnect a production SupabaseClient while any peer remains', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const owned = subscribe(client, 'supabase-wrapper-owned')
    const peer = subscribe(client, 'supabase-wrapper-peer')
    expect(owned).not.toBeNull()
    expect(peer).not.toBeNull()
    await flushPromiseHandlers()

    const disconnect = jest.spyOn(client.realtime, 'disconnect')
    await removeOwnedRealtimeChannels(client, [owned], 'test:supabase-wrapper-owned')
    await flushPromiseHandlers()

    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client.realtime)).toEqual([phoenixChannel(peer!)])
    expect(peer!.state).toBe('joined')
    expect(client.realtime.isConnected()).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
    expect(lifecycle.closes).toBe(0)

    await removeOwnedRealtimeChannels(client, [peer], 'test:supabase-wrapper-peer')
    await flushPromiseHandlers()
    expect(client.realtime.isConnected()).toBe(false)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle.closes).toBe(1)
  })

  it('does not disconnect a production SupabaseClient when a peer arrives during leave', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const owned = subscribe(client, 'supabase-wrapper-late-owned')
    expect(owned).not.toBeNull()
    await flushPromiseHandlers()

    const actualUnsubscribe = owned!.unsubscribe.bind(owned!)
    let releaseLeave: (() => void) | null = null
    const leaveGate = new Promise<void>((resolve) => {
      releaseLeave = resolve
    })
    let lateLeave: Promise<unknown> | null = null
    jest.spyOn(owned!, 'unsubscribe').mockImplementation((timeout) => {
      lateLeave = leaveGate.then(() => actualUnsubscribe(timeout))
      return lateLeave
    })
    const disconnect = jest.spyOn(client.realtime, 'disconnect')

    await removeOwnedRealtimeChannels(client, [owned], 'test:supabase-wrapper-late-owned')
    expect(client.getChannels()).toHaveLength(0)

    const peer = subscribe(client, 'supabase-wrapper-late-peer')
    expect(peer).not.toBeNull()
    await flushPromiseHandlers()
    expect(peer!.state).toBe('joined')

    releaseLeave!()
    await lateLeave
    await flushPromiseHandlers()

    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client.realtime)).toEqual([phoenixChannel(peer!)])
    expect(client.realtime.isConnected()).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
    expect(lifecycle.closes).toBe(0)

    await removeOwnedRealtimeChannels(client, [peer], 'test:supabase-wrapper-late-peer')
    await flushPromiseHandlers()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle.closes).toBe(1)
  })

  it('bounds setup rollback and disconnects a production SupabaseClient only once', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const createChannel = client.channel.bind(client)
    let attemptedChannel: RealtimeChannel | null = null
    jest.spyOn(client, 'channel').mockImplementation((topic, params) => {
      const channel = createChannel(topic, params)
      attemptedChannel = channel
      const actualSubscribe = channel.subscribe.bind(channel)
      jest.spyOn(channel, 'subscribe').mockImplementation((callback, timeout) => {
        actualSubscribe(callback, timeout)
        throw new Error('subscribe failed after connection started')
      })
      return channel
    })
    const disconnect = jest.spyOn(client.realtime, 'disconnect')

    expect(subscribe(client, 'supabase-wrapper-setup-rollback')).toBeNull()
    expect(client.getChannels()).toHaveLength(0)
    await flushPromiseHandlers()

    expect(attemptedChannel).not.toBeNull()
    expect(phoenixChannels(client.realtime)).toHaveLength(0)
    expectPhoenixChannelTerminated(client.realtime, attemptedChannel!)
    expect(client.realtime.isConnected()).toBe(false)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle).toEqual({ closes: 1, opens: 1, sockets: 1 })

    jest.advanceTimersByTime(5_000)
    await flushPromiseHandlers()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle.closes).toBe(1)
  })

  it('does not disconnect a production SupabaseClient peer during setup rollback', async () => {
    const { client, lifecycle } = createLiveSupabaseClient('ack')
    const peer = subscribe(client, 'supabase-wrapper-rollback-peer')
    expect(peer).not.toBeNull()
    await flushPromiseHandlers()
    const disconnect = jest.spyOn(client.realtime, 'disconnect')

    const failed = subscribeOwnedRealtimeChannel({
      client,
      configure: () => {
        throw new Error('configuration failed')
      },
      context: 'test:supabase-wrapper-peer-rollback',
      topic: 'supabase-wrapper-failed-channel',
    })
    expect(failed).toBeNull()
    await flushPromiseHandlers()

    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client.realtime)).toEqual([phoenixChannel(peer!)])
    expect(peer!.state).toBe('joined')
    expect(client.realtime.isConnected()).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
    expect(lifecycle.closes).toBe(0)

    await removeOwnedRealtimeChannels(client, [peer], 'test:supabase-wrapper-rollback-peer')
    await flushPromiseHandlers()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(lifecycle.closes).toBe(1)
  })

  it.each(['throw', 'reject'] as const)(
    'force-terminates the installed Phoenix registration when unsubscribe %s',
    async (failureMode) => {
      const { client } = createLiveClient('ack')
      const channel = subscribe(client, `live-unsubscribe-${failureMode}`)
      expect(channel).not.toBeNull()
      await flushPromiseHandlers()
      expect(phoenixChannels(client)).toHaveLength(1)

      if (failureMode === 'throw') {
        jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => {
          throw new Error('unsubscribe threw')
        })
      } else {
        jest.spyOn(channel!, 'unsubscribe').mockRejectedValue(new Error('unsubscribe rejected'))
      }
      const unhandledRejection = jest.fn()
      process.on('unhandledRejection', unhandledRejection)

      try {
        await removeOwnedRealtimeChannels(
          client as OwnedRealtimeClient,
          [channel],
          `test:live-unsubscribe-${failureMode}`
        )
        await flushPromiseHandlers()

        expect(client.getChannels()).toHaveLength(0)
        expect(phoenixChannels(client)).toHaveLength(0)
        expectPhoenixChannelTerminated(client, channel!)
        expect(unhandledRejection).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', unhandledRejection)
      }
    }
  )

  it('force-terminates a permanently pending unsubscribe at the bounded fallback', async () => {
    const { client } = createLiveClient('ack')
    const channel = subscribe(client, 'live-unsubscribe-pending')
    expect(channel).not.toBeNull()
    await flushPromiseHandlers()
    const unsubscribe = jest
      .spyOn(channel!, 'unsubscribe')
      .mockImplementation(() => new Promise(() => {}))

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:live-unsubscribe-pending'
    )

    expect(client.getChannels()).toHaveLength(0)
    expect(phoenixChannels(client)).toHaveLength(1)
    expect(unsubscribe).toHaveBeenCalledWith(500)
    jest.advanceTimersByTime(999)
    expect(phoenixChannels(client)).toHaveLength(1)

    jest.advanceTimersByTime(1)
    expect(phoenixChannels(client)).toHaveLength(0)
    expectPhoenixChannelTerminated(client, channel!)
  })

  it('leaves only the physical owned channel when a same-topic peer already exists', async () => {
    const { client, sentFrames } = createLiveClient('ack')
    const channel = subscribe(client, 'live-same-topic-existing-peer')
    expect(channel).not.toBeNull()
    await flushPromiseHandlers()
    const peer = addUnsubscribedPhysicalSameTopicPeer(
      client,
      channel!,
      'live-same-topic-existing-peer'
    )
    const removeChannel = jest.spyOn(client, 'removeChannel')
    const unsubscribe = jest.spyOn(channel!, 'unsubscribe')

    expect(client.getChannels()).toEqual([channel, peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(channel!), phoenixChannel(peer)])

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:live-same-topic-existing-peer'
    )

    expect(client.getChannels()).toEqual([peer])
    expect(removeChannel).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledWith(500)
    await flushPromiseHandlers()
    expect(phoenixChannels(client)).toEqual([phoenixChannel(peer)])
    expectPhoenixChannelTerminated(client, channel!)
    expect(sentFrames.filter(({ event }) => event === 'phx_leave')).toHaveLength(1)

    peer.subscribe()
    await flushPromiseHandlers()
    expect(peer.state).toBe('joined')
    await removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [peer], 'test:peer-cleanup')
    await flushPromiseHandlers()
  })

  it('preserves a same-topic peer added before the gated real leave starts', async () => {
    const { client } = createLiveClient('ack')
    const channel = subscribe(client, 'live-same-topic-late-peer')
    expect(channel).not.toBeNull()
    await flushPromiseHandlers()
    expect(channel!.state).toBe('joined')

    const actualUnsubscribe = channel!.unsubscribe.bind(channel!)
    let releaseLeave: (() => void) | null = null
    const leaveGate = new Promise<void>((resolve) => {
      releaseLeave = resolve
    })
    let lateLeave: Promise<unknown> | null = null
    jest.spyOn(channel!, 'unsubscribe').mockImplementation((timeout) => {
      lateLeave = leaveGate.then(() => actualUnsubscribe(timeout))
      return lateLeave
    })

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:live-same-topic-late-peer'
    )
    expect(client.getChannels()).toHaveLength(0)
    expect(phoenixChannels(client)).toEqual([phoenixChannel(channel!)])

    const peer = client.channel('live-same-topic-late-peer')
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(channel!), phoenixChannel(peer)])

    releaseLeave!()
    await lateLeave
    await flushPromiseHandlers()
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(peer)])
    expectPhoenixChannelTerminated(client, channel!)

    peer.subscribe()
    await flushPromiseHandlers()
    expect(peer.state).toBe('joined')

    await removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [peer], 'test:peer-cleanup')
    await flushPromiseHandlers()
  })

  it('preserves a late peer through fallback and a still-later real leave', async () => {
    const { client } = createLiveClient('ack')
    const channel = subscribe(client, 'live-same-topic-late-fallback')
    expect(channel).not.toBeNull()
    await flushPromiseHandlers()

    const actualUnsubscribe = channel!.unsubscribe.bind(channel!)
    let releaseLeave: (() => void) | null = null
    const leaveGate = new Promise<void>((resolve) => {
      releaseLeave = resolve
    })
    let lateLeave: Promise<unknown> | null = null
    jest.spyOn(channel!, 'unsubscribe').mockImplementation((timeout) => {
      lateLeave = leaveGate.then(() => actualUnsubscribe(timeout))
      return lateLeave
    })

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:live-same-topic-late-fallback'
    )
    const peer = client.channel('live-same-topic-late-fallback')
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(channel!), phoenixChannel(peer)])

    jest.advanceTimersByTime(1_000)
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(peer)])
    expectPhoenixChannelTerminated(client, channel!)

    peer.subscribe()
    await flushPromiseHandlers()
    expect(peer.state).toBe('joined')

    releaseLeave!()
    await lateLeave
    await flushPromiseHandlers()
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(peer)])

    await removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [peer], 'test:peer-cleanup')
    await flushPromiseHandlers()
  })

  it('evicts synchronously while normal cleanup still attempts unsubscribe and teardown', async () => {
    const client = createClient()
    const channel = subscribe(client, 'normal-cleanup')
    expect(channel).not.toBeNull()
    const unsubscribe = jest.spyOn(channel!, 'unsubscribe')
    const teardown = jest.spyOn(channel!, 'teardown')

    const cleanup = removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:normal-cleanup'
    )

    expect(client.getChannels()).toHaveLength(0)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await cleanup
    await flushPromiseHandlers()
    expect(teardown).toHaveBeenCalled()
  })

  it.each(['sync-throw', 'rejection'] as const)(
    'evicts synchronously and consumes an unsubscribe %s',
    async (failureMode) => {
      const client = createClient()
      const channel = subscribe(client, `unsubscribe:${failureMode}`)
      expect(channel).not.toBeNull()
      const teardown = jest.spyOn(channel!, 'teardown')
      const unhandledRejection = jest.fn()
      process.on('unhandledRejection', unhandledRejection)

      if (failureMode === 'sync-throw') {
        jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => {
          throw new Error('synchronous unsubscribe failure')
        })
      } else {
        jest.spyOn(channel!, 'unsubscribe').mockRejectedValue(new Error('unsubscribe rejected'))
      }

      try {
        const cleanup = removeOwnedRealtimeChannels(
          client as OwnedRealtimeClient,
          [channel],
          `test:${failureMode}`
        )
        expect(client.getChannels()).toHaveLength(0)
        await cleanup
        await flushPromiseHandlers()

        expect(teardown).toHaveBeenCalled()
        expect(unhandledRejection).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', unhandledRejection)
      }
    }
  )

  it('does not let diagnostic logging turn cleanup failures into throws', () => {
    const client = createClient()
    const channel = subscribe(client, 'logger-throws')
    expect(channel).not.toBeNull()
    jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => {
      throw new Error('unsubscribe failed')
    })
    jest.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger failed')
    })

    expect(() =>
      removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [channel], 'test:logger-throws')
    ).not.toThrow()
    expect(client.getChannels()).toHaveLength(0)
  })

  it('has a bounded teardown path when unsubscribe never settles', async () => {
    const client = createClient()
    const channel = subscribe(client, 'remove:pending')
    expect(channel).not.toBeNull()
    const unsubscribe = jest
      .spyOn(channel!, 'unsubscribe')
      .mockImplementation(() => new Promise(() => {}))
    const teardown = jest.spyOn(channel!, 'teardown')

    const cleanup = removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:pending'
    )

    expect(client.getChannels()).toHaveLength(0)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(cleanup).resolves.toBeUndefined()
    expect(teardown).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(client.getChannels()).toHaveLength(0)
    expect(phoenixChannels(client)).toHaveLength(0)
  })

  it.each(['unsubscribe-throw', 'unsubscribe-reject', 'teardown-throw'] as const)(
    'keeps cleanup terminal when channel %s fails',
    async (failureMode) => {
      const client = createClient()
      const channel = subscribe(client, `channel:${failureMode}`)
      expect(channel).not.toBeNull()
      const unhandledRejection = jest.fn()
      process.on('unhandledRejection', unhandledRejection)

      if (failureMode === 'unsubscribe-throw') {
        jest.spyOn(channel!, 'unsubscribe').mockImplementation(() => {
          throw new Error('unsubscribe threw')
        })
      } else if (failureMode === 'unsubscribe-reject') {
        jest.spyOn(channel!, 'unsubscribe').mockRejectedValue(new Error('unsubscribe rejected'))
      } else {
        jest.spyOn(channel!, 'teardown').mockImplementation(() => {
          throw new Error('teardown threw')
        })
      }

      try {
        await expect(
          removeOwnedRealtimeChannels(
            client as OwnedRealtimeClient,
            [channel],
            `test:${failureMode}`
          )
        ).resolves.toBeUndefined()
        expect(client.getChannels()).toHaveLength(0)
        await flushPromiseHandlers()
        expect(unhandledRejection).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', unhandledRejection)
      }
    }
  )

  it('uses exact registry identity without calling the topic-wide internal _remove hook', async () => {
    const client = createClient()
    const channel = subscribe(client, 'internal-remove-failure')
    const peer = subscribe(client, 'peer-must-survive')
    expect(channel).not.toBeNull()
    expect(peer).not.toBeNull()
    const internalRemove = jest.spyOn(client, '_remove').mockImplementation(() => {
      throw new Error('internal remove failed')
    })

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:identity-fallback'
    )

    expect(client.getChannels()).toEqual([peer])
    expect(internalRemove).not.toHaveBeenCalled()
  })

  it('skips public removal when a physical same-topic peer already exists', async () => {
    const client = createClient()
    const channel = subscribe(client, 'same-topic-existing-peer')
    expect(channel).not.toBeNull()
    const peer = addPhysicalSameTopicPeer(client, channel!, 'same-topic-existing-peer')
    const removeChannel = jest.spyOn(client, 'removeChannel')
    const teardown = jest.spyOn(channel!, 'teardown')

    const cleanup = removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [channel],
      'test:same-topic-existing-peer'
    )

    expect(client.getChannels()).toEqual([peer])
    expect(removeChannel).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()

    await cleanup
    await flushPromiseHandlers()
    expect(client.getChannels()).toEqual([peer])
    expect(phoenixChannels(client)).toEqual([phoenixChannel(peer!)])
    expect(teardown).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(1_000)
    expect(client.getChannels()).toEqual([peer])
  })

  it('keeps two component instances on separate physical topics and cleans them independently', async () => {
    const client = createClient()
    const first = subscribe(client, 'inbox:user-b:2:instance-a:1')
    const second = subscribe(client, 'inbox:user-b:2:instance-b:1')

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    expect(client.getChannels()).toHaveLength(2)

    await removeOwnedRealtimeChannels(client as OwnedRealtimeClient, [first], 'test:first-cleanup')
    expect(client.getChannels()).toEqual([second])

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [second],
      'test:second-cleanup'
    )
    expect(client.getChannels()).toHaveLength(0)
  })

  it('keeps two StrictMode instances physically separate and evicts replayed effects', async () => {
    const client = createClient()
    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(RealtimeHarness, { client, label: 'strict-a' }),
        React.createElement(RealtimeHarness, { client, label: 'strict-b' })
      )
    )

    const activeChannels = client.getChannels()
    expect(activeChannels).toHaveLength(2)
    expect(new Set(activeChannels.map((channel) => channel.topic))).toHaveProperty('size', 2)

    view.unmount()
    expect(client.getChannels()).toHaveLength(0)
    await flushPromiseHandlers()
  })

  it('never configures or removes a channel that already belongs to another instance', async () => {
    const client = createClient()
    const existing = subscribe(client, 'collision')
    const configure = jest.fn()
    const removeChannel = jest.spyOn(client, 'removeChannel')

    const collision = subscribeOwnedRealtimeChannel({
      client: client as OwnedRealtimeClient,
      configure,
      context: 'test:collision',
      topic: 'collision',
    })

    expect(collision).toBeNull()
    expect(configure).not.toHaveBeenCalled()
    expect(client.getChannels()).toEqual([existing])
    expect(removeChannel).not.toHaveBeenCalled()
    await flushPromiseHandlers()
    expect(client.getChannels()).toEqual([existing])

    await removeOwnedRealtimeChannels(
      client as OwnedRealtimeClient,
      [existing],
      'test:collision-owner-cleanup'
    )
    expect(client.getChannels()).toHaveLength(0)
  })

  it('rolls back a failed registration and consumes a later owned unsubscribe rejection', async () => {
    const client = createClient({ stage: 'subscribe', topicPrefix: 'messages:' })
    const notification = subscribe(client, 'notifications:user-b:2:top-nav:1')
    expect(notification).not.toBeNull()
    jest
      .spyOn(notification!, 'unsubscribe')
      .mockRejectedValue(new Error('notification unsubscribe rejected'))
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const message = subscribe(client, 'messages:user-b:2:top-nav:1')
      expect(message).toBeNull()
      expect(client.getChannels()).toEqual([notification])

      await removeOwnedRealtimeChannels(
        client as OwnedRealtimeClient,
        [notification],
        'test:notification-rollback'
      )
      expect(client.getChannels()).toHaveLength(0)
      await flushPromiseHandlers()
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })
})
