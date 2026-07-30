/**
 * 已订阅收藏夹 API
 * GET /api/bookmark-folders/subscribed - 获取用户订阅的收藏夹列表
 */

import { withAuth } from '@/lib/api/middleware'
import { success, handleError } from '@/lib/api/response'
import { validateNumber } from '@/lib/api/validation'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export const GET = withAuth(
  async ({ user, supabase, request }) => {
    try {
      const { searchParams } = new URL(request.url)

      const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
      const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

      // 获取用户订阅的收藏夹
      const { data: subscriptions, error } = await supabase
        .from('folder_subscriptions')
        .select(
          `
          id,
          created_at,
          bookmark_folders (
            id,
            name,
            description,
            avatar_url,
            is_public,
            post_count,
            created_at,
            user_id
          )
        `
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit)

      if (error) {
        throw error
      }
      if (!Array.isArray(subscriptions)) {
        throw new Error('Invalid subscribed folder result')
      }
      const hasMore = subscriptions.length > limit
      const pageSubscriptions = subscriptions.slice(0, limit)

      // 收集所有收藏夹所有者的 ID
      const ownerIds = pageSubscriptions
        .map((s) => asRecord(s.bookmark_folders)?.user_id)
        .filter((ownerId): ownerId is string => typeof ownerId === 'string' && ownerId.length > 0)

      // 获取所有者信息
      let ownerMap: Record<string, { handle: string; avatar_url: string | null }> = {}
      if (ownerIds.length > 0) {
        const { data: owners, error: ownersError } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', ownerIds)

        if (ownersError || !Array.isArray(owners)) {
          throw ownersError ?? new Error('Invalid subscribed folder owner result')
        }
        ownerMap = owners.reduce(
          (acc, owner) => {
            acc[owner.id] = { handle: owner.handle, avatar_url: owner.avatar_url }
            return acc
          },
          {} as Record<string, { handle: string; avatar_url: string | null }>
        )
      }

      // `bookmark_folders` has no subscriber_count column. Returning the old
      // unselected property fabricated zero for every folder. Exact HEAD
      // counts are bounded to this page and use the folder_id index.
      const visibleFolderIds = [
        ...new Set(
          pageSubscriptions.flatMap((subscription) => {
            const folder = asRecord(subscription.bookmark_folders)
            return folder?.is_public === true && typeof folder.id === 'string' ? [folder.id] : []
          })
        ),
      ]
      const subscriberCountEntries = await Promise.all(
        visibleFolderIds.map(async (folderId) => {
          const { count, error: countError } = await supabase
            .from('folder_subscriptions')
            .select('id', { count: 'exact', head: true })
            .eq('folder_id', folderId)
          if (countError || !Number.isSafeInteger(count) || Number(count) < 0) {
            throw countError ?? new Error('Invalid subscribed folder count')
          }
          return [folderId, Number(count)] as const
        })
      )
      const subscriberCountMap = new Map(subscriberCountEntries)

      // 格式化返回数据
      const folders = pageSubscriptions
        .map((s) => {
          const folder = asRecord(s.bookmark_folders)
          if (!folder || folder.is_public !== true || typeof folder.id !== 'string') return null

          const owner = ownerMap[String(folder.user_id)]
          const subscriberCount = subscriberCountMap.get(folder.id)
          if (subscriberCount === undefined) {
            throw new Error('Subscribed folder count acknowledgement is incomplete')
          }
          return {
            id: folder.id,
            name: folder.name,
            description: folder.description,
            avatar_url: folder.avatar_url,
            is_public: folder.is_public,
            post_count: folder.post_count || 0,
            subscriber_count: subscriberCount,
            created_at: folder.created_at,
            owner_id: folder.user_id,
            owner_handle: owner?.handle,
            owner_avatar_url: owner?.avatar_url,
            subscribed_at: s.created_at,
          }
        })
        .filter(Boolean)

      return success({
        folders,
        pagination: {
          limit,
          offset,
          has_more: hasMore,
        },
      })
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders/subscribed GET')
    }
  },
  { name: 'bookmark-folders-subscribed', rateLimit: 'read' }
)
