/**
 * Collections API
 * GET /api/collections - Get current user's collections
 * POST /api/collections - Create a new collection
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  ApiError,
  conflict,
  forbidden,
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { parseCollectionMutationAck } from '@/lib/collections/atomic'
import { readPublicProfileAudienceById } from '@/lib/profile/public-audience'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const CreateCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    description: z
      .string()
      .max(200)
      .transform((value) => value.trim() || null)
      .nullable()
      .optional(),
    is_public: z.boolean().optional(),
  })
  .strict()

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const currentAudience = await readPublicProfileAudienceById(supabase, user.id)
    if (currentAudience.status !== 'active') {
      return noStore(forbidden('Account is not active'))
    }

    const { error: defaultsError } = await supabase.rpc('ensure_default_collections', {
      p_user_id: user.id,
    })
    if (defaultsError) {
      // The database deliberately fails closed if the account becomes inactive
      // while the default-collection transaction is waiting on its profile lock.
      // Only translate that authorization error after an uncached state check;
      // an unexpected 42501 (for example a service-role regression) must surface.
      if (defaultsError.code === '42501') {
        const deniedAudience = await readPublicProfileAudienceById(supabase, user.id)
        if (deniedAudience.status !== 'active') {
          return noStore(forbidden('Account is not active'))
        }
      }
      throw defaultsError
    }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('id, name, collection_items(count)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    const result = (collections || []).map((collection: Record<string, unknown>) => {
      const count = Array.isArray(collection.collection_items)
        ? (collection.collection_items[0] as Record<string, unknown> | undefined)?.count
        : undefined
      if (
        typeof collection.id !== 'string' ||
        typeof collection.name !== 'string' ||
        !Number.isSafeInteger(count) ||
        Number(count) < 0
      ) {
        throw new Error('Malformed collection list projection')
      }
      return { id: collection.id, name: collection.name, item_count: Number(count) }
    })

    const releaseAudience = await readPublicProfileAudienceById(supabase, user.id)
    if (releaseAudience.status !== 'active') {
      return noStore(forbidden('Account is not active'))
    }

    return success({ viewerId: user.id, collections: result }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collections GET'))
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return noStore(rateLimitResp)

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw ApiError.validation('Invalid JSON body')
    }
    const parsed = CreateCollectionSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const name = parsed.data.name
    const description = parsed.data.description ?? null
    const is_public = parsed.data.is_public ?? false

    const { data, error } = await supabase.rpc('mutate_user_collection_atomic', {
      p_action: 'create',
      p_actor_id: user.id,
      p_collection_id: null,
      p_description: description,
      p_description_present: true,
      p_is_public: is_public,
      p_is_public_present: true,
      p_name: name,
      p_name_present: true,
    })

    if (error) throw error
    const acknowledgement = parseCollectionMutationAck(data, {
      action: 'create',
      actorId: user.id,
      collectionId: undefined,
    })
    if (acknowledgement.result_code === 'already_exists') {
      return noStore(conflict('Collection with this name already exists'))
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return noStore(forbidden('Account is not active'))
    }
    if (!acknowledgement.collection) throw new Error('Missing created collection')

    return success(
      {
        action: 'create' as const,
        actorId: user.id,
        collectionId: acknowledgement.collection.id,
        collection: acknowledgement.collection,
      },
      200,
      NO_STORE_HEADERS
    )
  } catch (error: unknown) {
    return noStore(handleError(error, 'collections POST'))
  }
}
