import type { RealtimeChannel, RealtimeClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

type OwnedRealtimeChannelClient = Pick<RealtimeClient, 'channel' | 'getChannels' | 'removeChannel'>

type OwnedRealtimeTransport = Pick<
  RealtimeClient,
  'disconnect' | 'getChannels' | 'isConnected' | 'isConnecting' | 'isDisconnecting'
>

/**
 * Production callers use SupabaseClient, whose channel methods delegate to
 * `.realtime`; lower-level callers can pass RealtimeClient directly.
 */
export type OwnedRealtimeClient =
  | (OwnedRealtimeChannelClient & OwnedRealtimeTransport & { realtime?: undefined })
  | (OwnedRealtimeChannelClient & { realtime: OwnedRealtimeTransport })

type RealtimeRegistryOwner = {
  _remove?: (channel: RealtimeChannel) => unknown
}

type PhoenixSocket = {
  channels?: PhoenixChannel[]
  off?: (refs: string[]) => unknown
  remove?: (channel: PhoenixChannel) => unknown
}

type PhoenixChannel = {
  bindings?: unknown[]
  joinPush?: {
    timeoutTimer?: unknown
  }
  pushBuffer?: unknown[]
  socket?: PhoenixSocket
  state?: string
  stateChangeRefs?: string[]
  teardown?: () => unknown
}

type RegistryEviction = {
  evicted: boolean
  hasSameTopicPeer: boolean
  wasRegistered: boolean | null
}

type CloseHookIsolation = 'isolated' | 'unavailable' | 'failed'

type InstalledLeaveState = {
  channel: RealtimeChannel | null
  cleanupFinished: boolean
  client: OwnedRealtimeClient | null
  context: string | null
  fallbackTimer: ReturnType<typeof setTimeout> | null
  phoenixChannel: PhoenixChannel | null
}

const LEAVE_TIMEOUT_MS = 500
const TEARDOWN_FALLBACK_MS = 1_000

function logRealtimeFailure(context: string, error: unknown): void {
  try {
    logger.warn(`[Realtime] ${context}`, error)
  } catch {
    // Diagnostics must never turn best-effort realtime cleanup into a crash.
  }
}

function readRegistry(
  client: Pick<RealtimeClient, 'getChannels'>,
  context: string
): RealtimeChannel[] | null {
  try {
    return client.getChannels()
  } catch (error) {
    logRealtimeFailure(`${context}:registry-read`, error)
    return null
  }
}

/**
 * Remove only the exact physical object owned by this subscription.
 *
 * RealtimeClient._remove currently removes by topic rather than identity. It
 * must never be used here: a peer can be added between cleanup beginning and
 * the old channel's leave completing. The installed client returns its live
 * channel array from getChannels(), so an identity splice is both immediate
 * and peer-safe.
 */
function evictOwnedChannelFromRegistry(
  client: OwnedRealtimeClient,
  channel: RealtimeChannel,
  context: string
): RegistryEviction {
  const initialRegistry = readRegistry(client, context)
  if (!initialRegistry) {
    return { evicted: false, hasSameTopicPeer: false, wasRegistered: null }
  }

  const hasSameTopicPeer = initialRegistry.some(
    (candidate) => candidate !== channel && candidate.topic === channel.topic
  )
  if (!initialRegistry.some((candidate) => candidate === channel)) {
    return { evicted: true, hasSameTopicPeer, wasRegistered: false }
  }

  try {
    for (let index = initialRegistry.length - 1; index >= 0; index -= 1) {
      if (initialRegistry[index] === channel) initialRegistry.splice(index, 1)
    }
  } catch (error) {
    logRealtimeFailure(`${context}:registry-identity-remove`, error)
  }

  const finalRegistry = readRegistry(client, context)
  const retained =
    finalRegistry === null || finalRegistry.some((candidate) => candidate === channel)
  const finalHasSameTopicPeer =
    finalRegistry?.some(
      (candidate) => candidate !== channel && candidate.topic === channel.topic
    ) ?? hasSameTopicPeer

  if (retained) {
    logRealtimeFailure(
      `${context}:registry-retained`,
      new Error('Owned realtime channel remained registered after cleanup')
    )
  }

  return {
    evicted: !retained,
    hasSameTopicPeer: finalHasSameTopicPeer,
    wasRegistered: true,
  }
}

/**
 * Repoint this dead channel's close hook before starting leave.
 *
 * The installed dependency's close callback reads `this.socket` at callback
 * time. Keeping an isolated owner on the retired channel means a delayed
 * `phx_close` cannot call the real client's topic-wide `_remove` and erase a
 * peer created after cleanup began.
 */
function isolateOwnedChannelCloseHook(
  channel: RealtimeChannel,
  context: string
): CloseHookIsolation {
  const registryOwner = channel.socket
  if (!registryOwner) return 'unavailable'

  try {
    const isolatedRegistryOwner = Object.create(registryOwner) as RealtimeRegistryOwner
    Object.defineProperty(isolatedRegistryOwner, '_remove', {
      configurable: false,
      enumerable: false,
      value: () => undefined,
      writable: false,
    })
    Object.defineProperty(channel, 'socket', {
      configurable: true,
      enumerable: true,
      value: isolatedRegistryOwner,
      writable: true,
    })
    return channel.socket === isolatedRegistryOwner ? 'isolated' : 'failed'
  } catch (error) {
    logRealtimeFailure(`${context}:close-hook-isolation`, error)
    return 'failed'
  }
}

function readPhoenixChannel(channel: RealtimeChannel, context: string): PhoenixChannel | null {
  try {
    const adapter = Reflect.get(channel, 'channelAdapter')
    if (!adapter || typeof adapter !== 'object') return null
    const getChannel = Reflect.get(adapter, 'getChannel')
    if (typeof getChannel !== 'function') return null
    const phoenixChannel = Reflect.apply(getChannel, adapter, [])
    return phoenixChannel && typeof phoenixChannel === 'object'
      ? (phoenixChannel as PhoenixChannel)
      : null
  } catch (error) {
    logRealtimeFailure(`${context}:phoenix-channel-read`, error)
    return null
  }
}

function teardownOwnedChannel(channel: RealtimeChannel, context: string): void {
  const teardown = channel.teardown
  try {
    if (typeof teardown === 'function') teardown.call(channel)
  } catch (error) {
    logRealtimeFailure(`${context}:teardown`, error)
  }

  try {
    const bindings = Reflect.get(channel, 'bindings')
    if (bindings && typeof bindings === 'object') {
      for (const bindingType of Reflect.ownKeys(bindings)) {
        Reflect.deleteProperty(bindings, bindingType)
      }
    }
  } catch (error) {
    logRealtimeFailure(`${context}:binding-release`, error)
  }
}

/**
 * Terminate the exact dependency-level Phoenix channel.
 *
 * Phoenix Socket.remove is identity-based and also unregisters the channel's
 * socket state listeners. The explicit identity splice/off fallback covers a
 * fault-injected or changed implementation without ever matching by topic.
 */
function terminatePhoenixChannel(phoenixChannel: PhoenixChannel, context: string): boolean {
  try {
    phoenixChannel.teardown?.call(phoenixChannel)
  } catch (error) {
    logRealtimeFailure(`${context}:phoenix-teardown`, error)
  }

  const phoenixSocket = phoenixChannel.socket
  if (!phoenixSocket) return false

  try {
    phoenixSocket.remove?.call(phoenixSocket, phoenixChannel)
  } catch (error) {
    logRealtimeFailure(`${context}:phoenix-remove`, error)
  }

  const registry = phoenixSocket.channels
  if (registry?.some((candidate) => candidate === phoenixChannel)) {
    try {
      if (Array.isArray(phoenixChannel.stateChangeRefs)) {
        phoenixSocket.off?.call(phoenixSocket, phoenixChannel.stateChangeRefs)
      }
      for (let index = registry.length - 1; index >= 0; index -= 1) {
        if (registry[index] === phoenixChannel) registry.splice(index, 1)
      }
    } catch (error) {
      logRealtimeFailure(`${context}:phoenix-identity-fallback`, error)
    }
  }

  if (phoenixSocket.channels?.some((candidate) => candidate === phoenixChannel)) {
    logRealtimeFailure(
      `${context}:phoenix-retained`,
      new Error('Owned Phoenix channel remained registered after cleanup')
    )
  }

  return phoenixSocket.channels?.length === 0
}

function realtimeTransport(client: OwnedRealtimeClient): OwnedRealtimeTransport {
  if (client.realtime) return client.realtime
  return client
}

function disconnectUnusedClient(client: OwnedRealtimeClient, context: string): void {
  const outerRegistry = readRegistry(client, context)
  if (!outerRegistry || outerRegistry.length > 0) return

  const transport = realtimeTransport(client)
  const transportRegistry =
    transport === client
      ? outerRegistry
      : readRegistry(transport, `${context}:transport-registry-read`)
  if (!transportRegistry || transportRegistry.length > 0) return

  try {
    const connected = transport.isConnected()
    const connecting = transport.isConnecting()
    if (transport.isDisconnecting() || (!connected && !connecting)) return
    const disconnection = transport.disconnect()
    void Promise.resolve(disconnection).catch((error: unknown) => {
      logRealtimeFailure(`${context}:disconnect`, error)
    })
  } catch (error) {
    logRealtimeFailure(`${context}:disconnect`, error)
  }
}

function finishInstalledChannelCleanup(
  client: OwnedRealtimeClient,
  channel: RealtimeChannel,
  phoenixChannel: PhoenixChannel,
  context: string
): void {
  // Keep the real leave bindings intact until leave settles or its bounded
  // fallback fires. Only then destroy timers/listeners and exact registries.
  teardownOwnedChannel(channel, context)
  const innerRegistryIsEmpty = terminatePhoenixChannel(phoenixChannel, context)
  if (innerRegistryIsEmpty) disconnectUnusedClient(client, context)
}

function finishBoundedInstalledLeave(state: InstalledLeaveState): void {
  if (state.cleanupFinished) return
  state.cleanupFinished = true

  const { channel, client, context, phoenixChannel } = state
  if (state.fallbackTimer !== null) clearTimeout(state.fallbackTimer)

  // A never-settling dependency Promise retains its reaction callbacks. Clear
  // every heavyweight reference so that retained reaction holds only this
  // small, terminal state box rather than the client/channel object graph.
  state.channel = null
  state.client = null
  state.context = null
  state.fallbackTimer = null
  state.phoenixChannel = null

  if (channel && client && context && phoenixChannel) {
    finishInstalledChannelCleanup(client, channel, phoenixChannel, context)
  }
}

function rejectBoundedInstalledLeave(state: InstalledLeaveState, error: unknown): void {
  if (state.context) logRealtimeFailure(`${state.context}:leave`, error)
  finishBoundedInstalledLeave(state)
}

/**
 * Start the installed client's real leave path without its public
 * topic-sensitive outer removal. A delayed leave is bounded, then forcefully
 * terminated from the identity-based Phoenix registry.
 */
function beginBoundedInstalledLeave(
  client: OwnedRealtimeClient,
  channel: RealtimeChannel,
  phoenixChannel: PhoenixChannel,
  context: string
): void {
  const state: InstalledLeaveState = {
    channel,
    cleanupFinished: false,
    client,
    context,
    fallbackTimer: null,
    phoenixChannel,
  }

  try {
    const leave = channel.unsubscribe(LEAVE_TIMEOUT_MS)
    state.fallbackTimer = setTimeout(() => finishBoundedInstalledLeave(state), TEARDOWN_FALLBACK_MS)
    void Promise.resolve(leave).then(
      () => finishBoundedInstalledLeave(state),
      (error: unknown) => rejectBoundedInstalledLeave(state, error)
    )
  } catch (error) {
    rejectBoundedInstalledLeave(state, error)
  }
}

/**
 * Compatibility path for lightweight adapters that do not expose the
 * installed Realtime/Phoenix channel layers.
 */
function beginBestEffortAdapterRemoval(
  client: OwnedRealtimeClient,
  channel: RealtimeChannel,
  context: string
): void {
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let teardownFinished = false

  const finishTeardown = () => {
    if (teardownFinished) return
    teardownFinished = true
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
    teardownOwnedChannel(channel, context)
  }

  try {
    const removal = client.removeChannel(channel)
    fallbackTimer = setTimeout(finishTeardown, TEARDOWN_FALLBACK_MS)
    void Promise.resolve(removal).then(
      () => finishTeardown(),
      (error: unknown) => {
        logRealtimeFailure(`${context}:remove`, error)
        finishTeardown()
      }
    )
  } catch (error) {
    logRealtimeFailure(`${context}:remove`, error)
    finishTeardown()
  }
}

/**
 * Synchronously evict exact owned handles from the local registry, then run
 * unsubscribe/teardown as bounded best-effort work. The returned promise never
 * waits on a dependency promise that may remain pending forever.
 */
export function removeOwnedRealtimeChannels(
  client: OwnedRealtimeClient,
  channels: ReadonlyArray<RealtimeChannel | null | undefined>,
  context: string
): Promise<void> {
  const uniqueChannels = [
    ...new Set(channels.filter((channel): channel is RealtimeChannel => !!channel)),
  ]

  for (const channel of uniqueChannels) {
    const eviction = evictOwnedChannelFromRegistry(client, channel, context)
    if (eviction.wasRegistered === false) continue

    const closeHookIsolation = isolateOwnedChannelCloseHook(channel, context)
    const phoenixChannel = readPhoenixChannel(channel, context)

    if (phoenixChannel) {
      if (eviction.evicted && closeHookIsolation === 'isolated') {
        // The wrapper close callback is isolated, while the inner Phoenix
        // close callback remains intact and removes only this physical object.
        beginBoundedInstalledLeave(client, channel, phoenixChannel, context)
      } else {
        // Never trigger leave if its wrapper close hook could still reach the
        // real topic-wide outer registry.
        finishInstalledChannelCleanup(client, channel, phoenixChannel, context)
      }
      continue
    }

    if (eviction.hasSameTopicPeer || closeHookIsolation === 'failed') {
      teardownOwnedChannel(channel, context)
      continue
    }

    // Lightweight adapters and tests may expose neither a live registry nor
    // the installed client's socket close hook. Their public removal remains
    // the only available identity cleanup path.
    beginBestEffortAdapterRemoval(client, channel, context)
  }

  return Promise.resolve()
}

/**
 * Create, configure, and subscribe one physically owned channel.
 *
 * Supabase registers a channel in its client before `.on()`/`.subscribe()`
 * run. Snapshotting the registry lets us recover a partially registered
 * channel even if `channel()` itself is fault-injected to throw after that
 * registration. An already-existing topic is never configured or removed:
 * callers use per-instance/per-attempt topics, and a collision belongs to a
 * different subscription.
 */
export function subscribeOwnedRealtimeChannel(options: {
  client: OwnedRealtimeClient
  configure: (channel: RealtimeChannel) => void
  context: string
  topic: string
}): RealtimeChannel | null {
  const { client, configure, context, topic } = options
  let before: Set<RealtimeChannel>

  try {
    before = new Set(client.getChannels())
  } catch (error) {
    logRealtimeFailure(`${context}:snapshot`, error)
    return null
  }

  let channel: RealtimeChannel | null = null
  try {
    // Keep the physical handle before either `.on()` or `.subscribe()` runs.
    channel = client.channel(topic)
    if (before.has(channel)) {
      logRealtimeFailure(
        `${context}:topic-collision`,
        new Error(`Realtime topic already exists: ${topic}`)
      )
      return null
    }

    configure(channel)
    channel.subscribe()
    return channel
  } catch (error) {
    let ownedChannels: RealtimeChannel[] = []
    if (channel && !before.has(channel)) {
      ownedChannels = [channel]
    } else if (!channel) {
      try {
        ownedChannels = client.getChannels().filter((candidate) => !before.has(candidate))
      } catch {
        // A channel() failure after registration can only be recovered through
        // the registry. There is no local handle in this branch.
      }
    }
    void removeOwnedRealtimeChannels(client, ownedChannels, `${context}:rollback`)
    logRealtimeFailure(`${context}:setup`, error)
    return null
  }
}
