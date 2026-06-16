/**
 * 收藏夹 API
 * GET /api/bookmark-folders - 获取用户的收藏夹列表
 * POST /api/bookmark-folders - 创建新收藏夹
 */

import { withAuth } from '@/lib/api/middleware'
import { badRequest, success, handleError } from '@/lib/api/response'
import { validateString, validateBoolean } from '@/lib/api/validation'

export const GET = withAuth(
  async ({ user, supabase }) => {
    try {
      // 尝试确保用户有默认收藏夹（如果表存在）
      try {
        await supabase.rpc('ensure_default_bookmark_folder', { p_user_id: user.id })
      } catch {
        // Intentionally swallowed: RPC function may not be deployed yet, folder creation continues without it
      }

      // 获取用户的所有收藏夹
      const { data: folders, error } = await supabase
        .from('bookmark_folders')
        .select('id, name, description, avatar_url, is_public, is_default, created_at')
        .eq('user_id', user.id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })

      if (error) {
        // 如果表不存在，返回空列表
        const ignoredCodes = ['42P01', 'PGRST116', 'PGRST204']
        if (ignoredCodes.includes(error.code || '')) {
          return success({ folders: [] })
        }
        throw error
      }

      // Attach per-folder item counts. The folder row has no count column, so the
      // client previously rendered "undefined items". Tally the user's bookmarks by
      // folder_id in one lightweight query (folder_id only); null-folder bookmarks
      // belong to the default folder.
      const list = (folders || []) as Array<{ id: string; is_default?: boolean }>
      const countByFolder: Record<string, number> = {}
      if (list.length > 0) {
        const { data: marks } = await supabase
          .from('post_bookmarks')
          .select('folder_id')
          .eq('user_id', user.id)
        const defaultId = list.find((f) => f.is_default)?.id
        for (const m of (marks || []) as Array<{ folder_id: string | null }>) {
          const fid = m.folder_id || defaultId
          if (fid) countByFolder[fid] = (countByFolder[fid] || 0) + 1
        }
      }
      return success({
        folders: list.map((f) => ({ ...f, post_count: countByFolder[f.id] ?? 0 })),
      })
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders GET')
    }
  },
  { name: 'bookmark-folders-list', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }

      const name = validateString(body.name, {
        required: true,
        minLength: 1,
        maxLength: 50,
        fieldName: 'folder name',
      })!
      const description = validateString(body.description, { maxLength: 200 })
      const avatar_url = validateString(body.avatar_url, { maxLength: 500 })
      const is_public = validateBoolean(body.is_public) ?? false

      // 创建收藏夹
      const { data: folder, error } = await supabase
        .from('bookmark_folders')
        .insert({
          user_id: user.id,
          name,
          description,
          avatar_url,
          is_public,
          is_default: false,
        })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') {
          throw new Error('A folder with this name already exists')
        }
        throw error
      }

      return success({ folder }, 201)
    } catch (error: unknown) {
      return handleError(error, 'bookmark-folders POST')
    }
  },
  { name: 'bookmark-folders-create', rateLimit: 'write' }
)
