jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [key, value] of Object.entries(init.headers ?? {})) this.headers.set(key, value)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import {
  executeAtomicPostEdit,
  handleAtomicPostEditHttp,
  preparePostEdit,
} from './post-edit-server'

const ACTOR = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const post = {
  id: POST,
  author_id: ACTOR,
  group_id: null,
  title: 'Edited title',
  content: 'First line\nSecond line',
  images: ['https://cdn.example/image.png'],
  language: 'en',
  mentions: ['Alice_1'],
  hashtags: ['markets'],
  content_version: 8,
  updated_at: '2026-07-30T01:35:00.123456+00:00',
}

function clientWith(result: unknown): SupabaseClient {
  return {
    rpc: jest.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient
}

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

describe('post edit server authority', () => {
  it('strictly prepares sanitized multiline content and canonical images', () => {
    expect(
      preparePostEdit({
        title: '  Edited title  ',
        content: 'First line\n\nSecond line<script>discard me</script>',
        images: ['https://cdn.example/image.png'],
        expected_version: 7,
      })
    ).toEqual({
      title: 'Edited title',
      content: 'First line\n\nSecond line',
      images: ['https://cdn.example/image.png'],
      expectedVersion: 7,
      language: 'en',
      mentionHandles: [],
      hashtagTags: [],
    })
  })

  it('derives canonical facets only after sanitizing the final editable text', () => {
    expect(
      preparePostEdit({
        title: 'Market @Alice_1 #BTC',
        content: 'Body @alice_1 #Markets<script>@Mallory #Injected</script>',
        expected_version: 7,
      })
    ).toEqual({
      title: 'Market @Alice_1 #BTC',
      content: 'Body @alice_1 #Markets',
      expectedVersion: 7,
      language: 'en',
      mentionHandles: ['Alice_1'],
      hashtagTags: ['btc', 'markets'],
    })
  })

  it.each([
    ['unknown property', { title: 'Title', content: '', expected_version: 0, extra: true }],
    ['empty sanitized title', { title: '<script>x</script>', content: '', expected_version: 0 }],
    ['fractional revision', { title: 'Title', content: '', expected_version: 1.5 }],
    [
      'duplicate images',
      {
        title: 'Title',
        content: '',
        expected_version: 0,
        images: ['https://cdn.example/a.png', 'https://cdn.example/a.png'],
      },
    ],
    [
      'unsafe image',
      { title: 'Title', content: '', expected_version: 0, images: ['javascript:alert(1)'] },
    ],
  ])('rejects %s', (_label, body) => {
    expect(preparePostEdit(body)).toBeNull()
  })

  it('sends one exact CAS intent and accepts authoritative evidence', async () => {
    const client = clientWith({
      data: { status: 'updated', actor_id: ACTOR, revision_advanced: true, post },
      error: null,
    })
    await expect(
      executeAtomicPostEdit(client, ACTOR, POST, {
        title: post.title,
        content: post.content,
        images: post.images ?? undefined,
        expectedVersion: 7,
        language: 'en',
        mentionHandles: ['Alice_1'],
        hashtagTags: ['markets'],
      })
    ).resolves.toEqual({ status: 'updated', post })
    expect(client.rpc).toHaveBeenCalledWith('edit_post_atomic', {
      p_actor_id: ACTOR,
      p_post_id: POST,
      p_expected_version: 7,
      p_title: post.title,
      p_content: post.content,
      p_update_images: true,
      p_images: post.images,
      p_language: 'en',
      p_mention_handles: ['Alice_1'],
      p_hashtag_tags: ['markets'],
    })
  })

  it.each([
    ['changed actor', { status: 'updated', actor_id: OTHER, revision_advanced: true, post }],
    [
      'changed author',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, author_id: OTHER },
      },
    ],
    [
      'wrong version',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, content_version: 9 },
      },
    ],
    [
      'changed content',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, content: 'Other' },
      },
    ],
    [
      'changed language',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, language: 'zh' },
      },
    ],
    [
      'invented mention',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, mentions: ['Mallory'] },
      },
    ],
    [
      'changed hashtags',
      {
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, hashtags: ['other'] },
      },
    ],
  ])('fails closed on %s evidence', async (_label, data) => {
    await expect(
      executeAtomicPostEdit(clientWith({ data, error: null }), ACTOR, POST, {
        title: post.title,
        content: post.content,
        expectedVersion: 7,
        language: 'en',
        mentionHandles: ['Alice_1'],
        hashtagTags: ['markets'],
      })
    ).resolves.toEqual({ status: 'invalid_ack' })
  })

  it('accepts an exact join-only repair without claiming a revision advance', async () => {
    const repairedPost = { ...post, content_version: 7 }
    await expect(
      executeAtomicPostEdit(
        clientWith({
          data: {
            status: 'updated',
            actor_id: ACTOR,
            revision_advanced: false,
            post: repairedPost,
          },
          error: null,
        }),
        ACTOR,
        POST,
        {
          title: post.title,
          content: post.content,
          expectedVersion: 7,
          language: 'en',
          mentionHandles: ['Alice_1'],
          hashtagTags: ['markets'],
        }
      )
    ).resolves.toEqual({ status: 'updated', post: repairedPost })
  })

  it('accepts an exact lost-ack retry at the authority-owned newer revision', async () => {
    await expect(
      executeAtomicPostEdit(
        clientWith({
          data: {
            status: 'unchanged',
            actor_id: ACTOR,
            revision_advanced: false,
            post,
          },
          error: null,
        }),
        ACTOR,
        POST,
        {
          title: post.title,
          content: post.content,
          expectedVersion: 7,
          language: 'en',
          mentionHandles: ['Alice_1'],
          hashtagTags: ['markets'],
        }
      )
    ).resolves.toEqual({ status: 'unchanged', post })
  })

  it('maps stale edits to 409 without claiming success', async () => {
    const response = await handleAtomicPostEditHttp({
      request: request({ title: 'Title', content: 'Body', expected_version: 7 }),
      supabase: clientWith({ data: { status: 'conflict' }, error: null }),
      actorId: ACTOR,
      postId: POST,
      envelope: 'direct',
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Post changed. Reload and retry.',
    })
  })

  it('fails closed with 503 when the migration authority is unavailable', async () => {
    const response = await handleAtomicPostEditHttp({
      request: request({ title: 'Title', content: 'Body', expected_version: 7 }),
      supabase: clientWith({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }),
      actorId: ACTOR,
      postId: POST,
      envelope: 'direct',
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns only the exact direct success envelope', async () => {
    const postWithoutFacets = { ...post, mentions: [], hashtags: [] }
    const response = await handleAtomicPostEditHttp({
      request: request({
        title: post.title,
        content: post.content,
        images: post.images,
        expected_version: 7,
      }),
      supabase: clientWith({
        data: {
          status: 'updated',
          actor_id: ACTOR,
          revision_advanced: true,
          post: postWithoutFacets,
        },
        error: null,
      }),
      actorId: ACTOR,
      postId: POST,
      envelope: 'direct',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, post: postWithoutFacets })
  })
})
