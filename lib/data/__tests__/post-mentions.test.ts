const mockSendNotifications = jest.fn()
const mockCanRead = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/data/notifications', () => ({
  sendNotifications: (...a: unknown[]) => mockSendNotifications(...a),
}))
jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...a: unknown[]) => mockCanRead(...a),
}))
jest.mock('@/lib/logger', () => ({ logger: { error: (...a: unknown[]) => mockLoggerError(...a) } }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { extractMentionHandles, MAX_MENTIONS_PER_POST, notifyPostMentions } from '../post-mentions'

function client(opts: {
  users?: Array<{ id: string; handle: string }>
  lookupError?: { message: string } | null
  storeError?: { message: string } | null
}) {
  const inCalls: unknown[] = []
  const supabase = {
    from: (table: string) => {
      if (table === 'user_profiles') {
        return {
          select: () => ({
            in: (_col: string, handles: unknown) => {
              inCalls.push(handles)
              return Promise.resolve({ data: opts.users ?? [], error: opts.lookupError ?? null })
            },
          }),
        }
      }
      return {
        update: () => ({ eq: () => Promise.resolve({ error: opts.storeError ?? null }) }),
      }
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, inCalls }
}

const base = {
  postId: 'post-1',
  authorId: 'author',
  authorHandle: 'alice',
  title: '',
  content: 'hi @bob and @carol and @alice',
}

describe('post mention notifications', () => {
  beforeEach(() => jest.clearAllMocks())

  it('notifies only mentioned users who can read the post, never the author', async () => {
    const { supabase } = client({
      users: [
        { id: 'bob', handle: 'bob' },
        { id: 'carol', handle: 'carol' },
        { id: 'author', handle: 'alice' },
      ],
    })
    mockCanRead.mockImplementation(async (_s: unknown, _p: string, uid: string) => uid === 'bob')

    await notifyPostMentions(supabase, base)

    expect(mockCanRead).toHaveBeenCalledTimes(2)
    expect(mockCanRead).toHaveBeenCalledWith(supabase, 'post-1', 'carol')
    const rows = mockSendNotifications.mock.calls[0][1] as Array<{ user_id: string }>
    expect(rows.map((r) => r.user_id)).toEqual(['bob'])
  })

  it('sends nothing when no mentioned user may read the post', async () => {
    const { supabase } = client({ users: [{ id: 'carol', handle: 'carol' }] })
    mockCanRead.mockResolvedValue(false)
    await notifyPostMentions(supabase, { ...base, content: '@carol secret plans' })
    expect(mockSendNotifications).not.toHaveBeenCalled()
  })

  it('logs a failed mentions write instead of swallowing it', async () => {
    const { supabase } = client({
      users: [{ id: 'bob', handle: 'bob' }],
      storeError: { message: 'boom' },
    })
    mockCanRead.mockResolvedValue(true)
    await notifyPostMentions(supabase, { ...base, content: '@bob' })
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[post-mentions] storing resolved mentions failed',
      expect.objectContaining({ postId: 'post-1' })
    )
    expect(mockSendNotifications).toHaveBeenCalled()
  })

  it('caps how many handles one post can resolve', () => {
    const content = Array.from({ length: 50 }, (_, i) => `@u${i}`).join(' ')
    expect(extractMentionHandles(content)).toHaveLength(MAX_MENTIONS_PER_POST)
    expect(extractMentionHandles('@a @a @b')).toEqual(['a', 'b'])
  })
})
