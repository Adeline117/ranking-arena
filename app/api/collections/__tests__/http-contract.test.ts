/** @jest-environment node */

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const COLLECTION_ID = '20000000-0000-4000-8000-000000000001'
const ITEM_ROW_ID = '30000000-0000-4000-8000-000000000001'
const ITEM_ID = '40000000-0000-4000-8000-000000000001'

const mockRequireAuth = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockReadAudience = jest.fn()
const mockSelect = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Map<string, string>()

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [name, value] of Object.entries(init.headers ?? {})) this.headers.set(name, value)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    private readonly body: unknown

    constructor(url: string, init: { method?: string; body?: unknown } = {}) {
      this.url = url
      this.method = init.method ?? 'GET'
      this.body = init.body
    }

    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

jest.mock('@/lib/profile/public-audience', () => ({
  readPublicProfileAudienceById: (...args: unknown[]) => mockReadAudience(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET as listCollections, POST as createCollection } from '../route'
import { POST as addCollectionItem } from '../[id]/items/route'
import {
  readCollectionCreateAcknowledgement,
  readCollectionItemAddAcknowledgement,
  readCollectionListAcknowledgement,
} from '@/lib/collections/client-contract'

const collection = {
  id: COLLECTION_ID,
  user_id: ACTOR_ID,
  name: 'Signals',
  description: null,
  is_public: false,
  created_at: '2026-08-03T12:00:00.000Z',
  updated_at: '2026-08-03T12:00:00.000Z',
}

const item = {
  id: ITEM_ROW_ID,
  collection_id: COLLECTION_ID,
  item_id: ITEM_ID,
  item_type: 'post',
  note: null,
  added_at: '2026-08-03T12:00:00.000Z',
}

function createAck(resultCode: 'created' | 'already_exists' = 'created') {
  return {
    action: 'create',
    actor_id: ACTOR_ID,
    applied: resultCode === 'created',
    collection: resultCode === 'created' ? collection : null,
    collection_id: resultCode === 'created' ? COLLECTION_ID : null,
    result_code: resultCode,
  }
}

function addAck(resultCode: 'inserted' | 'already_exists' = 'inserted') {
  return {
    action: 'add',
    actor_id: ACTOR_ID,
    applied: resultCode === 'inserted',
    collection_id: COLLECTION_ID,
    item: resultCode === 'inserted' ? item : null,
    item_id: ITEM_ID,
    item_type: 'post',
    result_code: resultCode,
  }
}

function request(body: unknown) {
  return new NextRequest('http://localhost/api/collections', { method: 'POST', body })
}

describe('collections HTTP identity contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: ACTOR_ID })
    mockReadAudience.mockResolvedValue({ status: 'active' })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'ensure_default_collections') return Promise.resolve({ data: null, error: null })
      if (name === 'mutate_user_collection_atomic') {
        return Promise.resolve({ data: createAck(), error: null })
      }
      if (name === 'mutate_collection_item_atomic') {
        return Promise.resolve({ data: addAck(), error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockFrom.mockImplementation(() => {
      const chain = {
        select: mockSelect,
        eq: jest.fn(),
        order: jest.fn(),
        then: jest.fn(),
      }
      chain.select.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)
      chain.order.mockReturnValue(chain)
      chain.then.mockImplementation((resolve: (value: unknown) => void) =>
        resolve({
          data: [{ id: COLLECTION_ID, name: 'Signals', collection_items: [{ count: 2 }] }],
          error: null,
        })
      )
      return chain
    })
  })

  it('returns an exact viewer-bound list projection', async () => {
    const response = await listCollections(
      new NextRequest('http://localhost/api/collections') as never
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockSelect).toHaveBeenCalledWith('id, name, collection_items(count)')
    expect(readCollectionListAcknowledgement(body, ACTOR_ID)).toEqual([
      { id: COLLECTION_ID, name: 'Signals', item_count: 2 },
    ])
  })

  it('returns an exact actor- and input-bound create acknowledgement', async () => {
    const response = await createCollection(
      request({ name: '  Signals  ', description: '', is_public: false }) as never
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(
      readCollectionCreateAcknowledgement(body, {
        actorId: ACTOR_ID,
        name: 'Signals',
        description: null,
        isPublic: false,
      })
    ).toEqual(collection)
    expect(mockRpc).toHaveBeenCalledWith('mutate_user_collection_atomic', {
      p_action: 'create',
      p_actor_id: ACTOR_ID,
      p_collection_id: null,
      p_description: null,
      p_description_present: true,
      p_is_public: false,
      p_is_public_present: true,
      p_name: 'Signals',
      p_name_present: true,
    })
  })

  it.each([
    { name: 'Signals', is_public: 'false' },
    { name: 'Signals', is_public: false, actorId: ACTOR_ID },
    { name: 123, is_public: false },
  ])('rejects a loose create body before the RPC', async (body) => {
    const response = await createCollection(request(body) as never)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects unreadable create JSON as a client error', async () => {
    const response = await createCollection({
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
    } as never)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('uses a failure envelope for a create conflict', async () => {
    mockRpc.mockResolvedValue({ data: createAck('already_exists'), error: null })

    const response = await createCollection(request({ name: 'Signals' }) as never)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.success).toBe(false)
  })

  it('returns an exact actor, collection and post-bound add acknowledgement', async () => {
    const response = await addCollectionItem(
      request({ item_type: 'post', item_id: ITEM_ID.toUpperCase() }) as never,
      { params: Promise.resolve({ id: COLLECTION_ID.toUpperCase() }) }
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(
      readCollectionItemAddAcknowledgement(body, {
        actorId: ACTOR_ID,
        collectionId: COLLECTION_ID,
        itemId: ITEM_ID,
        itemType: 'post',
      })
    ).toEqual(item)
    expect(mockRpc).toHaveBeenCalledWith('mutate_collection_item_atomic', {
      p_action: 'add',
      p_actor_id: ACTOR_ID,
      p_collection_id: COLLECTION_ID,
      p_item_id: ITEM_ID,
      p_item_type: 'post',
      p_note: null,
    })
  })

  it.each([
    { item_type: 'post', item_id: ITEM_ID, actorId: ACTOR_ID },
    { item_type: 'post', item_id: 123 },
    { item_type: 'trader', item_id: ITEM_ID },
  ])('rejects a loose add body before the RPC', async (body) => {
    const response = await addCollectionItem(request(body) as never, {
      params: Promise.resolve({ id: COLLECTION_ID }),
    })
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects unreadable add JSON as a client error', async () => {
    const response = await addCollectionItem(
      { json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')) } as never,
      { params: Promise.resolve({ id: COLLECTION_ID }) }
    )
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('uses a failure envelope for an add conflict', async () => {
    mockRpc.mockResolvedValue({ data: addAck('already_exists'), error: null })

    const response = await addCollectionItem(
      request({ item_type: 'post', item_id: ITEM_ID }) as never,
      { params: Promise.resolve({ id: COLLECTION_ID }) }
    )
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.success).toBe(false)
  })
})
