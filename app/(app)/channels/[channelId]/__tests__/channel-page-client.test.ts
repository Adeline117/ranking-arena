import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChannelPageSnapshot } from '../channel-page-client'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'

const channel = {
  id: CHANNEL_ID,
  name: 'Private group',
  avatar_url: null,
  description: 'Members only',
  type: 'group',
  created_by: ACTOR_ID,
  created_at: '2026-08-03T20:00:00.000Z',
  updated_at: '2026-08-03T20:01:00.000Z',
}

const member = {
  user_id: ACTOR_ID,
  role: 'member',
  nickname: null,
  joined_at: '2026-08-03T20:00:00.000Z',
  handle: 'reader',
  avatar_url: null,
}

const message = {
  id: MESSAGE_ID,
  sender_id: ACTOR_ID,
  content: 'hello',
  media_url: null,
  media_type: null,
  media_name: null,
  created_at: '2026-08-03T20:02:00.000Z',
  reply_to_id: null,
  reply_preview: null,
  reactions: [{ emoji: '🔥', count: 1, mine: true }],
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    channel,
    members: [member],
    messages: [message],
    has_more: false,
    my_role: 'member',
    ...overrides,
  }
}

describe('channel page client snapshot', () => {
  it('accepts an exact actor/channel snapshot and binds messages to the route', () => {
    expect(
      readChannelPageSnapshot(snapshot(), { actorId: ACTOR_ID, channelId: CHANNEL_ID })
    ).toEqual({
      channel: {
        id: CHANNEL_ID,
        name: 'Private group',
        type: 'group',
        avatar_url: null,
        description: 'Members only',
        created_by: ACTOR_ID,
      },
      members: [member],
      messages: [{ ...message, channel_id: CHANNEL_ID }],
      hasMore: false,
      myRole: 'member',
    })
  })

  it.each([
    null,
    { ...snapshot(), extra: true },
    snapshot({ channel: { ...channel, id: MESSAGE_ID } }),
    snapshot({ channel: { ...channel, extra: true } }),
    snapshot({ members: [] }),
    snapshot({ members: [{ ...member, role: 'owner' }] }),
    snapshot({ messages: [{ ...message, created_at: 'invalid' }] }),
    snapshot({ messages: [{ ...message, created_at: '2026-08-03T20:02:00' }] }),
    snapshot({ messages: [{ ...message, reactions: [{ emoji: '🔥', count: 0, mine: true }] }] }),
    snapshot({ messages: [message, message] }),
    snapshot({ has_more: true }),
  ])('rejects malformed, mismatched, or internally inconsistent evidence %#', (value) => {
    expect(readChannelPageSnapshot(value, { actorId: ACTOR_ID, channelId: CHANNEL_ID })).toBeNull()
  })

  it('renders channel data as viewer-owned and drops stale initial loads', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('const channelScopeKey = `${viewerKey}\\u0000${sessionGeneration}')
    expect(page).toContain('useViewerOwnedState<Channel | null>')
    expect(page).toContain(
      'loadChannelRequestGenerationRef.current === operation.requestGeneration'
    )
    expect(page).toContain('sessionGenerationRef.current === operation.sessionGeneration')
    expect(page).toContain('readChannelPageSnapshot(data, {')
    expect(page).toContain('loadChannelAbortRef.current?.abort()')
  })

  it('single-flights pagination inside the exact viewer/channel/cursor scope', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('loadOlderInFlightRef.current.has(requestKey)')
    expect(page).toContain('before=${encodeURIComponent(operation.before)}')
    expect(page).toContain('Date.parse(message.created_at) >= Date.parse(operation.before)')
    expect(page).toContain('snapshot.messages.filter((message) => !existingIds.has(message.id))')
    expect(page).toMatch(
      /const data: unknown = await res\.json\(\)\.catch\(\(\) => null\)[\s\S]{0,100}if \(!isCurrent\(\)\) return/
    )
  })

  it('binds one attachment upload to the active viewer and exact storage receipt', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('!accessToken || uploadOperationRef.current')
    expect(page).toContain('uploadOperationRef.current = operation')
    expect(page).toContain('signal: operation.controller.signal')
    expect(page).toContain('readChatUploadAcknowledgement(data, {')
    expect(page).toContain("storageBaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''")
    expect(page).toContain('uploadOperationRef.current?.controller.abort()')
  })

  it('drops realtime callbacks from a superseded viewer or channel', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('userIdRef.current !== userId')
    expect(page).toContain('channelIdRef.current !== channelId')
    expect(page).toContain('viewerKeyRef.current !== viewerKey')
    expect(page).toContain('sessionGenerationRef.current !== sessionGeneration')
    expect(page).toContain('msg.channel_id !== channelId')
    expect(page).toContain(
      'for (const controller of messageMutationControllersRef.current) controller.abort()'
    )
  })
})
