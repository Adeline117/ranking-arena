/**
 * 收藏夹订阅 API
 * POST /api/bookmark-folders/[id]/subscribe - 订阅收藏夹
 * DELETE /api/bookmark-folders/[id]/subscribe - 取消订阅
 * GET /api/bookmark-folders/[id]/subscribe - 检查订阅状态
 */

import { NextRequest } from 'next/server'
import { withAuth, withPublic } from '@/lib/api/middleware'
import { success, badRequest, error as errorResponse, handleError } from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'

type RouteContext = { params: Promise<{ id: string }> }

function isNoRows(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

type SubscriptionMutationStatus =
  | 'invalid'
  | 'account_inactive'
  | 'folder_not_found'
  | 'owner_forbidden'
  | 'folder_private'
  | 'added'
  | 'already_subscribed'
  | 'removed'
  | 'not_subscribed'

type SubscriptionMutationAck =
  | {
      status:
        | 'invalid'
        | 'account_inactive'
        | 'folder_not_found'
        | 'owner_forbidden'
        | 'folder_private'
    }
  | {
      status: 'added' | 'already_subscribed' | 'removed' | 'not_subscribed'
      userId: string
      folderId: string
      isSubscribed: boolean
      subscriberCount: number
    }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeFolderId(value: string): string | null {
  const normalized = value.toLowerCase()
  return uuidPattern.test(normalized) ? normalized : null
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function parseMutationAck(value: unknown): SubscriptionMutationAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const status = result.status as SubscriptionMutationStatus | undefined

  if (
    exactKeys(result, ['status']) &&
    (status === 'invalid' ||
      status === 'account_inactive' ||
      status === 'folder_not_found' ||
      status === 'owner_forbidden' ||
      status === 'folder_private')
  ) {
    return { status }
  }

  if (
    !exactKeys(result, ['status', 'user_id', 'folder_id', 'is_subscribed', 'subscriber_count']) ||
    (status !== 'added' &&
      status !== 'already_subscribed' &&
      status !== 'removed' &&
      status !== 'not_subscribed') ||
    typeof result.user_id !== 'string' ||
    !uuidPattern.test(result.user_id) ||
    typeof result.folder_id !== 'string' ||
    !uuidPattern.test(result.folder_id) ||
    typeof result.is_subscribed !== 'boolean' ||
    !Number.isSafeInteger(result.subscriber_count) ||
    Number(result.subscriber_count) < 0
  ) {
    return null
  }

  const shouldBeSubscribed = status === 'added' || status === 'already_subscribed'
  if (
    result.is_subscribed !== shouldBeSubscribed ||
    (shouldBeSubscribed && Number(result.subscriber_count) < 1)
  ) {
    return null
  }

  return {
    status,
    userId: result.user_id.toLowerCase(),
    folderId: result.folder_id.toLowerCase(),
    isSubscribed: result.is_subscribed,
    subscriberCount: Number(result.subscriber_count),
  }
}

function isSubscriptionAuthorityUnavailable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false
  return (
    error.code === 'PGRST202' ||
    error.code === 'PGRST205' ||
    error.code === '42883' ||
    error.code === '42P01' ||
    !!error.message?.includes('Could not find the table') ||
    !!error.message?.includes('Could not find the function')
  )
}

function subscriptionUnavailable() {
  return errorResponse(
    'Folder subscriptions are temporarily unavailable',
    503,
    ErrorCode.SERVICE_UNAVAILABLE
  )
}

function validateMutationAck(
  value: unknown,
  expected: { action: 'add' | 'remove'; userId: string; folderId: string }
): SubscriptionMutationAck {
  const ack = parseMutationAck(value)
  if (!ack) {
    throw new Error('Invalid atomic folder subscription acknowledgement')
  }

  if ('userId' in ack) {
    const validStatus =
      expected.action === 'add'
        ? ack.status === 'added' || ack.status === 'already_subscribed'
        : ack.status === 'removed' || ack.status === 'not_subscribed'
    if (!validStatus || ack.userId !== expected.userId || ack.folderId !== expected.folderId) {
      throw new Error('Atomic folder subscription acknowledgement mismatch')
    }
  }

  return ack
}

// 检查订阅状态（支持已登录和未登录用户）
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeFolderId(id)

  const handler = withPublic(
    async ({ user, supabase }) => {
      try {
        if (!folderId) {
          return badRequest('Invalid folder id')
        }
        if (!user) {
          return success({ is_subscribed: false })
        }

        // 检查是否已订阅
        const { data: subscription, error } = await supabase
          .from('folder_subscriptions')
          .select('id')
          .eq('user_id', user.id)
          .eq('folder_id', folderId)
          .single()

        if (error && !isNoRows(error)) {
          throw error
        }

        return success({ is_subscribed: !!subscription })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe GET')
      }
    },
    { name: 'bookmark-folder-subscribe-get', rateLimit: 'read', readsAuth: true }
  )

  return handler(request)
}

// 订阅收藏夹
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeFolderId(id)

  const handler = withAuth(
    async ({ user, request: req }) => {
      try {
        if (!folderId) {
          return badRequest('Invalid folder id')
        }

        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc(
          'mutate_bookmark_folder_subscription_atomic',
          {
            p_folder_id: folderId,
            p_action: 'add',
          }
        )
        if (error) {
          if (isSubscriptionAuthorityUnavailable(error)) return subscriptionUnavailable()
          throw error
        }

        const ack = validateMutationAck(data, {
          action: 'add',
          userId: user.id.toLowerCase(),
          folderId,
        })
        if (ack.status === 'account_inactive') {
          return success({ error: 'Account is inactive' }, 403)
        }
        if (ack.status === 'folder_not_found') {
          return success({ error: 'Folder not found' }, 404)
        }
        if (ack.status === 'owner_forbidden') {
          return success({ error: 'Cannot subscribe to your own folder' }, 400)
        }
        if (ack.status === 'folder_private') {
          return success({ error: 'This folder is not public' }, 403)
        }
        if (ack.status === 'already_subscribed') {
          return success({ error: 'Already subscribed to this folder' }, 409)
        }
        if (ack.status !== 'added' || !('subscriberCount' in ack)) {
          throw new Error('Atomic folder subscription add returned an impossible status')
        }

        return success(
          {
            message: 'Subscribed successfully',
            is_subscribed: true,
            subscriber_count: ack.subscriberCount,
          },
          201
        )
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe POST')
      }
    },
    { name: 'bookmark-folder-subscribe-post', rateLimit: 'write' }
  )

  return handler(request)
}

// 取消订阅
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const folderId = normalizeFolderId(id)

  const handler = withAuth(
    async ({ user, request: req }) => {
      try {
        if (!folderId) {
          return badRequest('Invalid folder id')
        }

        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc(
          'mutate_bookmark_folder_subscription_atomic',
          {
            p_folder_id: folderId,
            p_action: 'remove',
          }
        )
        if (error) {
          if (isSubscriptionAuthorityUnavailable(error)) return subscriptionUnavailable()
          throw error
        }

        const ack = validateMutationAck(data, {
          action: 'remove',
          userId: user.id.toLowerCase(),
          folderId,
        })
        if (ack.status === 'account_inactive') {
          return success({ error: 'Account is inactive' }, 403)
        }
        if (ack.status === 'folder_not_found') {
          return success({ error: 'Folder not found' }, 404)
        }
        if (ack.status === 'not_subscribed') {
          return success({ error: 'Not subscribed to this folder' }, 404)
        }
        if (ack.status !== 'removed' || !('subscriberCount' in ack)) {
          throw new Error('Atomic folder subscription remove returned an impossible status')
        }

        return success({
          message: 'Unsubscribed successfully',
          is_subscribed: false,
          subscriber_count: ack.subscriberCount,
        })
      } catch (error: unknown) {
        return handleError(error, 'bookmark-folders/[id]/subscribe DELETE')
      }
    },
    { name: 'bookmark-folder-subscribe-delete', rateLimit: 'write' }
  )

  return handler(request)
}
