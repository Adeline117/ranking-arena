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
      data: { status: 'updated', actor_id: ACTOR, post },
      error: null,
    })
    await expect(
      executeAtomicPostEdit(client, ACTOR, POST, {
        title: post.title,
        content: post.content,
        images: post.images ?? undefined,
        expectedVersion: 7,
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
    })
  })

  it.each([
    ['changed actor', { status: 'updated', actor_id: OTHER, post }],
    ['changed author', { status: 'updated', actor_id: ACTOR, post: { ...post, author_id: OTHER } }],
    [
      'wrong version',
      { status: 'updated', actor_id: ACTOR, post: { ...post, content_version: 9 } },
    ],
    [
      'changed content',
      { status: 'updated', actor_id: ACTOR, post: { ...post, content: 'Other' } },
    ],
  ])('fails closed on %s evidence', async (_label, data) => {
    await expect(
      executeAtomicPostEdit(clientWith({ data, error: null }), ACTOR, POST, {
        title: post.title,
        content: post.content,
        expectedVersion: 7,
      })
    ).resolves.toEqual({ status: 'invalid_ack' })
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
    const response = await handleAtomicPostEditHttp({
      request: request({
        title: post.title,
        content: post.content,
        images: post.images,
        expected_version: 7,
      }),
      supabase: clientWith({
        data: { status: 'updated', actor_id: ACTOR, post },
        error: null,
      }),
      actorId: ACTOR,
      postId: POST,
      envelope: 'direct',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, post })
  })
})
