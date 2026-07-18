/**
 * Collections API
 * GET /api/collections - Get current user's collections
 * POST /api/collections - Create a new collection
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateBoolean,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { parseCollectionMutationAck } from '@/lib/collections/atomic'
import { readPublicProfileAudienceById } from '@/lib/profile/public-audience'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

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
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
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
          return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
        }
      }
      throw defaultsError
    }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('*, collection_items(count)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    const result = (collections || []).map((c: Record<string, unknown>) => ({
      ...c,
      item_count: Array.isArray(c.collection_items)
        ? (c.collection_items[0] as Record<string, number>)?.count || 0
        : 0,
      collection_items: undefined,
    }))

    const releaseAudience = await readPublicProfileAudienceById(supabase, user.id)
    if (releaseAudience.status !== 'active') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }

    return success({ collections: result }, 200, NO_STORE_HEADERS)
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

    const body = (await request.json()) as Record<string, unknown>
    const name = validateString(body.name, {
      required: true,
      minLength: 1,
      maxLength: 50,
      fieldName: 'name',
    })!
    const description = validateString(body.description, {
      maxLength: 200,
      fieldName: 'description',
    })
    const is_public = validateBoolean(body.is_public) ?? false

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
      return success({ error: 'Collection with this name already exists' }, 409, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }

    return success({ collection: acknowledgement.collection }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collections POST'))
  }
}
